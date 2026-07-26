/**
 * SQLite スキーマとシード。
 * バランス値は balance_versions のスナップショット(不変JSON)にのみ存在し、
 * コードへの直書きは禁止(design/spec.md §0)。
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.WANWAN_DB || path.join(__dirname, '..', 'wanwan.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  xp INTEGER NOT NULL DEFAULT 0,
  coins INTEGER NOT NULL DEFAULT 0,
  rating INTEGER NOT NULL DEFAULT 1000,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  disconnects INTEGER NOT NULL DEFAULT 0,
  matches_played INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_pets (
  user_id INTEGER NOT NULL REFERENCES users(id),
  pet_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, pet_id)
);
CREATE TABLE IF NOT EXISTS decks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  pets_json TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS balance_versions (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'draft',
  label TEXT NOT NULL DEFAULT '',
  snapshot_json TEXT NOT NULL,
  base_version_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  p1_id INTEGER NOT NULL,
  p2_id INTEGER NOT NULL,
  winner_id INTEGER,
  result TEXT,
  balance_version_id INTEGER NOT NULL,
  p1_deck_json TEXT NOT NULL,
  p2_deck_json TEXT NOT NULL,
  p1_rating_before INTEGER, p1_rating_after INTEGER,
  p2_rating_before INTEGER, p2_rating_after INTEGER,
  points_json TEXT,
  rewarded INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  duration_sec REAL
);
CREATE TABLE IF NOT EXISTS match_events (
  id INTEGER PRIMARY KEY,
  match_id TEXT NOT NULL,
  t REAL NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_match_events ON match_events(match_id, t);
CREATE TABLE IF NOT EXISTS iz_purchases (
  nonce TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  firebase_uid TEXT NOT NULL,
  iz_amount INTEGER NOT NULL,
  coins INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS gacha_pulls (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  balance_version_id INTEGER NOT NULL,
  pet_id TEXT NOT NULL,
  rarity TEXT NOT NULL,
  duplicate INTEGER NOT NULL DEFAULT 0,
  coins_spent INTEGER NOT NULL DEFAULT 0,
  coins_refund INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gacha_pulls_user ON gacha_pulls(user_id, id);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  admin_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// マイグレーション: IZ(Firebase)アカウント連携用の列
{
  const cols = db.prepare('PRAGMA table_info(users)').all();
  if (!cols.some(c => c.name === 'firebase_uid')) {
    db.exec('ALTER TABLE users ADD COLUMN firebase_uid TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid)');
  }
}

// マイグレーション: 公開予約(scheduled)の実行時刻
{
  const cols = db.prepare('PRAGMA table_info(balance_versions)').all();
  if (!cols.some(c => c.name === 'scheduled_at')) {
    db.exec('ALTER TABLE balance_versions ADD COLUMN scheduled_at TEXT');
  }
}

const SEED_PATH = path.join(__dirname, '..', '..', 'data', 'balance-initial.json');
const readSeed = () => JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));

/** 初回起動時: data/balance-initial.json を published 版としてシード */
function seedBalance() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM balance_versions').get().n;
  if (count > 0) return;
  const snapshot = fs.readFileSync(SEED_PATH, 'utf8');
  JSON.parse(snapshot); // validate
  db.prepare(
    `INSERT INTO balance_versions (status, label, snapshot_json, published_at)
     VALUES ('published', 'initial', ?, datetime('now'))`,
  ).run(snapshot);
  console.log('[db] 初期バランス版をシードしました');
}
seedBalance();

/**
 * マイグレーション: 既存のバランス版を現行スキーマへ寄せる(冪等)。
 * 調整済みの値は保持し、不足・廃止された項目だけを直す。
 *  - pets[].unlock を削除(コイン購入による解放を廃止しガチャへ移行)
 *  - pets[].rarity と gacha ブロックを初期バランスから補完
 *  - 実装のないアビリティ healLowestAlly を除去
 */
function migrateGacha() {
  const rows = db.prepare('SELECT id, snapshot_json FROM balance_versions').all();
  if (rows.length === 0) return;
  const seed = readSeed();
  const seedRarity = Object.fromEntries(seed.pets.map(p => [p.id, p.rarity]));
  const defaultRarity = seed.gacha.rarities[0].id;
  const update = db.prepare('UPDATE balance_versions SET snapshot_json = ? WHERE id = ?');
  let migrated = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const s = JSON.parse(row.snapshot_json);
      let changed = false;
      for (const p of s.pets || []) {
        if (p.unlock) { delete p.unlock; changed = true; }
        if (!p.rarity) { p.rarity = seedRarity[p.id] || defaultRarity; changed = true; }
      }
      if (!s.gacha) { s.gacha = seed.gacha; changed = true; }
      // healLowestAlly はエンジンに実装がない飾りデータだった(回復は attackType=heal + healPower)。
      // 残っているとアビリティ検証で保存できなくなるため取り除く。
      for (const p of s.pets || []) {
        if (p.abilities?.some(a => a.type === 'healLowestAlly')) {
          p.abilities = p.abilities.filter(a => a.type !== 'healLowestAlly');
          changed = true;
        }
      }
      if (changed) { update.run(JSON.stringify(s), row.id); migrated++; }
    }
  });
  tx();
  if (migrated > 0) console.log(`[db] ${migrated}件のバランス版をガチャ対応へ移行しました`);
}
migrateGacha();

module.exports = db;
