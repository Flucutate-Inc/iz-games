/**
 * 認証(表示名+パスワード、scrypt)。方式は依頼書で未確定のため最小構成
 * (design/spec.md §9)。初期管理者の付与は isAdminBootstrap() を参照。
 */
const crypto = require('crypto');
const db = require('./db');
const balance = require('./balance');

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function register(name, password, adminToken) {
  if (typeof name !== 'string' || !/^[\w\-ぁ-んァ-ヶ一-龠ー]{2,16}$/u.test(name)) {
    throw httpError(400, '表示名は2〜16文字(英数・かな・漢字)で入力してください');
  }
  if (typeof password !== 'string' || password.length < 6) {
    throw httpError(400, 'パスワードは6文字以上にしてください');
  }
  const exists = db.prepare('SELECT id FROM users WHERE name = ?').get(name);
  if (exists) throw httpError(409, 'その表示名は使用されています');

  const salt = crypto.randomBytes(16).toString('hex');
  const userId = createUserWithGrants({
    name, passHash: hashPassword(password, salt), salt, isAdmin: isAdminBootstrap(adminToken),
  });
  return createSession(userId);
}

/**
 * 初期管理者の付与判定。
 *
 * 公開URLでは「最初に登録した人が管理者」も「特定の表示名なら管理者」も危険
 * (前者は第三者に先を越され、後者は表示名を知られると先に取られる)。
 * そのため **デプロイ時に設定した秘密トークン `WANWAN_ADMIN_TOKEN` を
 * 登録リクエストに添えた場合のみ** 管理者にする(タイミング安全比較)。
 * トークンが設定されている間は「最初の登録者」ルールを完全に無効化する。
 *
 * トークン未設定のときだけ、ローカル検証用に最初の登録者を管理者にする。
 * 初期管理者を作ったらトークンは環境変数から外すこと(以後の付与は管理画面から)。
 */
function isAdminBootstrap(adminToken) {
  const expected = process.env.WANWAN_ADMIN_TOKEN || '';
  if (expected) {
    if (typeof adminToken !== 'string' || adminToken.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(adminToken), Buffer.from(expected));
  }
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
}

/** 初期4体+初期デッキ付き(ACC-01)でユーザーを作成する共通処理 */
function createUserWithGrants({ name, passHash, salt, firebaseUid = null, isAdmin = false }) {
  const prog = balance.getPublished().snapshot.progression;
  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO users (name, pass_hash, salt, is_admin, coins, rating, firebase_uid) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, passHash, salt, isAdmin ? 1 : 0, prog.initialCoins, 1000, firebaseUid);
    const userId = info.lastInsertRowid;
    const addPet = db.prepare('INSERT INTO user_pets (user_id, pet_id) VALUES (?, ?)');
    for (const petId of prog.initialPets) addPet.run(userId, petId);
    db.prepare('INSERT INTO decks (user_id, name, pets_json, selected) VALUES (?, ?, ?, 1)').run(
      userId,
      'はじめてのデッキ',
      JSON.stringify(prog.initialPets),
    );
    return userId;
  });
  return tx();
}

/**
 * IZ(Firebase)アカウントでのログイン。検証済み uid でユーザーを検索し、
 * 無ければ表示名から自動作成する(パスワードなしアカウント)。
 */
function loginWithFirebase(uid, displayName) {
  const existing = db.prepare('SELECT * FROM users WHERE firebase_uid = ?').get(uid);
  if (existing) {
    if (existing.status !== 'active') throw httpError(403, 'このアカウントは停止されています');
    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(existing.id);
    return createSession(existing.id);
  }
  // 表示名をゲームの命名規則に合わせて整形し、衝突時はサフィックスを付ける
  const base = (String(displayName || '').match(/[\w\-ぁ-んァ-ヶ一-龠ー]/gu) || []).join('').slice(0, 12) || 'わんこ';
  let name = base;
  while (db.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) {
    name = `${base}_${crypto.randomInt(100, 9999)}`.slice(0, 16);
  }
  const userId = createUserWithGrants({ name, passHash: '', salt: '', firebaseUid: uid });
  return createSession(userId);
}

function login(name, password) {
  const user = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
  // pass_hash が空のアカウントは IZ 連携専用(パスワードログイン不可)
  if (!user || !user.pass_hash || hashPassword(password, user.salt) !== user.pass_hash) {
    throw httpError(401, '表示名またはパスワードが違います');
  }
  if (user.status !== 'active') throw httpError(403, 'このアカウントは停止されています');
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  return createSession(user.id);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  return { token, user: publicUser(userId) };
}

function logout(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function userByToken(token) {
  if (!token) return null;
  const row = db
    .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?')
    .get(token);
  return row && row.status === 'active' ? row : null;
}

function publicUser(id) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return null;
  const { pass_hash, salt, ...rest } = u;
  return rest;
}

/** express ミドルウェア */
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = userByToken(token);
  if (!user) return res.status(401).json({ error: '認証が必要です' });
  req.user = user;
  req.token = token;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.is_admin) return res.status(403).json({ error: '管理者権限が必要です' });
    next();
  });
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { register, login, loginWithFirebase, logout, userByToken, publicUser, requireAuth, requireAdmin, httpError };
