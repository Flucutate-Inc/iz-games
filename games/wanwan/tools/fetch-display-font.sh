#!/usr/bin/env bash
# 見出し・ボタン用の表示フォント(M PLUS Rounded 1c ExtraBold)を
# 「実際に使う文字だけ」のサブセットで取得し、リポジトリに自前配信用として置く。
#
# 日本語フォントは全部入りだと数MBになるため、Google Fonts の text= サブセット機能で
# 数十KBに抑える。文字を追加したら SUBSET を更新して再実行すること。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$HERE/../assets/fonts"
mkdir -p "$OUT_DIR"

# ボタン・見出しに出る文字(重複可)
SUBSET='たたかうガチャ回ひくとじるもどホーム提供割合ラインップわん大戦争勝利敗北引き分デッキ編集その他ランキング図鑑対履歴設定マッチルCPU練習あいこば作成参加以上確定体がなまにったつコイもど新しをむえよ0123456789/・←→!?%NEWSR'

ENCODED="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$SUBSET")"
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

CSS="$(curl -fsS -A "$UA" \
  "https://fonts.googleapis.com/css2?family=M+PLUS+Rounded+1c:wght@800&text=${ENCODED}&display=swap")"
# サブセット配信の URL は拡張子を持たない(…/l/font?kit=…)ので括弧の中を丸ごと取る
URL="$(printf '%s' "$CSS" | grep -o 'https://[^)]*' | head -1)"
[ -n "$URL" ] || { echo "woff2 の URL を取得できませんでした" >&2; exit 1; }

curl -fsS -A "$UA" "$URL" -o "$OUT_DIR/mplus-rounded-800-subset.woff2"
echo "保存: $OUT_DIR/mplus-rounded-800-subset.woff2"
ls -la "$OUT_DIR/mplus-rounded-800-subset.woff2" | awk '{print "  サイズ: "$5" bytes"}'
