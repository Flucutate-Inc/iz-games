# わんわん大戦争 デプロイ

わんわん大戦争は静的バンドルではなく **サーバー**(HTTP API + WebSocket + 管理画面 + SQLite)を持つため、
他のゲームのように GitHub Pages では配信できない。

デプロイ先は2通り用意してある。**既定は無料枠で動く Cloudflare Workers + Durable Objects**。

| | Cloudflare Workers + DO(既定) | Google Cloud Run |
|---|---|---|
| 費用 | **無料枠に収まる**(下記) | ゼロスケールなら概ね無料枠 |
| 状態 | Durable Object の SQLite(そのまま永続) | コンテナ内SQLite + litestreamでGCSへ複製 |
| 待機時 | DOが休止(接続で復帰) | インスタンス0 |
| 手順 | `npm run deploy` | `deploy/deploy.sh` |

---

# A. Cloudflare Workers + Durable Objects(既定・無料)

## 構成

```
ブラウザ / IZアプリ WebView
   ↓ HTTPS + WSS
Worker(静的アセット配信: ゲーム・管理画面・素材・SDK)
   └ /api/*, /ws, /healthz だけ → Durable Object "main"
        ├ SQLite (DO storage) … users/decks/matches/balance/gacha
        ├ 対戦ルーム(メモリ)   … 20Hz の戦闘ループ
        └ WebSocket           … 対戦の同期
```

**なぜ Durable Object 1個か**: 対戦ルームはメモリ上にあり、SQLite も単一。
Cloud Run 版の `max-instances=1` と同じ前提を、DO の「名前ごとに単一インスタンス」で満たす。

**なぜ無料枠に収まるか**(2026-07 時点の Workers Free):

| 項目 | 無料枠 | この構成での消費 |
|---|---|---|
| リクエスト | 100,000/日 | **受信WSメッセージは20:1で課金**(100通=5)・**送信は無料**・**setIntervalのtickは非課金** |
| DO 実行時間 | 13,000 GB秒/日 | DO(128MB)を24時間動かしても 10,800 GB秒 |
| SQLite | 5GB | 数MB |
| 静的アセット | 無制限・無課金 | ゲーム本体・素材(4.7MB) |

20Hz の戦闘ループはリクエストを消費しない(タイマーコールバックは課金対象外)ため、
**対戦を続けてもリクエスト数はほぼ増えない**。

## デプロイ

```bash
cd games/wanwan
npm install
npx wrangler login          # または CLOUDFLARE_API_TOKEN を環境変数で渡す
npm run deploy              # アセット収集 → バンドル → デプロイ
```

APIトークンで非対話デプロイする場合は、**Workers Scripts:Edit** 権限を持つトークンを作り、
IP制限を付けない(付ける場合は実行元IPを許可する)こと。

```bash
CLOUDFLARE_API_TOKEN=xxxxx npm run deploy
```

デプロイ後の URL は `https://wanwan.<サブドメイン>.workers.dev`。

## ローカルで動かす

```bash
cd games/wanwan
npm run dev      # http://localhost:8788 (workerd 上で本番と同じ構成)
```

E2E も同じものがそのまま通る:

```bash
cd games/wanwan/server
BASE=http://localhost:8788 node test/e2e.js
BASE=http://localhost:8788 ADMIN_NAME=<管理者名> ADMIN_PASS=<パスワード> node test/admin-e2e.js
```

## 移植のしくみ(サーバーコードは無改修)

`wrangler.jsonc` の `alias` で、Node 用の依存を Workers 用へ差し替えている。

| 差し替え元 | 差し替え先 | 役割 |
|---|---|---|
| `better-sqlite3` | `worker/sql-do.js` | DO SQLite を better-sqlite3 と同じAPIで使う |
| `express` | `worker/express-shim.js` | Router / req / res の最小互換 |
| `fs` | `worker/fs-shim.js` | 初期バランスJSONだけをバンドルから返す |

`server/src/*` は Node でも Workers でも同じコードが動く(`db.init()` だけ、
SQLite ハンドルが用意できたタイミングで呼び分ける)。

## 環境変数(wrangler.jsonc の vars / secret)

| 変数 | 既定 | 用途 |
|---|---|---|
| `FIREBASE_PROJECT` | `iz-app-6e1d5` | IZアカウント自動ログインの検証先 |
| `WANWAN_ADMIN_TOKEN` | 未設定 | 初期管理者を作るための秘密トークン。**公開後は必ず外す** |
| `WANWAN_RECEIPT_SECRET` | 未設定 | IZ課金レシートの検証鍵(IZ側 `GAME_RECEIPT_SECRET` と同じ値) |

秘密値は `vars` ではなく secret に入れる:

```bash
npx wrangler secret put WANWAN_ADMIN_TOKEN
npx wrangler secret put WANWAN_RECEIPT_SECRET
```

## デプロイ後

1. **初期管理者を作る**(最優先)。`WANWAN_ADMIN_TOKEN` を設定した状態で、そのトークンを添えて登録する。
   ```bash
   curl -X POST https://<デプロイ先>/api/register -H 'Content-Type: application/json' \
     -d '{"name":"<表示名>","password":"<パスワード>","adminToken":"<トークン>"}'
   npx wrangler secret delete WANWAN_ADMIN_TOKEN   # 作成後は必ず外す
   ```
   トークン未設定の間は「最初に登録した人」が管理者になる(ローカル検証用の挙動)。
2. **IZアプリへの掲載**: リポジトリ直下の `games.json` にデプロイ先URLを登録する。
3. 以後の管理者の追加・剥奪は管理画面の「アカウント」タブから。

## 注意

- ヘルスチェックは `GET /healthz`。
- 再デプロイすると DO が再起動し、進行中の試合は切れる(SQLiteのデータは保持)。
  管理画面の「稼働」タブで進行中の試合を確認してから行う。
- 両者が同時に切断すると DO が休止し、その間は試合が進まない(再接続で再開)。

---

# B. Google Cloud Run(代替)

コンテナで動かす場合の手順。SQLite は litestream で GCS へ継続複製する。

## 構成

```
Cloud Run (asia-northeast1, min=0 / max=1, 512MiB)
   └ コンテナ内 /data/wanwan.db (SQLite)
        ↕ litestream で継続複製 → Cloud Storage
```

**なぜ min-instances=0 か(無料枠)**: Cloud Run の無料枠は毎月
180,000 vCPU秒 / 360,000 GiB秒 / 200万リクエスト。常時起動にすると超過する(月20〜30ドル)。
WebSocket 接続中はリクエスト実行中としてCPUが割り当てられるため、対戦中は戦闘ループが動く。

**永続化**: Cloud Run のファイルシステムは揮発するため、litestream で SQLite を GCS へ継続複製し、
起動時に復元する(`deploy/entrypoint.sh`)。`LITESTREAM_REPLICA_URL` 未設定なら複製なし(検証用)。

## デプロイ

```bash
gcloud auth login          # 組織のセッション制御で定期的に失効する
export WANWAN_ADMIN_TOKEN="$(openssl rand -hex 16)"
./games/wanwan/deploy/deploy.sh
```

### 初回だけ必要な権限付与(スクリプトには含めていない)

```bash
PROJECT=iz-app-6e1d5
NUM=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
BUILD_SA=$NUM@cloudbuild.gserviceaccount.com      # 新しめのプロジェクトでは $NUM-compute@developer.gserviceaccount.com

gcloud projects add-iam-policy-binding $PROJECT \
  --member=serviceAccount:$BUILD_SA --role=roles/run.admin --condition=None
gcloud projects add-iam-policy-binding $PROJECT \
  --member=serviceAccount:$BUILD_SA --role=roles/artifactregistry.writer --condition=None
gcloud iam service-accounts add-iam-policy-binding wanwan-run@$PROJECT.iam.gserviceaccount.com \
  --member=serviceAccount:$BUILD_SA --role=roles/iam.serviceAccountUser --project $PROJECT
```

`--allow-unauthenticated` が組織ポリシーで弾かれる場合は、ドメイン制限の例外設定が必要。

## ローカルでの動作確認

```bash
docker build -f games/wanwan/Dockerfile -t wanwan .
docker run --rm -p 8787:8080 -e PORT=8080 wanwan     # DBは揮発(検証用)
```

## 無料枠のチェックリスト

| サービス | 無料枠 | 使い方 |
|---|---|---|
| Cloud Run | 180k vCPU秒・360k GiB秒・200万req/月 | ゼロスケール。1日1時間プレイで月11k vCPU秒程度 |
| Cloud Build | 120 ビルド分/日 | デプロイ1回2〜3分 |
| Artifact Registry | 0.5GB | イメージ約400MB。古いものは削除する |
| Cloud Storage | 5GB(米国3リージョン) | SQLiteの複製。数MB |

```bash
# 古いイメージを消す(直近3つを残す)
gcloud artifacts docker images list asia-northeast1-docker.pkg.dev/$PROJECT/wanwan/wanwan \
  --format='value(version)' --sort-by=~CREATE_TIME | tail -n +4 | \
  xargs -r -I{} gcloud artifacts docker images delete \
  asia-northeast1-docker.pkg.dev/$PROJECT/wanwan/wanwan@{} --quiet --delete-tags
```
