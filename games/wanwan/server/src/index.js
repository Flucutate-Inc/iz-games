/** わんわん大戦争 サーバー: HTTP(API+クライアント配信) + WebSocket 対戦 */
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

require('./db'); // スキーマ+シード
const api = require('./api');
const admin = require('./admin');
const balance = require('./balance');
const { userByToken } = require('./auth');
const mm = require('./matchmaker');

const PORT = process.env.PORT || 8787;

// 公開予約(scheduled)の自動実行。進行中の試合は開始時の版のまま続く(VERSION-01)
const SCHEDULE_CHECK_MS = 30000;
setInterval(() => {
  for (const id of balance.publishDue()) {
    console.log(`[balance] 予約公開しました: 版#${id}`);
  }
}, SCHEDULE_CHECK_MS).unref();

const app = express();
app.use(express.json({ limit: '2mb' }));

// ヘルスチェック(Cloud Run 等の起動プローブ用)。DBに触れて実際に応答できるか見る
app.get('/healthz', (req, res) => {
  try {
    res.json({ ok: true, balanceVersionId: balance.getPublished().id, uptimeSec: Math.round(process.uptime()) });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});
app.use('/api/admin', admin);
app.use('/api', api);
app.use('/assets', express.static(path.join(__dirname, '..', '..', 'assets')));
// IZ ゲームブリッジ SDK(リポジトリ共通のものをそのまま配信)
app.use('/sdk', express.static(path.join(__dirname, '..', '..', '..', '..', 'sdk')));
app.use(express.static(path.join(__dirname, '..', 'public')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', ws => {
  let user = null;

  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return ws.send(JSON.stringify({ type: 'error', error: '不正なメッセージです' }));
    }

    // 最初に認証(セッショントークンを再検証: 設計書 6.1)
    if (msg.type === 'auth') {
      user = userByToken(msg.token);
      if (!user) {
        ws.send(JSON.stringify({ type: 'error', error: '認証に失敗しました' }));
        return ws.close();
      }
      ws.send(JSON.stringify({ type: 'auth_ok', name: user.name }));
      // 対戦中なら再接続(NET-01)
      const room = mm.roomOf(user.id);
      if (room) room.handleReconnect(user.id, ws);
      return;
    }
    if (!user) return ws.send(JSON.stringify({ type: 'error', error: '先に認証してください' }));

    const room = mm.roomOf(user.id);
    switch (msg.type) {
      case 'queue': {
        const r = mm.joinQueue(user, ws);
        ws.send(JSON.stringify(r.error ? { type: 'error', error: r.error } : { type: 'queue_status', queued: true }));
        break;
      }
      case 'queue_cancel':
        mm.leaveQueue(user.id);
        ws.send(JSON.stringify({ type: 'queue_status', queued: false }));
        break;
      case 'room_create': {
        const r = mm.createRoomCode(user, ws);
        ws.send(JSON.stringify(r.error ? { type: 'error', error: r.error } : { type: 'room_created', code: r.code }));
        break;
      }
      case 'room_join': {
        const r = mm.joinRoomCode(user, ws, String(msg.code || ''));
        if (r.error) ws.send(JSON.stringify({ type: 'error', error: r.error }));
        break;
      }
      case 'practice': {
        const r = mm.startPractice(user, ws);
        if (r.error) ws.send(JSON.stringify({ type: 'error', error: r.error }));
        break;
      }
      case 'spawn':
      case 'upgrade':
      case 'surrender':
        if (room) room.handleOp(user.id, msg);
        else ws.send(JSON.stringify({ type: 'error', error: '対戦中ではありません' }));
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
        break;
      default:
        ws.send(JSON.stringify({ type: 'error', error: `不明なメッセージ: ${msg.type}` }));
    }
  });

  ws.on('close', () => {
    if (!user) return;
    mm.leaveQueue(user.id);
    const room = mm.roomOf(user.id);
    if (room) room.handleDisconnect(user.id);
  });
});

server.listen(PORT, () => {
  console.log(`わんわん大戦争サーバー起動: http://localhost:${PORT} (管理画面: /admin.html)`);
});
