/**
 * バランスバージョン管理。
 * published のスナップショットは不変。編集は draft の複製に対してのみ行う。
 * マッチ成立時に getPublished() の版IDを固定し、試合途中の公開は影響しない
 * (Room がスナップショットオブジェクトを保持するため)。
 */
const db = require('./db');
const { validateAbilities } = require('./abilities');

let cache = null; // { id, snapshot } 現行 published

function getPublished() {
  if (cache) return cache;
  const row = db
    .prepare("SELECT id, snapshot_json FROM balance_versions WHERE status = 'published' ORDER BY id DESC LIMIT 1")
    .get();
  if (!row) throw new Error('published なバランス版がありません');
  cache = { id: row.id, snapshot: JSON.parse(row.snapshot_json) };
  return cache;
}

function invalidateCache() {
  cache = null;
}

function getVersion(id) {
  const row = db.prepare('SELECT * FROM balance_versions WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, snapshot: JSON.parse(row.snapshot_json) };
}

function listVersions() {
  return db
    .prepare(`SELECT v.id, v.status, v.label, v.base_version_id, v.created_by, v.created_at, v.published_at, v.scheduled_at,
                     u.name AS created_by_name
              FROM balance_versions v LEFT JOIN users u ON u.id = v.created_by ORDER BY v.id DESC`)
    .all();
}

/** 現行(または指定)版を複製して draft を作る */
function createDraft(adminId, baseId, label) {
  const base = baseId ? getVersion(baseId) : { id: getPublished().id, snapshot_json: JSON.stringify(getPublished().snapshot) };
  if (!base) throw new Error('複製元の版が見つかりません');
  const snapshotJson = typeof base.snapshot_json === 'string' ? base.snapshot_json : JSON.stringify(base.snapshot);
  const info = db
    .prepare('INSERT INTO balance_versions (status, label, snapshot_json, base_version_id, created_by) VALUES (?, ?, ?, ?, ?)')
    .run('draft', label || '', snapshotJson, base.id ?? baseId, adminId);
  return info.lastInsertRowid;
}

// ─── バリデーション(依頼書 4.3 / 設計書 7.4) ───────────────────

const PET_RANGES = {
  cost: [1, 10],
  hp: [1, 100000],
  attackPower: [0, 20000],
  attackInterval: [0.1, 10],
  attackRange: [1, 1000],
  moveSpeed: [1, 500],
  spawnDelay: [0, 5],
  rechargeSec: [0, 120],
};

function validateSnapshot(s) {
  const errors = [];
  const warnings = [];
  if (!s || typeof s !== 'object') return { errors: ['スナップショットがオブジェクトではありません'], warnings };
  if (!Array.isArray(s.pets) || s.pets.length === 0) errors.push('pets が空です');
  const r = s.rules || {};
  if (!(r.normalTimeSec > 0)) errors.push('rules.normalTimeSec が不正です');
  if (!(r.bone?.max >= 1 && r.bone?.start >= 0 && r.bone?.regenSec > 0)) errors.push('rules.bone が不正です');
  if (!(r.deck?.min >= 1 && r.deck?.max >= r.deck?.min)) errors.push('rules.deck が不正です');
  for (const f of ['laneHouse', 'mainHouse']) {
    const fac = s.facilities?.[f];
    if (!(fac?.hp > 0 && fac?.attackPower >= 0 && fac?.attackRange > 0 && fac?.attackInterval > 0)) {
      errors.push(`facilities.${f} が不正です`);
    }
  }
  // ガチャ(排出率・コスト・重複還元)
  const g = s.gacha;
  const rarityIds = new Set();
  if (!g) {
    errors.push('gacha がありません');
  } else {
    if (!(g.singleCost >= 0)) errors.push('gacha.singleCost が不正です');
    if (!(g.multiCount >= 1)) errors.push('gacha.multiCount が不正です');
    if (!(g.multiCost >= 0)) errors.push('gacha.multiCost が不正です');
    if (!Array.isArray(g.rarities) || g.rarities.length === 0) {
      errors.push('gacha.rarities が空です');
    } else {
      for (const r of g.rarities) {
        if (!r.id) { errors.push('id のないレアリティがあります'); continue; }
        if (rarityIds.has(r.id)) errors.push(`レアリティID重複: ${r.id}`);
        rarityIds.add(r.id);
        if (!(r.weight >= 0)) errors.push(`gacha.rarities.${r.id}.weight が不正です`);
        if (!(r.duplicateCoins >= 0)) errors.push(`gacha.rarities.${r.id}.duplicateCoins が不正です`);
      }
      if (!g.rarities.some(r => r.weight > 0)) errors.push('gacha.rarities の重みが全て0です');
      if (g.multiGuaranteeRarity && !rarityIds.has(g.multiGuaranteeRarity)) {
        errors.push(`gacha.multiGuaranteeRarity が不明です: ${g.multiGuaranteeRarity}`);
      }
      if (g.multiCost > g.singleCost * g.multiCount) {
        warnings.push(`${g.multiCount}連(${g.multiCost})が単発${g.multiCount}回分(${g.singleCost * g.multiCount})より割高です`);
      }
    }
  }

  const ids = new Set();
  for (const p of s.pets || []) {
    if (!p.id) { errors.push('id のないペットがあります'); continue; }
    if (ids.has(p.id)) errors.push(`ペットID重複: ${p.id}`);
    ids.add(p.id);
    if (rarityIds.size > 0 && !rarityIds.has(p.rarity)) {
      errors.push(`${p.id}.rarity が不正です: ${p.rarity}`);
    }
    errors.push(...validateAbilities(p.id, p.abilities));
    if (p.attackType === 'heal' && !(p.healPower > 0)) errors.push(`${p.id}.healPower が必要です(attackType=heal)`);
    if ((p.attackType === 'area' || p.attackType === 'areaSmall') && !(p.areaRadius > 0)) {
      errors.push(`${p.id}.areaRadius が必要です(attackType=${p.attackType})`);
    }
    if (p.spawnCount != null && !(Number.isInteger(p.spawnCount) && p.spawnCount >= 1)) {
      errors.push(`${p.id}.spawnCount が不正です: ${p.spawnCount}`);
    }
    for (const [key, [min, max]] of Object.entries(PET_RANGES)) {
      const v = p[key];
      if (v == null || typeof v !== 'number' || v < min || v > max) {
        errors.push(`${p.id}.${key} が範囲外です(${min}〜${max}): ${v}`);
      }
    }
  }
  // 初期付与ペットは実在し、公開されている必要がある
  for (const petId of s.progression?.initialPets || []) {
    const pet = (s.pets || []).find(p => p.id === petId);
    if (!pet) errors.push(`progression.initialPets に不明なペット: ${petId}`);
    else if (pet.released === false) warnings.push(`初期付与ペット ${petId} が未公開です`);
  }
  if ((s.progression?.initialPets || []).length < (r.deck?.min || 0)) {
    errors.push(`progression.initialPets がデッキ最小数(${r.deck?.min})未満です`);
  }

  // 抽選対象が1体もいないレアリティは排出されない(率が実質再配分される)
  for (const r of g?.rarities || []) {
    if (r.weight > 0 && !(s.pets || []).some(p => p.rarity === r.id && p.released !== false)) {
      warnings.push(`レアリティ ${r.id} に公開中のペットがいません(排出されません)`);
    }
  }

  // 効率警告: 同コスト帯の平均から大きく外れる HP・DPS(±80%)
  const byCost = {};
  for (const p of s.pets || []) {
    if (!byCost[p.cost]) byCost[p.cost] = [];
    byCost[p.cost].push(p);
  }
  for (const p of s.pets || []) {
    const peers = byCost[p.cost].filter(q => q.id !== p.id);
    if (peers.length === 0) continue;
    const avgHp = peers.reduce((a, q) => a + q.hp, 0) / peers.length;
    const dps = q => (q.attackPower || 0) / (q.attackInterval || 1);
    const avgDps = peers.reduce((a, q) => a + dps(q), 0) / peers.length;
    if (p.hp > avgHp * 1.8) warnings.push(`${p.id}: HP ${p.hp} は同コスト平均 ${Math.round(avgHp)} の1.8倍超`);
    if (avgDps > 0 && dps(p) > avgDps * 1.8) warnings.push(`${p.id}: DPS ${Math.round(dps(p))} は同コスト平均 ${Math.round(avgDps)} の1.8倍超`);
  }
  return { errors, warnings };
}

function updateDraft(id, snapshot) {
  const v = getVersion(id);
  if (!v) throw new Error('版が見つかりません');
  if (v.status !== 'draft' && v.status !== 'testing') throw new Error(`${v.status} の版は編集できません(draft/testing のみ)`);
  const { errors, warnings } = validateSnapshot(snapshot);
  if (errors.length > 0) return { ok: false, errors, warnings };
  db.prepare('UPDATE balance_versions SET snapshot_json = ? WHERE id = ?').run(JSON.stringify(snapshot), id);
  return { ok: true, errors: [], warnings };
}

/** ラベル(メモ)の変更。公開済みの版でも識別のために変更できる */
function setLabel(id, label) {
  const v = getVersion(id);
  if (!v) throw new Error('版が見つかりません');
  db.prepare('UPDATE balance_versions SET label = ? WHERE id = ?').run(String(label ?? '').slice(0, 80), id);
}

/** 不要になった下書き(draft/testing)を削除する。公開済み・過去版は消せない */
function deleteVersion(id) {
  const v = getVersion(id);
  if (!v) throw new Error('版が見つかりません');
  if (!['draft', 'testing', 'scheduled'].includes(v.status)) {
    throw new Error(`${v.status} の版は削除できません(draft/testing/scheduled のみ)`);
  }
  db.prepare('DELETE FROM balance_versions WHERE id = ?').run(id);
}

/** 外部JSON(バックアップ・他環境)から下書きを作る */
function importSnapshot(adminId, snapshot, label) {
  const { errors, warnings } = validateSnapshot(snapshot);
  if (errors.length > 0) return { ok: false, errors, warnings };
  const info = db
    .prepare("INSERT INTO balance_versions (status, label, snapshot_json, created_by) VALUES ('draft', ?, ?, ?)")
    .run(label || 'imported', JSON.stringify(snapshot), adminId);
  return { ok: true, id: info.lastInsertRowid, errors: [], warnings };
}

/** 公開予約: 指定時刻(ISO文字列)に自動で公開する */
function schedule(id, atIso) {
  const v = getVersion(id);
  if (!v) throw new Error('版が見つかりません');
  if (!['draft', 'testing', 'scheduled'].includes(v.status)) throw new Error(`${v.status} の版は予約できません`);
  const at = new Date(atIso);
  if (Number.isNaN(at.getTime())) throw new Error('予約日時が不正です');
  if (at.getTime() < Date.now() - 60000) throw new Error('過去の日時は予約できません');
  const { errors } = validateSnapshot(v.snapshot);
  if (errors.length > 0) throw new Error('バリデーションエラー: ' + errors.join(' / '));
  db.prepare("UPDATE balance_versions SET status = 'scheduled', scheduled_at = ? WHERE id = ?")
    .run(at.toISOString(), id);
  return at.toISOString();
}

/** 予約の取り消し(draft へ戻す) */
function cancelSchedule(id) {
  const v = getVersion(id);
  if (!v) throw new Error('版が見つかりません');
  if (v.status !== 'scheduled') throw new Error('予約されていません');
  db.prepare("UPDATE balance_versions SET status = 'draft', scheduled_at = NULL WHERE id = ?").run(id);
}

/**
 * 予約時刻を過ぎた版を公開する(index.js から定期実行)。
 * 公開した版IDの配列を返す。
 */
function publishDue(now = Date.now()) {
  const due = db
    .prepare("SELECT id, scheduled_at FROM balance_versions WHERE status = 'scheduled' ORDER BY scheduled_at")
    .all()
    .filter(r => new Date(r.scheduled_at).getTime() <= now);
  const published = [];
  for (const row of due) {
    try {
      publish(row.id);
      db.prepare('UPDATE balance_versions SET scheduled_at = NULL WHERE id = ?').run(row.id);
      published.push(row.id);
    } catch (e) {
      console.error(`[balance] 予約公開に失敗(版#${row.id}): ${e.message}`);
      db.prepare("UPDATE balance_versions SET status = 'draft', scheduled_at = NULL WHERE id = ?").run(row.id);
    }
  }
  return published;
}

function setTesting(id) {
  const v = getVersion(id);
  if (!v) throw new Error('版が見つかりません');
  if (v.status !== 'draft') throw new Error('draft のみテスト反映できます');
  db.prepare("UPDATE balance_versions SET status = 'testing' WHERE id = ?").run(id);
}

/** 公開: 現行 published を archived にし、対象版を published にする(不変化) */
const publishTx = db.transaction(id => {
  const v = getVersion(id);
  if (!v) throw new Error('版が見つかりません');
  if (!['draft', 'testing', 'scheduled'].includes(v.status)) throw new Error(`${v.status} の版は公開できません`);
  const { errors } = validateSnapshot(v.snapshot);
  if (errors.length > 0) throw new Error('バリデーションエラー: ' + errors.join(' / '));
  db.prepare("UPDATE balance_versions SET status = 'archived' WHERE status = 'published'").run();
  db.prepare("UPDATE balance_versions SET status = 'published', published_at = datetime('now') WHERE id = ?").run(id);
});

function publish(id) {
  publishTx(id);
  invalidateCache();
}

/** ロールバック: 過去の archived 版のスナップショットを新しい published 版として複製 */
const rollbackTx = db.transaction((toId, adminId) => {
  const v = getVersion(toId);
  if (!v) throw new Error('版が見つかりません');
  if (!['archived', 'published'].includes(v.status)) throw new Error('archived の版にのみロールバックできます');
  const current = db.prepare("SELECT id FROM balance_versions WHERE status = 'published'").get();
  db.prepare("UPDATE balance_versions SET status = 'rolled_back' WHERE status = 'published'").run();
  const info = db
    .prepare(
      `INSERT INTO balance_versions (status, label, snapshot_json, base_version_id, created_by, published_at)
       VALUES ('published', ?, ?, ?, ?, datetime('now'))`,
    )
    .run(`rollback to v${toId}`, v.snapshot_json, toId, adminId);
  return { newId: info.lastInsertRowid, rolledBackId: current?.id };
});

function rollback(toId, adminId) {
  const res = rollbackTx(toId, adminId);
  invalidateCache();
  return res;
}

/** 2版のペット・ルール差分(公開前の確認表示用) */
function diff(aId, bId) {
  const a = getVersion(aId)?.snapshot;
  const b = getVersion(bId)?.snapshot;
  if (!a || !b) throw new Error('版が見つかりません');
  return diffSnapshots(a, b);
}

/** スナップショット同士の差分(保存前の変更点カウントにも使う) */
function diffSnapshots(a, b) {
  const changes = [];
  const flat = (obj, prefix = '') => {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flat(v, `${prefix}${k}.`));
      else out[`${prefix}${k}`] = v;
    }
    return out;
  };
  const petA = Object.fromEntries((a.pets || []).map(p => [p.id, p]));
  const petB = Object.fromEntries((b.pets || []).map(p => [p.id, p]));
  for (const id of new Set([...Object.keys(petA), ...Object.keys(petB)])) {
    const fa = flat(petA[id] || {});
    const fb = flat(petB[id] || {});
    for (const key of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
      if (JSON.stringify(fa[key]) !== JSON.stringify(fb[key])) {
        changes.push({ path: `pets.${id}.${key}`, from: fa[key], to: fb[key] });
      }
    }
  }
  for (const section of ['rules', 'facilities', 'progression', 'matchmaking', 'gacha', 'upgrades']) {
    const fa = flat(a[section] || {}, `${section}.`);
    const fb = flat(b[section] || {}, `${section}.`);
    for (const key of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
      if (JSON.stringify(fa[key]) !== JSON.stringify(fb[key])) changes.push({ path: key, from: fa[key], to: fb[key] });
    }
  }
  return changes;
}

function audit(adminId, action, target, before, after, reason) {
  db.prepare('INSERT INTO audit_log (admin_id, action, target, before_json, after_json, reason) VALUES (?, ?, ?, ?, ?, ?)').run(
    adminId,
    action,
    target,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    reason || null,
  );
}

module.exports = {
  getPublished,
  getVersion,
  listVersions,
  createDraft,
  updateDraft,
  validateSnapshot,
  setTesting,
  setLabel,
  deleteVersion,
  importSnapshot,
  schedule,
  cancelSchedule,
  publishDue,
  publish,
  rollback,
  diff,
  diffSnapshots,
  audit,
  invalidateCache,
};
