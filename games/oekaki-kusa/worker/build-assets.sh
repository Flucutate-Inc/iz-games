#!/usr/bin/env bash
# Workers の静的アセット配信用に、クライアント一式を worker/public へ集める。
#   /        … games/oekaki-kusa/public(ゲーム本体)
#   /sdk/*   … リポジトリ直下の sdk(IZブリッジSDK)
# 生成物なので .gitignore 済み。dev/deploy の前に必ず実行する。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GAME="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$GAME/../.." && pwd)"
OUT="$HERE/public"

rm -rf "$OUT"
mkdir -p "$OUT/sdk"
cp -r "$GAME/public/." "$OUT/"
cp -r "$ROOT/sdk/." "$OUT/sdk/"

echo "アセットを集めました: $OUT"
