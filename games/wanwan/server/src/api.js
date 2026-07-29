/** プレイヤー向け REST API */
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const balance = require('./balance');
const gacha = require('./gacha');
const { register, login, loginWithFirebase, logout, publicUser, requireAuth, httpError } = require('./auth');
const { verifyIdToken, ALLOWED_PROJECTS } = require('./firebase-auth');
const receipts = require('./receipt');

const router = express.Router();

router.post('/register', (req, res, next) => {
  try {
    // adminToken は初期管理者を作るときだけ使う(WANWAN_ADMIN_TOKEN と一致した場合のみ)
    res.json(register(req.body.name, req.body.password, req.body.adminToken));
  } catch (e) { next(e); }
});

router.post('/login', (req, res, next) => {
  try {
    res.json(login(req.body.name, req.body.password));
  } catch (e) { next(e); }
});

/**
 * IZ アカウントでの自動ログイン。
 * IZ ホスト(iz:getIdToken)から受け取った Firebase ID トークンを署名検証し、
 * uid に紐づくアカウントを検索または自動作成する。
 */
router.post('/login-iz', async (req, res, next) => {
  try {
    const payload = await verifyIdToken(req.body.idToken);
    res.json(loginWithFirebase(payload.sub, req.body.displayName || payload.name || ''));
  } catch (e) {
    next(e.status ? e : httpError(401, `IZログインに失敗しました: ${e.message}`));
  }
});

/**
 * IZ連携の設定(クライアントの自己診断用)。
 * 自動ログインに失敗したとき、アプリのトークンの aud とここを突き合わせれば
 * 「別のFirebaseプロジェクトのアプリから来ている」ことが即座に分かる。
 */
router.get('/iz-config', (req, res) => {
  res.json({ firebaseProjects: ALLOWED_PROJECTS });
});

router.post('/logout', requireAuth, (req, res) => {
  logout(req.token);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user.id), levelXp: levelInfo(req.user) });
});

function levelInfo(user) {
  const { base, perLevel } = balance.getPublished().snapshot.progression.levelXp;
  const need = base + (user.level - 1) * perLevel;
  return { current: user.xp, needed: need };
}

/** 図鑑: 全ペット(未所有も性能閲覧可)+所有状態 */
router.get('/pets', requireAuth, (req, res) => {
  const { snapshot } = balance.getPublished();
  const owned = new Set(db.prepare('SELECT pet_id FROM user_pets WHERE user_id = ?').all(req.user.id).map(r => r.pet_id));
  const pets = snapshot.pets
    .filter(p => p.released)
    .map(p => ({ ...p, owned: owned.has(p.id) }));
  // 図鑑では施設と強化設定も返す。値はすべて「実際に対戦で使われる公開バランス版」から取る。
  res.json({
    pets,
    facilities: snapshot.facilities,
    upgrades: snapshot.upgrades || null,
    rules: snapshot.rules,
    balanceVersionId: balance.getPublished().id,
  });
});

// ─── ガチャ ───────────────────────────────────────────────────
// 新しいペットはガチャでのみ入手する(コインでの個別購入=解放は廃止)。

/** ガチャの排出率・コスト・ラインナップ */
router.get('/gacha', requireAuth, (req, res) => {
  const { id, snapshot } = balance.getPublished();
  const owned = new Set(db.prepare('SELECT pet_id FROM user_pets WHERE user_id = ?').all(req.user.id).map(r => r.pet_id));
  const petById = Object.fromEntries(snapshot.pets.map(p => [p.id, p]));
  const rarities = gacha.rates(snapshot.gacha, snapshot.pets).map(r => ({
    ...r,
    pets: r.petIds.map(petId => ({ id: petId, name: petById[petId].name, cost: petById[petId].cost, owned: owned.has(petId) })),
  }));
  res.json({
    singleCost: snapshot.gacha.singleCost,
    multiCount: snapshot.gacha.multiCount,
    multiCost: snapshot.gacha.multiCost,
    multiGuaranteeRarity: snapshot.gacha.multiGuaranteeRarity || null,
    rarities,
    coins: req.user.coins,
    balanceVersionId: id,
  });
});

/** ガチャを引く。抽選・コイン増減はすべてサーバーで確定する */
router.post('/gacha/draw', requireAuth, (req, res, next) => {
  try {
    const { id: versionId, snapshot } = balance.getPublished();
    const conf = snapshot.gacha;
    const count = Number(req.body.count) || 1;
    const cost = gacha.costFor(conf, count);
    if (cost == null) throw httpError(400, `引ける回数は1回または${conf.multiCount}回です`);
    if (req.user.coins < cost) throw httpError(402, `コインが足りません(必要: ${cost})`);

    const owned = db.prepare('SELECT pet_id FROM user_pets WHERE user_id = ?').all(req.user.id).map(r => r.pet_id);
    const { results, newPetIds, refundCoins } = gacha.draw({
      gacha: conf,
      pets: snapshot.pets,
      owned,
      count,
      rng: () => crypto.randomInt(0, 2 ** 30) / 2 ** 30,
    });

    db.transaction(() => {
      db.prepare('UPDATE users SET coins = coins - ? + ? WHERE id = ?').run(cost, refundCoins, req.user.id);
      const addPet = db.prepare('INSERT INTO user_pets (user_id, pet_id) VALUES (?, ?)');
      for (const petId of newPetIds) addPet.run(req.user.id, petId);
      const log = db.prepare(
        `INSERT INTO gacha_pulls (user_id, balance_version_id, pet_id, rarity, duplicate, coins_spent, coins_refund)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      results.forEach((r, i) => {
        log.run(req.user.id, versionId, r.petId, r.rarity, r.duplicate ? 1 : 0, i === 0 ? cost : 0, r.coins);
      });
    })();

    const petById = Object.fromEntries(snapshot.pets.map(p => [p.id, p]));
    res.json({
      results: results.map(r => ({ ...r, name: petById[r.petId].name, cost: petById[r.petId].cost })),
      spent: cost,
      refunded: refundCoins,
      user: publicUser(req.user.id),
    });
  } catch (e) { next(e); }
});

/** ガチャ履歴(直近50件) */
router.get('/gacha/history', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT pet_id, rarity, duplicate, coins_refund, created_at FROM gacha_pulls WHERE user_id = ? ORDER BY id DESC LIMIT 50',
  ).all(req.user.id);
  res.json({
    history: rows.map(r => ({
      petId: r.pet_id, rarity: r.rarity, duplicate: !!r.duplicate, coins: r.coins_refund, at: r.created_at,
    })),
  });
});

/** デッキ一覧 */
router.get('/decks', requireAuth, (req, res) => {
  const decks = db.prepare('SELECT * FROM decks WHERE user_id = ?').all(req.user.id)
    .map(d => ({ id: d.id, name: d.name, pets: JSON.parse(d.pets_json), selected: !!d.selected }));
  res.json({ decks });
});

/** デッキ保存(新規/更新)。所有ペットのみ・4〜8体・重複不可(受入基準 DECK-01) */
router.post('/decks', requireAuth, (req, res, next) => {
  try {
    const { id, name, pets } = req.body;
    const rules = balance.getPublished().snapshot.rules;
    if (!Array.isArray(pets)) throw httpError(400, 'pets が必要です');
    if (pets.length < rules.deck.min || pets.length > rules.deck.max) {
      throw httpError(400, `デッキは${rules.deck.min}〜${rules.deck.max}体です`);
    }
    if (new Set(pets).size !== pets.length) throw httpError(400, '同じペットは複数入れられません');
    const owned = new Set(db.prepare('SELECT pet_id FROM user_pets WHERE user_id = ?').all(req.user.id).map(r => r.pet_id));
    for (const petId of pets) {
      if (!owned.has(petId)) throw httpError(403, `未所有のペットです: ${petId}`);
    }
    const petsJson = JSON.stringify(pets);
    let deckId = id;
    if (id) {
      const deck = db.prepare('SELECT * FROM decks WHERE id = ? AND user_id = ?').get(id, req.user.id);
      if (!deck) throw httpError(404, 'デッキが見つかりません');
      db.prepare('UPDATE decks SET name = ?, pets_json = ? WHERE id = ?').run(name || deck.name, petsJson, id);
    } else {
      deckId = db.prepare('INSERT INTO decks (user_id, name, pets_json) VALUES (?, ?, ?)').run(
        req.user.id, name || '新しいデッキ', petsJson,
      ).lastInsertRowid;
    }
    res.json({ ok: true, id: deckId });
  } catch (e) { next(e); }
});

router.post('/decks/:id/select', requireAuth, (req, res, next) => {
  try {
    const deck = db.prepare('SELECT * FROM decks WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!deck) throw httpError(404, 'デッキが見つかりません');
    db.transaction(() => {
      db.prepare('UPDATE decks SET selected = 0 WHERE user_id = ?').run(req.user.id);
      db.prepare('UPDATE decks SET selected = 1 WHERE id = ?').run(deck.id);
    })();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/decks/:id', requireAuth, (req, res, next) => {
  try {
    const deck = db.prepare('SELECT * FROM decks WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!deck) throw httpError(404, 'デッキが見つかりません');
    if (deck.selected) throw httpError(400, '選択中のデッキは削除できません');
    db.prepare('DELETE FROM decks WHERE id = ?').run(deck.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** 対戦履歴 */
router.get('/history', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT m.*, u1.name AS p1_name, u2.name AS p2_name FROM matches m
     JOIN users u1 ON u1.id = m.p1_id JOIN users u2 ON u2.id = m.p2_id
     WHERE (m.p1_id = ? OR m.p2_id = ?) AND m.ended_at IS NOT NULL
     ORDER BY m.started_at DESC LIMIT 30`,
  ).all(req.user.id, req.user.id);
  const history = rows.map(m => {
    const isP1 = m.p1_id === req.user.id;
    return {
      id: m.id,
      opponent: isP1 ? m.p2_name : m.p1_name,
      result: m.result === 'draw' ? 'draw' : m.winner_id === req.user.id ? 'win' : m.result === 'invalid' ? 'invalid' : 'lose',
      myDeck: JSON.parse(isP1 ? m.p1_deck_json : m.p2_deck_json),
      ratingBefore: isP1 ? m.p1_rating_before : m.p2_rating_before,
      ratingAfter: isP1 ? m.p1_rating_after : m.p2_rating_after,
      startedAt: m.started_at,
      durationSec: m.duration_sec,
      points: m.points_json ? JSON.parse(m.points_json) : null,
    };
  });
  res.json({ history });
});

/** 試合の主要イベントログ(LOG-01) */
router.get('/history/:matchId/events', requireAuth, (req, res, next) => {
  try {
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.matchId);
    if (!m || (m.p1_id !== req.user.id && m.p2_id !== req.user.id)) throw httpError(404, '試合が見つかりません');
    const events = db.prepare('SELECT t, type, data_json FROM match_events WHERE match_id = ? ORDER BY t').all(m.id)
      .map(e => ({ t: e.t, type: e.type, data: JSON.parse(e.data_json) }));
    res.json({ events, balanceVersionId: m.balance_version_id });
  } catch (e) { next(e); }
});

/**
 * IZ 課金でゲーム内コインを購入する(IZアプリ内でのみ利用可能)。
 * IZ の残高移動は IZ 側サーバーが行い、ここでは署名済みレシートを検証して付与するだけ。
 * nonce を主キーにした INSERT で二重付与を防ぐ。
 */
router.post('/purchase', requireAuth, (req, res, next) => {
  try {
    if (!receipts.isEnabled()) throw httpError(503, 'IZ課金は現在利用できません');
    if (!req.user.firebase_uid) throw httpError(403, 'IZアカウントでログインしている場合のみ購入できます');
    let receipt;
    try {
      receipt = receipts.verifyReceipt(req.body.receipt);
    } catch (e) {
      throw httpError(400, e.message);
    }
    if (receipt.uid !== req.user.firebase_uid) throw httpError(403, '他のアカウントのレシートです');

    // レシートが伝えるのは消費した IZ の額だけ。付与コインはゲーム側のレートで決める
    const coins = receipts.coinsFor(receipt.izAmount);

    try {
      db.transaction(() => {
        db.prepare(
          'INSERT INTO iz_purchases (nonce, user_id, firebase_uid, iz_amount, coins) VALUES (?, ?, ?, ?, ?)',
        ).run(receipt.nonce, req.user.id, receipt.uid, receipt.izAmount, coins);
        db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(coins, req.user.id);
      })();
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw httpError(409, 'このレシートは使用済みです');
      throw e;
    }
    res.json({ ok: true, coins, user: publicUser(req.user.id) });
  } catch (e) { next(e); }
});

/**
 * IZ課金が利用可能かどうかと、交換レート・購入パック(クライアントの表示用)。
 * 買えない理由は2種類あり(サーバー側で無効 / IZアカウントでログインしていない)、
 * 案内文が変わるため reason で区別して返す。
 */
router.get('/purchase/status', requireAuth, (req, res) => {
  const available = receipts.isEnabled();
  res.json({
    enabled: available && !!req.user.firebase_uid,
    reason: !available ? 'unavailable' : !req.user.firebase_uid ? 'not_iz_account' : 'ok',
    coinsPerIz: receipts.COINS_PER_IZ,
    packs: receipts.COIN_PACKS.map(coins => ({ coins, iz: Math.ceil(coins / receipts.COINS_PER_IZ) })),
  });
});

/** ユーザーランキング(レート順)。自分の順位も返す。 */
router.get('/ranking', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT id, name, level, rating, wins, losses, draws, matches_played FROM users
     WHERE status = 'active' AND matches_played > 0
     ORDER BY rating DESC, wins DESC, id ASC LIMIT 50`,
  ).all();
  const entries = rows.map((u, i) => ({
    rank: i + 1,
    id: u.id,
    name: u.name,
    level: u.level,
    rating: u.rating,
    wins: u.wins,
    losses: u.losses,
    draws: u.draws,
    isMe: u.id === req.user.id,
  }));
  // 自分が50位圏外なら末尾に自分の行を足す
  let me = entries.find(e => e.isMe) || null;
  if (!me) {
    const better = db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND matches_played > 0 AND rating > ?",
    ).get(req.user.rating).n;
    me = {
      rank: better + 1,
      id: req.user.id,
      name: req.user.name,
      level: req.user.level,
      rating: req.user.rating,
      wins: req.user.wins,
      losses: req.user.losses,
      draws: req.user.draws,
      isMe: true,
    };
  }
  res.json({ entries, me });
});

/** 現行公開バランス(クライアント表示用) */
router.get('/balance/current', (req, res) => {
  const { id, snapshot } = balance.getPublished();
  res.json({ id, rules: snapshot.rules, facilities: snapshot.facilities, progression: snapshot.progression });
});

module.exports = router;
