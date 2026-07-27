/**
 * 生成した背景PNGを配信用に軽量化する(WebP化 + 上限幅でリサイズ)。
 * モバイル回線で読み込むため、見た目を保ったままサイズを1桁落とす。
 *
 *   cd games/wanwan/tools && node optimize-bg.js
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DIR = path.join(__dirname, '..', 'assets', 'background');
const SRC = path.join(DIR, 'gacha-bg.png');
const OUT = path.join(DIR, 'gacha-bg.webp');
const MAX_WIDTH = 1080; // スマホの実解像度で十分。背景はぼけているので更に落としても破綻しない

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error(`元画像がありません: ${SRC}(先に generate-gacha-bg.js を実行)`);
    process.exit(1);
  }
  const before = fs.statSync(SRC).size;
  const meta = await sharp(SRC).metadata();
  await sharp(SRC)
    .resize({ width: Math.min(MAX_WIDTH, meta.width), withoutEnlargement: true })
    .webp({ quality: 78, effort: 6 })
    .toFile(OUT);
  const after = fs.statSync(OUT).size;
  console.log(`元: ${meta.width}x${meta.height} ${Math.round(before / 1024)}KB`);
  console.log(`WebP: ${Math.round(after / 1024)}KB (${Math.round((1 - after / before) * 100)}% 削減)`);
  console.log(`保存: ${OUT}`);
})();
