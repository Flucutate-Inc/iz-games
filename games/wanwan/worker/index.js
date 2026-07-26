/**
 * Cloudflare Workers エントリ + Durable Object 本体。
 *
 * 構成:
 *   Worker  … 静的アセット(ゲーム/管理画面/素材/SDK)を配信し、/api と /ws だけ DO へ渡す
 *   GameServer(DO) … サーバー本体。SQLite(DO storage) + 対戦ルーム(メモリ) + WebSocket
 *
 * DO は1個だけ(名前 "main")使う。対戦ルームはプロセスのメモリ上にあり、
 * SQLite も単一なので、Cloud Run 版の「max-instances=1」と同じ前提を保つ。
 *
 * サーバー側のコード(src/*)は wrangler の alias 経由で無改修のまま動く:
 *   better-sqlite3 → worker/sql-do.js   (DO SQLite アダプタ)
 *   express        → worker/express-shim.js
 *   fs             → worker/fs-shim.js  (初期バランスJSONのみ)
 */
// シムは CommonJS なので default インポートで受け取る
import sqlDo from './sql-do.js';
import expressShim from './express-shim.js';

const { attachSql } = sqlDo;
const { dispatch } = expressShim;

// src/* は alias 済みモジュールを取り込むため、DO 生成後に使う(読み込み自体は副作用なし)
// src/* は CommonJS なので default インポートで module.exports を受け取る
import db from '../server/src/db.js';
import apiRouter from '../server/src/api.js';
import adminRouter from '../server/src/admin.js';
import auth from '../server/src/auth.js';
import balance from '../server/src/balance.js';
import mm from '../server/src/matchmaker.js';

const SCHEDULE_CHECK_MS = 30000;

export class GameServer {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // 環境変数をサーバーコードから見えるようにする(process.env 互換)
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === 'string') process.env[k] = v;
    }
    // SQLite を接続してからスキーマ作成・シードを行う
    attachSql(ctx.storage.sql, cb => ctx.storage.transactionSync(cb));
    db.init();
    this.scheduleTimer = null;
  }

  /** 予約公開の確認(WS接続中は setInterval、それ以外は起動時に1回) */
  runScheduledPublish() {
    try {
      for (const id of balance.publishDue()) console.log(`[balance] 予約公開しました: 版#${id}`);
    } catch (e) {
      console.error('[balance] 予約公開の確認に失敗:', e.message);
    }
  }

  ensureScheduleTimer() {
    if (this.scheduleTimer) return;
    this.scheduleTimer = setInterval(() => this.runScheduledPublish(), SCHEDULE_CHECK_MS);
  }

  async fetch(request) {
    const url = new URL(request.url);
    this.runScheduledPublish(); // 待機中に到来した予約をここで拾う

    if (url.pathname === '/ws') return this.handleWebSocket(request);

    if (url.pathname === '/healthz') {
      return Response.json({
        ok: true,
        balanceVersionId: balance.getPublished().id,
        runtime: 'cloudflare-durable-object',
      });
    }

    // JSON ボディを読んでから express 互換ルーターへ渡す
    let body = {};
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const text = await request.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          return Response.json({ error: '不正なJSONです' }, { status: 400 });
        }
      }
    }

    const router = url.pathname.startsWith('/api/admin') ? adminRouter : apiRouter;
    const prefix = url.pathname.startsWith('/api/admin') ? '/api/admin' : '/api';
    // ボディは読み終えているので、メソッドとヘッダーだけを引き継いだ Request を作る
    // (読み終えた Request をそのまま渡すとストリームを二重に読むことになる)
    const inner = new Request(new URL(url.pathname.slice(prefix.length) + url.search, url.origin), {
      method: request.method,
      headers: request.headers,
    });
    return dispatch(router, inner, body);
  }

  /** WebSocket: Node 版 index.js のメッセージ処理をそのまま移植 */
  handleWebSocket(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket が必要です', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.ensureScheduleTimer();

    let user = null;
    const send = obj => {
      try { server.send(JSON.stringify(obj)); } catch { /* 切断済み */ }
    };

    server.addEventListener('message', ev => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
      } catch {
        return send({ type: 'error', error: '不正なメッセージです' });
      }

      // 最初に認証(セッショントークンを再検証: 設計書 6.1)
      if (msg.type === 'auth') {
        user = auth.userByToken(msg.token);
        if (!user) {
          send({ type: 'error', error: '認証に失敗しました' });
          return server.close(1008, '認証に失敗しました');
        }
        send({ type: 'auth_ok', name: user.name });
        const room = mm.roomOf(user.id);
        if (room) room.handleReconnect(user.id, server); // 再接続(NET-01)
        return;
      }
      if (!user) return send({ type: 'error', error: '先に認証してください' });

      const room = mm.roomOf(user.id);
      switch (msg.type) {
        case 'queue': {
          const r = mm.joinQueue(user, server);
          send(r.error ? { type: 'error', error: r.error } : { type: 'queue_status', queued: true });
          break;
        }
        case 'queue_cancel':
          mm.leaveQueue(user.id);
          send({ type: 'queue_status', queued: false });
          break;
        case 'room_create': {
          const r = mm.createRoomCode(user, server);
          send(r.error ? { type: 'error', error: r.error } : { type: 'room_created', code: r.code });
          break;
        }
        case 'room_join': {
          const r = mm.joinRoomCode(user, server, String(msg.code || ''));
          if (r.error) send({ type: 'error', error: r.error });
          break;
        }
        case 'practice': {
          const r = mm.startPractice(user, server);
          if (r.error) send({ type: 'error', error: r.error });
          break;
        }
        case 'spawn':
        case 'upgrade':
        case 'surrender':
          if (room) room.handleOp(user.id, msg);
          else send({ type: 'error', error: '対戦中ではありません' });
          break;
        case 'ping':
          send({ type: 'pong', t: msg.t });
          break;
        default:
          send({ type: 'error', error: `不明なメッセージ: ${msg.type}` });
      }
    });

    const onClose = () => {
      if (!user) return;
      mm.leaveQueue(user.id);
      const room = mm.roomOf(user.id);
      if (room) room.handleDisconnect(user.id);
    };
    server.addEventListener('close', onClose);
    server.addEventListener('error', onClose);

    return new Response(null, { status: 101, webSocket: client });
  }
}

/** すべてのリクエストは単一の DO("main")へ集約する */
function gameStub(env) {
  return env.GAME_SERVER.get(env.GAME_SERVER.idFromName('main'));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws' || url.pathname === '/healthz' || url.pathname.startsWith('/api/')) {
      return gameStub(env).fetch(request);
    }
    // それ以外は静的アセット(ゲーム本体・管理画面・素材・SDK)
    return env.ASSETS.fetch(request);
  },
};
