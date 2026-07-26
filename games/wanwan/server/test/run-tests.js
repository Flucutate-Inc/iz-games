/** エンジン・バランス管理のヘッドレステスト(DBに触るものは一時DBを使用) */
process.env.WANWAN_DB = require('path').join(__dirname, 'test.db');
const fs = require('fs');
for (const f of ['test.db', 'test.db-wal', 'test.db-shm']) {
  try { fs.unlinkSync(require('path').join(__dirname, f)); } catch {}
}

const assert = require('assert');
const engine = require('../src/engine');
const snapshot = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', '..', 'data', 'balance-initial.json'), 'utf8'));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

const DECK6 = ['mame-shiba', 'bulldog', 'chihuahua-assault', 'dachs-sniper', 'pomeranian-squad', 'husky-artillery'];
const DECK4 = ['mame-shiba', 'bulldog', 'dachs-sniper', 'pomeranian-squad'];

function newBattle(d1 = DECK6, d2 = DECK6, seed = 42) {
  return engine.createBattle({ snapshot, decks: [d1, d2], seed });
}

function run(state, seconds) {
  const dt = 0.05;
  for (let i = 0; i < seconds / dt; i++) {
    engine.tick(state, dt);
    if (state.phase === 'ended') break;
  }
}

console.log('engine tests:');

test('初期状態: ほね4・手札4・施設HP', () => {
  const s = newBattle();
  assert.equal(s.players[0].bone, 4);
  assert.equal(s.players[0].hand.length, 4);
  assert.equal(s.players[0].facilities.main.hp, 12000);
});

test('ほねが2.5秒に1回復し上限10で止まる', () => {
  const s = newBattle();
  run(s, 10);
  assert.ok(Math.abs(s.players[0].bone - 8) < 0.1, `bone=${s.players[0].bone}`);
  run(s, 30);
  assert.equal(s.players[0].bone, 10);
});

test('出撃: 手札消費・ほね消費・予告→ユニット生成', () => {
  const s = newBattle();
  const petId = s.players[0].hand[0];
  const cost = s.petsById[petId].cost;
  const r = engine.spawn(s, 0, petId, 'top');
  assert.ok(r.ok, r.error);
  assert.ok(!s.players[0].hand.includes(petId));
  assert.ok(Math.abs(s.players[0].bone - (4 - cost)) < 0.01);
  assert.equal(s.pendingSpawns.length, 1);
  run(s, 1.2);
  const expected = s.petsById[petId].spawnCount || 1;
  assert.equal(s.units.filter(u => u.owner === 0).length, expected);
});

test('検証: 手札外・ほね不足・不正レーンを拒否', () => {
  const s = newBattle();
  assert.ok(engine.spawn(s, 0, 'great-dane-king', 'top').error); // 編成外/手札外
  const heavy = s.players[0].hand.find(id => s.petsById[id].cost > 4);
  if (heavy) assert.ok(engine.spawn(s, 0, heavy, 'top').error); // ほね不足
  assert.ok(engine.spawn(s, 0, s.players[0].hand[0], 'middle').error);
});

test('手札循環: 使用→CD→控え末尾/4体デッキは直接手札へ(HAND-01)', () => {
  const s = newBattle(DECK4, DECK6);
  const petId = s.players[0].hand[0];
  engine.spawn(s, 0, petId, 'top');
  assert.equal(s.players[0].hand.length, 3); // 控えなし → 補充なし
  assert.ok(s.players[0].cooldowns[petId] > 0);
  run(s, s.petsById[petId].rechargeSec + 0.2);
  assert.ok(s.players[0].hand.includes(petId), '4体デッキはCD後に手札へ直接復帰');

  const s6 = newBattle(DECK6, DECK6);
  const p6 = s6.players[0].hand[0];
  engine.spawn(s6, 0, p6, 'top');
  assert.equal(s6.players[0].hand.length, 4, '控えから補充');
  run(s6, s6.petsById[p6].rechargeSec + 0.2);
  assert.ok(s6.players[0].reserve.includes(p6), '6体デッキはCD後に控え末尾へ');
});

test('戦闘: ユニット同士が交戦して死亡する', () => {
  const s = newBattle();
  engine.spawn(s, 0, 'mame-shiba', 'top');
  engine.spawn(s, 1, 'mame-shiba', 'top');
  run(s, 60);
  const deaths = s.units.filter(u => u.hp <= 0);
  const alive = s.units.filter(u => u.hp > 0);
  assert.ok(deaths.length >= 1 || alive.length <= 1, '交戦の結果が出る');
});

test('施設: レーンハウスが防衛攻撃し、放置レーンは削られる', () => {
  const s = newBattle();
  s.players[0].bone = 10;
  engine.spawn(s, 0, 'mame-shiba', 'top');
  run(s, 90);
  const lh = s.players[1].facilities.top;
  assert.ok(lh.hp < lh.maxHp || s.units.every(u => u.hp <= 0), 'レーンハウスに何か起きる');
});

test('メインハウス破壊で即時勝利(BATTLE-02)', () => {
  const s = newBattle(DECK4, DECK4); // 4体デッキなら手札に全ペットが入る
  s.players[1].facilities.main.hp = 1;
  s.players[1].facilities.top.destroyed = true;
  s.players[1].facilities.top.hp = 0;
  s.players[0].bone = 10;
  // ダックスナイパー(射程270)はメインハウス(射程250)をアウトレンジできる
  engine.spawn(s, 0, 'dachs-sniper', 'top');
  run(s, 60);
  assert.equal(s.phase, 'ended');
  assert.equal(s.result.result, 'p1');
});

test('延長: 180秒で overtime、ほね回復2倍', () => {
  const s = newBattle();
  run(s, 181);
  assert.equal(s.phase, 'overtime');
  s.players[0].bone = 0;
  run(s, 5);
  assert.ok(s.players[0].bone >= 3.5, `延長中は2.5/2=1.25秒に1: bone=${s.players[0].bone}`);
});

test('タイブレーク: レーンハウス破壊数 → 総ダメージ → 引き分け', () => {
  const s = newBattle();
  s.players[0].destroyedLaneHouses = 1;
  run(s, 245);
  assert.equal(s.phase, 'ended');
  assert.equal(s.result.result, 'p1');
  assert.equal(s.result.reason, 'tiebreak_lanehouses');

  const s2 = newBattle();
  s2.players[1].totalFacilityDamage = 500;
  run(s2, 245);
  assert.equal(s2.result.result, 'p2');
  assert.equal(s2.result.reason, 'tiebreak_damage');

  const s3 = newBattle();
  run(s3, 245);
  assert.equal(s3.result.result, 'draw');
});

test('降参で相手の勝ち', () => {
  const s = newBattle();
  engine.surrender(s, 0);
  assert.equal(s.result.result, 'p2');
});

test('ポメラニアン軍団は3体出撃し、それぞれ上限にカウント', () => {
  const s = newBattle();
  s.players[0].bone = 10;
  engine.spawn(s, 0, 'pomeranian-squad', 'top');
  run(s, 0.5);
  assert.equal(s.units.filter(u => u.owner === 0).length, 3);
});

test('うさぎ救護班が味方を回復する', () => {
  const deck = ['rabbit-medic', 'bulldog', 'mame-shiba', 'dachs-sniper'];
  const s = newBattle(deck, DECK6);
  s.players[0].bone = 10;
  engine.spawn(s, 0, 'bulldog', 'top');
  run(s, 2);
  const bull = s.units.find(u => u.petId === 'bulldog');
  bull.hp = 1000;
  engine.spawn(s, 0, 'rabbit-medic', 'top');
  run(s, 6);
  assert.ok(bull.hp > 1000, `回復される: hp=${bull.hp}`);
});

// ── バランス管理(一時DB) ──
console.log('balance tests:');
const balance = require('../src/balance');

test('published 版がシードされている', () => {
  const { id, snapshot: snap } = balance.getPublished();
  assert.ok(id >= 1);
  assert.equal(snap.pets.length, 16);
});

test('draft作成→編集→公開→ロールバック(ADMIN-02)', () => {
  const draftId = balance.createDraft(1, null, 'test');
  const v = balance.getVersion(draftId);
  assert.equal(v.status, 'draft');
  const snap = v.snapshot;
  snap.pets.find(p => p.id === 'mame-shiba').hp = 900;
  const res = balance.updateDraft(draftId, snap);
  assert.ok(res.ok, JSON.stringify(res.errors));
  const before = balance.getPublished().id;
  balance.publish(draftId);
  assert.equal(balance.getPublished().id, draftId);
  assert.equal(balance.getPublished().snapshot.pets.find(p => p.id === 'mame-shiba').hp, 900);
  const rb = balance.rollback(before, 1);
  assert.equal(balance.getPublished().id, rb.newId);
  assert.equal(balance.getPublished().snapshot.pets.find(p => p.id === 'mame-shiba').hp, 750, 'ロールバックで旧値へ');
});

test('バリデーション: 範囲外を拒否', () => {
  const draftId = balance.createDraft(1, null, 'invalid');
  const snap = balance.getVersion(draftId).snapshot;
  snap.pets[0].hp = -5;
  const res = balance.updateDraft(draftId, snap);
  assert.ok(!res.ok && res.errors.length > 0);
});

test('diff が変更点を返す', () => {
  const draftId = balance.createDraft(1, null, 'diff');
  const snap = balance.getVersion(draftId).snapshot;
  snap.pets.find(p => p.id === 'bulldog').hp = 3500;
  balance.updateDraft(draftId, snap);
  const changes = balance.diff(balance.getPublished().id, draftId);
  assert.ok(changes.some(c => c.path === 'pets.bulldog.hp' && c.to === 3500), JSON.stringify(changes));
});

test('試合内強化: ほね容量・回復速度が上がる', () => {
  const s = newBattle();
  s.players[0].bone = 10;
  const r = engine.upgrade(s, 0, 'boneCapacity');
  assert.ok(r.ok, r.error);
  assert.equal(engine.boneMax(s, 0), 10 + snapshot.upgrades.boneCapacity.increment, 'ほね上限が増える');
  const capCost = snapshot.upgrades.boneCapacity.baseCost;
  assert.ok(Math.abs(s.players[0].bone - (10 - capCost)) < 0.01, `コスト${capCost}を消費`);

  const s2 = newBattle();
  s2.players[0].bone = 10;
  engine.upgrade(s2, 0, 'boneSpeed');
  s2.players[0].bone = 0;
  const plain = newBattle();
  plain.players[0].bone = 0;
  run(s2, 5);
  run(plain, 5);
  assert.ok(s2.players[0].bone > plain.players[0].bone, '回復が速くなる');
});

test('試合内強化: ペットごとに強化され、そのペットだけHPが上がる', () => {
  const s = newBattle(DECK4, DECK4);
  s.players[0].bone = 20;
  assert.ok(engine.upgrade(s, 0, 'pets', 'mame-shiba').ok);
  s.players[0].bone = 20;
  engine.spawn(s, 0, 'mame-shiba', 'top');
  engine.spawn(s, 0, 'bulldog', 'bottom');
  run(s, 1.2);
  const shiba = s.units.find(x => x.petId === 'mame-shiba' && x.owner === 0);
  const bull = s.units.find(x => x.petId === 'bulldog' && x.owner === 0);
  const hpPerLevel = snapshot.upgrades.pets.hpPerLevel;
  assert.equal(shiba.maxHp, Math.round(750 * (1 + hpPerLevel)), `強化したペット: ${shiba.maxHp}`);
  assert.equal(bull.maxHp, 3200, '強化していないペットは据え置き');
  assert.equal(engine.upgradeLevel(s, 0, 'pets', 'bulldog'), 0);
});

test('ペット強化: 編成外・不明ペットを拒否し、コストはペットコストに比例', () => {
  const s = newBattle(DECK4, DECK4);
  s.players[0].bone = 50;
  assert.ok(engine.upgrade(s, 0, 'pets', 'great-dane-king').error, '編成外');
  assert.ok(engine.upgrade(s, 0, 'pets', 'nope').error, '不明');
  const cheap = engine.upgradeCost(s, 0, 'pets', 'mame-shiba'); // cost2
  const pricey = engine.upgradeCost(s, 0, 'pets', 'bulldog'); // cost4
  assert.ok(pricey > cheap, `${pricey} > ${cheap}`);
});

test('試合内強化: メインハウス強化でHP上限が増える', () => {
  const s = newBattle();
  s.players[0].bone = 10;
  const before = s.players[0].facilities.main.maxHp;
  assert.ok(engine.upgrade(s, 0, 'mainHouse').ok);
  assert.ok(s.players[0].facilities.main.maxHp > before);
  assert.equal(s.players[0].facilities.main.hp, s.players[0].facilities.main.maxHp);
});

test('試合内強化: ほね不足・上限レベル・不明キーを拒否', () => {
  const s = newBattle();
  s.players[0].bone = 0;
  assert.ok(engine.upgrade(s, 0, 'pets', 'mame-shiba').error, 'ほね不足');
  assert.ok(engine.upgrade(s, 0, 'unknown').error, '不明キー');
  const conf = snapshot.upgrades.boneCapacity;
  for (let i = 0; i < conf.maxLevel; i++) {
    s.players[0].bone = 100;
    assert.ok(engine.upgrade(s, 0, 'boneCapacity').ok, `Lv${i + 1}`);
  }
  s.players[0].bone = 100;
  assert.ok(engine.upgrade(s, 0, 'boneCapacity').error, '最大レベル');
  assert.equal(engine.upgradeCost(s, 0, 'boneCapacity'), null);
});

test('強化は試合ごとにリセットされる(永続育成差なし)', () => {
  const s = newBattle();
  s.players[0].bone = 10;
  engine.upgrade(s, 0, 'pets', 'mame-shiba');
  const fresh = newBattle();
  assert.deepEqual(fresh.players[0].upgrades.pets, {});
});

// ── Firebase ID トークン検証(IZ 自動ログイン用) ──
(async () => {
  console.log('firebase-auth tests:');
  const crypto = require('crypto');
  const { verifyIdToken } = require('../src/firebase-auth');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const certs = { k1: pubPem };

  const makeToken = (payload, key = privateKey, kid = 'k1') => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url');
    return `${h}.${p}.${sig}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const good = { aud: 'testproj', iss: 'https://securetoken.google.com/testproj', exp: now + 3600, iat: now, sub: 'uid123', name: 'テスト' };
  const opts = { certs, project: 'testproj' };

  async function atest(name, fn) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.error(`  ✗ ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  const rejects = async p => {
    try { await p; } catch { return; }
    throw new Error('拒否されるべきトークンが通りました');
  };

  await atest('正しいトークンを受理し sub を返す', async () => {
    const payload = await verifyIdToken(makeToken(good), opts);
    assert.equal(payload.sub, 'uid123');
  });
  await atest('別鍵で署名されたトークンを拒否', () => rejects(verifyIdToken(makeToken(good, otherKey), opts)));
  await atest('aud 不一致を拒否', () => rejects(verifyIdToken(makeToken({ ...good, aud: 'evil' }), opts)));
  await atest('iss 不一致を拒否', () => rejects(verifyIdToken(makeToken({ ...good, iss: 'https://evil.example' }), opts)));
  await atest('期限切れを拒否', () => rejects(verifyIdToken(makeToken({ ...good, exp: now - 10 }), opts)));
  await atest('sub 欠落を拒否', () => rejects(verifyIdToken(makeToken({ ...good, sub: '' }), opts)));

  // ── IZ課金レシート検証 ──
  console.log('iz-purchase tests:');
  process.env.WANWAN_RECEIPT_SECRET = 'test-secret';
  delete require.cache[require.resolve('../src/receipt')];
  const receipts = require('../src/receipt');

  const sign = (payload, secret = 'test-secret') => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const canonical = [payload.gameId, payload.uid, payload.izAmount, payload.coins, payload.nonce, payload.issuedAt].join('|');
    const sig = crypto.createHmac('sha256', secret).update(canonical).digest('base64url');
    return `${body}.${sig}`;
  };
  const goodReceipt = { gameId: 'wanwan', uid: 'uid1', izAmount: 10, coins: 100, nonce: 'n1', issuedAt: Date.now() };

  await atest('正しいレシートを受理する', () => {
    const r = receipts.verifyReceipt(sign(goodReceipt));
    assert.equal(r.coins, 100);
    assert.equal(r.uid, 'uid1');
  });
  await atest('署名を偽造したレシートを拒否', () => rejectsSync(() => receipts.verifyReceipt(sign(goodReceipt, 'wrong-secret'))));
  await atest('金額を改ざんしたレシートを拒否', () => {
    const token = sign(goodReceipt);
    const [body, sig] = token.split('.');
    const tampered = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    tampered.coins = 999999;
    const forged = `${Buffer.from(JSON.stringify(tampered), 'utf8').toString('base64url')}.${sig}`;
    rejectsSync(() => receipts.verifyReceipt(forged));
  });
  await atest('別ゲーム・期限切れを拒否', () => {
    rejectsSync(() => receipts.verifyReceipt(sign({ ...goodReceipt, gameId: 'coinflip' })));
    rejectsSync(() => receipts.verifyReceipt(sign({ ...goodReceipt, issuedAt: Date.now() - 20 * 60 * 1000 })));
  });

  console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
})();

function rejectsSync(fn) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error('拒否されるべきレシートが通りました');
}
