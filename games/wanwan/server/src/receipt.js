/**
 * IZ 課金レシートの検証。
 * IZ アプリのサーバー(purchaseGameCurrency Cloud Function)が HMAC-SHA256 で署名した
 * レシートを、共有シークレット(WANWAN_RECEIPT_SECRET / iz 側は GAME_RECEIPT_SECRET)で検証する。
 * 署名ロジックは iz/functions/src/helpers/game-currency.ts と同一。
 */
const crypto = require('crypto');

/**
 * 検証に使う鍵。
 * 鍵の入れ替え中は「IZ側は新しい鍵で署名したのに、ゲーム側はまだ旧鍵」という
 * 隙間が生まれ、その間のレシートは検証に失敗する。IZは先に減っているため
 * ユーザーが損をする。これを避けるため、旧鍵(WANWAN_RECEIPT_SECRET_OLD)を
 * 併用できるようにして、切り替え中はどちらの署名も受け付ける。
 *
 * 手順: ①ゲーム側に新旧2本を設定 → ②IZ側を新鍵へ切替 → ③旧鍵を削除
 */
const SECRET = process.env.WANWAN_RECEIPT_SECRET || '';
const OLD_SECRET = process.env.WANWAN_RECEIPT_SECRET_OLD || '';
const SECRETS = [SECRET, OLD_SECRET].filter(Boolean);
const MAX_AGE_MS = 10 * 60 * 1000; // レシートの有効期間

/**
 * ゲーム内コインの交換レート。**1 IZ = 1 コイン(=1ポイント)**。
 *
 * レートはゲームの持ち物であり、IZ 側は「IZ をいくら減らすか」しか関知しない。
 * レシートが伝えるのは消費した IZ の額(izAmount)だけで、付与するコイン数は
 * ここで決める。ゲーム内の価格表(購入パック・ガチャ費用)もすべてこの値から
 * 作るため、レート変更はこのファイルだけで完結する(IZ 側の変更は不要)。
 */
const COINS_PER_IZ = 1;

/** 購入パック(付与コイン)。IZ の消費額は coins / COINS_PER_IZ。 */
const COIN_PACKS = [100, 500, 1000];

/** レシートの izAmount から、実際に付与するコイン数を決める */
const coinsFor = izAmount => Math.floor(izAmount * COINS_PER_IZ);

/**
 * 署名対象の正規化文字列。IZ 側 `functions/src/helpers/game-currency.ts` と同一。
 *
 * 旧形式のレシートには IZ 側が計算した `coins` が入っており、署名対象にも
 * 含まれていた。レートがゲーム側へ移ったことで `coins` は不要になったが、
 * 「ゲーム側は新形式・IZ側はまだ旧形式」という切り替えの隙間で検証に失敗すると
 * IZ だけ先に減ってユーザーが損をする(鍵の入れ替えと同じ問題)。
 * そこで本文に `coins` があるかどうかで署名対象を選び、移行中は両方受け付ける。
 * 本文を書き換えれば署名は一致しなくなるため、これで検証が緩むことはない。
 *
 * 手順: ①ゲーム側を先にデプロイ → ②IZ側を新形式へ → ③下の旧形式分岐を削除
 */
function canonical(r) {
  return r.coins === undefined
    ? [r.gameId, r.uid, r.izAmount, r.nonce, r.issuedAt].join('|')
    : [r.gameId, r.uid, r.izAmount, r.coins, r.nonce, r.issuedAt].join('|');
}

/** 検証に成功したらレシート本文、失敗したら理由つきで throw */
function verifyReceipt(token, { gameId = 'wanwan', now = Date.now() } = {}) {
  if (SECRETS.length === 0) throw new Error('WANWAN_RECEIPT_SECRET が未設定です(IZ課金は無効)');
  if (typeof token !== 'string') throw new Error('レシートが不正です');
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('レシートの形式が不正です');
  let receipt;
  try {
    receipt = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    throw new Error('レシートを解析できません');
  }
  if (
    typeof receipt?.gameId !== 'string' ||
    typeof receipt?.uid !== 'string' ||
    typeof receipt?.nonce !== 'string' ||
    !Number.isInteger(receipt?.izAmount) ||
    !Number.isFinite(receipt?.issuedAt) ||
    // 旧形式で coins を持つ場合だけ、その型も見る(値そのものは使わない)
    (receipt.coins !== undefined && !Number.isInteger(receipt.coins))
  ) {
    throw new Error('レシートの内容が不正です');
  }
  // 現行鍵と(あれば)旧鍵のどちらかで一致すれば通す。比較は常にタイミング安全に行う
  const given = Buffer.from(parts[1]);
  const matched = SECRETS.some(secret => {
    const expected = Buffer.from(crypto.createHmac('sha256', secret).update(canonical(receipt)).digest('base64url'));
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
  if (!matched) throw new Error('レシートの署名が不正です');
  if (receipt.gameId !== gameId) throw new Error('別のゲームのレシートです');
  // 付与額は izAmount から計算するため、見るのは izAmount だけでよい
  if (receipt.izAmount <= 0) throw new Error('購入額が不正です');
  if (now - receipt.issuedAt > MAX_AGE_MS) throw new Error('レシートの有効期限が切れています');
  return receipt;
}

module.exports = {
  verifyReceipt,
  isEnabled: () => SECRETS.length > 0,
  COINS_PER_IZ,
  COIN_PACKS,
  coinsFor,
};
