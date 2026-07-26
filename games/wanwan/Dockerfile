# わんわん大戦争 ゲームサーバー(API + WebSocket + 管理画面)
# ビルドコンテキストはリポジトリルート: docker build -f games/wanwan/Dockerfile .
#   サーバーは ../../assets(ペット素材)と ../../../../sdk(IZ SDK)も配信するため、
#   games/wanwan と sdk の両方をイメージへ入れる。

# ── 依存のビルド(better-sqlite3 はネイティブ。prebuilt が無い環境でも通るようにする)
FROM node:22-bookworm AS deps
WORKDIR /app
COPY games/wanwan/server/package*.json ./
RUN npm ci --omit=dev

# ── 実行イメージ
FROM node:22-bookworm-slim
ENV NODE_ENV=production
# SQLite の実体はコンテナ内(/data)。永続化は litestream で GCS へ複製する(下記)
ENV WANWAN_DB=/data/wanwan.db
ENV PORT=8080

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# litestream(SQLite を継続的にオブジェクトストレージへ複製するサイドカー)
ARG LITESTREAM_VERSION=0.3.13
RUN curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.tar.gz" \
  | tar -xz -C /usr/local/bin litestream

WORKDIR /app
COPY --from=deps /app/node_modules ./games/wanwan/server/node_modules
COPY games/wanwan/server ./games/wanwan/server
COPY games/wanwan/data ./games/wanwan/data
COPY games/wanwan/assets ./games/wanwan/assets
COPY sdk ./sdk
COPY games/wanwan/deploy/litestream.yml /etc/litestream.yml
COPY games/wanwan/deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /data

WORKDIR /app/games/wanwan/server
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
