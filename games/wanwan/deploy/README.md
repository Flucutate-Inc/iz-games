# わんわん大戦争 デプロイ

わんわん大戦争は静的バンドルではなく **Node サーバー**(HTTP API + WebSocket + 管理画面 + SQLite)なので、
他のゲームのように GitHub Pages では配信できない。ここでは Cloud Run へのデプロイ手順をまとめる。

## 構成

```
ブラウザ / IZアプリ WebView
   ↓ HTTPS + WSS
Cloud Run (asia-northeast1, min=1 / max=1, CPU常時割り当て)
   └ コンテナ内 /data/wanwan.db (SQLite)
        ↕ litestream で継続複製
      Cloud Storage gs://<project>-wanwan-db/wanwan
```

**なぜ max-instances=1 か**: 対戦ルームはプロセスのメモリ上にあり、SQLite も単一ファイル。
複数インスタンスに分散すると同じ試合が別プロセスに割れる。スケールアウトするには
ルーム分散とDBの外部化(設計書の将来対応)が必要。

**なぜ CPU 常時割り当て(`--no-cpu-throttling`)か**: 戦闘は 20Hz の `setInterval` で進む。
リクエスト外でもCPUが必要なため、スロットリングされると試合が止まる。

**永続化**: Cloud Run のファイルシステムは揮発するため、litestream で SQLite を GCS へ継続複製し、
起動時に復元する(`deploy/entrypoint.sh`)。`LITESTREAM_REPLICA_URL` 未設定なら複製なし(検証用)。

## デプロイ

```bash
gcloud auth login          # 組織のセッション制御で定期的に失効する
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

`--min-instances=1 --no-cpu-throttling`(常時起動・CPU常時割り当て)は
1 vCPU / 1GiB で **月あたり US$20〜30 程度**かかる。戦闘ループが常時動く設計のため
最小構成でもアイドル課金は避けられない。下げたい場合は `cloudbuild.yaml` の
`--cpu=0.5 --memory=512Mi` へ変更する(同時対戦数が少ないうちは十分)。

| 環境変数 | 既定 | 用途 |
|---|---|---|
| `PORT` | 8080 | Cloud Run が渡す |
| `WANWAN_DB` | `/data/wanwan.db` | SQLite の場所 |
| `LITESTREAM_REPLICA_URL` | (deploy.sh が設定) | `gs://<bucket>/wanwan` |
| `WANWAN_ADMIN_NAMES` | 未設定 | 管理者にする表示名(カンマ区切り)。**公開URLでは必ず設定する** |
| `WANWAN_RECEIPT_SECRET` | 未設定 | IZ課金レシートの検証鍵。IZ側 Secret `GAME_RECEIPT_SECRET` と同じ値 |
| `FIREBASE_PROJECT` | `iz-app-6e1d5` | IZアカウント自動ログインの検証先 |

## デプロイ後

1. **管理者の指定**: 公開URLでは `WANWAN_ADMIN_NAMES` に自分の表示名を設定してからデプロイすること。
   設定しておけば、その表示名で登録したときだけ管理者になる(第三者が先に登録しても管理者にならない)。
   ```bash
   gcloud run services update wanwan --region asia-northeast1 \
     --update-env-vars=WANWAN_ADMIN_NAMES=<あなたの表示名>
   ```
   未設定のままだと従来どおり「最初に登録した人」が管理者になる(ローカル検証用の挙動)。
   以後の追加・剥奪は管理画面の「アカウント」タブから行う。
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
