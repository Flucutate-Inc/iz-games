/**
 * express の最小互換シム(Workers 用)。
 *
 * wrangler の alias で `express` をこのモジュールへ差し替えることで、
 * api.js / admin.js のルーター定義を無改修のまま Workers 上で動かす。
 * 対応しているのは実際に使われている機能だけ:
 *   Router() / get,post,put,patch,delete / use(mw) / use(path, router)
 *   req.body(JSON) / req.query / req.params / req.headers
 *   res.json / res.status / res.send / res.setHeader
 *   next(err) と (err, req, res, next) のエラーハンドラ
 */

/** '/users/:id' → 正規表現 + パラメータ名 */
function compile(path) {
  const names = [];
  const pattern = path
    .replace(/[.+*?^${}()|[\]\\]/g, m => `\\${m}`)
    .replace(/:(\w+)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
  return { re: new RegExp(`^${pattern}$`), names };
}

class Router {
  constructor() {
    this.layers = [];
    // express の Router は「関数としても mount できるオブジェクト」なので、
    // 呼び出し可能な関数にプロトタイプを付け替えて返す。
    // (プライベートフィールド #x はこの形だと使えないため使わない)
    const layers = this.layers;
    const self = (req, res, next) => Router.prototype.handle.call(self, req, res, next);
    Object.setPrototypeOf(self, Router.prototype);
    self.layers = layers;
    return self;
  }

  addRoute(method, path, handlers) {
    const { re, names } = compile(path);
    this.layers.push({ method, re, names, handlers: handlers.flat() });
  }

  get(path, ...h) { this.addRoute('GET', path, h); return this; }
  post(path, ...h) { this.addRoute('POST', path, h); return this; }
  put(path, ...h) { this.addRoute('PUT', path, h); return this; }
  patch(path, ...h) { this.addRoute('PATCH', path, h); return this; }
  delete(path, ...h) { this.addRoute('DELETE', path, h); return this; }

  /** use(mw) / use(path, router|mw) */
  use(pathOrFn, ...rest) {
    if (typeof pathOrFn === 'function') {
      this.layers.push({ method: null, prefix: '', handlers: [pathOrFn, ...rest] });
    } else {
      this.layers.push({ method: null, prefix: pathOrFn, handlers: rest.flat() });
    }
    return this;
  }

  /** このルーターで req を処理する。処理しきれなければ next() を呼ぶ */
  async handle(req, res, next) {
    const path = req.path;
    for (const layer of this.layers) {
      if (res.finished) return;

      // ミドルウェア/マウント
      if (layer.method === null) {
        const prefix = layer.prefix || '';
        if (prefix && !(path === prefix || path.startsWith(`${prefix}/`))) continue;
        const saved = req.path;
        if (prefix) req.path = path.slice(prefix.length) || '/';
        for (const h of layer.handlers) {
          if (res.finished) break;
          const err = await runHandler(h, req, res);
          if (err) { req.path = saved; return next(err); }
        }
        req.path = saved;
        continue;
      }

      // ルート
      if (layer.method !== req.method) continue;
      const m = layer.re.exec(path);
      if (!m) continue;
      req.params = {};
      layer.names.forEach((name, i) => { req.params[name] = decodeURIComponent(m[i + 1]); });
      for (const h of layer.handlers) {
        if (res.finished) break;
        const err = await runHandler(h, req, res);
        if (err) return next(err);
      }
      return;
    }
    return next();
  }
}

/** ハンドラを1つ実行し、next(err) で渡されたエラーを返す(無ければ undefined) */
function runHandler(handler, req, res) {
  return new Promise(resolve => {
    let settled = false;
    const done = err => {
      if (settled) return;
      settled = true;
      resolve(err instanceof Error ? err : undefined);
    };
    try {
      const out = handler(req, res, done);
      if (out && typeof out.then === 'function') {
        out.then(() => { if (res.finished) done(); }, e => done(e));
      }
      // 同期ハンドラがレスポンスを書いたら終了
      if (res.finished) done();
      // next() も呼ばれずレスポンスも無い場合は、res が書かれるまで待つ
      res.onFinish(() => done());
    } catch (e) {
      done(e);
    }
  });
}

/** Request/Response の擬似オブジェクトを作る */
function createReqRes(request, url, body) {
  const finishers = [];
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    finished: false,
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    json(obj) {
      this.headers['content-type'] = 'application/json; charset=utf-8';
      this.body = JSON.stringify(obj);
      this.finish();
      return this;
    },
    send(text) {
      if (!this.headers['content-type']) this.headers['content-type'] = 'text/plain; charset=utf-8';
      this.body = text;
      this.finish();
      return this;
    },
    finish() {
      if (this.finished) return;
      this.finished = true;
      for (const fn of finishers.splice(0)) fn();
    },
    onFinish(fn) {
      if (this.finished) fn();
      else finishers.push(fn);
    },
  };

  const query = {};
  for (const [k, v] of url.searchParams) query[k] = v;

  const headers = {};
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;

  const req = {
    method: request.method,
    path: url.pathname,
    originalUrl: url.pathname + url.search,
    query,
    headers,
    body: body ?? {},
    params: {},
  };
  return { req, res };
}

/** Router を使って Request を処理し、Response を返す */
async function dispatch(router, request, body) {
  const url = new URL(request.url);
  const { req, res } = createReqRes(request, url, body);
  await new Promise(resolve => {
    router.handle(req, res, err => {
      if (err) {
        res.statusCode = err.status || 500;
        res.json({ error: err.message || 'サーバーエラー' });
      } else if (!res.finished) {
        res.statusCode = 404;
        res.json({ error: 'Not Found' });
      }
      resolve();
    });
    res.onFinish(resolve);
  });
  return new Response(res.body, { status: res.statusCode, headers: res.headers });
}

// api.js / admin.js は CommonJS の require('express') で読み込むため CommonJS で公開する
const express = () => new Router();
express.Router = () => new Router();
express.json = () => (req, res, next) => next();
express.static = () => (req, res, next) => next();

module.exports = express;
module.exports.Router = express.Router;
module.exports.dispatch = dispatch;
module.exports.createReqRes = createReqRes;
