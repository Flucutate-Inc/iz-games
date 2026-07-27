/**
 * Firebase ID トークン検証(Admin SDK 不使用の軽量実装)。
 * IZ アプリ(ホスト)が iz:getIdToken で渡すトークンを、Google の公開鍵で
 * RS256 署名検証し、iss / aud / exp / sub をチェックする。
 * ホスト経由の user.uid は表示用で偽装可能なため、認証は必ずこのトークンで行う。
 */
const crypto = require('crypto');

/**
 * 受け入れる Firebase プロジェクト。カンマ区切りで複数指定できる
 * (本番とステージングの両方のアプリから遊べるようにするため)。
 */
const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT || 'iz-app-6e1d5';
const ALLOWED_PROJECTS = FIREBASE_PROJECT.split(',').map(s => s.trim()).filter(Boolean);
const CERT_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let certCache = { certs: null, expiresAt: 0 };

async function fetchCerts() {
  if (certCache.certs && Date.now() < certCache.expiresAt) return certCache.certs;
  const res = await fetch(CERT_URL);
  if (!res.ok) throw new Error(`公開鍵の取得に失敗しました: HTTP ${res.status}`);
  const certs = await res.json();
  // Cache-Control: max-age を尊重(なければ1時間)
  const m = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  const maxAge = m ? parseInt(m[1], 10) : 3600;
  certCache = { certs, expiresAt: Date.now() + maxAge * 1000 };
  return certs;
}

function b64urlJson(seg) {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

/** 証明書PEMまたは公開鍵PEMから公開鍵を得る(テストでは公開鍵PEMを直接渡せる) */
function toPublicKey(pem) {
  if (pem.includes('BEGIN CERTIFICATE')) return new crypto.X509Certificate(pem).publicKey;
  return crypto.createPublicKey(pem);
}

/**
 * 検証成功で payload({sub, name, ...})を返し、失敗で throw する。
 * opts.certs でキー辞書を注入可能(テスト用)。
 */
async function verifyIdToken(idToken, opts = {}) {
  if (typeof idToken !== 'string' || idToken.split('.').length !== 3) {
    throw new Error('IDトークンの形式が不正です');
  }
  const [h, p, s] = idToken.split('.');
  const header = b64urlJson(h);
  if (header.alg !== 'RS256') throw new Error(`未対応のアルゴリズムです: ${header.alg}`);

  const certs = opts.certs || (await fetchCerts());
  const pem = certs[header.kid];
  if (!pem) throw new Error('署名鍵(kid)が見つかりません');

  const valid = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${h}.${p}`),
    toPublicKey(pem),
    Buffer.from(s, 'base64url'),
  );
  if (!valid) throw new Error('署名検証に失敗しました');

  const payload = b64urlJson(p);
  // opts.project(テスト用)があればそれだけ、無ければ環境変数で許可した一覧と突き合わせる
  const projects = opts.project ? [opts.project] : ALLOWED_PROJECTS;
  const now = Math.floor(Date.now() / 1000);
  if (!projects.includes(payload.aud)) {
    throw new Error(`aud が不正です: ${payload.aud}(このゲームが受け付けるのは ${projects.join(' / ')})`);
  }
  if (!projects.some(pr => payload.iss === `https://securetoken.google.com/${pr}`)) {
    throw new Error(`iss が不正です: ${payload.iss}`);
  }
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw new Error('トークンの有効期限が切れています');
  if (typeof payload.iat === 'number' && payload.iat > now + 300) throw new Error('iat が未来です');
  if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 128) {
    throw new Error('sub が不正です');
  }
  return payload;
}

module.exports = { verifyIdToken, FIREBASE_PROJECT, ALLOWED_PROJECTS };
