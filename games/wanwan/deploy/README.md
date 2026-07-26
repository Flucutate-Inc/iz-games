# わんわん大戦争 デプロイ

わんわん大戦争は静的バンドルではなく **Node サーバー**(HTTP API + WebSocket + 管理画面 + SQLite)なので、
他のゲームのように GitHub Pages では配信できない。ここでは Cloud Run へのデプロイ手順をまとめる。

## 構成(無料枠に収まるゼロスケール構成)

```
ブラウザ / IZアプリ WebView
   ↓ HTTPS + WSS
Cloud Run (asia-northeast1, min=0 / max=1, 512MiB)
   └ コンテナ内 /data/wanwan.db (SQLite)
        ↕ litestream で継続複製
      Cloud Storage gs://<project>-wanwan-db/wanwan
```

**なぜ max-instances=1 か**: 対戦ルームはプロセスのメモリ上にあり、SQLite も単一ファイル。
複数インスタンスに分散すると同じ試合が別プロセスに割れる。スケールアウトするには
ルーム分散とDBの外部化(設計書の将来対応)が必要。

**なぜ min-instances=0 か(無料枠)**: Cloud Run の無料枠は毎月
**180,000 vCPU秒 / 360,000 GiB秒 / 200万リクエスト**。常時起動(`--min-instances=1
--no-cpu-throttling`)にすると月260万vCPU秒となり大きく超過する(月20〜30ドル)。
ゼロスケールなら**誰も遊んでいない間は課金されない**。

**それで戦闘ループは動くのか**: 動く。Cloud Run は**リクエスト処理中のみCPUを割り当てる**が、
WebSocket 接続は「実行中の長いリクエスト」として扱われるため、**対戦中は常にCPUが割り当てられ**
20Hz の `setInterval` も進む。両者が切断している間だけ停止する(そのときは進める必要もない)。

**ゼロスケールの副作用**:
- 最初のアクセスはコールドスタート(イメージpull+起動+litestream復元で数秒)。
- 両者が同時に切断すると試合が凍結する。再接続で再開するが、切断敗北の判定も止まる。
- 予約公開は待機中に動かないので、次にアクセスがあった時点でまとめて実行される(起動時にも確認する)。

常時起動にしたい場合は `cloudbuild.yaml` の `--min-instances=1 --no-cpu-throttling` を有効化する。

**永続化**: Cloud Run のファイルシステムは揮発するため、litestream で SQLite を GCS へ継続複製し、
起動時に復元する(`deploy/entrypoint.sh`)。`LITESTREAM_REPLICA_URL` 未設定なら複製なし(検証用)。
DBは数MB程度なので GCS の費用も無視できる(Always Free の5GBは us-east1/us-west1/us-central1 のみ。
`asia-northeast1` に置いても月0.01ドル未満)。

### 無料枠に収めるためのチェックリスト

| サービス | 無料枠 | この構成での使い方 |
|---|---|---|
| Cloud Run | 180k vCPU秒・360k GiB秒・200万req/月 | ゼロスケール。1日1時間プレイでも月11k vCPU秒程度 |
| Cloud Build | 120 ビルド分/日 | デプロイ1回あたり2〜3分 |
| Artifact Registry | 0.5GB | イメージは約300MB。**古いイメージを消さないと超過**するので下記を実行 |
| Cloud Storage | 5GB(米国3リージョンのみ) | SQLiteの複製。数MB |

```bash
# 古いイメージを消す(直近3つを残す)。Artifact Registry の無料枠を超えないため
gcloud artifacts docker images list asia-northeast1-docker.pkg.dev/$PROJECT/wanwan/wanwan \
  --format='value(version)' --sort-by=~CREATE_TIME | tail -n +4 | \
  xargs -r -I{} gcloud artifacts docker images delete \
  asia-northeast1-docker.pkg.dev/$PROJECT/wanwan/wanwan@{} --quiet --delete-tags
```

## デプロイ

```bash
gcloud auth login          # 組織のセッション制御で定期的に失効する

# 初期管理者用のトークンを作ってからデプロイする(公開URLでは必須)
export WANWAN_ADMIN_TOKEN="$(openssl rand -hex 16)"
echo "管理者トークン: $WANWAN_ADMIN_TOKEN"   # 控えておく
./games/wanwan/deploy/deploy.sh
```

初回は API 有効化・Artifact Registry・GCS バケット・実行サービスアカウントの作成まで行う。
2回目以降は同じコマンドでビルドと差し替えのみ。

### 初回だけ必要な権限付与(スクリプトには含めていない)

Cloud Build から Cloud Run へデプロイするには、ビルド実行SAに権限が要る。
プロジェクトの設定によってビルドSAは2種類ありうるので、使われている方に付与する。

```bash
PROJECT=iz-app-6e1d5
NUM=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
BUILD_SA=$NUM@cloudbuild.gserviceaccount.com      # 新しめのプロジェクトでは $NUM-compute@developer.gserviceaccount.com

# Cloud Run へデプロイする権限
gcloud projects add-iam-policy-binding $PROJECT \
  --member=serviceAccount:$BUILD_SA --role=roles/run.admin --condition=None

# 実行SAとしてデプロイするために必要
gcloud iam service-accounts add-iam-policy-binding wanwan-run@$PROJECT.iam.gserviceaccount.com \
  --member=serviceAccount:$BUILD_SA --role=roles/iam.serviceAccountUser --project $PROJECT
```

`--allow-unauthenticated` が組織ポリシー(`constraints/iam.allowedPolicyMemberDomains`)で
弾かれる場合は、ドメイン制限の例外設定が必要。設定できない場合は Cloud Run を非公開のままにして
IAP か Firebase Hosting のリライト経由で公開する構成に変更すること。

### 費用の目安

既定のゼロスケール構成なら、**遊んだ時間ぶんしか課金されず、通常は無料枠に収まる**。
目安として 1 vCPU / 512MiB で毎日1時間プレイしても月あたり約 11,000 vCPU秒
(無料枠 180,000 vCPU秒の6%)。無料枠を超えるのは、常時起動へ切り替えた場合か、
1日あたり50時間ぶん以上の同時接続が発生した場合。

| 環境変数 | 既定 | 用途 |
|---|---|---|
| `PORT` | 8080 | Cloud Run が渡す |
| `WANWAN_DB` | `/data/wanwan.db` | SQLite の場所 |
| `LITESTREAM_REPLICA_URL` | (deploy.sh が設定) | `gs://<bucket>/wanwan` |
| `WANWAN_ADMIN_TOKEN` | 未設定 | 初期管理者を作るための秘密トークン。**公開URLでは必ず設定し、作成後に外す** |
| `WANWAN_RECEIPT_SECRET` | 未設定 | IZ課金レシートの検証鍵。IZ側 Secret `GAME_RECEIPT_SECRET` と同じ値 |
| `FIREBASE_PROJECT` | `iz-app-6e1d5` | IZアカウント自動ログインの検証先 |

## デプロイ後

1. **初期管理者を作る(最優先)**: `WANWAN_ADMIN_TOKEN` を設定してデプロイし、
   そのトークンを添えて登録したアカウントだけが管理者になる。表示名は何でもよい
   (表示名を条件にすると、名前を知られた時点で先に登録されて奪われるため)。
   ```bash
   URL=$(gcloud run services describe wanwan --region asia-northeast1 --format='value(status.url)')
   curl -X POST "$URL/api/register" -H 'Content-Type: application/json' \
     -d "{\"name\":\"<表示名>\",\"password\":\"<パスワード>\",\"adminToken\":\"$WANWAN_ADMIN_TOKEN\"}"
   ```
   **作成後は必ずトークンを外す**(残すと知っている人が誰でも管理者になれる):
   ```bash
   gcloud run services update wanwan --region asia-northeast1 --remove-env-vars=WANWAN_ADMIN_TOKEN
   ```
   トークン未設定の間は「最初に登録した人」が管理者になる(ローカル検証用の挙動)。
   以後の追加・剥奪は管理画面の「アカウント」タブから行う。
   なお、この環境変数は**新規登録時にしか効かない**。すでに管理者がいるDBに後から設定しても
   既存の権限は変わらないので、不要な管理者は管理画面から剥奪すること。
2. **IZ課金**: 使う場合のみ、IZ側と同じ鍵を設定する。
   ```bash
   gcloud run services update wanwan --region asia-northeast1 \
     --update-secrets=WANWAN_RECEIPT_SECRET=GAME_RECEIPT_SECRET:latest
   ```
3. **IZアプリへの掲載**: リポジトリ直下の `games.json` に Cloud Run の URL で登録する
   (登録するとIZアプリのゲーム一覧に出る)。

## ローカルでの動作確認

```bash
docker build -f games/wanwan/Dockerfile -t wanwan .
docker run --rm -p 8787:8080 -e PORT=8080 wanwan     # DBは揮発(検証用)
```

## 注意

- ヘルスチェックは `GET /healthz`(公開バランス版IDと稼働秒を返す)。
- 再デプロイすると進行中の試合は切れる。切断猶予(既定10秒)を超えると切断敗北になるため、
  更新は試合数の少ない時間帯に行う(管理画面「稼働」タブで進行中の試合を確認できる)。
- litestream の複製は約1秒間隔。クラッシュ時に最後の1秒ぶんが失われる可能性がある。
