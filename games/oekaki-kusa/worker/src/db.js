/**
 * Durable Object の SQLite に置く永続データ。
 *
 * 部屋(対戦中の状態)はメモリ上にしか持たない。ここに残すのは
 * アカウント・セッションと、**投稿された**おえかき作品(ギャラリー)だけ。
 *
 * 絵はビットマップではなく「作者IDつきのストローク列」で保存する。
 * 原作の「荒らしを追放するとその人の描いた線だけが消える」仕様から読み取った設計で、
 * 容量が小さく、あとから再生・巻き戻し・差分同期がすべてこれ1つで解ける。
 *
 * ギャラリーへの公開は2通り(研究 命題6「承認は他人経由でしか得られず、公開は本人が決める」):
 *   - quiz: 対戦後の推薦コーナーで誰かに推薦された作品だけ、本人が投稿を選べる
 *   - solo: 1人で描いた作品。他人の承認を待つ相手がいないので、本人の判断で即公開する
 * どちらも `posted = 1` になったものだけがギャラリーに並ぶ。
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
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL,
      display_name  TEXT NOT NULL,
      topic_label   TEXT NOT NULL,
      strokes_json  TEXT NOT NULL,
      stroke_count  INTEGER NOT NULL DEFAULT 0,
      solved        INTEGER NOT NULL DEFAULT 0,
      solver_name   TEXT,
      room_code     TEXT,
      mode          TEXT NOT NULL DEFAULT 'quiz', -- 'quiz' | 'solo'
      posted        INTEGER NOT NULL DEFAULT 0,   -- ギャラリーに公開済みか
      comments_json TEXT,                          -- 推薦コメント(本人が採用したものだけ)
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      posted_at     TEXT
    )`);

    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_drawings_posted ON drawings (posted, id DESC)');
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

  /**
   * 1枚保存して、保存した行の id を返す。
   * `posted` を渡さなければ非公開(0)で保存され、あとから `postDrawing` で公開する。
   * solo モードはここで posted: true を渡して即公開する。
   */
  saveDrawing({ userId, displayName, topicLabel, strokes, ar, solved, solverName, roomCode, mode, posted, comments }) {
    const isPosted = posted ? 1 : 0;
    this.sql.exec(
      `INSERT INTO drawings
        (user_id, display_name, topic_label, strokes_json, stroke_count, solved, solver_name,
         room_code, mode, posted, comments_json, posted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      displayName,
      topicLabel,
      // ar(高さ/幅)も一緒に持つ。ギャラリーで元の絵と同じ形に再生するために要る
      JSON.stringify({ ar: ar || 4 / 3, strokes }),
      strokes.length,
      solved ? 1 : 0,
      solverName || null,
      roomCode || null,
      mode || 'quiz',
      isPosted,
      comments && comments.length ? JSON.stringify(comments) : null,
      isPosted ? new Date().toISOString() : null,
    );
    return this.sql.exec('SELECT last_insert_rowid() AS id').one().id;
  }

  /** 推薦コーナーを経て、本人が「投稿する」を選んだときに呼ぶ */
  postDrawing(id, comments) {
    this.sql.exec(
      `UPDATE drawings SET posted = 1, comments_json = ?, posted_at = datetime('now') WHERE id = ?`,
      comments && comments.length ? JSON.stringify(comments) : null,
      id,
    );
  }

  drawingById(id) {
    const row = this.sql.exec('SELECT * FROM drawings WHERE id = ?', id).toArray()[0];
    return row ? publicDrawing(row) : null;
  }

  /**
   * ギャラリー一覧。`mine` に user_id を渡すとその人の作品だけ返す(未公開含む、自分の控え)。
   * それ以外は **公開済み(posted=1)のものだけ**。
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
        .exec('SELECT * FROM drawings WHERE posted = 1 AND id < ? ORDER BY id DESC LIMIT ?', before, lim)
        .toArray();
    } else {
      rows = this.sql.exec('SELECT * FROM drawings WHERE posted = 1 ORDER BY id DESC LIMIT ?', lim).toArray();
    }
    return rows.map(publicDrawing);
  }

  /** ホーム画面の背景などに使う、公開済み作品からのランダム抽出 */
  randomDrawings(n = 6) {
    const lim = Math.min(Math.max(1, n | 0), 20);
    return this.sql
      .exec('SELECT * FROM drawings WHERE posted = 1 ORDER BY RANDOM() LIMIT ?', lim)
      .toArray()
      .map(publicDrawing);
  }

  countDrawings() {
    return this.sql.exec('SELECT COUNT(*) AS n FROM drawings WHERE posted = 1').one().n;
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
  let comments = [];
  if (row.comments_json) {
    try {
      comments = JSON.parse(row.comments_json);
    } catch {
      comments = [];
    }
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
    mode: row.mode || 'quiz',
    posted: !!row.posted,
    comments,
    createdAt: row.created_at,
  };
}

export function publicUser(row) {
  if (!row) return null;
  return { id: row.id, displayName: row.display_name, isIz: !!row.firebase_uid };
}
