/**
 * node:fs の最小シム(Workers 用)。
 * サーバーが読むファイルは初期バランス JSON だけなので、それをバンドルして返す。
 * wrangler の alias で `fs` をこのモジュールへ差し替える。
 * db.js は CommonJS の require('fs') で読み込むため CommonJS で公開する。
 */
const balanceInitial = require('../data/balance-initial.json');

function readFileSync(path) {
  const p = String(path);
  if (p.endsWith('balance-initial.json')) return JSON.stringify(balanceInitial);
  throw new Error(`Workers では読み込めないファイルです: ${p}`);
}

function existsSync(path) {
  return String(path).endsWith('balance-initial.json');
}

function writeFileSync() {
  throw new Error('Workers ではファイルへ書き込めません');
}

module.exports = { readFileSync, existsSync, writeFileSync, unlinkSync() {} };
