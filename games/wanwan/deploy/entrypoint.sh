#!/bin/sh
# わんわん大戦争サーバーの起動。
#   LITESTREAM_REPLICA_URL があれば: 起動時に GCS から SQLite を復元し、
#   litestream の監視下でサーバーを動かす(継続複製 → 再デプロイ・再起動で復帰)。
#   無ければ: そのまま起動する(DBはコンテナと同じ寿命=検証用)。
set -e

DB_PATH="${WANWAN_DB:-/data/wanwan.db}"
mkdir -p "$(dirname "$DB_PATH")"

if [ -n "$LITESTREAM_REPLICA_URL" ]; then
  echo "[entrypoint] litestream restore: $LITESTREAM_REPLICA_URL"
  # -if-replica-exists があるので「複製がまだ無い初回起動」は正常終了する。
  # 認証エラー・通信エラー・破損はそのまま失敗させる(握りつぶすとデータを失う)。
  litestream restore -if-db-not-exists -if-replica-exists -o "$DB_PATH" "$LITESTREAM_REPLICA_URL"
  exec litestream replicate -exec "node src/index.js" "$DB_PATH" "$LITESTREAM_REPLICA_URL"
fi

echo "[entrypoint] LITESTREAM_REPLICA_URL 未設定: DBは永続化されません(検証用)"
exec node src/index.js
