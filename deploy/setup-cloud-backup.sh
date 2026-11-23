#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# MUN COMPUTER ERP — Production Firebase Backup & Restore Infrastructure Setup
# Target Project: gen-lang-client-0631735980
# Region: asia-south1 (Mumbai) · Timezone: Asia/Kolkata
# ==============================================================================

PROJECT_ID="${PROJECT_ID:-gen-lang-client-0631735980}"
REGION="${REGION:-asia-south1}"
FIRESTORE_DB_ID="${FIRESTORE_DB_ID:-ai-studio-remixremixmaishj-f383be4b-a370-477e-bcbb-4d9a3c3870b9}"
SOURCE_BUCKET="${SOURCE_BUCKET:-gen-lang-client-0631735980.firebasestorage.app}"
BACKUP_BUCKET="${BACKUP_BUCKET:-gen-lang-client-0631735980-mun-backups}"
SERVICE_NAME="${SERVICE_NAME:-mun-erp-backup-worker}"
BACKUP_SA_NAME="mun-backup-worker-sa"
SCHEDULER_SA_NAME="mun-backup-scheduler-sa"

echo "==> 1. Enable required Google Cloud APIs"
gcloud services enable \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  firestore.googleapis.com \
  storage.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  --project="${PROJECT_ID}"

echo "==> 2. Create dedicated non-public GCS backup bucket with Uniform Access + Versioning + 30d Soft Delete"
if ! gcloud storage buckets describe "gs://${BACKUP_BUCKET}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BACKUP_BUCKET}" \
    --project="${PROJECT_ID}" \
    --location="${REGION}" \
    --uniform-bucket-level-access \
    --public-access-prevention \
    --soft-delete-duration=30d
fi

gcloud storage buckets update "gs://${BACKUP_BUCKET}" \
  --versioning \
  --public-access-prevention \
  --soft-delete-duration=30d \
  --lifecycle-file="deploy/gcs-lifecycle.json" \
  --project="${PROJECT_ID}"

echo "==> 3. Create least-privilege IAM Service Accounts"
gcloud iam service-accounts create "${BACKUP_SA_NAME}" \
  --display-name="MUN ERP Backup Cloud Run Worker SA" \
  --project="${PROJECT_ID}" || true

gcloud iam service-accounts create "${SCHEDULER_SA_NAME}" \
  --display-name="MUN ERP Cloud Scheduler OIDC SA" \
  --project="${PROJECT_ID}" || true

BACKUP_SA_EMAIL="${BACKUP_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_SA_EMAIL="${SCHEDULER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# Allow Worker SA to run Firestore Managed Export/Import and read/write backup metadata
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${BACKUP_SA_EMAIL}" \
  --role="roles/datastore.importExportAdmin"

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${BACKUP_SA_EMAIL}" \
  --role="roles/datastore.user"

# Read-only object viewer on source Firebase Storage bucket
gcloud storage buckets add-iam-policy-binding "gs://${SOURCE_BUCKET}" \
  --member="serviceAccount:${BACKUP_SA_EMAIL}" \
  --role="roles/storage.objectViewer"

# Object Admin on dedicated GCS Backup bucket
gcloud storage buckets add-iam-policy-binding "gs://${BACKUP_BUCKET}" \
  --member="serviceAccount:${BACKUP_SA_EMAIL}" \
  --role="roles/storage.objectAdmin"

echo "==> 4. Store Admin Service Auth Token in Secret Manager"
if ! gcloud secrets describe mun-backup-service-token --project="${PROJECT_ID}" >/dev/null 2>&1; then
  openssl rand -hex 32 | gcloud secrets create mun-backup-service-token \
    --data-file=- \
    --replication-policy="automatic" \
    --project="${PROJECT_ID}"
fi

gcloud secrets add-iam-policy-binding mun-backup-service-token \
  --member="serviceAccount:${BACKUP_SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor" \
  --project="${PROJECT_ID}"

echo "==> 5. Deploy Cloud Run Backup Service (authenticated, non-public scheduler access)"
gcloud builds submit --config=cloud-run-backup/Dockerfile . || \
  gcloud run deploy "${SERVICE_NAME}" \
    --source=. \
    --dockerfile=cloud-run-backup/Dockerfile \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --service-account="${BACKUP_SA_EMAIL}" \
    --no-allow-unauthenticated \
    --set-env-vars="FIREBASE_PROJECT_ID=${PROJECT_ID},FIREBASE_DATABASE_ID=${FIRESTORE_DB_ID},FIREBASE_STORAGE_BUCKET=${SOURCE_BUCKET},BACKUP_GCS_BUCKET=${BACKUP_BUCKET},CLOUD_SCHEDULER_SA_EMAIL=${SCHEDULER_SA_EMAIL},FIREBASE_USE_ADC=true" \
    --set-secrets="BACKUP_SERVICE_AUTH_TOKEN=mun-backup-service-token:latest"

CLOUD_RUN_URL="$(gcloud run services describe "${SERVICE_NAME}" --region="${REGION}" --project="${PROJECT_ID}" --format='value(status.url)')"

gcloud run services update "${SERVICE_NAME}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --update-env-vars="CLOUD_SCHEDULER_AUDIENCE=${CLOUD_RUN_URL},BACKUP_CLOUD_RUN_URL=${CLOUD_RUN_URL}"

gcloud run services add-iam-policy-binding "${SERVICE_NAME}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --member="serviceAccount:${SCHEDULER_SA_EMAIL}" \
  --role="roles/run.invoker"

echo "==> 6. Configure Cloud Scheduler Jobs (Asia/Kolkata: 02:00 AM Firestore, 02:30 AM Storage)"
gcloud scheduler jobs create http mun-erp-firestore-daily-0200-ist \
  --location="${REGION}" \
  --schedule="0 2 * * *" \
  --time-zone="Asia/Kolkata" \
  --uri="${CLOUD_RUN_URL}/scheduler/firestore-backup" \
  --http-method=POST \
  --oidc-service-account-email="${SCHEDULER_SA_EMAIL}" \
  --oidc-token-audience="${CLOUD_RUN_URL}" \
  --max-retry-attempts=3 \
  --min-backoff=30s \
  --max-backoff=300s \
  --project="${PROJECT_ID}" || true

gcloud scheduler jobs create http mun-erp-storage-daily-0230-ist \
  --location="${REGION}" \
  --schedule="30 2 * * *" \
  --time-zone="Asia/Kolkata" \
  --uri="${CLOUD_RUN_URL}/scheduler/storage-backup" \
  --http-method=POST \
  --oidc-service-account-email="${SCHEDULER_SA_EMAIL}" \
  --oidc-token-audience="${CLOUD_RUN_URL}" \
  --max-retry-attempts=3 \
  --min-backoff=30s \
  --max-backoff=300s \
  --project="${PROJECT_ID}" || true

echo "Setup completed cleanly."
echo "Cloud Run URL: ${CLOUD_RUN_URL}"
