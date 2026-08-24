/**
 * Firebase ID トークンの検証(Workers の Web Crypto だけで完結する軽量実装)。
 *
 * IZ アプリ(ホスト)が `iz:getIdToken` で渡すトークンを、Google の公開鍵で RS256 署名検証し、
 * iss / aud / exp / iat / sub をチェックする。
 *
 * **重要**: `iz:init` で渡される `user.uid` は表示用であり偽装可能。認証は必ずこのトークンで行う。
 * わんわん大戦争(games/wanwan/server/src/firebase-auth.js)と同じ方針だが、
 * あちらは Node の crypto + X.509 証明書、こちらは Workers 向けに JWK エンドポイントを使う。
 */

/** X.509 版ではなく JWK 版を使う。crypto.subtle.importKey('jwk') にそのまま渡せる。 */
const JWK_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

let jwkCache = { keys: null, expiresAt: 0 };

async function fetchKeys() {
  if (jwkCache.keys && Date.now() < jwkCache.expiresAt) return jwkCache.keys;
  const res = await fetch(JWK_URL);
  if (!res.ok) throw new Error(`公開鍵の取得に失敗しました: HTTP ${res.status}`);
  const body = await res.json();
  const keys = {};
  for (const k of body.keys || []) keys[k.kid] = k;
  // Cache-Control: max-age を尊重(なければ1時間)
  const m = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  const maxAge = m ? parseInt(m[1], 10) : 3600;
  jwkCache = { keys, expiresAt: Date.now() + maxAge * 1000 };
  return keys;
}

function b64urlToBytes(seg) {
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(seg) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(seg)));
}

/**
 * 検証に成功したら payload({ sub, name, ... })を返し、失敗したら throw する。
 * opts.keys でキー辞書を注入できる(テスト用)。
 */
export async function verifyIdToken(idToken, allowedProjects, opts = {}) {
  if (typeof idToken !== 'string' || idToken.split('.').length !== 3) {
    throw new Error('IDトークンの形式が不正です');
  }
  const [h, p, s] = idToken.split('.');

  let header;
  try {
    header = b64urlJson(h);
  } catch {
    throw new Error('IDトークンのヘッダーを読めませんでした');
  }
  if (header.alg !== 'RS256') throw new Error(`未対応のアルゴリズムです: ${header.alg}`);

  const keys = opts.keys || (await fetchKeys());
  const jwk = keys[header.kid];
  if (!jwk) throw new Error('署名鍵(kid)が見つかりません');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!valid) throw new Error('署名検証に失敗しました');

  const payload = b64urlJson(p);
  const now = Math.floor(Date.now() / 1000);

  if (!allowedProjects.includes(payload.aud)) {
    throw new Error(
      `aud が不正です: ${payload.aud}(このゲームが受け付けるのは ${allowedProjects.join(' / ')})`,
    );
  }
  if (!allowedProjects.some(pr => payload.iss === `https://securetoken.google.com/${pr}`)) {
    throw new Error(`iss が不正です: ${payload.iss}`);
  }
  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    throw new Error('トークンの有効期限が切れています');
  }
  if (typeof payload.iat === 'number' && payload.iat > now + 300) {
    throw new Error('iat が未来です');
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 128) {
    throw new Error('sub が不正です');
  }
  return payload;
}

/** 環境変数 FIREBASE_PROJECT(カンマ区切り)を配列にする */
export function allowedProjects(env) {
  return String(env.FIREBASE_PROJECT || 'iz-app-6e1d5')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}
