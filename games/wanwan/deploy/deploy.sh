#!/usr/bin/env bash
# わんわん大戦争サーバーを Cloud Run へデプロイする(初回はAPI有効化・バケット・SA作成も行う)。
#
#   WANWAN_ADMIN_NAMES=<あなたの表示名> ./games/wanwan/deploy/deploy.sh
#   PROJECT=xxx REGION=asia-northeast1 WANWAN_ADMIN_NAMES=... ./games/wanwan/deploy/deploy.sh
#
# WANWAN_ADMIN_NAMES を指定すると、その表示名で登録したときだけ管理者になる。
# 公開URLでは必ず指定すること(未指定だと最初に登録した第三者が管理者になる)。
#
# 事前に `gcloud auth login`(組織のセッション制御で定期的に失効する)が必要。
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
if [ -z "$PROJECT" ] || [ "$PROJECT" = "(unset)" ]; then
  echo "PROJECT を指定するか、gcloud config set project <project-id> を実行してください(例: iz-app-6e1d5)。" >&2
  exit 2
fi
REGION="${REGION:-asia-northeast1}"
SERVICE="${SERVICE:-wanwan}"
REPO="${REPO:-wanwan}"
BUCKET_NAME="${BUCKET_NAME:-${PROJECT}-wanwan-db}"
RUN_SA="${RUN_SA:-wanwan-run@${PROJECT}.iam.gserviceaccount.com}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

echo "▶ project=$PROJECT region=$REGION service=$SERVICE"

echo "▶ API を有効化"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com storage.googleapis.com --project "$PROJECT"

echo "▶ Artifact Registry"
gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "$REPO" --repository-format=docker --location "$REGION" \
    --description="わんわん大戦争" --project "$PROJECT"

echo "▶ SQLite 複製先バケット(litestream)"
gcloud storage buckets describe "gs://${BUCKET_NAME}" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://${BUCKET_NAME}" --location "$REGION" \
    --uniform-bucket-level-access --project "$PROJECT"

echo "▶ 実行サービスアカウント"
gcloud iam service-accounts describe "$RUN_SA" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "${RUN_SA%%@*}" --display-name="wanwan Cloud Run" --project "$PROJECT"
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET_NAME}" \
  --member="serviceAccount:${RUN_SA}" --role=roles/storage.objectAdmin --project "$PROJECT" >/dev/null

echo "▶ Cloud Build 実行SAの権限を確認"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
cat <<NOTE
  ビルド実行SAには次の権限が必要です(不足していると初回デプロイが失敗します)。
  付与コマンドは games/wanwan/deploy/README.md を参照してください。
    - roles/artifactregistry.writer  (イメージのpush)
    - roles/run.admin               (Cloud Runへのデプロイ)
    - roles/iam.serviceAccountUser  (実行SA ${RUN_SA} の利用)
  対象SA: ${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com
          または ${PROJECT_NUMBER}-compute@developer.gserviceaccount.com
NOTE

echo "▶ ビルド + デプロイ"
cd "$ROOT"
gcloud builds submit --config games/wanwan/deploy/cloudbuild.yaml --project "$PROJECT" \
  --substitutions="^@^_REGION=${REGION}@_SERVICE=${SERVICE}@_REPO=${REPO}@_BUCKET=gs://${BUCKET_NAME}/wanwan@_SERVICE_ACCOUNT=${RUN_SA}@_ADMIN_NAMES=${WANWAN_ADMIN_NAMES:-}"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format='value(status.url)')"
echo "▶ デプロイ完了: $URL"
echo "▶ ヘルスチェック"
curl -fsS "$URL/healthz" && echo

cat <<MSG

次の手順:
  1) 最初に登録したアカウントが管理者になります。$URL でアカウントを作成してください。
  2) IZ課金を使う場合: Secret Manager の GAME_RECEIPT_SECRET と同じ値を
     WANWAN_RECEIPT_SECRET に設定してください。
       gcloud run services update $SERVICE --region $REGION \\
         --update-secrets=WANWAN_RECEIPT_SECRET=GAME_RECEIPT_SECRET:latest
  3) IZアプリの一覧に載せる場合は games.json に $URL を登録してください。
MSG
