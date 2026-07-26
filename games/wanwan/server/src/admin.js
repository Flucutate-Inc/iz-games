/**
 * 管理画面 API。
 * - バランス版: 作成・編集・検証・差分・テスト反映・予約・公開・ロールバック・入出力
 * - 運用: アカウント検索/詳細/付与/停止/管理者権限、試合調査、稼働状況
 * - 分析: KPI・ペット・ガチャ・売上(期間+バランス版で絞り込み)
 * - 監査: 検索つき一覧・CSV
 *
 * 危険な操作(公開・ロールバック・予約・削除・付与・停止・権限変更)は理由を必須にする。
 */
const express = require('express');
const db = require('./db');
const balance = require('./balance');
const gacha = require('./gacha');
const { ABILITIES, makeDefault } = require('./abilities');
const mm = require('./matchmaker');
const { requireAdmin, httpError } = require('./auth');

const router = express.Router();
router.use(requireAdmin);

/** 監査に残す操作は理由必須(依頼書 4.4 の安全機能) */
function requireReason(req) {
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 2) throw httpError(400, '変更理由を入力してください(監査ログに残ります)');
  return reason;
}

/**
 * 期間(from/to)とバランス版(versionId)の共通フィルタ。
 * `AND ...` を返すので、呼び出し側は `WHERE 1=1` などの後ろに連結する。
 */
function rangeFilter(req, { column = 'started_at', versionColumn = 'balance_version_id', prefix = '' } = {}) {
  const p = prefix ? `${prefix}.` : '';
  const where = [];
  const params = [];
  if (req.query.from) { where.push(`${p}${column} >= ?`); params.push(String(req.query.from)); }
  if (req.query.to) { where.push(`${p}${column} <= ?`); params.push(`${String(req.query.to)} 23:59:59`); }
  if (req.query.versionId && versionColumn) { where.push(`${p}${versionColumn} = ?`); params.push(Number(req.query.versionId)); }
  return { sql: where.length ? ` AND ${where.join(' AND ')}` : '', params };
}

// ─── バランス版 ────────────────────────────────────────────────

router.get('/versions', (req, res) => {
  res.json({ versions: balance.listVersions(), publishedId: balance.getPublished().id });
});

/** アビリティのカタログ(管理画面のフォーム生成用) */
router.get('/ability-types', (req, res) => res.json({ abilities: ABILITIES }));

router.get('/versions/:id', (req, res, next) => {
  try {
    const v = balance.getVersion(Number(req.params.id));
    if (!v) throw httpError(404, '版が見つかりません');
    const { snapshot_json, ...meta } = v;
    res.json(meta);
  } catch (e) { next(e); }
});

/** エクスポート(バックアップ・他環境への移送用) */
router.get('/versions/:id/export', (req, res, next) => {
  try {
    const v = balance.getVersion(Number(req.params.id));
    if (!v) throw httpError(404, '版が見つかりません');
    res.setHeader('Content-Disposition', `attachment; filename="wanwan-balance-v${v.id}.json"`);
    res.json(v.snapshot);
  } catch (e) { next(e); }
});

router.post('/versions/import', (req, res, next) => {
  try {
    const reason = requireReason(req);
    const result = balance.importSnapshot(req.user.id, req.body.snapshot, req.body.label);
    if (result.ok) balance.audit(req.user.id, 'import', `version:${result.id}`, null, { label: req.body.label }, reason);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) { next(e); }
});

router.post('/versions/draft', (req, res, next) => {
  try {
    const id = balance.createDraft(req.user.id, req.body.baseId || null, req.body.label);
    balance.audit(req.user.id, 'create_draft', `version:${id}`, null, { baseId: req.body.baseId || null }, req.body.reason);
    res.json({ id });
  } catch (e) { next(e); }
});

router.put('/versions/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const before = balance.getVersion(id);
    if (!before) throw httpError(404, '版が見つかりません');
    const result = balance.updateDraft(id, req.body.snapshot);
    if (result.ok) {
      const changes = balance.diffSnapshots(before.snapshot, req.body.snapshot);
      balance.audit(req.user.id, 'update_draft', `version:${id}`, null, { changes: changes.length }, req.body.reason);
      result.changes = changes.length;
    }
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) { next(e); }
});

router.patch('/versions/:id/label', (req, res, next) => {
  try {
    balance.setLabel(Number(req.params.id), req.body.label);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/versions/:id', (req, res, next) => {
  try {
    const reason = requireReason(req);
    const id = Number(req.params.id);
    balance.deleteVersion(id);
    balance.audit(req.user.id, 'delete_version', `version:${id}`, null, null, reason);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/versions/:id/validate', (req, res, next) => {
  try {
    const v = balance.getVersion(Number(req.params.id));
    if (!v) throw httpError(404, '版が見つかりません');
    res.json(balance.validateSnapshot(v.snapshot));
  } catch (e) { next(e); }
});

router.get('/versions/:id/diff/:otherId', (req, res, next) => {
  try {
    res.json({ changes: balance.diff(Number(req.params.otherId), Number(req.params.id)) });
  } catch (e) { next(e); }
});

router.post('/versions/:id/testing', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    balance.setTesting(id);
    balance.audit(req.user.id, 'set_testing', `version:${id}`, null, null, req.body.reason);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/versions/:id/schedule', (req, res, next) => {
  try {
    const reason = requireReason(req);
    const id = Number(req.params.id);
    const at = balance.schedule(id, req.body.at);
    balance.audit(req.user.id, 'schedule', `version:${id}`, null, { at }, reason);
    res.json({ ok: true, at });
  } catch (e) { next(e); }
});

router.post('/versions/:id/schedule/cancel', (req, res, next) => {
  try {
    const reason = requireReason(req);
    const id = Number(req.params.id);
    balance.cancelSchedule(id);
    balance.audit(req.user.id, 'cancel_schedule', `version:${id}`, null, null, reason);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/versions/:id/publish', (req, res, next) => {
  try {
    const reason = requireReason(req);
    const id = Number(req.params.id);
    const beforeId = balance.getPublished().id;
    balance.publish(id);
    balance.audit(req.user.id, 'publish', `version:${id}`, { publishedId: beforeId }, { publishedId: id }, reason);
    res.json({ ok: true, publishedId: id });
  } catch (e) { next(e); }
});

router.post('/versions/:id/rollback', (req, res, next) => {
  try {
    const reason = requireReason(req);
    const id = Number(req.params.id);
    const result = balance.rollback(id, req.user.id);
    balance.audit(req.user.id, 'rollback', `version:${id}`, { rolledBackId: result.rolledBackId }, { newId: result.newId }, reason);
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/** アビリティの既定値(管理画面の「追加」用) */
router.get('/ability-default/:type', (req, res, next) => {
  try {
    res.json({ ability: makeDefault(req.params.type) });
  } catch (e) { next(httpError(400, e.message)); }
});

// ─── 監査ログ ──────────────────────────────────────────────────

function auditRows(req) {
  const where = [];
  const params = [];
  if (req.query.action) { where.push('a.action = ?'); params.push(String(req.query.action)); }
  if (req.query.adminId) { where.push('a.admin_id = ?'); params.push(Number(req.query.adminId)); }
  if (req.query.from) { where.push('a.created_at >= ?'); params.push(String(req.query.from)); }
  if (req.query.to) { where.push('a.created_at <= ?'); params.push(`${String(req.query.to)} 23:59:59`); }
  if (req.query.q) {
    where.push('(a.target LIKE ? OR a.reason LIKE ? OR a.after_json LIKE ?)');
    const like = `%${req.query.q}%`;
    params.push(like, like, like);
  }
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const offset = Number(req.query.offset) || 0;
  const sql = `SELECT a.*, u.name AS admin_name FROM audit_log a JOIN users u ON u.id = a.admin_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...params, limit, offset);
}

router.get('/audit', (req, res) => {
  const actions = db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map(r => r.action);
  const total = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
  res.json({ audit: auditRows(req), actions, total });
});

router.get('/audit.csv', (req, res) => {
  const rows = auditRows({ query: { ...req.query, limit: 1000 } });
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['日時,実行者,操作,対象,理由,変更前,変更後']
    .concat(rows.map(a => [a.created_at, a.admin_name, a.action, a.target, a.reason, a.before_json, a.after_json].map(esc).join(',')))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="wanwan-audit.csv"');
  res.send('﻿' + csv); // Excel 用 BOM
});

// ─── アカウント運用 ────────────────────────────────────────────

router.get('/users', (req, res) => {
  const where = [];
  const params = [];
  const q = String(req.query.q || '').trim();
  if (q) {
    where.push('(name LIKE ? OR CAST(id AS TEXT) = ? OR firebase_uid = ?)');
    params.push(`%${q}%`, q, q);
  }
  if (req.query.status) { where.push('status = ?'); params.push(String(req.query.status)); }
  if (req.query.admin === '1') where.push('is_admin = 1');
  const sortable = { id: 'id', rating: 'rating', coins: 'coins', level: 'level', matches: 'matches_played', created: 'created_at', login: 'last_login_at' };
  const sort = sortable[req.query.sort] || 'id';
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const users = db.prepare(
    `SELECT id, name, level, xp, coins, rating, wins, losses, draws, matches_played, disconnects,
            status, is_admin, firebase_uid, created_at, last_login_at
     FROM users ${whereSql} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM users ${whereSql}`).get(...params).n;
  res.json({ users, total, limit, offset });
});

/** ユーザー詳細: 所持ペット・デッキ・対戦履歴・ガチャ・課金 */
router.get('/users/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw httpError(404, 'ユーザーが見つかりません');
    const { pass_hash, salt, ...safe } = user;
    const { snapshot } = balance.getPublished();
    const petName = Object.fromEntries(snapshot.pets.map(p => [p.id, p.name]));
    res.json({
      user: safe,
      pets: db.prepare('SELECT pet_id, acquired_at FROM user_pets WHERE user_id = ? ORDER BY acquired_at').all(id)
        .map(r => ({ id: r.pet_id, name: petName[r.pet_id] || r.pet_id, acquiredAt: r.acquired_at })),
      decks: db.prepare('SELECT id, name, pets_json, selected FROM decks WHERE user_id = ?').all(id)
        .map(d => ({ id: d.id, name: d.name, pets: JSON.parse(d.pets_json), selected: !!d.selected })),
      matches: db.prepare(
        `SELECT m.id, m.result, m.winner_id, m.balance_version_id, m.started_at, m.duration_sec,
                m.p1_id, m.p2_id, u1.name AS p1_name, u2.name AS p2_name
         FROM matches m JOIN users u1 ON u1.id = m.p1_id JOIN users u2 ON u2.id = m.p2_id
         WHERE m.p1_id = ? OR m.p2_id = ? ORDER BY m.started_at DESC LIMIT 20`,
      ).all(id, id),
      gacha: db.prepare(
        'SELECT pet_id, rarity, duplicate, coins_refund, created_at FROM gacha_pulls WHERE user_id = ? ORDER BY id DESC LIMIT 30',
      ).all(id),
      purchases: db.prepare('SELECT nonce, iz_amount, coins, created_at FROM iz_purchases WHERE user_id = ? ORDER BY created_at DESC LIMIT 30').all(id),
      allPets: snapshot.pets.map(p => ({ id: p.id, name: p.name, rarity: p.rarity })),
    });
  } catch (e) { next(e); }
});

/** 付与・調整: コイン/XP/レベル/レート(増減)、ペットの付与・剥奪 */
router.post('/users/:id/grant', (req, res, next) => {
  try {
    const reason = requireReason(req);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) throw httpError(404, 'ユーザーが見つかりません');
    const num = v => (v == null || v === '' ? 0 : Number(v));
    const { coins, xp, rating, level, petId, removePetId } = req.body;
    for (const [k, v] of Object.entries({ coins, xp, rating, level })) {
      if (v != null && v !== '' && !Number.isFinite(Number(v))) throw httpError(400, `${k} が数値ではありません`);
    }
    const before = { coins: user.coins, xp: user.xp, rating: user.rating, level: user.level };
    db.transaction(() => {
      if (num(coins)) db.prepare('UPDATE users SET coins = MAX(0, coins + ?) WHERE id = ?').run(num(coins), user.id);
      if (num(xp)) db.prepare('UPDATE users SET xp = MAX(0, xp + ?) WHERE id = ?').run(num(xp), user.id);
      if (num(rating)) db.prepare('UPDATE users SET rating = MAX(0, rating + ?) WHERE id = ?').run(num(rating), user.id);
      if (num(level)) db.prepare('UPDATE users SET level = MAX(1, level + ?) WHERE id = ?').run(num(level), user.id);
      if (petId) db.prepare('INSERT OR IGNORE INTO user_pets (user_id, pet_id) VALUES (?, ?)').run(user.id, petId);
      if (removePetId) db.prepare('DELETE FROM user_pets WHERE user_id = ? AND pet_id = ?').run(user.id, removePetId);
    })();
    const after = db.prepare('SELECT coins, xp, rating, level FROM users WHERE id = ?').get(user.id);
    balance.audit(req.user.id, 'grant', `user:${user.id}`, before, { ...after, petId, removePetId }, reason);
    res.json({ ok: true, user: after });
  } catch (e) { next(e); }
});

router.post('/users/:id/status', (req, res, next) => {
  try {
    const reason = requireReason(req);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) throw httpError(404, 'ユーザーが見つかりません');
    const status = req.body.status === 'suspended' ? 'suspended' : 'active';
    if (status === 'suspended' && user.is_admin) throw httpError(400, '管理者は停止できません(先に権限を外してください)');
    db.transaction(() => {
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, user.id);
      if (status === 'suspended') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id); // 停止は即時ログアウト
    })();
    balance.audit(req.user.id, 'set_status', `user:${user.id}`, { status: user.status }, { status }, reason);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** 管理者権限の付与・剥奪(権限分離。最後の1人は剥奪できない) */
router.post('/users/:id/admin', (req, res, next) => {
  try {
    const reason = requireReason(req);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) throw httpError(404, 'ユーザーが見つかりません');
    const isAdmin = req.body.isAdmin ? 1 : 0;
    if (!isAdmin) {
      const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND status = 'active'").get().n;
      if (admins <= 1) throw httpError(400, '管理者が0人になるため剥奪できません');
    }
    if (isAdmin && user.status !== 'active') throw httpError(400, '停止中のアカウントには付与できません');
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin, user.id);
    balance.audit(req.user.id, 'set_admin', `user:${user.id}`, { is_admin: user.is_admin }, { is_admin: isAdmin }, reason);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ─── 試合調査 ──────────────────────────────────────────────────

router.get('/matches', (req, res) => {
  const { sql, params } = rangeFilter(req, { prefix: 'm' });
  const where = ['m.ended_at IS NOT NULL'];
  const extra = [];
  if (req.query.result) { where.push('m.result = ?'); extra.push(String(req.query.result)); }
  if (req.query.userId) { where.push('(m.p1_id = ? OR m.p2_id = ?)'); extra.push(Number(req.query.userId), Number(req.query.userId)); }
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = db.prepare(
    `SELECT m.*, u1.name AS p1_name, u2.name AS p2_name FROM matches m
     JOIN users u1 ON u1.id = m.p1_id JOIN users u2 ON u2.id = m.p2_id
     WHERE ${where.join(' AND ')}${sql}
     ORDER BY m.started_at DESC LIMIT ?`,
  ).all(...extra, ...params, limit);
  // 決着理由は表示対象の試合ぶんだけ引く(match_events 全体は読まない)
  const placeholders = rows.map(() => '?').join(',');
  const reasons = rows.length === 0 ? {} : Object.fromEntries(
    db.prepare(`SELECT match_id, data_json FROM match_events WHERE type = 'match_end' AND match_id IN (${placeholders})`)
      .all(...rows.map(m => m.id))
      .map(r => [r.match_id, JSON.parse(r.data_json).reason]),
  );
  res.json({
    matches: rows.map(m => ({
      id: m.id, p1: m.p1_name, p2: m.p2_name, result: m.result, reason: reasons[m.id] || null,
      versionId: m.balance_version_id, startedAt: m.started_at, durationSec: m.duration_sec,
      p1Deck: JSON.parse(m.p1_deck_json), p2Deck: JSON.parse(m.p2_deck_json),
      ratings: [m.p1_rating_before, m.p1_rating_after, m.p2_rating_before, m.p2_rating_after],
    })),
  });
});

router.get('/matches/:id', (req, res, next) => {
  try {
    const m = db.prepare(
      `SELECT m.*, u1.name AS p1_name, u2.name AS p2_name FROM matches m
       JOIN users u1 ON u1.id = m.p1_id JOIN users u2 ON u2.id = m.p2_id WHERE m.id = ?`,
    ).get(req.params.id);
    if (!m) throw httpError(404, '試合が見つかりません');
    const events = db.prepare('SELECT t, type, data_json FROM match_events WHERE match_id = ? ORDER BY t, id').all(m.id)
      .map(e => ({ t: e.t, type: e.type, data: JSON.parse(e.data_json) }));
    res.json({ match: { ...m, p1Deck: JSON.parse(m.p1_deck_json), p2Deck: JSON.parse(m.p2_deck_json) }, events });
  } catch (e) { next(e); }
});

// ─── 分析 ──────────────────────────────────────────────────────

/**
 * KPI: 登録・アクティブ・試合数・決着理由・切断・レート分布。
 * 件数の増加に耐えるよう、集計は SQL 側で行う(全件をJSへ読み出さない)。
 */
router.get('/stats/overview', (req, res) => {
  const { sql, params } = rangeFilter(req, { column: 'started_at' });
  const joined = rangeFilter(req, { column: 'started_at', prefix: 'm' }); // JOIN 用(列名を m. で修飾)
  const matchWhere = `WHERE ended_at IS NOT NULL${sql}`;

  const agg = db.prepare(
    `SELECT COUNT(*) AS matches,
            SUM(CASE WHEN result = 'draw' THEN 1 ELSE 0 END) AS draws,
            AVG(duration_sec) AS avgDuration
     FROM matches ${matchWhere}`,
  ).get(...params);
  // 中央値は1列だけ取り出して求める(全カラムのロードは避ける)
  const median = db.prepare(
    `SELECT duration_sec AS d FROM matches ${matchWhere} AND duration_sec IS NOT NULL
     ORDER BY duration_sec LIMIT 1 OFFSET (SELECT COUNT(*) / 2 FROM matches ${matchWhere} AND duration_sec IS NOT NULL)`,
  ).get(...params, ...params);

  // 決着理由: 対象の試合に紐づくイベントだけを結合して数える
  const reasons = {};
  for (const r of db.prepare(
    `SELECT e.data_json FROM match_events e
     JOIN matches m ON m.id = e.match_id
     WHERE e.type = 'match_end' AND m.ended_at IS NOT NULL${joined.sql}`,
  ).all(...joined.params)) {
    const reason = JSON.parse(r.data_json).reason || 'unknown';
    reasons[reason] = (reasons[reason] || 0) + 1;
  }

  const byDay = db.prepare(
    `SELECT substr(started_at, 1, 10) AS day, COUNT(*) AS n FROM matches ${matchWhere} GROUP BY day ORDER BY day`,
  ).all(...params);

  const ratingBuckets = db.prepare(
    `SELECT (rating / 100) * 100 AS rating, COUNT(*) AS n FROM users
     WHERE matches_played > 0 GROUP BY rating ORDER BY rating`,
  ).all();

  const userAgg = db.prepare(
    `SELECT COUNT(*) AS users,
            SUM(CASE WHEN created_at    > datetime('now', '-1 day')  THEN 1 ELSE 0 END) AS newUsers24h,
            SUM(CASE WHEN created_at    > datetime('now', '-7 days') THEN 1 ELSE 0 END) AS newUsers7d,
            SUM(CASE WHEN last_login_at > datetime('now', '-1 day')  THEN 1 ELSE 0 END) AS activeUsers24h,
            SUM(CASE WHEN last_login_at > datetime('now', '-7 days') THEN 1 ELSE 0 END) AS activeUsers7d,
            SUM(disconnects) AS disconnects
     FROM users`,
  ).get();

  res.json({
    totals: {
      users: userAgg.users,
      newUsers24h: userAgg.newUsers24h || 0,
      newUsers7d: userAgg.newUsers7d || 0,
      activeUsers24h: userAgg.activeUsers24h || 0,
      activeUsers7d: userAgg.activeUsers7d || 0,
      matches: agg.matches,
      draws: agg.draws || 0,
      avgDurationSec: Math.round(agg.avgDuration || 0),
      medianDurationSec: Math.round(median?.d || 0),
      disconnects: userAgg.disconnects || 0,
    },
    endReasons: reasons,
    matchesByDay: byDay,
    ratingBuckets,
  });
});

/** ペット分析: 採用率・勝率・出撃・与ダメージ(期間/版で絞り込み) */
router.get('/stats/pets', (req, res) => {
  const { sql, params } = rangeFilter(req, { column: 'started_at' });
  const joinedFilter = rangeFilter(req, { column: 'started_at', prefix: 'm' });
  const matches = db.prepare(
    `SELECT id, result, p1_deck_json, p2_deck_json FROM matches WHERE result IN ('p1','p2','draw')${sql}`,
  ).all(...params);
  const ids = new Set(matches.map(m => m.id));
  const stats = {};
  const bump = (petId, key, n = 1) => {
    if (!stats[petId]) stats[petId] = { decks: 0, wins: 0, spawns: 0, damage: 0, facilityDamage: 0 };
    stats[petId][key] += n;
  };
  for (const m of matches) {
    const sides = [
      { deck: JSON.parse(m.p1_deck_json), won: m.result === 'p1' },
      { deck: JSON.parse(m.p2_deck_json), won: m.result === 'p2' },
    ];
    for (const s of sides) for (const petId of s.deck) {
      bump(petId, 'decks');
      if (s.won) bump(petId, 'wins');
    }
  }
  // 対象試合に紐づくイベントだけを取る(テーブル全体は読まない)
  const events = ids.size === 0 ? [] : db.prepare(
    `SELECT e.type, e.data_json FROM match_events e
     JOIN matches m ON m.id = e.match_id
     WHERE e.type IN ('spawn','damage_summary') AND m.result IN ('p1','p2','draw')${joinedFilter.sql}`,
  ).all(...joinedFilter.params);
  for (const e of events) {
    const d = JSON.parse(e.data_json);
    if (e.type === 'spawn' && d.petId) bump(d.petId, 'spawns', d.count || 1);
    if (e.type === 'damage_summary' && d.petId) {
      bump(d.petId, 'damage', d.damage || 0);
      bump(d.petId, 'facilityDamage', d.facilityDamage || 0);
    }
  }
  const { snapshot } = balance.getPublished();
  const meta = Object.fromEntries(snapshot.pets.map(p => [p.id, { name: p.name, cost: p.cost, rarity: p.rarity }]));
  res.json({ totalMatches: matches.length, stats, meta });
});

/** ガチャ分析: 排出実績と理論値の乖離・重複率・コイン収支 */
router.get('/stats/gacha', (req, res) => {
  const { sql, params } = rangeFilter(req, { column: 'created_at' });
  const pulls = db.prepare(`SELECT * FROM gacha_pulls WHERE 1=1${sql}`).all(...params);
  const { snapshot } = balance.getPublished();
  const theoretical = Object.fromEntries(gacha.rates(snapshot.gacha, snapshot.pets).map(r => [r.id, r.rate]));
  const byRarity = {};
  const byPet = {};
  let spent = 0;
  let refund = 0;
  for (const p of pulls) {
    byRarity[p.rarity] = byRarity[p.rarity] || { pulls: 0, duplicates: 0 };
    byRarity[p.rarity].pulls++;
    if (p.duplicate) byRarity[p.rarity].duplicates++;
    byPet[p.pet_id] = byPet[p.pet_id] || { pulls: 0, duplicates: 0 };
    byPet[p.pet_id].pulls++;
    if (p.duplicate) byPet[p.pet_id].duplicates++;
    spent += p.coins_spent;
    refund += p.coins_refund;
  }
  const petName = Object.fromEntries(snapshot.pets.map(p => [p.id, p.name]));
  res.json({
    totalPulls: pulls.length,
    coinsSpent: spent,
    coinsRefunded: refund,
    duplicateRate: pulls.length ? Math.round((pulls.filter(p => p.duplicate).length / pulls.length) * 1000) / 10 : 0,
    users: new Set(pulls.map(p => p.user_id)).size,
    rarities: Object.entries(byRarity).map(([id, v]) => ({
      id,
      pulls: v.pulls,
      duplicates: v.duplicates,
      actualRate: pulls.length ? Math.round((v.pulls / pulls.length) * 1000) / 10 : 0,
      theoreticalRate: theoretical[id] ?? 0,
    })),
    pets: Object.entries(byPet).map(([id, v]) => ({ id, name: petName[id] || id, ...v }))
      .sort((a, b) => b.pulls - a.pulls),
  });
});

/** 売上: IZ課金(期間別・ユーザー別) */
router.get('/stats/revenue', (req, res) => {
  const { sql, params } = rangeFilter(req, { column: 'created_at', versionColumn: null, prefix: 'p' });
  // 全件ロードを避けるため上限を設ける(既定5000件・期間で絞り込む前提)
  const limit = Math.min(Number(req.query.limit) || 5000, 20000);
  const rows = db.prepare(
    `SELECT p.*, u.name FROM iz_purchases p JOIN users u ON u.id = p.user_id WHERE 1=1${sql}
     ORDER BY p.created_at DESC LIMIT ?`,
  ).all(...params, limit);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM iz_purchases p WHERE 1=1${sql}`).get(...params).n;
  const byDay = {};
  const byUser = {};
  for (const r of rows) {
    const day = String(r.created_at).slice(0, 10);
    byDay[day] = (byDay[day] || 0) + r.iz_amount;
    byUser[r.user_id] = byUser[r.user_id] || { name: r.name, iz: 0, coins: 0, count: 0 };
    byUser[r.user_id].iz += r.iz_amount;
    byUser[r.user_id].coins += r.coins;
    byUser[r.user_id].count++;
  }
  res.json({
    totalIz: rows.reduce((a, r) => a + r.iz_amount, 0),
    totalCoins: rows.reduce((a, r) => a + r.coins, 0),
    count: rows.length,
    total, // 期間内の全件数(count が limit で切られている場合の目安)
    truncated: total > rows.length,
    payers: Object.keys(byUser).length,
    byDay: Object.entries(byDay).sort().map(([day, iz]) => ({ day, iz })),
    byUser: Object.entries(byUser).map(([id, v]) => ({ id: Number(id), ...v })).sort((a, b) => b.iz - a.iz).slice(0, 50),
    recent: rows.slice(0, 30),
  });
});

/**
 * バックアップ: 全テーブルをJSONで書き出す(セッションは除く)。
 * Durable Object の SQLite は Cloudflare 側で永続化されるが、
 * 論理的な事故(誤操作・誤ったバランス公開)に備えて手元へ保管できるようにする。
 * 対戦イベントは件数が多いので既定では含めない(?includeEvents=1 で含む)。
 */
router.get('/backup', (req, res) => {
  const dump = table => db.prepare(`SELECT * FROM ${table}`).all();
  const out = {
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    publishedVersionId: balance.getPublished().id,
    users: dump('users'),
    user_pets: dump('user_pets'),
    decks: dump('decks'),
    balance_versions: dump('balance_versions'),
    matches: dump('matches'),
    gacha_pulls: dump('gacha_pulls'),
    iz_purchases: dump('iz_purchases'),
    audit_log: dump('audit_log'),
  };
  if (req.query.includeEvents === '1') out.match_events = dump('match_events');
  res.setHeader('Content-Disposition', `attachment; filename="wanwan-backup-${out.exportedAt.slice(0, 10)}.json"`);
  res.json(out);
});

/** 稼働状況: 進行中の試合・マッチング待機・接続数 */
router.get('/live', (req, res) => {
  const rooms = [...mm.activeRooms.values()].map(r => ({
    id: r.id,
    practice: !!r.practice,
    versionId: r.balanceVersionId,
    elapsedSec: Math.round(r.battle.t),
    phase: r.battle.phase,
    players: r.players.map(p => ({ userId: p.userId, name: p.name, connected: p.connected })),
    mainHp: r.battle.players.map(p => Math.round(p.facilities.main.hp)),
  }));
  res.json({
    now: new Date().toISOString(),
    publishedVersionId: balance.getPublished().id,
    rooms,
    queue: mm.queueInfo(),
    roomCodes: mm.roomCodeInfo(),
    connections: rooms.reduce((a, r) => a + r.players.filter(p => p.connected && p.userId > 0).length, 0),
  });
});

module.exports = router;
