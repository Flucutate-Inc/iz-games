/**
 * Durable Object の SQLite に置く永続データ。
 *
 * 部屋(対戦中の状態)はメモリ上にしか持たない。ここに残すのは
 * アカウント・セッションと、**描かれた作品すべて**(ギャラリー)、
 * そしていいね・コメントだけ。
 *
 * 絵はビットマップではなく「作者IDつきのストローク列」で保存する。
 * 原作の「荒らしを追放するとその人の描いた線だけが消える」仕様から読み取った設計で、
 * 容量が小さく、あとから再生・巻き戻し・差分同期がすべてこれ1つで解ける。
 *
 * 対戦で描いた絵も、1人で描いた絵も、**描いた時点で全部ギャラリーに並ぶ**。
 * 対戦の最後にある推薦コーナー(game.js)は「公開してよいかの審査」ではなく、
 * 推薦されたコメントをその絵にそのまま添える、という位置づけ。
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
      posted        INTEGER NOT NULL DEFAULT 0,   -- 旧スキーマの名残(未使用。読み書きしない)
      comments_json TEXT,                          -- 同上
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      posted_at     TEXT
    )`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_drawings_created ON drawings (id DESC)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_drawings_user ON drawings (user_id, id DESC)');

    this.sql.exec(`CREATE TABLE IF NOT EXISTS likes (
      drawing_id INTEGER NOT NULL,
      user_id    INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (drawing_id, user_id)
    )`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_likes_drawing ON likes (drawing_id)');

    this.sql.exec(`CREATE TABLE IF NOT EXISTS comments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      drawing_id   INTEGER NOT NULL,
      user_id      INTEGER,
      display_name TEXT NOT NULL,
      text         TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_comments_drawing ON comments (drawing_id, id)');

    // 月間絵しりとり。month('2026-08') ごとに1本のチェーンを seq でつなぐ。
    // guessed_prev は「前の絵をなんと読んだか」(2枚目以降)。前の人の実際のことばと
    // ズレていてもしりとりは続く(ズレそのものが面白さ)。
    this.sql.exec(`CREATE TABLE IF NOT EXISTS shiritori_entries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      month        TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      user_id      INTEGER NOT NULL,
      display_name TEXT NOT NULL,
      word         TEXT NOT NULL,
      guessed_prev TEXT,
      strokes_json TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (month, seq)
    )`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_shiritori_month ON shiritori_entries (month, seq)');
    // 旧スキーマ(guessed_prev なし)で作られた既存デプロイへの追いつき
    try {
      this.sql.exec('ALTER TABLE shiritori_entries ADD COLUMN guessed_prev TEXT');
    } catch {
      /* すでにある */
    }
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

  /** 1枚保存して、保存した行の id を返す。描いた時点で誰でも見られる。 */
  saveDrawing({ userId, displayName, topicLabel, strokes, ar, solved, solverName, roomCode, mode }) {
    this.sql.exec(
      `INSERT INTO drawings
        (user_id, display_name, topic_label, strokes_json, stroke_count, solved, solver_name, room_code, mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
    return this.sql.exec('SELECT last_insert_rowid() AS id').one().id;
  }

  drawingById(id, viewerId = null) {
    const row = this.selectWithCounts('WHERE d.id = ?', [id], viewerId)[0];
    return row ? publicDrawing(row) : null;
  }

  /**
   * ギャラリー一覧。`mine` に user_id を渡すとその人の作品だけ返す。
   * `viewerId` は「自分がいいね済みか」を判定するためのもので、見る人がログインしていれば渡す。
   */
  listDrawings({ limit = 30, before = null, userId = null, viewerId = null } = {}) {
    const lim = Math.min(Math.max(1, limit | 0), 60);
    const conds = [];
    const params = [];
    if (userId) {
      conds.push('d.user_id = ?');
      params.push(userId);
    }
    if (before) {
      conds.push('d.id < ?');
      params.push(before);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = this.selectWithCounts(where, params, viewerId, lim);
    return rows.map(publicDrawing);
  }

  /** ホーム画面の背景などに使う、作品からのランダム抽出 */
  randomDrawings(n = 6) {
    const lim = Math.min(Math.max(1, n | 0), 20);
    return this.sql
      .exec('SELECT * FROM drawings ORDER BY RANDOM() LIMIT ?', lim)
      .toArray()
      .map(publicDrawing);
  }

  countDrawings() {
    return this.sql.exec('SELECT COUNT(*) AS n FROM drawings').one().n;
  }

  /** like_count / comment_count / liked_by_me を付けて drawings を引く共通クエリ */
  selectWithCounts(where, params, viewerId, limit = null) {
    const sql = `
      SELECT d.*,
        (SELECT COUNT(*) FROM likes l WHERE l.drawing_id = d.id) AS like_count,
        (SELECT COUNT(*) FROM comments c WHERE c.drawing_id = d.id) AS comment_count,
        EXISTS(SELECT 1 FROM likes l WHERE l.drawing_id = d.id AND l.user_id = ?) AS liked_by_me
      FROM drawings d
      ${where}
      ORDER BY d.id DESC
      ${limit ? 'LIMIT ?' : ''}
    `;
    const args = [viewerId || 0, ...params, ...(limit ? [limit] : [])];
    return this.sql.exec(sql, ...args).toArray();
  }

  // ─── いいね ──────────────────────────────────────────────

  /** 推薦コーナー用: 付けるだけ(すでに付いていれば何もしない) */
  toggleLikeOn(drawingId, userId) {
    this.sql.exec(
      'INSERT OR IGNORE INTO likes (drawing_id, user_id) VALUES (?, ?)',
      drawingId,
      userId,
    );
  }

  /** トグルする。結果として今どうなったかを返す */
  toggleLike(drawingId, userId) {
    const existing = this.sql
      .exec('SELECT 1 FROM likes WHERE drawing_id = ? AND user_id = ?', drawingId, userId)
      .toArray()[0];
    if (existing) {
      this.sql.exec('DELETE FROM likes WHERE drawing_id = ? AND user_id = ?', drawingId, userId);
    } else {
      this.sql.exec('INSERT INTO likes (drawing_id, user_id) VALUES (?, ?)', drawingId, userId);
    }
    const count = this.sql.exec('SELECT COUNT(*) AS n FROM likes WHERE drawing_id = ?', drawingId).one().n;
    return { liked: !existing, count };
  }

  // ─── コメント ────────────────────────────────────────────

  addComment(drawingId, userId, displayName, text) {
    this.sql.exec(
      'INSERT INTO comments (drawing_id, user_id, display_name, text) VALUES (?, ?, ?, ?)',
      drawingId,
      userId,
      displayName,
      text,
    );
    const row = this.sql
      .exec('SELECT * FROM comments WHERE id = last_insert_rowid()')
      .toArray()[0];
    return publicComment(row);
  }

  listComments(drawingId, limit = 100) {
    return this.sql
      .exec('SELECT * FROM comments WHERE drawing_id = ? ORDER BY id ASC LIMIT ?', drawingId, limit)
      .toArray()
      .map(publicComment);
  }

  drawingExists(id) {
    return !!this.sql.exec('SELECT 1 FROM drawings WHERE id = ?', id).toArray()[0];
  }

  // ─── 月間絵しりとり ──────────────────────────────────────

  shiritoriLast(month) {
    const row = this.sql
      .exec('SELECT * FROM shiritori_entries WHERE month = ? ORDER BY seq DESC LIMIT 1', month)
      .toArray()[0];
    return row ? publicShiritoriEntry(row) : null;
  }

  shiritoriChain(month) {
    return this.sql
      .exec('SELECT * FROM shiritori_entries WHERE month = ? ORDER BY seq ASC', month)
      .toArray()
      .map(publicShiritoriEntry);
  }

  shiritoriParticipated(month, userId) {
    return !!this.sql
      .exec('SELECT 1 FROM shiritori_entries WHERE month = ? AND user_id = ? LIMIT 1', month, userId)
      .toArray()[0];
  }

  /**
   * 1枚つなぐ。seq の UNIQUE 制約で同時投稿の後勝ちを防ぐ
   * (DO はシングルスレッドなので実際には API 層の prevSeq 検査で先に弾かれる)。
   */
  shiritoriAppend({ month, seq, userId, displayName, word, guessedPrev, strokes, ar }) {
    this.sql.exec(
      `INSERT INTO shiritori_entries (month, seq, user_id, display_name, word, guessed_prev, strokes_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      month,
      seq,
      userId,
      displayName,
      word,
      guessedPrev || null,
      JSON.stringify({ ar: ar || 4 / 3, strokes }),
    );
    const row = this.sql
      .exec('SELECT * FROM shiritori_entries WHERE id = last_insert_rowid()')
      .toArray()[0];
    return publicShiritoriEntry(row);
  }
}

export function publicShiritoriEntry(row) {
  let ar = 4 / 3;
  let strokes = [];
  try {
    const parsed = JSON.parse(row.strokes_json);
    strokes = parsed.strokes || [];
    if (parsed.ar) ar = parsed.ar;
  } catch {
    strokes = [];
  }
  return {
    seq: row.seq,
    userId: row.user_id,
    displayName: row.display_name,
    word: row.word,
    guessedPrev: row.guessed_prev || null,
    ar,
    strokes,
    createdAt: row.created_at,
  };
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
    mode: row.mode || 'quiz',
    likeCount: row.like_count || 0,
    likedByMe: !!row.liked_by_me,
    commentCount: row.comment_count || 0,
    createdAt: row.created_at,
  };
}

export function publicComment(row) {
  return {
    id: row.id,
    drawingId: row.drawing_id,
    userId: row.user_id,
    displayName: row.display_name,
    text: row.text,
    createdAt: row.created_at,
  };
}

export function publicUser(row) {
  if (!row) return null;
  return { id: row.id, displayName: row.display_name, isIz: !!row.firebase_uid };
}
