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

| 環境変数 | 既定 | 用途 |
|---|---|---|
| `PORT` | 8080 | Cloud Run が渡す |
| `WANWAN_DB` | `/data/wanwan.db` | SQLite の場所 |
| `LITESTREAM_REPLICA_URL` | (deploy.sh が設定) | `gs://<bucket>/wanwan` |
| `WANWAN_RECEIPT_SECRET` | 未設定 | IZ課金レシートの検証鍵。IZ側 Secret `GAME_RECEIPT_SECRET` と同じ値 |
| `FIREBASE_PROJECT` | `iz-app-6e1d5` | IZアカウント自動ログインの検証先 |

## デプロイ後

1. **管理者の作成**: 最初に登録したアカウントが管理者になる。デプロイ直後に自分で登録すること
   (放置すると他人が最初の登録者=管理者になる)。以後は管理画面の「アカウント」タブから権限を付与できる。
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
