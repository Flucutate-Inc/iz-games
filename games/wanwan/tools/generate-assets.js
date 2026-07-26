/**
 * わんわん大戦争 素材一括生成スクリプト
 *
 * Gemini 画像生成 API でゲーム素材(ペット16体×6ポーズ、施設、背景、エフェクト、UI)を
 * 生成し、games/wanwan/assets/ 以下へ PNG として保存する。
 *
 * パイプラインの考え方(参考: iz/scripts/generate-pets.js +
 * https://qiita.com/archeleeds/items/2efad73069b54288deb4 の知見):
 *   - キャラごとに基準ポーズ(idle)を先に生成し、raw 画像を保存
 *   - 他ポーズは基準画像をリファレンスとして添付し、同一デザインを保証
 *   - 生成結果はファイルとして永続キャッシュ(存在すればスキップ = 中断・再実行に強い)
 *   - 白背景(#FFFFFF)で生成 → sharp で透過化(iz 本体と同じ WHITE_THRESHOLD=230)
 *   - 施設は青チームで生成し、赤チームは青系ピクセルの色相回転で機械的に生成
 *
 * 実行方法:
 *   cd games/wanwan/tools
 *   npm install
 *   export GEMINI_API_KEY=xxxx   (iz 本体と同じ Secret Manager の値。.env には無い)
 *   node generate-assets.js
 *
 * オプション(環境変数):
 *   DRY_RUN=true       生成のみ試行し保存しない
 *   LIMIT=5            生成ジョブ数の上限
 *   ONLY=mame-shiba,arena   指定 id のみ(ペット id / 施設 id / エフェクト id など)
 *   CATEGORY=pets      pets | facilities | background | effects | ui のみ実行
 *   FORCE=true         既存ファイルがあっても再生成
 *   IMAGE_MODEL=...    使用モデルの上書き(既定: gemini-3.1-flash-image-preview)
 *
 * 例:
 *   DRY_RUN=true LIMIT=1 node generate-assets.js
 *   CATEGORY=pets ONLY=mame-shiba node generate-assets.js
 */

const fs = require('fs');
const path = require('path');
const P = require('./prompts');

// ─── 設定 ─────────────────────────────────────────────────────────
// Vertex AI(ADC)では GA 名 `gemini-3.1-flash-image`。API キー経由
// (generativelanguage)では `gemini-3.1-flash-image-preview` を IMAGE_MODEL で指定する。
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gemini-3.1-flash-image';
const WHITE_THRESHOLD = 230; // iz functions/src/helpers/image.ts と同じ
const DRY_RUN = process.env.DRY_RUN === 'true';
const FORCE = process.env.FORCE === 'true';
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity;
const ONLY = process.env.ONLY ? process.env.ONLY.split(',').map(s => s.trim()) : null;
const CATEGORY = process.env.CATEGORY || null;
const RETRIES = 5;
const RETRY_WAIT_MS = 4000;
const QUOTA_WAIT_MS = 45000; // 429 のときは長めに待つ
// Veo(image-to-video)。ペットのアニメーションフレーム生成に使う
const VIDEO_MODEL = process.env.VIDEO_MODEL || 'veo-3.0-fast-generate-001';
const VIDEO_POLL_MS = 10000;
const VIDEO_TIMEOUT_MS = 6 * 60 * 1000;

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const PETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'pets.json'), 'utf8')).pets;
const FACILITIES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'facilities.json'), 'utf8')).facilities;
// ──────────────────────────────────────────────────────────────────

/**
 * 認証は2系統:
 *   1. GEMINI_API_KEY があれば generativelanguage.googleapis.com(API キー)
 *   2. なければ Vertex AI + ADC(gcloud auth application-default login 済みの
 *      サービスアカウント/ユーザー認証)。トークンは google-auth-library が
 *      スクリプト内部で取得・更新する。
 */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
const GCP_PROJECT = process.env.GCP_PROJECT || 'iz-app-6e1d5';
const GCP_LOCATION = process.env.GCP_LOCATION || 'global';

let vertexAuthClient = null;
async function getVertexToken() {
  if (!vertexAuthClient) {
    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    vertexAuthClient = await auth.getClient();
  }
  const { token } = await vertexAuthClient.getAccessToken();
  if (!token) throw new Error('ADC からアクセストークンを取得できませんでした(gcloud auth application-default login を実行してください)');
  return token;
}

let sharp;
try {
  sharp = require('sharp');
} catch (_e) {
  console.error('❌ sharp が見つかりません。tools/ ディレクトリで `npm install` を実行してください。');
  process.exit(1);
}

// ─── Gemini 呼び出し ───────────────────────────────────────────────

/**
 * Gemini 画像生成。referencePng(Buffer)を渡すとリファレンス画像として添付する。
 * 戻り値: 生成 PNG の Buffer(白背景のままの raw)
 */
async function generateImage(prompt, { referencePng = null, aspectRatio = '1:1' } = {}) {
  const parts = [];
  if (referencePng) {
    parts.push({ inlineData: { mimeType: 'image/png', data: referencePng.toString('base64') } });
  }
  parts.push({ text: prompt });

  // imageConfig.aspectRatio はモデルによって未対応の場合があるため、
  // 400 が返ったら imageConfig なしで自動フォールバックする
  let useImageConfig = true;

  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseModalities: ['IMAGE', 'TEXT'],
        ...(useImageConfig ? { imageConfig: { aspectRatio } } : {}),
      },
    };
    try {
      let url, headers;
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
      if (!res.ok) {
        if (res.status === 400 && useImageConfig) {
          useImageConfig = false;
          console.log('  … imageConfig 未対応の可能性があるため外して再試行します');
        }
        throw new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const json = JSON.parse(text);
      const outParts = json.candidates?.[0]?.content?.parts ?? [];
      const imagePart = outParts.find(p => p.inlineData?.data);
      if (!imagePart) throw new Error('画像データが返りませんでした');
      return Buffer.from(imagePart.inlineData.data, 'base64');
    } catch (e) {
      lastErr = e;
      if (attempt < RETRIES) {
        const isQuota = /RESOURCE_EXHAUSTED|HTTP 429/.test(e.message);
        const wait = isQuota ? QUOTA_WAIT_MS * attempt : RETRY_WAIT_MS * attempt;
        console.log(`  … リトライ ${attempt}/${RETRIES - 1}、${Math.round(wait / 1000)}秒待機(${e.message.slice(0, 120)})`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

// ─── Veo 動画生成(image-to-video)────────────────────────────────

/**
 * 基準スプライト(白背景 PNG)を初期フレームに Veo で短い動画を生成し、
 * mp4 Buffer を返す。predictLongRunning → fetchPredictOperation でポーリング。
 */
async function generateVideo(prompt, referencePng) {
  const base = `https://aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/global/publishers/google/models/${VIDEO_MODEL}`;
  const headers = async () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${await getVertexToken()}`,
  });

  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const startRes = await fetch(`${base}:predictLongRunning`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({
          instances: [
            {
              prompt,
              image: { bytesBase64Encoded: referencePng.toString('base64'), mimeType: 'image/png' },
            },
          ],
          parameters: {
            aspectRatio: '16:9',
            durationSeconds: 4,
            sampleCount: 1,
            generateAudio: false,
            resolution: '720p',
          },
        }),
      });
      const startText = await startRes.text();
      if (!startRes.ok) throw new Error(`Veo HTTP ${startRes.status}: ${startText.slice(0, 300)}`);
      const operationName = JSON.parse(startText).name;
      if (!operationName) throw new Error('Veo operation name が返りませんでした');

      const deadline = Date.now() + VIDEO_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, VIDEO_POLL_MS));
        const pollRes = await fetch(`${base}:fetchPredictOperation`, {
          method: 'POST',
          headers: await headers(),
          body: JSON.stringify({ operationName }),
        });
        const pollText = await pollRes.text();
        if (!pollRes.ok) throw new Error(`Veo poll HTTP ${pollRes.status}: ${pollText.slice(0, 300)}`);
        const op = JSON.parse(pollText);
        if (!op.done) continue;
        if (op.error) throw new Error(`Veo error: ${JSON.stringify(op.error).slice(0, 300)}`);
        const video = op.response?.videos?.[0];
        const b64 = video?.bytesBase64Encoded;
        if (!b64) throw new Error(`Veo が動画を返しませんでした: ${JSON.stringify(op.response ?? {}).slice(0, 200)}`);
        return Buffer.from(b64, 'base64');
      }
      throw new Error('Veo 動画生成がタイムアウトしました');
    } catch (e) {
      lastErr = e;
      if (attempt < RETRIES) {
        const isQuota = /RESOURCE_EXHAUSTED|HTTP 429/.test(e.message);
        const wait = isQuota ? QUOTA_WAIT_MS * attempt : RETRY_WAIT_MS * attempt;
        console.log(`  … Veo リトライ ${attempt}/${RETRIES - 1}、${Math.round(wait / 1000)}秒待機(${e.message.slice(0, 120)})`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

/**
 * mp4 から指定位置(0..1)のフレームを PNG Buffer として抽出する(要 ffmpeg)。
 * 中央の正方形にクロップして返す(Veo 出力は 16:9 のため)。
 */
function extractFrame(mp4Path, position) {
  const { execFileSync } = require('child_process');
  const durText = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4Path,
  ]).toString().trim();
  const duration = parseFloat(durText);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`ffprobe が動画長を取得できませんでした: ${durText}`);
  const t = Math.min(duration * position, duration - 0.05);
  return execFileSync('ffmpeg', [
    '-v', 'error',
    '-ss', String(t),
    '-i', mp4Path,
    '-frames:v', '1',
    '-vf', 'crop=ih:ih',
    '-f', 'image2pipe',
    '-vcodec', 'png',
    '-',
  ], { maxBuffer: 64 * 1024 * 1024 });
}

// ─── 画像後処理 ────────────────────────────────────────────────────

/**
 * 白背景を透過にした PNG Buffer を返す。
 * 単純な白閾値(iz 本体方式)だと白い被写体(白犬・骨など)の内部ハイライトまで
 * 抜けて穴になるため、「画像外周から連結している白ピクセルのみ」を
 * フラッドフィルで背景と判定して除去する。
 */
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
  for (let p = 0; p < w * h; p++) {
    if (bg[p]) data[p * channels + 3] = 0;
  }
  return sharp(data, { raw: { width: w, height: h, channels } }).png().toBuffer();
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** 青系ピクセルだけ赤系へ色相回転した PNG を返す(施設の敵チームカラー用) */
async function blueToRed(pngBuffer) {
  const { data, info } = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  for (let i = 0; i < data.length; i += channels) {
    if (data[i + 3] === 0) continue;
    const [h, s, v] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
    if (h >= 170 && h <= 280 && s > 0.25) {
      const [r, g, b] = hsvToRgb((h + 135) % 360, s, v);
      data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

/** idle 画像からデッキ用アイコン(透明トリム + 192px)を作る */
async function makeIcon(transparentPng) {
  return sharp(transparentPng)
    .trim({ threshold: 10 })
    .resize(192, 192, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

// ─── ジョブ構築 ────────────────────────────────────────────────────

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function exists(p) {
  return fs.existsSync(p);
}

/**
 * ジョブ = { id, category, out, run() } の配列を作る。
 * run() は out へ書き込む。基準画像に依存するジョブは run 内で raw キャッシュを読む。
 */
function buildJobs() {
  const jobs = [];

  // ── ペット: idle(基準・静止画)→ Veo 動画 → フレーム抽出 ──
  for (const pet of PETS) {
    const dir = path.join(ASSETS, 'pets', pet.id);
    const rawBase = path.join(dir, '_base_raw.png');

    // 基準ポーズ(静止画)。アイコンもここから作る
    jobs.push({
      id: pet.id,
      category: 'pets',
      label: `${pet.name} / idle`,
      out: path.join(dir, 'idle.png'),
      run: async () => {
        ensureDir(dir);
        const raw = await generateImage(P.petBasePrompt(pet.subject, P.PET_POSES.idle));
        if (DRY_RUN) return;
        fs.writeFileSync(rawBase, raw); // Veo の初期フレーム用に白背景のまま保存
        const transparent = await removeWhiteBackground(raw);
        fs.writeFileSync(path.join(dir, 'idle.png'), transparent);
        fs.writeFileSync(path.join(dir, 'icon.png'), await makeIcon(transparent));
      },
    });

    // アニメーション: 基準画像 → Veo(image-to-video)→ フレーム切り出し
    // (Qiita 記事の「動画に展開して良いフレームを選ぶ」工程に相当)
    for (const [animId, anim] of Object.entries(P.PET_ANIMS)) {
      const firstOut = path.join(dir, `${anim.frames[0][0]}.png`);
      jobs.push({
        id: pet.id,
        category: 'pets',
        label: `${pet.name} / ${animId}(動画→${anim.frames.length}フレーム)`,
        out: firstOut,
        run: async () => {
          ensureDir(dir);
          if (!exists(rawBase)) throw new Error(`基準画像がありません(先に idle を生成): ${rawBase}`);
          const mp4Path = path.join(dir, `_${animId}_raw.mp4`);
          if (!exists(mp4Path) || FORCE) {
            const mp4 = await generateVideo(anim.prompt, fs.readFileSync(rawBase));
            if (DRY_RUN) return;
            fs.writeFileSync(mp4Path, mp4); // 動画もキャッシュ(フレーム選定のやり直し用)
          }
          for (const [frameName, position] of anim.frames) {
            const framePng = extractFrame(mp4Path, position);
            const transparent = await removeWhiteBackground(framePng);
            if (!DRY_RUN) fs.writeFileSync(path.join(dir, `${frameName}.png`), transparent);
          }
        },
      });
    }
  }

  // ── 施設: 青チーム normal(基準) → damaged / destroyed → 赤変換 ──
  for (const fac of FACILITIES) {
    const dir = path.join(ASSETS, 'facilities');
    const rawBase = path.join(dir, `_${fac.id}_raw.png`);

    for (const [stateId, stateDesc] of Object.entries(P.FACILITY_STATES)) {
      const outBlue = path.join(dir, `${fac.id}-${stateId}-blue.png`);
      const outRed = path.join(dir, `${fac.id}-${stateId}-red.png`);
      jobs.push({
        id: fac.id,
        category: 'facilities',
        label: `${fac.name} / ${stateId}`,
        out: outBlue,
        run: async () => {
          ensureDir(dir);
          let raw;
          if (stateId === 'normal') {
            raw = await generateImage(P.facilityBasePrompt(fac.subject, P.FACILITY_STATES.normal));
            if (!DRY_RUN) fs.writeFileSync(rawBase, raw);
          } else {
            if (!exists(rawBase)) throw new Error(`基準画像がありません(先に normal を生成): ${rawBase}`);
            raw = await generateImage(P.facilityStatePrompt(stateDesc), { referencePng: fs.readFileSync(rawBase) });
          }
          const transparent = await removeWhiteBackground(raw);
          if (DRY_RUN) return;
          fs.writeFileSync(outBlue, transparent);
          fs.writeFileSync(outRed, await blueToRed(transparent)); // 敵チームカラーは機械変換
        },
      });
    }
  }

  // ── 背景(透過処理なし) ──
  jobs.push({
    id: P.BACKGROUND.id,
    category: 'background',
    label: '対戦フィールド背景',
    out: path.join(ASSETS, 'background', 'arena.png'),
    run: async function () {
      ensureDir(path.join(ASSETS, 'background'));
      const raw = await generateImage(P.BACKGROUND.prompt, { aspectRatio: P.BACKGROUND.aspectRatio });
      if (!DRY_RUN) fs.writeFileSync(this.out, raw);
    },
  });

  // ── エフェクト ──
  for (const ef of P.EFFECTS) {
    const out = path.join(ASSETS, 'effects', `${ef.id}.png`);
    jobs.push({
      id: ef.id,
      category: 'effects',
      label: `エフェクト / ${ef.id}`,
      out,
      run: async () => {
        ensureDir(path.join(ASSETS, 'effects'));
        const raw = await generateImage(P.effectPrompt(ef.subject));
        const transparent = await removeWhiteBackground(raw);
        if (!DRY_RUN) fs.writeFileSync(out, transparent);
      },
    });
  }

  // ── UI アイコン ──
  for (const icon of P.UI_ICONS) {
    const out = path.join(ASSETS, 'ui', `${icon.id}.png`);
    jobs.push({
      id: icon.id,
      category: 'ui',
      label: `UI / ${icon.id}`,
      out,
      run: async () => {
        ensureDir(path.join(ASSETS, 'ui'));
        const raw = await generateImage(P.uiIconPrompt(icon.subject));
        const transparent = await removeWhiteBackground(raw);
        if (!DRY_RUN) fs.writeFileSync(out, transparent);
      },
    });
  }

  // ── タイトルロゴ ──
  jobs.push({
    id: P.TITLE_LOGO.id,
    category: 'ui',
    label: 'タイトルロゴ',
    out: path.join(ASSETS, 'ui', 'title-logo.png'),
    run: async function () {
      ensureDir(path.join(ASSETS, 'ui'));
      const raw = await generateImage(P.TITLE_LOGO.prompt, { aspectRatio: P.TITLE_LOGO.aspectRatio });
      const transparent = await removeWhiteBackground(raw);
      if (!DRY_RUN) fs.writeFileSync(this.out, transparent);
    },
  });

  // ── サムネイル(透過処理なし) ──
  jobs.push({
    id: P.THUMB.id,
    category: 'ui',
    label: 'サムネイル',
    out: path.join(ROOT, 'thumb.png'),
    run: async function () {
      const raw = await generateImage(P.THUMB.prompt, { aspectRatio: P.THUMB.aspectRatio });
      if (!DRY_RUN) fs.writeFileSync(this.out, await sharp(raw).resize(512, 512).png().toBuffer());
    },
  });

  return jobs;
}

// ─── メイン ────────────────────────────────────────────────────────

async function main() {
  let jobs = buildJobs();
  if (CATEGORY) jobs = jobs.filter(j => j.category === CATEGORY);
  if (ONLY) jobs = jobs.filter(j => ONLY.includes(j.id));
  if (!FORCE) jobs = jobs.filter(j => !exists(j.out));
  jobs = jobs.slice(0, LIMIT);

  console.log(`🐾 モデル: ${IMAGE_MODEL}`);
  console.log(`🐾 ${jobs.length} 件の素材を生成します${DRY_RUN ? '(DRY_RUN: 保存なし)' : ''}`);
  if (jobs.length === 0) {
    console.log('生成対象がありません(FORCE=true で再生成、CATEGORY/ONLY で絞り込みできます)。');
    return;
  }

  let success = 0;
  const failed = [];
  for (const [i, job] of jobs.entries()) {
    try {
      console.log(`\n[${i + 1}/${jobs.length}] ${job.label} 生成中…`);
      await job.run();
      console.log(`  ✓ ${path.relative(ROOT, job.out)}`);
      success++;
    } catch (e) {
      console.error(`  ✗ 失敗: ${e instanceof Error ? e.message : String(e)}`);
      failed.push(job);
    }
  }

  console.log(`\n完了: 成功 ${success} / 失敗 ${failed.length}`);
  if (failed.length > 0) {
    const ids = [...new Set(failed.map(j => j.id))];
    console.log(`失敗した素材(再実行で続きから生成されます): ${ids.join(',')}`);
    process.exitCode = 1;
  }
}

main().catch(e => {
  console.error('スクリプトが異常終了しました:', e);
  process.exit(1);
});
