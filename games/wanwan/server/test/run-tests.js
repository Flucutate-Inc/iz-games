/** エンジン・バランス管理のヘッドレステスト(DBに触るものは一時DBを使用) */
process.env.WANWAN_DB = require('path').join(__dirname, 'test.db');
const fs = require('fs');
for (const f of ['test.db', 'test.db-wal', 'test.db-shm']) {
  try { fs.unlinkSync(require('path').join(__dirname, f)); } catch {}
}

const assert = require('assert');
require('../src/db').init(); // スキーマ+シード(Workers では DO 側で呼ぶ)
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

test('初期状態: ほね4・手札=デッキ全体(控え廃止)・施設HP', () => {
  const s = newBattle();
  assert.equal(s.players[0].bone, 4);
  assert.equal(s.players[0].hand.length, DECK6.length, 'デッキ全ペットが手札に並ぶ');
  assert.equal(s.players[0].reserve.length, 0, '控えは存在しない');
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

test('手札循環: 使用→個別CD→手札へ直接復帰(控え廃止)(HAND-01)', () => {
  const s = newBattle(DECK4, DECK6);
  const petId = s.players[0].hand[0];
  engine.spawn(s, 0, petId, 'top');
  assert.equal(s.players[0].hand.length, 3); // 出撃分だけ手札から抜ける
  assert.ok(s.players[0].cooldowns[petId] > 0);
  run(s, s.petsById[petId].rechargeSec + 0.2);
  assert.ok(s.players[0].hand.includes(petId), 'CD後に手札へ直接復帰');

  const s6 = newBattle(DECK6, DECK6);
  const p6 = s6.players[0].hand[0];
  engine.spawn(s6, 0, p6, 'top');
  assert.equal(s6.players[0].hand.length, 5, '控えからの補充は行われない');
  assert.equal(s6.players[0].reserve.length, 0, '控えは常に空');
  run(s6, s6.petsById[p6].rechargeSec + 0.2);
  assert.ok(s6.players[0].hand.includes(p6), '6体デッキでもCD後に手札へ直接復帰');
  assert.equal(s6.players[0].reserve.length, 0, 'CD後も控えには入らない');
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

// ── ガチャ抽選 ──
console.log('gacha tests:');
{
  const gacha = require('../src/gacha');
  const conf = snapshot.gacha;
  // 決定的な擬似乱数(テストの再現性のため)
  const seqRng = values => { let i = 0; return () => values[i++ % values.length]; };

  test('ガチャ設定が初期バランスに存在する', () => {
    assert.ok(conf.singleCost > 0 && conf.multiCount > 1 && conf.rarities.length > 0);
    for (const p of snapshot.pets) {
      assert.ok(conf.rarities.some(r => r.id === p.rarity), `${p.id} のレアリティが未定義`);
    }
  });

  test('コスト: 1回・多連のみ受け付ける', () => {
    assert.equal(gacha.costFor(conf, 1), conf.singleCost);
    assert.equal(gacha.costFor(conf, conf.multiCount), conf.multiCost);
    assert.equal(gacha.costFor(conf, 3), null);
  });

  test('排出率の合計は100%', () => {
    const total = gacha.rates(conf, snapshot.pets).reduce((a, r) => a + r.rate, 0);
    assert.ok(Math.abs(total - 100) < 0.2, `total=${total}`);
  });

  test('未所有が出れば NEW、所持済みなら重複としてコイン還元', () => {
    const all = snapshot.pets.map(p => p.id);
    const dup = gacha.draw({ gacha: conf, pets: snapshot.pets, owned: all, count: 5, rng: seqRng([0.1, 0.5]) });
    assert.equal(dup.newPetIds.length, 0);
    assert.ok(dup.results.every(r => r.duplicate));
    assert.equal(dup.refundCoins, dup.results.reduce((a, r) => a + r.coins, 0));
    assert.ok(dup.refundCoins > 0);

    const fresh = gacha.draw({ gacha: conf, pets: snapshot.pets, owned: [], count: 1, rng: seqRng([0.1, 0.5]) });
    assert.equal(fresh.results[0].duplicate, false);
    assert.equal(fresh.refundCoins, 0);
    assert.equal(fresh.newPetIds.length, 1);
  });

  test('同じ抽選内で同じペットが2回出たら2回目は重複', () => {
    // rng が常に同じ値 → 同じレアリティの同じ添字を引き続ける
    const r = gacha.draw({ gacha: conf, pets: snapshot.pets, owned: [], count: 3, rng: () => 0 });
    assert.equal(new Set(r.results.map(x => x.petId)).size, 1);
    assert.equal(r.newPetIds.length, 1);
    assert.equal(r.results.filter(x => x.duplicate).length, 2);
  });

  test(`${snapshot.gacha.multiCount}連は ${snapshot.gacha.multiGuaranteeRarity} 以上が1回以上でる`, () => {
    const minRank = gacha.rarityRank(conf, conf.multiGuaranteeRarity);
    for (let seed = 0; seed < 20; seed++) {
      // 常に最低レアリティを引く rng でも確定枠が働くこと
      const r = gacha.draw({ gacha: conf, pets: snapshot.pets, owned: [], count: conf.multiCount, rng: () => (seed % 19) / 20 });
      assert.ok(r.results.some(x => gacha.rarityRank(conf, x.rarity) >= minRank), `seed=${seed}`);
    }
  });

  test('未公開(released=false)のペットは抽選されない', () => {
    const pets = snapshot.pets.map(p => (p.id === 'great-dane-king' ? { ...p, released: false } : p));
    const pool = gacha.poolByRarity(conf, pets);
    assert.ok(!Object.values(pool).flat().includes('great-dane-king'));
  });

  test('バランス検証: gacha 欠落・不正レアリティを検出', () => {
    const balance = require('../src/balance');
    const noGacha = { ...snapshot, gacha: undefined };
    assert.ok(balance.validateSnapshot(noGacha).errors.some(e => e.includes('gacha')));
    const badRarity = { ...snapshot, pets: snapshot.pets.map((p, i) => (i === 0 ? { ...p, rarity: 'XX' } : p)) };
    assert.ok(balance.validateSnapshot(badRarity).errors.some(e => e.includes('rarity')));
    assert.equal(balance.validateSnapshot(snapshot).errors.length, 0);
  });
}

// ── アビリティ(カタログ+検証+エンジン実装) ──
console.log('ability tests:');
{
  const abilities = require('../src/abilities');
  const balance = require('../src/balance');

  test('カタログの型はすべてエンジンに実装がある', () => {
    const src = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'engine.js'), 'utf8');
    for (const a of abilities.ABILITIES) {
      assert.ok(src.includes(`'${a.type}'`), `engine.js に ${a.type} の実装がありません`);
    }
  });

  test('データのアビリティはすべてカタログに存在する', () => {
    for (const p of snapshot.pets) {
      assert.deepEqual(abilities.validateAbilities(p.id, p.abilities), [], `${p.id}`);
    }
  });

  test('未実装の型・範囲外・型違いを検出する', () => {
    assert.ok(abilities.validateAbilities('x', [{ type: 'nope' }])[0].includes('未実装'));
    assert.ok(abilities.validateAbilities('x', [{ type: 'firstStrikeMultiplier', amount: 999 }])[0].includes('範囲外'));
    assert.ok(abilities.validateAbilities('x', [{ type: 'firstStrikeMultiplier' }])[0].includes('数値'));
    assert.ok(abilities.validateAbilities('x', [{ type: 'auraAttackBuff', amount: 0.1, radius: 10, stacking: 'yes' }])[0].includes('true/false'));
  });

  test('既定値つきでアビリティを生成できる', () => {
    const ab = abilities.makeDefault('damageReduction');
    assert.equal(ab.trigger, 'onSpawn');
    assert.ok(ab.amount > 0 && ab.duration > 0);
    assert.deepEqual(abilities.validateAbilities('x', [ab]), []);
  });

  test('出撃時の被ダメージ軽減がエンジンで効く(ブルドッグ)', () => {
    const s = newBattle(DECK6, DECK6, 7);
    const pet = s.petsById.bulldog;
    const ab = pet.abilities.find(a => a.type === 'damageReduction');
    s.players[0].bone = 10;
    s.players[0].hand = ['bulldog', ...s.players[0].hand.filter(id => id !== 'bulldog')].slice(0, 4);
    assert.ok(engine.spawn(s, 0, 'bulldog', 'top').ok);
    run(s, pet.spawnDelay + 0.1);
    const unit = s.units.find(u => u.petId === 'bulldog');
    assert.ok(unit, 'ユニットが出撃していない');
    const cut = unit.buffs.find(b => b.kind === 'dmgcut');
    assert.ok(cut && Math.abs(cut.amount - ab.amount) < 1e-9, '軽減バフが付与されていない');
    // 軽減が切れたあとは消える
    run(s, ab.duration + 0.5);
    assert.ok(!s.units.find(u => u.petId === 'bulldog')?.buffs.some(b => b.kind === 'dmgcut'), '軽減が持続時間を超えて残っている');
  });

  test('スナップショット検証がアビリティ・初期ペット・回復量まで見る', () => {
    const bad = JSON.parse(JSON.stringify(snapshot));
    bad.pets[0].abilities = [{ type: 'unknownAbility' }];
    assert.ok(balance.validateSnapshot(bad).errors.some(e => e.includes('未実装')));

    const bad2 = JSON.parse(JSON.stringify(snapshot));
    bad2.progression.initialPets = ['not-a-pet', 'mame-shiba', 'bulldog', 'dachs-sniper'];
    assert.ok(balance.validateSnapshot(bad2).errors.some(e => e.includes('initialPets')));

    const bad3 = JSON.parse(JSON.stringify(snapshot));
    const healer = bad3.pets.find(p => p.attackType === 'heal');
    delete healer.healPower;
    assert.ok(balance.validateSnapshot(bad3).errors.some(e => e.includes('healPower')));
  });
}

// ── バージョンのライフサイクル(予約・削除・入出力) ──
console.log('version lifecycle tests:');
{
  const balance = require('../src/balance');
  const db = require('../src/db');
  const adminId = db.prepare("INSERT INTO users (name, pass_hash, salt) VALUES ('lifecycle', '', '') RETURNING id").get().id;

  test('予約 → 時刻経過で自動公開される', () => {
    const id = balance.createDraft(adminId, null, 'scheduled-test');
    balance.schedule(id, new Date(Date.now() + 1000).toISOString());
    assert.equal(balance.getVersion(id).status, 'scheduled');
    assert.deepEqual(balance.publishDue(Date.now()), [], '時刻前に公開されている');
    const published = balance.publishDue(Date.now() + 2000);
    assert.deepEqual(published, [id]);
    assert.equal(balance.getPublished().id, id);
    assert.equal(balance.getVersion(id).scheduled_at, null);
  });

  test('過去日時の予約と、予約の取り消し', () => {
    const id = balance.createDraft(adminId, null, 'cancel-test');
    assert.throws(() => balance.schedule(id, '2000-01-01T00:00:00Z'), /過去/);
    balance.schedule(id, new Date(Date.now() + 3600000).toISOString());
    balance.cancelSchedule(id);
    assert.equal(balance.getVersion(id).status, 'draft');
    assert.throws(() => balance.cancelSchedule(id), /予約されていません/);
  });

  test('下書きは削除でき、公開中の版は削除できない', () => {
    const id = balance.createDraft(adminId, null, 'delete-test');
    balance.deleteVersion(id);
    assert.equal(balance.getVersion(id), null);
    assert.throws(() => balance.deleteVersion(balance.getPublished().id), /削除できません/);
  });

  test('インポートは検証を通ったものだけ下書きになる', () => {
    const good = balance.importSnapshot(adminId, snapshot, 'imported');
    assert.ok(good.ok && balance.getVersion(good.id).status === 'draft');
    const bad = balance.importSnapshot(adminId, { pets: [] }, 'broken');
    assert.ok(!bad.ok && bad.errors.length > 0);
  });

  test('ラベル変更と、版一覧に作成者・予約が出る', () => {
    const id = balance.createDraft(adminId, null, '');
    balance.setLabel(id, 'ラベル変更');
    const row = balance.listVersions().find(v => v.id === id);
    assert.equal(row.label, 'ラベル変更');
    assert.equal(row.created_by_name, 'lifecycle');
    assert.ok('scheduled_at' in row);
  });
}

// ── 管理者の決まり方 ──
console.log('admin bootstrap tests:');
{
  const db = require('../src/db');
  const auth = require('../src/auth');
  const isAdmin = name => db.prepare('SELECT is_admin FROM users WHERE name = ?').get(name).is_admin;

  test('WANWAN_ADMIN_TOKEN 未設定なら最初の登録者が管理者(ローカル検証用)', () => {
    delete process.env.WANWAN_ADMIN_TOKEN;
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM decks').run();
    db.prepare('DELETE FROM user_pets').run();
    db.prepare('DELETE FROM users').run();
    auth.register('firstuser', 'password1');
    auth.register('seconduser', 'password1');
    assert.equal(isAdmin('firstuser'), 1);
    assert.equal(isAdmin('seconduser'), 0);
  });

  test('WANWAN_ADMIN_TOKEN 設定時はトークン一致の登録だけが管理者(公開URL向け)', () => {
    process.env.WANWAN_ADMIN_TOKEN = 'super-secret-token';
    auth.register('stranger1', 'password1');                      // トークンなし
    auth.register('stranger2', 'password1', 'wrong-token-value'); // 誤ったトークン(長さ違い)
    auth.register('stranger3', 'password1', 'super-secret-tokeN'); // 1文字違い(長さ同じ)
    auth.register('realowner', 'password1', 'super-secret-token');
    assert.equal(isAdmin('stranger1'), 0);
    assert.equal(isAdmin('stranger2'), 0);
    assert.equal(isAdmin('stranger3'), 0);
    assert.equal(isAdmin('realowner'), 1);
  });

  test('WANWAN_ADMIN_TOKEN 設定中は「最初の登録者」ルールが無効になる', () => {
    process.env.WANWAN_ADMIN_TOKEN = 'another-secret';
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM decks').run();
    db.prepare('DELETE FROM user_pets').run();
    db.prepare('DELETE FROM users').run();
    auth.register('firstcomer', 'password1'); // DBが空でもトークンなしなら管理者にならない
    assert.equal(isAdmin('firstcomer'), 0);
    delete process.env.WANWAN_ADMIN_TOKEN;
  });
}

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

  // 本番とステージングの両方のアプリから遊べるよう、受け入れプロジェクトは複数指定できる
  await atest('FIREBASE_PROJECT を複数指定すると両方受理する', async () => {
    process.env.FIREBASE_PROJECT = 'iz-app-6e1d5, iz-app-staging';
    delete require.cache[require.resolve('../src/firebase-auth')];
    const multi = require('../src/firebase-auth');
    assert.deepEqual(multi.ALLOWED_PROJECTS, ['iz-app-6e1d5', 'iz-app-staging']);

    const forProject = p => ({
      aud: p, iss: `https://securetoken.google.com/${p}`, exp: now + 3600, iat: now, sub: 'uid1',
    });
    assert.equal((await multi.verifyIdToken(makeToken(forProject('iz-app-6e1d5')), { certs })).sub, 'uid1');
    assert.equal((await multi.verifyIdToken(makeToken(forProject('iz-app-staging')), { certs })).sub, 'uid1');

    // 許可していないプロジェクトは拒否し、エラーに受け入れ一覧を含める(原因が分かるように)
    let message = '';
    try {
      await multi.verifyIdToken(makeToken(forProject('other-project')), { certs });
    } catch (e) {
      message = e.message;
    }
    assert.ok(/aud が不正/.test(message) && /iz-app-6e1d5/.test(message), message);

    delete process.env.FIREBASE_PROJECT;
    delete require.cache[require.resolve('../src/firebase-auth')];
  });

  // ── IZ課金レシート検証 ──
  console.log('iz-purchase tests:');
  process.env.WANWAN_RECEIPT_SECRET = 'test-secret';
  delete require.cache[require.resolve('../src/receipt')];
  const receipts = require('../src/receipt');

  // 現行形式: 署名対象に coins を含めない(交換レートはゲーム側の持ち物)
  const sign = (payload, secret = 'test-secret') => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const canonical = [payload.gameId, payload.uid, payload.izAmount, payload.nonce, payload.issuedAt].join('|');
    const sig = crypto.createHmac('sha256', secret).update(canonical).digest('base64url');
    return `${body}.${sig}`;
  };
  // 旧形式: IZ 側が算出した coins を含み、署名対象にも入っていた
  const signLegacy = (payload, secret = 'test-secret') => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const canonical = [payload.gameId, payload.uid, payload.izAmount, payload.coins, payload.nonce, payload.issuedAt].join('|');
    const sig = crypto.createHmac('sha256', secret).update(canonical).digest('base64url');
    return `${body}.${sig}`;
  };
  const goodReceipt = { gameId: 'wanwan', uid: 'uid1', izAmount: 10, nonce: 'n1', issuedAt: Date.now() };

  await atest('正しいレシートを受理する', () => {
    const r = receipts.verifyReceipt(sign(goodReceipt));
    assert.equal(r.izAmount, 10);
    assert.equal(r.uid, 'uid1');
  });
  await atest('署名を偽造したレシートを拒否', () => rejectsSync(() => receipts.verifyReceipt(sign(goodReceipt, 'wrong-secret'))));
  await atest('金額を改ざんしたレシートを拒否', () => {
    const token = sign(goodReceipt);
    const [body, sig] = token.split('.');
    const tampered = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    tampered.izAmount = 999999;
    const forged = `${Buffer.from(JSON.stringify(tampered), 'utf8').toString('base64url')}.${sig}`;
    rejectsSync(() => receipts.verifyReceipt(forged));
  });
  await atest('別ゲーム・期限切れを拒否', () => {
    rejectsSync(() => receipts.verifyReceipt(sign({ ...goodReceipt, gameId: 'coinflip' })));
    rejectsSync(() => receipts.verifyReceipt(sign({ ...goodReceipt, issuedAt: Date.now() - 20 * 60 * 1000 })));
  });

  // 交換レートはゲーム側の持ち物。レシートは「いくら IZ を消費したか」だけを伝える。
  await atest('付与額はゲーム側のレート(1 IZ = 1 コイン)で決まる', () => {
    assert.equal(receipts.COINS_PER_IZ, 1);
    assert.equal(receipts.coinsFor(10), 10);
    assert.equal(receipts.coinsFor(1000), 1000);
    assert.equal(receipts.coinsFor(receipts.verifyReceipt(sign(goodReceipt)).izAmount), 10);
    // 購入パックは付与コインから IZ 価格を逆算する
    const packs = receipts.COIN_PACKS.map(coins => ({ coins, iz: Math.ceil(coins / receipts.COINS_PER_IZ) }));
    assert.deepEqual(packs, [{ coins: 100, iz: 100 }, { coins: 500, iz: 500 }, { coins: 1000, iz: 1000 }]);
  });
  await atest('izAmount が 0 以下のレシートを拒否', () => {
    rejectsSync(() => receipts.verifyReceipt(sign({ ...goodReceipt, izAmount: 0 })));
    rejectsSync(() => receipts.verifyReceipt(sign({ ...goodReceipt, izAmount: -10 })));
  });

  // 形式の切り替え中(ゲーム側が先・IZ側がまだ旧形式)でも IZ だけ減る事故を起こさない。
  // IZ 側のデプロイ完了後、receipt.js の旧形式分岐ごとこのテストを消す。
  await atest('移行中は coins つきの旧形式レシートも受理する', () => {
    const legacy = { ...goodReceipt, coins: 100, nonce: 'legacy1' };
    const r = receipts.verifyReceipt(signLegacy(legacy));
    assert.equal(r.izAmount, 10);
    // 付与額は旧形式の coins(100) ではなく、ゲーム側のレート(10)で決まる
    assert.equal(receipts.coinsFor(r.izAmount), 10);
  });
  await atest('旧形式でも coins の改ざんは拒否する', () => {
    const legacy = { ...goodReceipt, coins: 100, nonce: 'legacy2' };
    const [body, sig] = signLegacy(legacy).split('.');
    const tampered = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    tampered.coins = 999999;
    rejectsSync(() => receipts.verifyReceipt(`${Buffer.from(JSON.stringify(tampered), 'utf8').toString('base64url')}.${sig}`));
    // coins を落として新形式に見せかけても、署名対象が変わるので通らない
    delete tampered.coins;
    rejectsSync(() => receipts.verifyReceipt(`${Buffer.from(JSON.stringify(tampered), 'utf8').toString('base64url')}.${sig}`));
  });

  // 鍵の入れ替え中は「IZ側は新鍵・ゲーム側は旧鍵」の隙間でIZだけ減る事故が起きるため、
  // 切り替え中は新旧どちらの署名も受け付けられるようにしてある
  await atest('鍵の入れ替え中は新旧どちらの署名も受理する', () => {
    // 途中で失敗しても後続テストへ影響しないよう、環境変数とモジュールキャッシュは
    // finally で必ず元に戻す
    const savedCurrent = process.env.WANWAN_RECEIPT_SECRET;
    const savedOld = process.env.WANWAN_RECEIPT_SECRET_OLD;
    const restoreEnv = (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    try {
      process.env.WANWAN_RECEIPT_SECRET = 'new-secret';
      process.env.WANWAN_RECEIPT_SECRET_OLD = 'test-secret';
      delete require.cache[require.resolve('../src/receipt')];
      const rotating = require('../src/receipt');

      assert.equal(rotating.verifyReceipt(sign(goodReceipt, 'new-secret')).izAmount, 10, '新鍵');
      assert.equal(rotating.verifyReceipt(sign(goodReceipt, 'test-secret')).izAmount, 10, '旧鍵');
      rejectsSync(() => rotating.verifyReceipt(sign(goodReceipt, 'unrelated-secret')));

      // 旧鍵を外すと旧鍵の署名は通らなくなる(入れ替え完了後)
      delete process.env.WANWAN_RECEIPT_SECRET_OLD;
      delete require.cache[require.resolve('../src/receipt')];
      const rotated = require('../src/receipt');
      assert.equal(rotated.verifyReceipt(sign(goodReceipt, 'new-secret')).izAmount, 10);
      rejectsSync(() => rotated.verifyReceipt(sign(goodReceipt, 'test-secret')));
    } finally {
      restoreEnv('WANWAN_RECEIPT_SECRET', savedCurrent);
      restoreEnv('WANWAN_RECEIPT_SECRET_OLD', savedOld);
      delete require.cache[require.resolve('../src/receipt')];
    }
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
