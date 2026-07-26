#!/usr/bin/env bash
# わんわん大戦争のデータをJSONで手元に保存する。
#
#   BASE=https://wanwan.naggigoishi.workers.dev \
#   ADMIN_NAME=<管理者の表示名> ADMIN_PASS=<パスワード> \
#   ./games/wanwan/deploy/backup.sh [出力先ディレクトリ]
#
# Durable Object の SQLite は Cloudflare 側で永続化されるため、
# これは「誤操作・誤公開からの復旧用」の論理バックアップ。
# cron に登録して日次で回してもよい(1ファイル数百KB程度)。
set -euo pipefail

BASE="${BASE:-https://wanwan.naggigoishi.workers.dev}"
OUT_DIR="${1:-$HOME/wanwan-backups}"
: "${ADMIN_NAME:?ADMIN_NAME を指定してください}"
: "${ADMIN_PASS:?ADMIN_PASS を指定してください}"

mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$OUT_DIR/wanwan-backup-$STAMP.json"

TOKEN="$(curl -fsS -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
  -d "{\"name\":\"$ADMIN_NAME\",\"password\":\"$ADMIN_PASS\"}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.token){console.error("ログイン失敗");process.exit(1);}console.log(j.token);})')"

curl -fsS "$BASE/api/admin/backup?includeEvents=${INCLUDE_EVENTS:-0}" \
  -H "Authorization: Bearer $TOKEN" -o "$OUT"

# 中身の健全性を確認してから古い世代を消す(既定30世代)
node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!Array.isArray(j.users) || !Array.isArray(j.balance_versions)) {
  console.error("バックアップの形式が不正です");
  process.exit(1);
}
console.log(`保存しました: ${process.argv[1]}`);
console.log(`  アカウント ${j.users.length} / バランス版 ${j.balance_versions.length} / 対戦 ${j.matches.length} / ガチャ ${j.gacha_pulls.length}`);
' "$OUT"

KEEP="${KEEP:-30}"
ls -1t "$OUT_DIR"/wanwan-backup-*.json 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --
