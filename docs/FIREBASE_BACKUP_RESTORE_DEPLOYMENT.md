# MUN COMPUTER ERP — Automatic Firebase Backup & Restore Architecture & Deployment Guide

## 1. System Overview
- **Frontend & API Gateway**: Vercel (`MUN COMPUTER ERP`) — custom 4-layer ERP authentication (User ID + Password, CAPTCHA, Fast2SMS OTP, Google Authenticator TOTP). Google OAuth login is permanently removed.
- **Database**: Firebase Cloud Firestore (`gen-lang-client-0631735980`, database `ai-studio-remixremixmaishj-f383be4b-a370-477e-bcbb-4d9a3c3870b9`)
- **File Storage**: Firebase Storage (`gen-lang-client-0631735980.firebasestorage.app`)
- **Backup Worker**: Google Cloud Run (`cloud-run-backup/server.ts`), using Application Default Credentials (ADC) with least-privilege IAM.
- **Scheduler**: Google Cloud Scheduler (`Asia/Kolkata` timezone) with OIDC JWT authentication:
  - `02:00 AM IST` (`0 2 * * *`): Full Native Firestore Managed Export -> `gs://BACKUP_BUCKET/firestore/YYYY/MM/DD/TIMESTAMP/`
  - `02:30 AM IST` (`30 2 * * *`): Firebase Storage Incremental + Full Versioned Copy + Checksum Verification + Manifest -> `gs://BACKUP_BUCKET/storage/YYYY/MM/DD/TIMESTAMP/`

## 2. Environment Variables (Vercel vs Cloud Run)
### Vercel (Server-Side / API Environment ONLY — never expose private secrets as `VITE_*`)
- `FIREBASE_PROJECT_ID=gen-lang-client-0631735980`
- `FIREBASE_DATABASE_ID=ai-studio-remixremixmaishj-f383be4b-a370-477e-bcbb-4d9a3c3870b9`
- `FIREBASE_STORAGE_BUCKET=gen-lang-client-0631735980.firebasestorage.app`
- `BACKUP_GCS_BUCKET=gen-lang-client-0631735980-mun-backups`
- `BACKUP_CLOUD_RUN_URL=<deployed Cloud Run HTTPS URL>`
- `BACKUP_SERVICE_AUTH_TOKEN=<shared secret stored in Secret Manager & Vercel Server Env>`
- `FIREBASE_SERVICE_ACCOUNT_JSON=<JSON service account or Workload Identity Federation>`

### Google Cloud Run Worker (`cloud-run-backup/Dockerfile`)
- `FIREBASE_USE_ADC=true` (uses attached Cloud Run IAM Service Account automatically)
- `FIREBASE_PROJECT_ID=gen-lang-client-0631735980`
- `FIREBASE_DATABASE_ID=ai-studio-remixremixmaishj-f383be4b-a370-477e-bcbb-4d9a3c3870b9`
- `FIREBASE_STORAGE_BUCKET=gen-lang-client-0631735980.firebasestorage.app`
- `BACKUP_GCS_BUCKET=gen-lang-client-0631735980-mun-backups`
- `CLOUD_SCHEDULER_AUDIENCE=<deployed Cloud Run HTTPS URL>`
- `CLOUD_SCHEDULER_SA_EMAIL=<mun-backup-scheduler-sa@project.iam.gserviceaccount.com>`
- `BACKUP_SERVICE_AUTH_TOKEN` (injected from Google Cloud Secret Manager)

## 3. GCS Backup Bucket Hardening & Soft Delete
- Bucket created with `--uniform-bucket-level-access` and `--public-access-prevention`.
- Object Versioning enabled + `--soft-delete-duration=30d` protects deleted/overwritten backup objects against ransomware or human error.
- `deploy/gcs-lifecycle.json` manages 30-day object aging alongside application-level `RetentionService`, which guarantees:
  - **Latest successful backup** is always preserved.
  - **Only successful backup** is never deleted.
  - **Failed & partial backup logs** remain permanently for troubleshooting.

## 4. Provisioning Command
```bash
chmod +x deploy/setup-cloud-backup.sh
./deploy/setup-cloud-backup.sh
```
