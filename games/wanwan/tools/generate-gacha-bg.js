/**
 * ガチャ画面の背景を Gemini(画像モデル)で生成する。
 *
 * 認証は generate-assets.js と同じ:
 *   - Vertex AI(推奨): `gcloud auth application-default login` 済みの ADC
 *   - もしくは APIキー: GEMINI_API_KEY=... (この場合は IMAGE_MODEL=gemini-3.1-flash-image-preview)
 *
 *   cd games/wanwan/tools && npm install
 *   node generate-gacha-bg.js            # 既存ファイルがあればスキップ
 *   FORCE=true node generate-gacha-bg.js # 作り直す
 *
 * 出力: assets/background/gacha-bg.png (縦長。CSSで背景として敷く)
 */
const fs = require('fs');
const path = require('path');

const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gemini-3.1-flash-image';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GCP_PROJECT = process.env.GCP_PROJECT || 'iz-app-6e1d5';
const GCP_LOCATION = process.env.GCP_LOCATION || 'global';
const OUT = path.join(__dirname, '..', 'assets', 'background', 'gacha-bg.png');

// ゲーム画面の上に文字とガチャ機が乗るので、中央は暗く・情報量を抑えた背景にする。
// 既存のUIトークン(紫紺の背景・琥珀のアクセント)に合わせる。
const PROMPT = `Vertical mobile game background art for a cute dog-themed gacha (capsule toy) screen.

Composition: a cozy indoor toy-shop corner at night, seen straight on. Rows of blurred capsule-toy
machines line the left and right edges, receding into soft bokeh. The CENTER of the image must stay
visually calm and darker so UI text and a capsule machine can sit on top of it.

Style: painterly game UI illustration, soft rim lighting, gentle warm amber light sources against a
deep indigo-violet room, subtle floating sparkles and dust motes, no text, no characters, no logos.
Slight vignette. Clean enough for UI overlay.

Palette: deep indigo #1b1630 to #241d3d for shadows, amber #ffb020 and warm orange #ff7a1a for lights,
occasional soft pastel capsule colors (pink, mint, sky blue, lilac).

Do not include any text, watermark, UI element, button, or human figure.`;

async function getVertexToken() {
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return typeof token === 'string' ? token : token.token;
}

async function generate() {
  const body = {
    contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: { aspectRatio: '9:16' } },
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

(async () => {
  if (fs.existsSync(OUT) && process.env.FORCE !== 'true') {
    console.log(`既に存在します(FORCE=true で作り直し): ${OUT}`);
    return;
  }
  console.log(`🎨 モデル: ${IMAGE_MODEL}${GEMINI_API_KEY ? '(APIキー)' : '(Vertex AI / ADC)'}`);
  const png = await generate();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, png);
  console.log(`保存: ${OUT} (${Math.round(png.length / 1024)} KB)`);
  console.log('次: cd games/wanwan && npm run deploy で反映されます');
})().catch(e => {
  console.error('失敗:', e.message);
  if (/UNAUTHENTICATED|401|invalid authentication|Reauthentication/i.test(e.message)) {
    console.error('→ `gcloud auth application-default login` を実行するか、GEMINI_API_KEY を設定してください');
  }
  process.exit(1);
});
