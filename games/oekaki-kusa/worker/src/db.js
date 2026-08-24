/**
 * Durable Object の SQLite に置く永続データ。
 *
 * 部屋(対戦中の状態)はメモリ上にしか持たない。ここに残すのは
 * アカウント・セッションと、**全員分のおえかき作品**(ギャラリー)だけ。
 *
 * 絵はビットマップではなく「作者IDつきのストローク列」で保存する。
 * 原作の「荒らしを追放するとその人の描いた線だけが消える」仕様から読み取った設計で、
 * 容量が小さく、あとから再生・巻き戻し・差分同期がすべてこれ1つで解ける。
 */

export class Db {
  constructor(sql) {
    this.sql = sql;
  }

  init() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      firebase_uid  TEXT UNIQUE,
      display_name  TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    )`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS drawings (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      display_name TEXT NOT NULL,
      topic_label  TEXT NOT NULL,
      strokes_json TEXT NOT NULL,
      stroke_count INTEGER NOT NULL DEFAULT 0,
      solved       INTEGER NOT NULL DEFAULT 0,
      solver_name  TEXT,
      room_code    TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_drawings_created ON drawings (id DESC)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_drawings_user ON drawings (user_id, id DESC)');
  }

  // ─── アカウント ──────────────────────────────────────────

  userByFirebaseUid(uid) {
    return this.sql.exec('SELECT * FROM users WHERE firebase_uid = ?', uid).toArray()[0] || null;
  }

  userById(id) {
    return this.sql.exec('SELECT * FROM users WHERE id = ?', id).toArray()[0] || null;
  }

  createUser(displayName, firebaseUid = null) {
    this.sql.exec(
      'INSERT INTO users (display_name, firebase_uid) VALUES (?, ?)',
      displayName,
      firebaseUid,
    );
    return this.sql.exec('SELECT last_insert_rowid() AS id').one().id;
  }

  touchLogin(id) {
    this.sql.exec("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", id);
  }

  setDisplayName(id, displayName) {
    this.sql.exec('UPDATE users SET display_name = ? WHERE id = ?', displayName, id);
  }

  // ─── セッション ──────────────────────────────────────────

  createSession(userId) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    this.sql.exec('INSERT INTO sessions (token, user_id) VALUES (?, ?)', token, userId);
    return token;
  }

  userByToken(token) {
    if (!token) return null;
    return (
      this.sql
        .exec(
          'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?',
          token,
        )
        .toArray()[0] || null
    );
  }

  // ─── ギャラリー ──────────────────────────────────────────

  /** 1枚保存して、保存した行の id を返す */
  saveDrawing({ userId, displayName, topicLabel, strokes, ar, solved, solverName, roomCode }) {
    this.sql.exec(
      `INSERT INTO drawings
        (user_id, display_name, topic_label, strokes_json, stroke_count, solved, solver_name, room_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      displayName,
      topicLabel,
      // ar(高さ/幅)も一緒に持つ。ギャラリーで元の絵と同じ形に再生するために要る
      JSON.stringify({ ar: ar || 4 / 3, strokes }),
      strokes.length,
      solved ? 1 : 0,
      solverName || null,
      roomCode || null,
    );
    return this.sql.exec('SELECT last_insert_rowid() AS id').one().id;
  }

  /**
   * ギャラリー一覧。`mine` に user_id を渡すとその人の作品だけ返す。
   * 一覧では strokes_json も返す(サムネイルを描くのに必要。ベクタなので軽い)。
   */
  listDrawings({ limit = 30, before = null, userId = null } = {}) {
    const lim = Math.min(Math.max(1, limit | 0), 60);
    let rows;
    if (userId && before) {
      rows = this.sql
        .exec('SELECT * FROM drawings WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?', userId, before, lim)
        .toArray();
    } else if (userId) {
      rows = this.sql
        .exec('SELECT * FROM drawings WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, lim)
        .toArray();
    } else if (before) {
      rows = this.sql
        .exec('SELECT * FROM drawings WHERE id < ? ORDER BY id DESC LIMIT ?', before, lim)
        .toArray();
    } else {
      rows = this.sql.exec('SELECT * FROM drawings ORDER BY id DESC LIMIT ?', lim).toArray();
    }
    return rows.map(publicDrawing);
  }

  countDrawings() {
    return this.sql.exec('SELECT COUNT(*) AS n FROM drawings').one().n;
  }
}

export function publicDrawing(row) {
  let ar = 4 / 3;
  let strokes = [];
  try {
    const parsed = JSON.parse(row.strokes_json);
    // 旧形式(配列そのもの)も読めるようにしておく
    if (Array.isArray(parsed)) {
      strokes = parsed;
    } else {
      strokes = parsed.strokes || [];
      if (parsed.ar) ar = parsed.ar;
    }
  } catch {
    strokes = [];
  }
  return {
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    topic: row.topic_label,
    ar,
    strokes,
    solved: !!row.solved,
    solverName: row.solver_name,
    createdAt: row.created_at,
  };
}

export function publicUser(row) {
  if (!row) return null;
  return { id: row.id, displayName: row.display_name, isIz: !!row.firebase_uid };
}
