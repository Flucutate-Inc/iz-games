/**
 * Cloudflare Workers エントリ + Durable Object 本体。
 *
 * 構成:
 *   Worker         … 静的アセット(ゲーム本体・IZ SDK)を配信し、/api と /ws だけ DO へ渡す
 *   GameServer(DO) … サーバー本体。SQLite(アカウント・作品) + 部屋(メモリ) + WebSocket
 *
 * DO は1個だけ(名前 "main")使う。部屋はプロセスのメモリ上にあり、SQLite も単一なので、
 * わんわん大戦争と同じ「単一インスタンス」前提を保つ。
 */

import topicsData from '../data/topics.json';
import { Db, publicUser } from './src/db.js';
import { Rooms, RULES, sanitizeStrokes } from './src/game.js';
import { verifyIdToken, allowedProjects } from './src/firebase-auth.js';
import { toHiraganaOnly } from './src/kana.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function errorJson(message, status = 400) {
  return json({ error: message }, status);
}

/** 表示名をゲームの命名規則に整える。IZ の表示名をそのまま使うと長すぎることがある */
function normalizeName(raw, fallback = 'ななしさん') {
  const s = String(raw || '')
    .normalize('NFKC')
    .replace(/[\r\n\t]/g, ' ')
    .trim();
  const kept = (s.match(/[\p{Letter}\p{Number}ー－_\- ]/gu) || []).join('').trim();
  return kept.slice(0, 12) || fallback;
}

export class GameServer {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.db = new Db(ctx.storage.sql);
    this.db.init();
    this.rooms = new Rooms(this.db, topicsData.topics);
    this.projects = allowedProjects(env);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/ws') return this.handleWs(request, url);
      if (path.startsWith('/api/')) return await this.handleApi(request, url, path);
      return errorJson('見つかりません', 404);
    } catch (e) {
      console.error('[oekaki-kusa]', e && e.stack ? e.stack : e);
      return errorJson((e && e.message) || 'サーバーエラー', e && e.status ? e.status : 500);
    }
  }

  // ─── HTTP API ────────────────────────────────────────────

  userFromRequest(request, url) {
    const header = request.headers.get('authorization') || '';
    const token = header.replace(/^Bearer\s+/i, '') || url.searchParams.get('t') || '';
    return this.db.userByToken(token);
  }

  async handleApi(request, url, path) {
    // 設定の確認(IZ 連携が失敗したときの原因表示に使う)
    if (path === '/api/iz-config' && request.method === 'GET') {
      return json({ firebaseProjects: this.projects, rules: RULES });
    }

    if (path === '/api/stats' && request.method === 'GET') {
      return json({ ...this.rooms.stats(), drawings: this.db.countDrawings() });
    }

    if (path === '/api/login-iz' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (!body.idToken) return errorJson('IDトークンがありません', 400);
      let payload;
      try {
        payload = await verifyIdToken(body.idToken, this.projects);
      } catch (e) {
        // 原因をそのまま返す。クライアントが aud 不一致などを画面に出せるようにする
        return errorJson((e && e.message) || 'IDトークンの検証に失敗しました', 401);
      }
      const uid = payload.sub;
      const name = normalizeName(body.displayName || payload.name, 'いずさん');
      let user = this.db.userByFirebaseUid(uid);
      if (!user) {
        const id = this.db.createUser(name, uid);
        user = this.db.userById(id);
      } else if (name && user.display_name !== name) {
        // IZ 側で表示名を変えたら追従する
        this.db.setDisplayName(user.id, name);
        user = this.db.userById(user.id);
      }
      this.db.touchLogin(user.id);
      const token = this.db.createSession(user.id);
      return json({ token, user: publicUser(user) });
    }

    // IZ アプリの外(普通のブラウザ)で試すためのログイン。IZ のアカウントとは別枠。
    if (path === '/api/login-guest' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const name = normalizeName(body.displayName, 'ゲスト');
      const id = this.db.createUser(name, null);
      const user = this.db.userById(id);
      this.db.touchLogin(id);
      const token = this.db.createSession(id);
      return json({ token, user: publicUser(user) });
    }

    if (path === '/api/me' && request.method === 'GET') {
      const user = this.userFromRequest(request, url);
      if (!user) return errorJson('認証が必要です', 401);
      return json({ user: publicUser(user) });
    }

    if (path === '/api/gallery' && request.method === 'GET') {
      const user = this.userFromRequest(request, url);
      const mine = url.searchParams.get('mine') === '1';
      if (mine && !user) return errorJson('認証が必要です', 401);
      const drawings = this.db.listDrawings({
        limit: Number(url.searchParams.get('limit')) || 24,
        before: Number(url.searchParams.get('before')) || null,
        userId: mine ? user.id : null,
        viewerId: user ? user.id : null,
      });
      return json({ drawings, total: this.db.countDrawings() });
    }

    // ホーム画面の背景など、作品からのランダム抽出
    if (path === '/api/gallery/random' && request.method === 'GET') {
      const n = Number(url.searchParams.get('n')) || 6;
      return json({ drawings: this.db.randomDrawings(n) });
    }

    // 作品1件(シェアされたリンクから開くときに使う)
    {
      const m = path.match(/^\/api\/drawings\/(\d+)$/);
      if (m && request.method === 'GET') {
        const user = this.userFromRequest(request, url);
        const drawing = this.db.drawingById(Number(m[1]), user ? user.id : null);
        if (!drawing) return errorJson('その作品はありません', 404);
        return json({ drawing, comments: this.db.listComments(drawing.id) });
      }
    }

    // いいね(トグル)
    {
      const m = path.match(/^\/api\/drawings\/(\d+)\/like$/);
      if (m && request.method === 'POST') {
        const user = this.userFromRequest(request, url);
        if (!user) return errorJson('認証が必要です', 401);
        const id = Number(m[1]);
        if (!this.db.drawingExists(id)) return errorJson('その作品はありません', 404);
        return json(this.db.toggleLike(id, user.id));
      }
    }

    // コメント(一覧・追加)
    {
      const m = path.match(/^\/api\/drawings\/(\d+)\/comments$/);
      if (m) {
        const id = Number(m[1]);
        if (!this.db.drawingExists(id)) return errorJson('その作品はありません', 404);
        if (request.method === 'GET') {
          return json({ comments: this.db.listComments(id) });
        }
        if (request.method === 'POST') {
          const user = this.userFromRequest(request, url);
          if (!user) return errorJson('認証が必要です', 401);
          const body = await request.json().catch(() => ({}));
          // NFKC はかけない(全角の「！」などが変わってしまう)。改行・制御文字だけ潰す
          const text = String(body.text || '')
            .replace(/[\u0000-\u001f\u007f]+/g, ' ')
            .trim()
            .slice(0, 80);
          if (!text) return errorJson('コメントが空です', 400);
          const comment = this.db.addComment(id, user.id, user.display_name, text);
          return json({ comment });
        }
      }
    }

    // ソロモード用のお題(1件)。答え合わせがないので label だけ返す
    if (path === '/api/topics/random' && request.method === 'GET') {
      const list = topicsData.topics;
      const t = list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];
      return json({ label: t.label });
    }

    // ソロモード: 1人で描いた作品。描いた時点でギャラリーに並ぶ
    if (path === '/api/solo-post' && request.method === 'POST') {
      const user = this.userFromRequest(request, url);
      if (!user) return errorJson('認証が必要です', 401);
      const body = await request.json().catch(() => ({}));
      const topicLabel = String(body.topicLabel || '')
        .normalize('NFKC')
        .replace(/[\r\n\t]/g, ' ')
        .trim()
        .slice(0, 20);
      if (!topicLabel) return errorJson('お題がありません', 400);
      const strokes = sanitizeStrokes(body.strokes);
      if (!strokes.length) return errorJson('絵が描かれていません', 400);
      const ar = Number(body.ar);

      const id = this.db.saveDrawing({
        userId: user.id,
        displayName: user.display_name,
        topicLabel,
        strokes,
        ar: Number.isFinite(ar) && ar > 0.2 && ar < 5 ? ar : 4 / 3,
        solved: false,
        solverName: null,
        roomCode: null,
        mode: 'solo',
      });
      return json({ drawing: this.db.drawingById(id, user.id) });
    }

    return errorJson('見つかりません', 404);
  }

  // ─── WebSocket ───────────────────────────────────────────

  handleWs(request, url) {
    if (request.headers.get('upgrade') !== 'websocket') {
      return errorJson('WebSocket が必要です', 426);
    }
    const user = this.db.userByToken(url.searchParams.get('t') || '');
    if (!user) return errorJson('認証が必要です', 401);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    server.addEventListener('message', ev => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      try {
        this.onMessage(user, server, msg);
      } catch (e) {
        console.error('[ws]', e && e.stack ? e.stack : e);
        try {
          server.send(JSON.stringify({ t: 'error', message: (e && e.message) || 'エラー' }));
        } catch { /* 送れないなら諦める */ }
      }
    });

    const cleanup = () => {
      const room = this.rooms.roomOf(user.id);
      if (room) {
        const p = room.players.get(user.id);
        // 別端末で入り直したときは、新しいソケットを消さない
        if (!p || p.ws === server) room.markDisconnected(user.id);
      }
    };
    server.addEventListener('close', cleanup);
    server.addEventListener('error', cleanup);

    server.send(JSON.stringify({ t: 'hello', user: publicUser(user), rules: RULES }));
    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(user, ws, msg) {
    const room = () => this.rooms.roomOf(user.id);

    switch (msg.t) {
      case 'join': {
        const code = msg.code ? String(msg.code).toUpperCase().slice(0, 8) : null;
        const res = this.rooms.join(user, ws, code);
        if (res.error) {
          ws.send(JSON.stringify({ t: 'joinError', message: res.error }));
          return;
        }
        ws.send(JSON.stringify(res.room.snapshot()));
        res.room.pushState();
        return;
      }
      case 'leave': {
        this.rooms.leave(user.id);
        ws.send(JSON.stringify({ t: 'left' }));
        return;
      }
      case 'ready':
        room()?.setReady(user.id, msg.ready !== false);
        return;
      case 'noDraw':
        room()?.setNoDraw(user.id, !!msg.value);
        return;
      case 's0':
        room()?.strokeStart(user.id, msg);
        return;
      case 's+':
        room()?.strokeAppend(user.id, msg);
        return;
      case 'undo':
        room()?.undo(user.id);
        return;
      case 'clear':
        room()?.clearCanvas(user.id);
        return;
      case 'guess':
        // 念のためサーバー側でもひらがなに落としてから判定する
        room()?.guess(user.id, toHiraganaOnly(msg.text));
        return;
      case 'restart':
        room()?.restart(user.id);
        return;
      case 'recommend':
        room()?.recommend(user.id, Number(msg.drawingId), msg.comment);
        return;
      case 'ping':
        ws.send(JSON.stringify({ t: 'pong' }));
        return;
      default:
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws' || url.pathname.startsWith('/api/')) {
      const id = env.GAME.idFromName('main');
      return env.GAME.get(id).fetch(request);
    }
    // 静的アセット(assets バインディングが先に効くので、ここに来るのは未知のパスだけ)
    return env.ASSETS.fetch(request);
  },
};
