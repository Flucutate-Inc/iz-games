/**
 * ガチャ画面の主役(ガチャ機)を Gemini で生成し、透過WebPにする。
 *
 * CSSで描いた簡易ガチャ機は背景(生成イラスト)と画風が合わないため、
 * 背景と同じ絵柄で1枚絵として作る。白背景で生成 → 外周フラッドフィルで透過化
 * (generate-assets.js と同じ手法。白い被写体の内部に穴が開かない)。
 *
 *   cd games/wanwan/tools && node generate-gacha-machine.js
 *   FORCE=true node generate-gacha-machine.js   # 作り直す
 *
 * 認証は generate-gacha-bg.js と同じ(ADC もしくは GCP_ACCESS_TOKEN / GEMINI_API_KEY)。
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gemini-3.1-flash-image';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GCP_PROJECT = process.env.GCP_PROJECT || 'iz-app-6e1d5';
const GCP_LOCATION = process.env.GCP_LOCATION || 'global';
const WHITE_THRESHOLD = 230;
const OUT_DIR = path.join(__dirname, '..', 'assets', 'ui');
const OUT = path.join(OUT_DIR, 'gacha-machine.webp');

const PROMPT = `A single cute capsule-toy (gachapon) machine, front view, centered, on a PLAIN PURE WHITE background (#FFFFFF).

The machine: warm cream and amber painted metal body with soft rounded edges, a big clear glass
globe on top filled with pastel capsules (pink, mint, sky blue, lilac, cream), a golden crank knob
on the front, a dark capsule exit slot at the bottom, and a small shiba-inu paw emblem on the front
panel. A sturdy base with subtle reflections.

Style: painterly mobile game UI illustration, soft warm rim lighting from the upper left, gentle
shadows, slightly glossy surfaces, high detail but clean silhouette. Cozy and premium, not toy-like
vector art. No text, no logo, no characters, no floor, no shadow on the ground plane.

The background must be completely flat pure white so it can be cut out. Do not add any scenery.`;

async function getVertexToken() {
  if (process.env.GCP_ACCESS_TOKEN) return process.env.GCP_ACCESS_TOKEN;
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return typeof token === 'string' ? token : token.token;
}

async function generate() {
  const body = {
    contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: { aspectRatio: '1:1' } },
  };
  let url;
  let headers;
  if (GEMINI_API_KEY) {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    headers = { 'Content-Type': 'application/json' };
  } else {
    const host = GCP_LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${GCP_LOCATION}-aiplatform.googleapis.com`;
    url = `https://${host}/v1/projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/publishers/google/models/${IMAGE_MODEL}:generateContent`;
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${await getVertexToken()}` };
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text);
  const part = (json.candidates?.[0]?.content?.parts ?? []).find(p => p.inlineData?.data);
  if (!part) throw new Error('画像データが返りませんでした');
  return Buffer.from(part.inlineData.data, 'base64');
}

/** 画像外周から連結している白のみを背景とみなして透過にする */
async function removeWhiteBackground(pngBuffer) {
  const { data, info } = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  const isWhite = p => {
    const i = p * channels;
    return data[i] > WHITE_THRESHOLD && data[i + 1] > WHITE_THRESHOLD && data[i + 2] > WHITE_THRESHOLD;
  };
  const bg = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const p = stack.pop();
    if (p < 0 || p >= w * h || bg[p] || !isWhite(p)) continue;
    bg[p] = 1;
    const x = p % w;
    stack.push(p - w, p + w);
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
  }
  for (let p = 0; p < w * h; p++) if (bg[p]) data[p * channels + 3] = 0;
  return sharp(data, { raw: { width: w, height: h, channels } }).png().toBuffer();
}

(async () => {
  if (fs.existsSync(OUT) && process.env.FORCE !== 'true') {
    console.log(`既に存在します(FORCE=true で作り直し): ${OUT}`);
    return;
  }
  console.log(`🎰 モデル: ${IMAGE_MODEL}`);
  const raw = await generate();
  const cut = await removeWhiteBackground(raw);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await sharp(cut).trim({ threshold: 1 }).resize({ width: 720, withoutEnlargement: true })
    .webp({ quality: 88, effort: 6, alphaQuality: 100 })
    .toFile(OUT);
  const size = fs.statSync(OUT).size;
  console.log(`保存: ${OUT} (${Math.round(size / 1024)} KB)`);
})().catch(e => {
  console.error('失敗:', e.message);
  process.exit(1);
});
