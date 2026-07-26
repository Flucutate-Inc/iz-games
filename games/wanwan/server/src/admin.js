/** 管理画面 API(バランスバージョン・監査ログ・アカウント運用・統計) */
const express = require('express');
const db = require('./db');
const balance = require('./balance');
const { requireAdmin, httpError } = require('./auth');

const router = express.Router();
router.use(requireAdmin);

router.get('/versions', (req, res) => {
  res.json({ versions: balance.listVersions(), publishedId: balance.getPublished().id });
});

router.get('/versions/:id', (req, res, next) => {
  try {
    const v = balance.getVersion(Number(req.params.id));
    if (!v) throw httpError(404, '版が見つかりません');
    const { snapshot_json, ...meta } = v;
    res.json(meta);
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
      balance.audit(req.user.id, 'update_draft', `version:${id}`, null, null, req.body.reason);
    }
    res.status(result.ok ? 200 : 400).json(result);
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

router.post('/versions/:id/publish', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const beforeId = balance.getPublished().id;
    balance.publish(id);
    balance.audit(req.user.id, 'publish', `version:${id}`, { publishedId: beforeId }, { publishedId: id }, req.body.reason);
    res.json({ ok: true, publishedId: id });
  } catch (e) { next(e); }
});

router.post('/versions/:id/rollback', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = balance.rollback(id, req.user.id);
    balance.audit(req.user.id, 'rollback', `version:${id}`, { rolledBackId: result.rolledBackId }, { newId: result.newId }, req.body.reason);
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.get('/audit', (req, res) => {
  const rows = db.prepare(
    `SELECT a.*, u.name AS admin_name FROM audit_log a JOIN users u ON u.id = a.admin_id
     ORDER BY a.id DESC LIMIT 100`,
  ).all();
  res.json({ audit: rows });
});

/** アカウント運用: 検索・付与・停止(依頼書 3.3) */
router.get('/users', (req, res) => {
  const q = `%${req.query.q || ''}%`;
  const users = db.prepare(
    'SELECT id, name, level, xp, coins, rating, wins, losses, status, created_at FROM users WHERE name LIKE ? ORDER BY id DESC LIMIT 50',
  ).all(q);
  res.json({ users });
});

router.post('/users/:id/grant', (req, res, next) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) throw httpError(404, 'ユーザーが見つかりません');
    const { coins, petId } = req.body;
    db.transaction(() => {
      if (coins) db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(Number(coins), user.id);
      if (petId) db.prepare('INSERT OR IGNORE INTO user_pets (user_id, pet_id) VALUES (?, ?)').run(user.id, petId);
    })();
    balance.audit(req.user.id, 'grant', `user:${user.id}`, null, { coins, petId }, req.body.reason);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/users/:id/status', (req, res, next) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) throw httpError(404, 'ユーザーが見つかりません');
    const status = req.body.status === 'suspended' ? 'suspended' : 'active';
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, user.id);
    balance.audit(req.user.id, 'set_status', `user:${user.id}`, { status: user.status }, { status }, req.body.reason);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** 分析: ペット採用率・勝率・出撃数・与ダメージ(依頼書 3.4) */
router.get('/stats/pets', (req, res) => {
  const matches = db.prepare("SELECT * FROM matches WHERE result IN ('p1','p2','draw')").all();
  const stats = {}; // petId -> {decks, wins, spawns, damage, facilityDamage}
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
  const events = db.prepare("SELECT type, data_json FROM match_events WHERE type IN ('spawn','damage_summary')").all();
  for (const e of events) {
    const d = JSON.parse(e.data_json);
    if (e.type === 'spawn' && d.petId) bump(d.petId, 'spawns');
    if (e.type === 'damage_summary' && d.petId) {
      bump(d.petId, 'damage', d.damage || 0);
      bump(d.petId, 'facilityDamage', d.facilityDamage || 0);
    }
  }
  res.json({ totalMatches: matches.length, stats });
});

module.exports = router;
