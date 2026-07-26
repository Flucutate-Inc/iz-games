/**
 * IZ 課金レシートの検証。
 * IZ アプリのサーバー(purchaseGameCurrency Cloud Function)が HMAC-SHA256 で署名した
 * レシートを、共有シークレット(WANWAN_RECEIPT_SECRET / iz 側は GAME_RECEIPT_SECRET)で検証する。
 * 署名ロジックは iz/functions/src/helpers/game-currency.ts と同一。
 */
const crypto = require('crypto');

const SECRET = process.env.WANWAN_RECEIPT_SECRET || '';
const MAX_AGE_MS = 10 * 60 * 1000; // レシートの有効期間

function canonical(r) {
  return [r.gameId, r.uid, r.izAmount, r.coins, r.nonce, r.issuedAt].join('|');
}

/** 検証に成功したらレシート本文、失敗したら理由つきで throw */
function verifyReceipt(token, { gameId = 'wanwan', now = Date.now() } = {}) {
  if (!SECRET) throw new Error('WANWAN_RECEIPT_SECRET が未設定です(IZ課金は無効)');
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
    !Number.isInteger(receipt?.coins) ||
    !Number.isFinite(receipt?.issuedAt)
  ) {
    throw new Error('レシートの内容が不正です');
  }
  const expected = crypto.createHmac('sha256', SECRET).update(canonical(receipt)).digest('base64url');
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('レシートの署名が不正です');
  if (receipt.gameId !== gameId) throw new Error('別のゲームのレシートです');
  if (receipt.coins <= 0) throw new Error('付与額が不正です');
  if (now - receipt.issuedAt > MAX_AGE_MS) throw new Error('レシートの有効期限が切れています');
  return receipt;
}

module.exports = { verifyReceipt, isEnabled: () => !!SECRET };
