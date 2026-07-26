#!/usr/bin/env bash
# Workers の静的アセット配信用に、クライアント一式を worker/public へ集める。
#   /            … server/public(ゲーム本体・管理画面)
#   /assets/*    … games/wanwan/assets(ペット素材など)
#   /sdk/*       … リポジトリ直下の sdk(IZブリッジSDK)
# 生成物なので .gitignore 済み。deploy/dev の前に必ず実行する。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GAME="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$GAME/../.." && pwd)"
OUT="$HERE/public"

rm -rf "$OUT"
mkdir -p "$OUT"
cp -r "$GAME/server/public/." "$OUT/"
mkdir -p "$OUT/assets" "$OUT/sdk"
cp -r "$GAME/assets/." "$OUT/assets/"
cp -r "$ROOT/sdk/." "$OUT/sdk/"

echo "アセットを集めました: $OUT"
du -sh "$OUT"
