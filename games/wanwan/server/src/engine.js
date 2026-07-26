/**
 * サーバー権威の戦闘エンジン(純粋シミュレーション、I/Oなし)。
 * すべての数値はマッチ開始時に固定されたバランススナップショットから取る。
 *
 * フィールドは1レーン=1次元(x: 0〜1000)。P1は左(+x方向)、P2は右(-x方向)。
 *   P1メイン x=0 / P1レーンハウス x=100 / P2レーンハウス x=900 / P2メイン x=1000
 * メインハウスは「そのレーンの敵レーンハウス破壊後」に攻撃対象になる。
 */

const LANE_LEN = 1000;
const LANES = ['top', 'bottom'];
const FACILITY_X = { laneHouse: [100, 900], main: [0, 1000] };
const SPAWN_X = [140, 860];
const KB_DISTANCE = 40;
const KB_STUN = 0.35;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createBattle({ snapshot, decks, seed }) {
  const petsById = Object.fromEntries(snapshot.pets.map(p => [p.id, p]));
  const rng = mulberry32(seed);
  const rules = snapshot.rules;

  const players = decks.map(deck => {
    const order = [...deck];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const hand = order.slice(0, rules.hand.size);
    const reserve = order.slice(rules.hand.size);
    return {
      deck: [...deck],
      hand,
      reserve,
      cooldowns: {}, // petId -> remainSec
      bone: rules.bone.start,
      facilities: {
        top: { kind: 'laneHouse', hp: snapshot.facilities.laneHouse.hp, maxHp: snapshot.facilities.laneHouse.hp, attackCd: 0, destroyed: false },
        bottom: { kind: 'laneHouse', hp: snapshot.facilities.laneHouse.hp, maxHp: snapshot.facilities.laneHouse.hp, attackCd: 0, destroyed: false },
        main: { kind: 'mainHouse', hp: snapshot.facilities.mainHouse.hp, maxHp: snapshot.facilities.mainHouse.hp, attackCd: 0, destroyed: false },
      },
      points: 0,
      totalFacilityDamage: 0, // 与えた施設ダメージ(タイブレーク用)
      destroyedLaneHouses: 0,
      surrendered: false,
      petDamage: {}, // petId -> {damage, facilityDamage, kills, spawns}
      // 試合内強化(働きネコ相当)。試合ごとにリセットされるため永続的な育成差は生じない。
      // ペット強化はペットごと(petId -> level)に持つ。
      upgrades: { boneCapacity: 0, boneSpeed: 0, mainHouse: 0, pets: {} },
    };
  });

  return {
    snapshot,
    petsById,
    rules,
    t: 0,
    phase: 'normal', // normal | overtime | ended
    players,
    units: [],
    pendingSpawns: [],
    nextUnitId: 1,
    events: [],
    result: null, // {result:'p1'|'p2'|'draw', reason}
  };
}

function emit(state, type, data) {
  state.events.push({ t: Math.round(state.t * 100) / 100, type, data });
}

function petStat(state, side, petId) {
  const p = state.players[side];
  if (!p.petDamage[petId]) p.petDamage[petId] = { damage: 0, facilityDamage: 0, kills: 0, spawns: 0 };
  return p.petDamage[petId];
}

// ─── 試合内強化(ほね消費) ─────────────────────────────────────

const UPGRADE_KEYS = ['boneCapacity', 'boneSpeed', 'pets', 'mainHouse'];

/** 現在の強化レベル(pets は petId 指定) */
function upgradeLevel(state, side, key, petId) {
  const up = state.players[side].upgrades;
  return key === 'pets' ? (up.pets[petId] || 0) : up[key];
}

/**
 * 次のレベルに必要なほね(未定義や上限到達なら null)。
 * ペット強化はペットごとに独立し、コストはそのペットのコストに比例させる。
 */
function upgradeCost(state, side, key, petId) {
  const conf = state.snapshot.upgrades?.[key];
  if (!conf) return null;
  if (key === 'pets' && !state.petsById[petId]) return null;
  const level = upgradeLevel(state, side, key, petId);
  if (level >= conf.maxLevel) return null;
  const base = conf.baseCost + conf.costStep * level;
  if (key !== 'pets') return base;
  // 低コストペットは安く、高コストペットは高く(コスト4を基準)
  return Math.max(1, Math.round(base * (state.petsById[petId].cost / 4)));
}

function boneMax(state, side) {
  const conf = state.snapshot.upgrades?.boneCapacity;
  const level = state.players[side].upgrades.boneCapacity;
  return state.rules.bone.max + (conf ? conf.increment * level : 0);
}

function boneRegenPerSec(state, side) {
  const conf = state.snapshot.upgrades?.boneSpeed;
  const level = state.players[side].upgrades.boneSpeed;
  const speedup = conf ? 1 + conf.speedupPerLevel * level : 1;
  return speedup / state.rules.bone.regenSec;
}

function petUpgradeMult(state, side, petId, kind) {
  const conf = state.snapshot.upgrades?.pets;
  if (!conf) return 1;
  const level = state.players[side].upgrades.pets[petId] || 0;
  return 1 + (kind === 'hp' ? conf.hpPerLevel : conf.attackPerLevel) * level;
}

/** 現在の強化効果(UI表示用) */
function upgradeEffects(state, side) {
  const conf = state.snapshot.upgrades || {};
  const up = state.players[side].upgrades;
  return {
    boneCapacity: boneMax(state, side),
    // 「ほね1個あたり何秒」で表示するほうが体感と一致する
    boneSpeedSec: Math.round((1 / boneRegenPerSec(state, side)) * 100) / 100,
    petPercent: Math.round((conf.pets?.hpPerLevel ?? 0) * 100),
    mainHousePercent: Math.round((conf.mainHouse?.hpPerLevel ?? 0) * up.mainHouse * 100),
  };
}

/** 強化を実行する。成功で {ok:true,level}、失敗で {error} */
function upgrade(state, side, key, petId) {
  if (state.phase === 'ended') return { error: '試合は終了しています' };
  if (!UPGRADE_KEYS.includes(key)) return { error: '不明な強化です' };
  const conf = state.snapshot.upgrades?.[key];
  if (!conf) return { error: 'この強化は無効です' };
  const player = state.players[side];
  if (key === 'pets') {
    if (!state.petsById[petId]) return { error: '不明なペットです' };
    if (!player.deck.includes(petId)) return { error: '編成外のペットです' };
  }
  if (upgradeLevel(state, side, key, petId) >= conf.maxLevel) return { error: 'すでに最大レベルです' };
  const cost = upgradeCost(state, side, key, petId);
  if (player.bone < cost) return { error: 'ほねが足りません' };

  player.bone -= cost;
  let level;
  if (key === 'pets') {
    level = (player.upgrades.pets[petId] || 0) + 1;
    player.upgrades.pets[petId] = level;
  } else {
    player.upgrades[key] += 1;
    level = player.upgrades[key];
  }

  if (key === 'mainHouse') {
    // 最大HPを増やし、増分をそのまま回復する
    const main = player.facilities.main;
    const base = state.snapshot.facilities.mainHouse.hp;
    const newMax = Math.round(base * (1 + conf.hpPerLevel * level));
    const gain = newMax - main.maxHp;
    main.maxHp = newMax;
    main.hp = Math.min(newMax, main.hp + gain);
  }
  emit(state, 'upgrade', { side, key, petId, level });
  return { ok: true, level };
}

// ─── 出撃(クライアント操作の検証はここが最終防衛線: NET-02) ─────

function spawn(state, side, petId, lane) {
  if (state.phase === 'ended') return { error: '試合は終了しています' };
  if (!LANES.includes(lane)) return { error: '不正なレーンです' };
  const player = state.players[side];
  const pet = state.petsById[petId];
  if (!pet) return { error: '不明なペットです' };
  if (!player.hand.includes(petId)) return { error: '手札にありません' };
  if (player.bone < pet.cost) return { error: 'ほねが足りません' };

  const caps = state.rules.unitCaps;
  const mine = state.units.filter(u => u.owner === side && u.hp > 0);
  const pend = state.pendingSpawns.filter(s => s.owner === side);
  const pendCount = pend.reduce((a, s) => a + (state.petsById[s.petId].spawnCount || 1), 0);
  const addCount = pet.spawnCount || 1;
  if (mine.length + pendCount + addCount > caps.totalPerPlayer) return { error: '出撃上限です' };
  const laneCount = mine.filter(u => u.lane === lane).length +
    pend.filter(s => s.lane === lane).reduce((a, s) => a + (state.petsById[s.petId].spawnCount || 1), 0);
  if (laneCount + addCount > caps.perLane) return { error: 'このレーンは出撃上限です' };

  player.bone -= pet.cost;
  // 手札から除去 → 個別クールダウン開始 → 控え先頭から補充(設計書 5.1)
  player.hand.splice(player.hand.indexOf(petId), 1);
  player.cooldowns[petId] = pet.rechargeSec;
  if (player.reserve.length > 0) player.hand.push(player.reserve.shift());

  state.pendingSpawns.push({ owner: side, petId, lane, remain: pet.spawnDelay, x: SPAWN_X[side] });
  emit(state, 'spawn_pending', { side, petId, lane, delay: pet.spawnDelay });
  return { ok: true };
}

function surrender(state, side) {
  if (state.phase === 'ended') return;
  state.players[side].surrendered = true;
  finish(state, side === 0 ? 'p2' : 'p1', 'surrender');
}

// ─── tick ─────────────────────────────────────────────────────────

function tick(state, dt) {
  if (state.phase === 'ended') return;
  state.t += dt;
  const rules = state.rules;

  // フェーズ遷移
  if (state.phase === 'normal' && state.t >= rules.normalTimeSec) {
    state.phase = 'overtime';
    emit(state, 'overtime_start', {});
  }
  if (state.phase === 'overtime' && state.t >= rules.normalTimeSec + rules.overtimeSec) {
    return resolveTiebreak(state);
  }

  // ほね回復(延長中は倍率、強化レベルで加速、上限超過分は消滅)
  const regenMult = state.phase === 'overtime' ? rules.bone.overtimeMultiplier : 1;
  for (let side = 0; side < 2; side++) {
    const p = state.players[side];
    p.bone = Math.min(boneMax(state, side), p.bone + dt * boneRegenPerSec(state, side) * regenMult);
  }

  // 個別クールダウン(終了後は控え末尾へ。控えが空=4体デッキ等なら直接手札へ)
  for (const p of state.players) {
    for (const [petId, remain] of Object.entries(p.cooldowns)) {
      const next = remain - dt;
      if (next <= 0) {
        delete p.cooldowns[petId];
        if (p.hand.length < rules.hand.size && p.reserve.length === 0) p.hand.push(petId);
        else p.reserve.push(petId);
      } else {
        p.cooldowns[petId] = next;
      }
    }
  }

  // 出撃予告 → ユニット生成
  for (const s of [...state.pendingSpawns]) {
    s.remain -= dt;
    if (s.remain > 0) continue;
    state.pendingSpawns.splice(state.pendingSpawns.indexOf(s), 1);
    const pet = state.petsById[s.petId];
    const count = pet.spawnCount || 1;
    for (let i = 0; i < count; i++) {
      const dir = s.owner === 0 ? 1 : -1;
      state.units.push(makeUnit(state, s.owner, pet, s.lane, s.x - dir * i * 26));
    }
    petStat(state, s.owner, s.petId).spawns += count;
    emit(state, 'spawn', { side: s.owner, petId: s.petId, lane: s.lane, count });
  }

  // オーラ(毎tick再計算): コーギー攻撃+15% / セントバーナード被ダメ-10%(同効果は重複しない)
  for (const u of state.units) {
    u.auraAtk = 1;
    u.auraDef = 1;
  }
  for (const src of state.units) {
    if (src.hp <= 0) continue;
    const pet = state.petsById[src.petId];
    for (const ab of pet.abilities || []) {
      if (ab.type !== 'auraAttackBuff' && ab.type !== 'auraDamageReduction') continue;
      for (const ally of state.units) {
        if (ally.owner !== src.owner || ally === src || ally.lane !== src.lane || ally.hp <= 0) continue;
        if (Math.abs(ally.x - src.x) > ab.radius) continue;
        if (ab.type === 'auraAttackBuff') ally.auraAtk = Math.max(ally.auraAtk, 1 + ab.amount);
        else ally.auraDef = Math.min(ally.auraDef, 1 - ab.amount);
      }
    }
  }

  // ユニット行動
  for (const u of state.units) {
    if (u.hp <= 0) continue;
    updateTimers(u, dt);
    if (u.stunRemain > 0) { u.anim = 'stun'; continue; }

    const pet = state.petsById[u.petId];
    if (pet.attackType === 'heal') actHealer(state, u, pet, dt);
    else actFighter(state, u, pet, dt);
  }

  // 施設攻撃
  for (let side = 0; side < 2; side++) facilityAttacks(state, side, dt);

  // 死亡処理
  for (const u of state.units) {
    if (u.hp <= 0 && !u.deadHandled) {
      u.deadHandled = true;
      handleDeath(state, u);
    }
  }
  state.units = state.units.filter(u => u.hp > 0 || state.t - u.diedAt < 1.2); // 死亡アニメ表示分だけ残す

  // 勝敗(メインハウス破壊 = 即時勝利)
  for (let side = 0; side < 2; side++) {
    if (state.players[side].facilities.main.hp <= 0 && state.phase !== 'ended') {
      finish(state, side === 0 ? 'p2' : 'p1', 'main_destroyed');
    }
  }
}

function makeUnit(state, owner, pet, lane, x) {
  const spawnStun = pet.spawnStun || 0;
  const kbCount = pet.abilities?.some(a => a.type === 'knockbackImmune') ? 0 : (pet.knockbackCount || 0);
  // 出撃時点のペット強化レベルでHPが決まる(既に出ているユニットは変化しない)
  const hp = Math.round(pet.hp * petUpgradeMult(state, owner, pet.id, 'hp'));
  return {
    id: state.nextUnitId++,
    owner,
    petId: pet.id,
    lane,
    x,
    dir: owner === 0 ? 1 : -1,
    hp,
    maxHp: hp,
    attackCd: 0,
    stunRemain: spawnStun,
    stunImmuneRemain: 0,
    buffs: [], // {kind:'dmgcut'|'atkdown'|'atkspeed', amount, remain}
    kbThresholds: Array.from({ length: kbCount }, (_, i) => hp * (kbCount - i) / (kbCount + 1)),
    firstAttackDone: false,
    flying: pet.movement === 'flying',
    anim: 'idle',
    diedAt: null,
    auraAtk: 1,
    auraDef: 1,
  };
}

function updateTimers(u, dt) {
  u.attackCd = Math.max(0, u.attackCd - dt);
  u.stunRemain = Math.max(0, u.stunRemain - dt);
  u.stunImmuneRemain = Math.max(0, u.stunImmuneRemain - dt);
  u.buffs = u.buffs.filter(b => (b.remain -= dt) > 0);
}

function buffAtkMult(u, state) {
  let m = u.auraAtk;
  for (const b of u.buffs) {
    if (b.kind === 'atkdown') m *= 1 - b.amount;
  }
  // そのペットの強化は攻撃力に即時反映(出撃済みのユニットにも適用)
  if (state) m *= petUpgradeMult(state, u.owner, u.petId, 'attack');
  return m;
}

function buffAtkSpeedMult(u) {
  let m = 1;
  for (const b of u.buffs) if (b.kind === 'atkspeed') m *= 1 + b.amount;
  return m;
}

function damageTakenMult(u) {
  let m = u.auraDef;
  for (const b of u.buffs) if (b.kind === 'dmgcut') m *= 1 - b.amount;
  return m;
}

/** u から見た敵施設ターゲット(そのレーンのレーンハウス → 破壊後はメイン) */
function enemyFacilityTarget(state, u) {
  const enemySide = 1 - u.owner;
  const enemy = state.players[enemySide];
  const laneFac = enemy.facilities[u.lane];
  if (!laneFac.destroyed) {
    return { facility: laneFac, side: enemySide, key: u.lane, x: FACILITY_X.laneHouse[enemySide] };
  }
  if (!enemy.facilities.main.destroyed) {
    return { facility: enemy.facilities.main, side: enemySide, key: 'main', x: FACILITY_X.main[enemySide] };
  }
  return null;
}

function enemyUnitsInLane(state, u) {
  return state.units.filter(e => e.owner !== u.owner && e.hp > 0 && e.lane === u.lane);
}

function actFighter(state, u, pet, dt) {
  const targetsUnits = pet.targetType !== 'buildings';
  const enemies = targetsUnits ? enemyUnitsInLane(state, u) : [];
  let nearest = null;
  let nearestD = Infinity;
  for (const e of enemies) {
    const d = Math.abs(e.x - u.x);
    if (d < nearestD) { nearest = e; nearestD = d; }
  }
  const fac = enemyFacilityTarget(state, u);
  const facD = fac ? Math.abs(fac.x - u.x) : Infinity;
  const range = pet.attackRange + 20;

  let target = null;
  if (nearest && nearestD <= range) target = { unit: nearest, d: nearestD };
  else if (fac && facD <= range) target = { fac, d: facD };

  if (!target) {
    // 前進(敵・施設のいずれも射程外)
    u.x += u.dir * pet.moveSpeed * dt;
    u.x = Math.max(10, Math.min(LANE_LEN - 10, u.x));
    u.anim = 'walk';
    return;
  }

  u.anim = 'attack_ready';
  if (u.attackCd > 0) return;
  u.attackCd = pet.attackInterval / buffAtkSpeedMult(u);
  u.anim = 'attack';

  let dmg = pet.attackPower * buffAtkMult(u, state);
  const firstStrike = (pet.abilities || []).find(a => a.type === 'firstStrikeMultiplier');
  if (firstStrike && !u.firstAttackDone) dmg *= firstStrike.amount;
  u.firstAttackDone = true;

  if (target.unit) {
    const centerX = target.unit.x;
    const victims = pet.attackType === 'area' || pet.attackType === 'areaSmall'
      ? enemies.filter(e => Math.abs(e.x - centerX) <= (pet.areaRadius || 0))
      : [target.unit];
    for (const v of victims) applyDamage(state, u, v, dmg, pet);
    emit(state, 'attack', { unitId: u.id, lane: u.lane, x: centerX, area: pet.attackType !== 'single' });
  } else {
    const f = target.fac;
    let fdmg = pet.buildingAttackPower != null ? pet.buildingAttackPower * buffAtkMult(u, state) : dmg;
    if (pet.buildingDamageRatio != null) fdmg *= pet.buildingDamageRatio;
    dealFacilityDamage(state, u.owner, u.petId, f.side, f.key, fdmg);
    emit(state, 'attack', { unitId: u.id, lane: u.lane, x: f.x, facility: true });
  }
}

function actHealer(state, u, pet, dt) {
  const allies = state.units.filter(a => a.owner === u.owner && a !== u && a.hp > 0 && a.lane === u.lane);
  const inRange = allies.filter(a => Math.abs(a.x - u.x) <= pet.attackRange);
  const wounded = inRange.filter(a => a.hp < a.maxHp).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp);

  if (wounded.length > 0 && u.attackCd <= 0) {
    u.attackCd = pet.attackInterval;
    const target = wounded[0];
    target.hp = Math.min(target.maxHp, target.hp + pet.healPower);
    u.anim = 'attack';
    emit(state, 'heal', { unitId: u.id, targetId: target.id, lane: u.lane, x: target.x });
    return;
  }
  // 味方が前方射程内にいれば待機、いなければ前進
  const ahead = allies.some(a => (a.x - u.x) * u.dir > 0 && Math.abs(a.x - u.x) <= pet.attackRange * 0.9);
  if (!ahead) {
    u.x += u.dir * pet.moveSpeed * dt;
    u.x = Math.max(10, Math.min(LANE_LEN - 10, u.x));
    u.anim = 'walk';
  } else {
    u.anim = 'idle';
  }
}

function applyDamage(state, attacker, victim, rawDmg, attackerPet) {
  const dmg = rawDmg * damageTakenMult(victim);
  victim.hp -= dmg;
  petStat(state, attacker.owner, attacker.petId).damage += dmg;

  // 命中時デバフ(プードル)
  for (const ab of attackerPet.abilities || []) {
    if (ab.type === 'attackDebuffOnHit') {
      victim.buffs = victim.buffs.filter(b => b.kind !== 'atkdown');
      victim.buffs.push({ kind: 'atkdown', amount: ab.amount, remain: ab.duration });
    }
    if (ab.type === 'stunOnFirstHit' && victim.stunImmuneRemain <= 0) {
      victim.stunRemain = Math.max(victim.stunRemain, ab.duration);
      victim.stunImmuneRemain = ab.reStunImmunity;
      emit(state, 'stun', { unitId: victim.id, lane: victim.lane, x: victim.x });
    }
  }

  // ノックバック(HP閾値方式)
  while (victim.kbThresholds.length > 0 && victim.hp <= victim.kbThresholds[0]) {
    victim.kbThresholds.shift();
    if (victim.hp > 0) {
      victim.x -= victim.dir * KB_DISTANCE;
      victim.x = Math.max(10, Math.min(LANE_LEN - 10, victim.x));
      victim.stunRemain = Math.max(victim.stunRemain, KB_STUN);
      emit(state, 'knockback', { unitId: victim.id });
    }
  }

  if (victim.hp <= 0) {
    victim.diedAt = state.t;
    petStat(state, attacker.owner, attacker.petId).kills += 1;
    // 撃破時攻速バフ(ボーダーコリー)
    for (const ab of attackerPet.abilities || []) {
      if (ab.type === 'attackSpeedOnKill') {
        const stacks = attacker.buffs.filter(b => b.kind === 'atkspeed').length;
        if (stacks < ab.maxStacks) attacker.buffs.push({ kind: 'atkspeed', amount: ab.amount, remain: ab.duration });
      }
    }
  }
}

function handleDeath(state, u) {
  const pet = state.petsById[u.petId];
  emit(state, 'death', { unitId: u.id, petId: u.petId, side: u.owner, lane: u.lane, x: u.x });
  // 死亡時爆発(パグ)
  for (const ab of pet.abilities || []) {
    if (ab.type !== 'deathExplosion') continue;
    emit(state, 'explosion', { lane: u.lane, x: u.x });
    for (const e of state.units) {
      if (e.owner === u.owner || e.hp <= 0 || e.lane !== u.lane) continue;
      if (Math.abs(e.x - u.x) <= ab.radius) applyDamage(state, u, e, ab.damage, pet);
    }
    const fac = enemyFacilityTarget(state, u);
    if (fac && Math.abs(fac.x - u.x) <= ab.radius) {
      dealFacilityDamage(state, u.owner, u.petId, fac.side, fac.key, ab.damage * (ab.buildingDamageRatio ?? 1));
    }
  }
}

function dealFacilityDamage(state, attackerSide, petId, facSide, key, dmg) {
  const fac = state.players[facSide].facilities[key];
  if (fac.destroyed) return;
  fac.hp -= dmg;
  state.players[attackerSide].totalFacilityDamage += Math.min(dmg, dmg + fac.hp); // オーバーキル分は数えない
  petStat(state, attackerSide, petId).facilityDamage += dmg;
  if (fac.hp <= 0) {
    fac.hp = 0;
    fac.destroyed = true;
    emit(state, 'facility_destroyed', { side: facSide, key });
    if (fac.kind === 'laneHouse') {
      state.players[attackerSide].points += state.snapshot.facilities.laneHouse.point;
      state.players[attackerSide].destroyedLaneHouses += 1;
    }
  }
}

function facilityAttacks(state, side, dt) {
  const player = state.players[side];
  const conf = state.snapshot.facilities;
  const enemyUnits = state.units.filter(u => u.owner !== side && u.hp > 0);

  for (const lane of LANES) {
    const fac = player.facilities[lane];
    if (fac.destroyed) continue;
    fac.attackCd = Math.max(0, fac.attackCd - dt);
    const x = FACILITY_X.laneHouse[side];
    const inRange = enemyUnits.filter(u => u.lane === lane && Math.abs(u.x - x) <= conf.laneHouse.attackRange);
    if (inRange.length === 0 || fac.attackCd > 0) continue;
    fac.attackCd = conf.laneHouse.attackInterval;
    const target = inRange.sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0];
    facilityHit(state, side, target, conf.laneHouse.attackPower, lane);
  }

  // メインハウスは自軍レーンハウスがどちらか破壊されるまで攻撃しない
  const main = player.facilities.main;
  if (!main.destroyed) {
    const activated = player.facilities.top.destroyed || player.facilities.bottom.destroyed;
    main.attackCd = Math.max(0, main.attackCd - dt);
    if (activated && main.attackCd <= 0) {
      const x = FACILITY_X.main[side];
      const inRange = enemyUnits.filter(u => Math.abs(u.x - x) <= conf.mainHouse.attackRange);
      if (inRange.length > 0) {
        main.attackCd = conf.mainHouse.attackInterval;
        const target = inRange.sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0];
        const up = state.snapshot.upgrades?.mainHouse;
        const mult = up ? 1 + up.attackPerLevel * player.upgrades.mainHouse : 1;
        facilityHit(state, side, target, conf.mainHouse.attackPower * mult, 'main');
      }
    }
  }
}

function facilityHit(state, side, victim, power, from) {
  const dmg = power * damageTakenMult(victim);
  victim.hp -= dmg;
  emit(state, 'facility_attack', { side, from, targetId: victim.id, lane: victim.lane, x: victim.x });
  while (victim.kbThresholds.length > 0 && victim.hp <= victim.kbThresholds[0]) {
    victim.kbThresholds.shift();
    if (victim.hp > 0) {
      victim.x -= victim.dir * KB_DISTANCE;
      victim.stunRemain = Math.max(victim.stunRemain, KB_STUN);
    }
  }
  if (victim.hp <= 0) victim.diedAt = state.t;
}

// ─── 決着 ─────────────────────────────────────────────────────────

function resolveTiebreak(state) {
  const [a, b] = state.players;
  // ①破壊レーンハウス数 ②施設総ダメージ ③メインハウス残HP率 ④引き分け
  if (a.destroyedLaneHouses !== b.destroyedLaneHouses) {
    return finish(state, a.destroyedLaneHouses > b.destroyedLaneHouses ? 'p1' : 'p2', 'tiebreak_lanehouses');
  }
  if (Math.round(a.totalFacilityDamage) !== Math.round(b.totalFacilityDamage)) {
    return finish(state, a.totalFacilityDamage > b.totalFacilityDamage ? 'p1' : 'p2', 'tiebreak_damage');
  }
  const aRatio = a.facilities.main.hp / a.facilities.main.maxHp;
  const bRatio = b.facilities.main.hp / b.facilities.main.maxHp;
  if (aRatio !== bRatio) {
    return finish(state, aRatio > bRatio ? 'p1' : 'p2', 'tiebreak_mainhp');
  }
  return finish(state, 'draw', 'tiebreak_draw');
}

function finish(state, result, reason) {
  if (state.phase === 'ended') return;
  state.phase = 'ended';
  state.result = { result, reason };
  emit(state, 'match_end', { result, reason });
}

module.exports = { createBattle, tick, spawn, surrender, upgrade, upgradeCost, upgradeLevel, upgradeEffects, boneMax, finish, LANE_LEN, FACILITY_X, SPAWN_X, LANES };
