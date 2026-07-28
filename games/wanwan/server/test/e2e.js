/**
 * E2E: 実サーバー(localhost:8787)に対して受入基準を検証する。
 * 事前に `npm start` でサーバーを起動しておくこと。
 * アカウントはテスト用(e2e-xxx)を毎回ユニーク名で作成する。
 */
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:8787';
const WSBASE = BASE.replace('http', 'ws') + '/ws';
const uniq = Math.random().toString(36).slice(2, 7);

let passed = 0;
let failed = 0;
function ok(cond, name, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
}

async function api(path, { token, body, method } = {}) {
  const res = await fetch(BASE + '/api' + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

/** WSクライアント(受信メッセージを溜めて待てる) */
class Client {
  constructor(token) {
    this.token = token;
    this.msgs = [];
    this.seq = 0;
  }
  connect() {
    return new Promise(resolve => {
      this.ws = new WebSocket(WSBASE);
      this.ws.on('message', raw => this.msgs.push(JSON.parse(raw)));
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ type: 'auth', token: this.token }));
        resolve();
      });
    });
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  op(msg) { this.send({ ...msg, seq: ++this.seq }); }
  async wait(type, timeoutMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const i = this.msgs.findIndex(m => m.type === type);
      if (i >= 0) return this.msgs.splice(i, 1)[0];
      await new Promise(r => setTimeout(r, 40));
    }
    throw new Error(`timeout waiting ${type}`);
  }
  drain(type) {
    const out = this.msgs.filter(m => m.type === type);
    this.msgs = this.msgs.filter(m => m.type !== type);
    return out;
  }
  close() { this.ws.close(); }
}

(async () => {
  console.log('E2E tests:');

  // ACC-01: 登録で初期4体+初期デッキ
  const u1 = await api('/register', { body: { name: `e2eA${uniq}`, password: 'pass123' } });
  const u2 = await api('/register', { body: { name: `e2eB${uniq}`, password: 'pass123' } });
  ok(u1.token && u2.token, '登録できる');
  const pets1 = await api('/pets', { token: u1.token });
  ok(pets1.pets.filter(p => p.owned).length === 4, 'ACC-01: 初期4体が付与される');
  const decks1 = await api('/decks', { token: u1.token });
  ok(decks1.decks.length === 1 && decks1.decks[0].selected && decks1.decks[0].pets.length === 4, 'ACC-01: 初期デッキが選択済み');

  // DECK-01: 不正デッキ拒否
  const bad1 = await api('/decks', { token: u1.token, body: { pets: ['mame-shiba', 'mame-shiba', 'bulldog', 'dachs-sniper'] } });
  ok(bad1.status === 400, 'DECK-01: 重複を拒否');
  const bad2 = await api('/decks', { token: u1.token, body: { pets: ['mame-shiba', 'bulldog', 'great-dane-king', 'dachs-sniper'] } });
  ok(bad2.status === 403, 'DECK-01: 未所有を拒否');
  const bad3 = await api('/decks', { token: u1.token, body: { pets: ['mame-shiba', 'bulldog'] } });
  ok(bad3.status === 400, 'DECK-01: 4体未満を拒否');

  // MATCH-01: ルームコードで2アカウントが同一試合へ
  const c1 = new Client(u1.token);
  const c2 = new Client(u2.token);
  await c1.connect();
  await c2.connect();
  await c1.wait('auth_ok');
  await c2.wait('auth_ok');
  c1.send({ type: 'room_create' });
  const room = await c1.wait('room_created');
  ok(/^\d{6}$/.test(room.code), 'ルームコードが発行される');
  c2.send({ type: 'room_join', code: room.code });
  const ms1 = await c1.wait('match_start');
  const ms2 = await c2.wait('match_start');
  ok(ms1.matchId === ms2.matchId, 'MATCH-01: 同一試合に参加');
  ok(ms1.side !== ms2.side, '両者に異なるサイドが割り当てられる');
  ok(ms1.balanceVersionId >= 1, 'バランス版IDが固定される');
  const matchId = ms1.matchId;
  const pinnedVersion = ms1.balanceVersionId;

  // VERSION-01: 試合中に新版を公開しても試合は旧版のまま
  const admin = await api('/login', { body: { name: process.env.ADMIN_NAME || 'admin', password: process.env.ADMIN_PASS || 'admin123' } });
  let adminOk = !!admin.token;
  if (adminOk) {
    const draft = await api('/admin/versions/draft', { token: admin.token, body: { label: 'e2e-mid-match' } });
    const vd = await api(`/admin/versions/${draft.id}`, { token: admin.token });
    vd.snapshot.pets.find(p => p.id === 'mame-shiba').hp += 1;
    await api(`/admin/versions/${draft.id}`, { token: admin.token, method: 'PUT', body: { snapshot: vd.snapshot } });
    const pub = await api(`/admin/versions/${draft.id}/publish`, { token: admin.token, body: { reason: 'e2e' } });
    ok(pub.ok, 'ADMIN-02: 試合中に新版を公開できる');
    const snap1 = await c1.wait('snapshot', 4000);
    ok(snap1.balanceVersionId === pinnedVersion, 'VERSION-01: 進行中試合は開始時の版を維持', `pinned=${pinnedVersion} got=${snap1.balanceVersionId}`);
  } else {
    console.log('  - admin アカウント未作成のため VERSION-01 は後続の管理E2Eで検証');
  }

  // BATTLE-01 / NET-02: 出撃と不正操作拒否
  const state1 = (await c1.wait('state')).state;
  const petInHand = state1.hand[0];
  c1.op({ type: 'spawn', petId: petInHand, lane: 'top' });
  const acc = await c1.wait('op_accepted');
  ok(!!acc, 'BATTLE-01: 出撃が受理される');
  c1.op({ type: 'spawn', petId: 'great-dane-king', lane: 'top' });
  const rej1 = await c1.wait('op_rejected');
  ok(!!rej1, 'NET-02: 編成外ペットの出撃を拒否');
  c1.send({ type: 'spawn', petId: petInHand, lane: 'top', seq: 1 }); // 使用済み連番
  const rej2 = await c1.wait('op_rejected');
  ok(rej2.error.includes('連番'), 'NET-02: 重複連番を拒否');

  // スポーンイベントが両者へ配信される
  const sawSpawn2 = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      if (c2.drain('event').some(e => e.ev && ['spawn', 'spawn_pending'].includes(e.ev.type))) return true;
      await new Promise(r => setTimeout(r, 60));
    }
    return false;
  })();
  ok(sawSpawn2, '出撃が相手クライアントにも同期される');

  // NET-01: 切断→再接続で完全スナップショット復帰
  c2.close();
  await new Promise(r => setTimeout(r, 800));
  const c2b = new Client(u2.token);
  await c2b.connect();
  await c2b.wait('auth_ok');
  const resnap = await c2b.wait('match_start', 5000);
  ok(resnap.reconnected === true && resnap.matchId === matchId, 'NET-01: 再接続で試合へ復帰');
  ok(Array.isArray(resnap.state.units) && typeof resnap.state.bone === 'number', 'NET-01: 完全スナップショットを受領');

  // 降参 → 勝敗確定 → REWARD-01
  c2b.op({ type: 'surrender' });
  const end1 = await c1.wait('match_end', 6000);
  const end2 = await c2b.wait('match_end', 6000);
  ok(end1.youWon === true && end2.youWon === false, '降参で勝敗が確定する');
  ok(end1.rewards && end1.rewards.xp > 0 && end2.rewards && end2.rewards.xp > 0, 'REWARD-01: 双方に報酬(敗者にも)');
  ok(end1.rewards.ratingAfter > end1.rewards.ratingBefore, '勝者のレートが上がる');

  const me1 = await api('/me', { token: u1.token });
  ok(me1.user.wins === 1 && me1.user.xp === end1.rewards.xp, 'REWARD-01: 戦績・XPが一度だけ反映');

  const hist = await api('/history', { token: u1.token });
  ok(hist.history.length === 1 && hist.history[0].result === 'win', 'LOG-01: 対戦履歴に記録');
  const ev = await api(`/history/${matchId}/events`, { token: u1.token });
  ok(ev.events.some(e => e.type === 'surrender') && ev.balanceVersionId === pinnedVersion, 'LOG-01: イベント+バランス版を確認可能');

  c1.close();
  c2b.close();

  // IZ課金: 買えないときの理由を区別して返す(クライアントの案内文が変わるため)。
  // 表示名+パスワードで登録したユーザーは firebase_uid を持たない
  const pstatus = await api('/purchase/status', { token: u1.token });
  ok(pstatus.enabled === false, 'PURCHASE: IZアカウント以外では購入できない');
  ok(
    pstatus.reason === (process.env.WANWAN_RECEIPT_SECRET ? 'not_iz_account' : 'unavailable'),
    `PURCHASE: 買えない理由を返す(${pstatus.reason})`,
  );
  ok(pstatus.coinsPerIz === 1, 'PURCHASE: 交換レートは 1 IZ = 1 コイン');
  ok(
    Array.isArray(pstatus.packs) && pstatus.packs.every(p => p.iz === p.coins),
    'PURCHASE: 購入パックの IZ 価格はレートから逆算される',
  );

  // GACHA-01: 解放APIは廃止され、ペット入手はガチャのみ
  const removed = await api('/pets/great-dane-king/unlock', { token: u1.token, body: {} });
  ok(removed.status === 404, 'GACHA-01: 解放API(/pets/:id/unlock)は存在しない');

  const g = await api('/gacha', { token: u1.token });
  const rateSum = g.rarities.reduce((a, r) => a + r.rate, 0);
  ok(g.singleCost > 0 && Math.abs(rateSum - 100) < 0.2, 'GACHA-01: コストと排出率(合計100%)を取得できる');

  const beforeCoins = (await api('/me', { token: u1.token })).user.coins;
  const poor = await api('/gacha/draw', { token: u1.token, body: { count: g.multiCount } });
  ok(poor.status === 402, 'GACHA-01: コイン不足なら引けない');
  ok((await api('/gacha/draw', { token: u1.token, body: { count: 3 } })).status === 400, 'GACHA-01: 不正な回数を拒否');

  if (beforeCoins < g.singleCost) {
    // 公開中のバランス版では新規アカウントが単発を引けない設定になっている
    console.log(`  - GACHA-01: 抽選の検証はスキップ(所持${beforeCoins} < 単発${g.singleCost})`);
  } else {
    const ownedBefore = (await api('/pets', { token: u1.token })).pets.filter(p => p.owned).length;
    const draw = await api('/gacha/draw', { token: u1.token, body: { count: 1 } });
    ok(draw.results && draw.results.length === 1 && draw.spent === g.singleCost, 'GACHA-01: サーバーが抽選しコインを消費する');
    const r = draw.results[0];
    ok(draw.user.coins === beforeCoins - g.singleCost + draw.refunded, 'GACHA-01: コイン増減が結果と一致');
    const ownedAfter = (await api('/pets', { token: u1.token })).pets.filter(p => p.owned).length;
    ok(ownedAfter === ownedBefore + (r.duplicate ? 0 : 1), 'GACHA-01: 新規は所持に加わり、重複は増えない');
    const gh = await api('/gacha/history', { token: u1.token });
    ok(gh.history.length >= 1 && gh.history[0].petId === r.petId, 'LOG-01: ガチャ履歴に記録される');
  }

  console.log(`\n${passed} passed / ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('E2E 異常終了:', e);
  process.exit(1);
});
