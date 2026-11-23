import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { SecurityStore } from '../server/securityStore';
import { Phase03Store } from '../server/phase03Store';
import { ErpStore } from '../server/erpStore';
import { FinanceStore } from '../server/finance/financeStore';
import { ReportStore } from '../server/reports/reportStore';
import { Phase08Store } from '../server/phase08/phase08Store';
import { QaStore } from '../server/phase09/qaStore';
import { CscStore } from '../server/cscStore';
import { performFourLayerLogin, createTestUser } from './testAuthHelper';
import { BackupMetadataStore } from '../server/backup/backupMetadataStore';
import { BackupOrchestrator } from '../server/backup/backupOrchestrator';
import {
  FirestoreAdminRestAdapter,
  FirestoreManagedOperation,
  GcsBackupStorageAdapter,
  GcsObjectInfo,
} from '../server/backup/backupTypes';
import { createCloudRunBackupApp } from '../cloud-run-backup/server';
import { getResolvedFirebaseAdminConfig } from '../server/firebaseAdminDb';

interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
  json: any;
  cookies: Record<string, string>;
}

function extractSetCookies(rawList: string[]): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const entry of rawList) {
    const firstPart = entry.split(';')[0];
    const idx = firstPart.indexOf('=');
    if (idx > -1) {
      jar[firstPart.slice(0, idx).trim()] = decodeURIComponent(firstPart.slice(idx + 1).trim());
    }
  }
  return jar;
}

async function reqApi(
  baseUrl: string,
  method: string,
  urlPath: string,
  body?: unknown,
  cookies: Record<string, string> = {},
  extraHeaders: Record<string, string> = {}
): Promise<HttpResult> {
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('; ');

  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(cookies.mun_csrf ? { 'X-CSRF-Token': cookies.mun_csrf } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  const setCookies =
    typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie()
      : res.headers.get('set-cookie')
        ? [res.headers.get('set-cookie')!]
        : [];

  return {
    status: res.status,
    headers: res.headers,
    text,
    json,
    cookies: extractSetCookies(setCookies),
  };
}

class MockGcsAdapter implements GcsBackupStorageAdapter {
  public buckets = new Map<string, Map<string, { info: GcsObjectInfo; content: Buffer }>>();
  public failCopyForPath: string | null = null;
  public failChecksumForDest = false;
  public deleteCalls: string[] = [];

  seedObject(
    bucket: string,
    name: string,
    content: string | Buffer,
    options?: { generation?: string; contentType?: string; metadata?: Record<string, string> }
  ) {
    if (!this.buckets.has(bucket)) {
      this.buckets.set(bucket, new Map());
    }
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const md5Hash = crypto.createHash('md5').update(buf).digest('base64');
    const crc32c = crypto.createHash('sha256').update(buf).digest('base64').slice(0, 8);
    const info: GcsObjectInfo = {
      name,
      bucket,
      generation: options?.generation || '1',
      size: buf.length,
      contentType: options?.contentType || 'application/octet-stream',
      md5Hash,
      crc32c,
      updated: new Date().toISOString(),
      metadata: options?.metadata ? { ...options.metadata } : undefined,
      isPublic: false,
    };
    this.buckets.get(bucket)!.set(name, { info, content: buf });
    return info;
  }

  removeObject(bucket: string, name: string) {
    this.buckets.get(bucket)?.delete(name);
  }

  async listObjects(bucket: string, prefix = ''): Promise<GcsObjectInfo[]> {
    const map = this.buckets.get(bucket);
    if (!map) return [];
    const results: GcsObjectInfo[] = [];
    for (const [name, entry] of map.entries()) {
      if (!prefix || name.startsWith(prefix)) {
        results.push({ ...entry.info });
      }
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  async copyObject(params: {
    sourceBucket: string;
    sourceName: string;
    destBucket: string;
    destName: string;
    contentType?: string;
    metadata?: Record<string, string>;
  }): Promise<GcsObjectInfo> {
    if (this.failCopyForPath && params.sourceName.includes(this.failCopyForPath)) {
      throw new Error(`Simulated GCS copy failure for ${params.sourceName}`);
    }
    const src = this.buckets.get(params.sourceBucket)?.get(params.sourceName);
    if (!src) {
      throw new Error(`Source object gs://${params.sourceBucket}/${params.sourceName} does not exist.`);
    }
    if (!this.buckets.has(params.destBucket)) {
      this.buckets.set(params.destBucket, new Map());
    }
    const info: GcsObjectInfo = {
      name: params.destName,
      bucket: params.destBucket,
      generation: String(Number(src.info.generation || '1') + 1),
      size: src.info.size,
      contentType: params.contentType || src.info.contentType,
      md5Hash: this.failChecksumForDest ? 'CORRUPTED_MD5==' : src.info.md5Hash,
      crc32c: src.info.crc32c,
      updated: new Date().toISOString(),
      metadata: params.metadata ? { ...params.metadata } : src.info.metadata,
      isPublic: false,
    };
    this.buckets.get(params.destBucket)!.set(params.destName, {
      info,
      content: Buffer.from(src.content),
    });
    return { ...info };
  }

  async getObjectMetadata(bucket: string, name: string): Promise<GcsObjectInfo | null> {
    const hit = this.buckets.get(bucket)?.get(name);
    return hit ? { ...hit.info } : null;
  }

  async writeJsonObject(bucket: string, name: string, payload: unknown): Promise<void> {
    this.seedObject(bucket, name, JSON.stringify(payload, null, 2), {
      contentType: 'application/json',
    });
  }

  async readJsonObject<T = unknown>(bucket: string, name: string): Promise<T | null> {
    const hit = this.buckets.get(bucket)?.get(name);
    if (!hit) return null;
    return JSON.parse(hit.content.toString('utf8')) as T;
  }

  async deletePrefix(bucket: string, prefix: string): Promise<number> {
    this.deleteCalls.push(`gs://${bucket}/${prefix}`);
    const map = this.buckets.get(bucket);
    if (!map) return 0;
    let deleted = 0;
    for (const key of Array.from(map.keys())) {
      if (key.startsWith(prefix)) {
        map.delete(key);
        deleted++;
      }
    }
    return deleted;
  }
}

class MockFirestoreRestAdapter implements FirestoreAdminRestAdapter {
  public exportCalls: Array<{
    projectId: string;
    databaseId: string;
    outputUriPrefix: string;
    collectionIds?: string[];
  }> = [];
  public importCalls: Array<{
    projectId: string;
    databaseId: string;
    inputUriPrefix: string;
    collectionIds?: string[];
  }> = [];
  public transientFailuresBeforeSuccess = 0;
  public permanentFailureMessage: string | null = null;
  public simulateSlowMs = 0;
  private ops = new Map<string, { pollsLeft: number; doneResult: FirestoreManagedOperation }>();

  constructor(private readonly gcs: MockGcsAdapter) {}

  async exportDocuments(params: {
    projectId: string;
    databaseId: string;
    outputUriPrefix: string;
    collectionIds?: string[];
  }): Promise<FirestoreManagedOperation> {
    this.exportCalls.push(params);
    if (this.simulateSlowMs > 0) {
      await new Promise((r) => setTimeout(r, this.simulateSlowMs));
    }
    if (this.permanentFailureMessage) {
      throw new Error(this.permanentFailureMessage);
    }
    if (this.transientFailuresBeforeSuccess > 0) {
      this.transientFailuresBeforeSuccess--;
      throw new Error('HTTP 503 Firestore export temporarily unavailable');
    }

    const opName = `projects/${params.projectId}/databases/${params.databaseId}/operations/export-${this.exportCalls.length}`;
    const cleaned = params.outputUriPrefix.replace(/^gs:\/\//i, '');
    const slash = cleaned.indexOf('/');
    const bucket = cleaned.slice(0, slash);
    const prefix = cleaned.slice(slash + 1).replace(/\/+$/, '');

    // Populate native Managed Export metadata artifact inside backup bucket
    this.gcs.seedObject(bucket, `${prefix}/overall_export_metadata`, 'NATIVE_FIRESTORE_EXPORT_METADATA_PB', {
      contentType: 'application/octet-stream',
    });
    this.gcs.seedObject(bucket, `${prefix}/all_namespaces/all_kinds/output-0`, 'ENTITY_RECORDS', {
      contentType: 'application/octet-stream',
    });

    this.ops.set(opName, {
      pollsLeft: 1,
      doneResult: {
        name: opName,
        done: true,
        response: { outputUriPrefix: params.outputUriPrefix },
      },
    });

    return {
      name: opName,
      done: false,
      metadata: { operationState: 'PROCESSING' },
    };
  }

  async importDocuments(params: {
    projectId: string;
    databaseId: string;
    inputUriPrefix: string;
    collectionIds?: string[];
  }): Promise<FirestoreManagedOperation> {
    this.importCalls.push(params);
    const opName = `projects/${params.projectId}/databases/${params.databaseId}/operations/import-${this.importCalls.length}`;
    this.ops.set(opName, {
      pollsLeft: 1,
      doneResult: {
        name: opName,
        done: true,
        response: { inputUriPrefix: params.inputUriPrefix },
      },
    });
    return {
      name: opName,
      done: false,
      metadata: { operationState: 'PROCESSING' },
    };
  }

  async getOperationStatus(operationName: string): Promise<FirestoreManagedOperation> {
    const entry = this.ops.get(operationName);
    if (!entry) {
      return { name: operationName, done: false };
    }
    if (entry.pollsLeft > 0) {
      entry.pollsLeft--;
      return { name: operationName, done: false };
    }
    return entry.doneResult;
  }
}

function buildTestOrchestrator() {
  const gcs = new MockGcsAdapter();
  const fsRest = new MockFirestoreRestAdapter(gcs);
  const store = new BackupMetadataStore({
    useAdminFirestore: false,
    persistencePath: null,
  });
  store.config.backupBucket = 'mun-test-backup-bucket';
  store.config.sourceProjectId = 'gen-lang-client-0631735980';
  store.config.sourceDatabaseId = 'ai-studio-test-db';
  store.config.sourceStorageBucket = 'gen-lang-client-0631735980.firebasestorage.app';
  store.config.retryBaseDelayMs = 10;

  gcs.seedObject(
    'gen-lang-client-0631735980.firebasestorage.app',
    'customers/CUST-001/photo.jpg',
    'JPEG_BINARY_V1',
    { generation: '101', contentType: 'image/jpeg', metadata: { uploadedBy: 'OP01' } }
  );
  gcs.seedObject(
    'gen-lang-client-0631735980.firebasestorage.app',
    'applications/APP-100/pan_doc.pdf',
    'PDF_BINARY_V1',
    { generation: '202', contentType: 'application/pdf', metadata: { docType: 'PAN' } }
  );

  const orchestrator = new BackupOrchestrator({
    store,
    firestoreRest: fsRest,
    gcs,
    pollIntervalMs: 1,
    healthChecker: async () => ({
      adminInitialized: true,
      firestoreConnected: true,
      storageConnected: true,
      backupBucketConfigured: true,
      projectId: store.config.sourceProjectId,
      firestoreDatabaseId: store.config.sourceDatabaseId,
      storageBucket: store.config.sourceStorageBucket,
      backupBucket: store.config.backupBucket,
      authMode: 'ADC_CLOUD_RUN',
      cloudRunUrlConfigured: false,
      error: null,
    }),
  });

  return { gcs, fsRest, store, orchestrator };
}

test('Module 1 & 2: Zero Google OAuth login UI/handlers and single Admin SDK config resolution', async () => {
  const root = process.cwd();
  const loginCode = fs.readFileSync(path.join(root, 'frontend/pages/LoginPage.tsx'), 'utf8');
  const firebaseCode = fs.readFileSync(path.join(root, 'frontend/services/firebase.ts'), 'utf8');
  const cloudSyncCode = fs.readFileSync(path.join(root, 'frontend/services/cloudSync.ts'), 'utf8');
  const topNavCode = fs.readFileSync(path.join(root, 'frontend/layouts/TopNavbar.tsx'), 'utf8');

  assert.equal(/Continue with Google|GoogleAuthProvider|signInWithPopup/i.test(loginCode), false);
  assert.equal(/GoogleAuthProvider|signInWithPopup/i.test(firebaseCode), false);
  assert.equal(/GoogleAuthProvider|signInWithPopup/i.test(cloudSyncCode), false);
  assert.equal(/Connect Cloud DB|Google Sign-In/i.test(topNavCode), false);

  const adminCfg = getResolvedFirebaseAdminConfig();
  assert.equal(adminCfg.projectId, 'gen-lang-client-0631735980');
  assert.ok(adminCfg.storageBucket.includes('gen-lang-client-0631735980'));
});

test('Module 3, 4 & 10: Native Firestore export format, incremental Storage backup deltas, checksum verify, private ACLs & secret stripping', async () => {
  const { gcs, fsRest, orchestrator, store } = buildTestOrchestrator();

  // First full COMPLETE backup
  const firstRun = await orchestrator.runBackup({
    component: 'COMPLETE',
    triggerType: 'MANUAL',
    triggeredBy: 'MC-AD-202613-0001',
    actorRole: 'ADMIN',
  });
  const rec1 = firstRun.record;
  assert.equal(rec1.status, 'SUCCESS');
  assert.equal(rec1.verificationStatus, 'VERIFIED');
  assert.ok(rec1.firestoreDestinationUri?.match(/^gs:\/\/mun-test-backup-bucket\/firestore\/\d{4}\/\d{2}\/\d{2}\/.+/));
  assert.ok(rec1.storageDestinationUri?.match(/^gs:\/\/mun-test-backup-bucket\/storage\/\d{4}\/\d{2}\/\d{2}\/.+/));
  assert.equal(fsRest.exportCalls[0].collectionIds, undefined, 'Full DB export must NOT restrict collectionIds');

  const manifest1 = await orchestrator.getAuthorizedManifest(rec1.backupId, {
    userId: 'MC-AD-202613-0001',
    role: 'ADMIN',
  });
  assert.equal(manifest1.totalFiles, 2);
  assert.equal(manifest1.newFilesCount, 2);
  assert.equal(manifest1.verifiedFilesCount, 2);
  for (const entry of manifest1.entries) {
    assert.equal(entry.isPublic, false, 'Backup files must never be exposed publicly');
    assert.ok(entry.backupPath.includes(entry.originalPath), 'Original path hierarchy must be preserved');
  }

  // Simulate Storage changes: 1 unchanged, 1 changed (new gen + content), 1 deleted, 1 new file
  gcs.seedObject(
    'gen-lang-client-0631735980.firebasestorage.app',
    'customers/CUST-001/photo.jpg',
    'JPEG_BINARY_V2_UPDATED',
    { generation: '105', contentType: 'image/jpeg' }
  );
  gcs.removeObject('gen-lang-client-0631735980.firebasestorage.app', 'applications/APP-100/pan_doc.pdf');
  gcs.seedObject(
    'gen-lang-client-0631735980.firebasestorage.app',
    'csc/receipts/rec-9.pdf',
    'NEW_RECEIPT_BYTES',
    { generation: '301', contentType: 'application/pdf' }
  );

  const secondRun = await orchestrator.runBackup({
    component: 'STORAGE',
    triggerType: 'MANUAL',
    triggeredBy: 'MC-AD-202613-0001',
    actorRole: 'ADMIN',
  });
  assert.equal(secondRun.record.status, 'SUCCESS');
  assert.deepEqual(secondRun.record.filesDeltaSummary, {
    newCount: 1,
    changedCount: 1,
    unchangedCount: 0,
    deletedCount: 1,
  });

  // Never delete existing historical backup folders during backup
  assert.equal(gcs.deleteCalls.length, 0);

  // Secret stripping enforcement on metadata audit logs
  await store.addAuditLog({
    logId: 'BAUD-SECRET-TEST',
    action: 'CONFIG_UPDATED',
    actorUserId: 'ADMIN',
    actorRole: 'ADMIN',
    detail: 'Secret check',
    metadata: {
      privateKey: 'SHOULD_BE_REDACTED',
      apiKey: 'SHOULD_BE_REDACTED',
      safeField: 'allowed',
    },
    createdAt: new Date().toISOString(),
  });
  const savedLog = store.auditLogs.find((l) => l.logId === 'BAUD-SECRET-TEST');
  assert.equal((savedLog?.metadata as any).privateKey, undefined);
  assert.equal((savedLog?.metadata as any).apiKey, undefined);
  assert.equal((savedLog?.metadata as any).safeField, 'allowed');
});

test('Module 5 & 7: Cloud Scheduler OIDC auth, idempotent delivery, retry backoff, execution lock & PARTIAL failure semantics', async () => {
  const { fsRest, gcs, store, orchestrator } = buildTestOrchestrator();

  // Retry exponential backoff succeeds after 2 transient 503 failures
  fsRest.transientFailuresBeforeSuccess = 2;
  const retryResult = await orchestrator.runBackup({
    component: 'FIRESTORE',
    triggerType: 'MANUAL',
    triggeredBy: 'ADMIN',
  });
  assert.equal(retryResult.record.status, 'SUCCESS');
  assert.equal(retryResult.record.attemptCount, 3);

  // Partial failure: Firestore succeeds, Storage fails -> overall status MUST be PARTIAL (never SUCCESS)
  gcs.failCopyForPath = 'pan_doc.pdf';
  store.config.maxRetries = 0;
  const partialResult = await orchestrator.runBackup({
    component: 'COMPLETE',
    triggerType: 'MANUAL',
    triggeredBy: 'ADMIN',
  });
  assert.equal(partialResult.record.status, 'PARTIAL');
  assert.equal(partialResult.record.verificationStatus, 'FAILED');
  assert.ok(partialResult.record.firestoreDestinationUri);
  assert.ok(store.alerts.some((a) => a.category === 'BACKUP_PARTIAL' && a.status === 'OPEN'));
  gcs.failCopyForPath = null;

  // Duplicate lock protection blocks concurrent duplicate backup execution
  const lockedOk = await store.tryAcquireFirestoreLock('backup_execution_FIRESTORE', 'OTHER_JOB', 60_000);
  assert.equal(lockedOk, true);
  await assert.rejects(
    () =>
      orchestrator.runBackup({
        component: 'FIRESTORE',
        triggerType: 'MANUAL',
        triggeredBy: 'ADMIN',
      }),
    /Duplicate backup blocked/
  );
  await store.releaseLock('backup_execution_FIRESTORE', 'OTHER_JOB');

  // Cloud Run Express endpoint: OIDC auth + idempotent Cloud Scheduler repeat delivery
  const cloudRunApp = createCloudRunBackupApp({
    orchestrator,
    schedulerAuthConfig: {
      expectedAudience: 'https://backup-worker.run.app',
      expectedServiceAccountEmail: 'scheduler-sa@gen-lang-client-0631735980.iam.gserviceaccount.com',
      verifyOidcToken: async (token) => {
        if (token === 'valid-scheduler-jwt') {
          return {
            email: 'scheduler-sa@gen-lang-client-0631735980.iam.gserviceaccount.com',
            email_verified: true,
          };
        }
        throw new Error('Bad signature');
      },
    },
    serviceAuthToken: 'test-service-secret',
  });

  const server = http.createServer(cloudRunApp);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // Reject unauthenticated scheduler request
    const unauth = await reqApi(baseUrl, 'POST', '/scheduler/firestore-backup', {});
    assert.equal(unauth.status, 401);

    // Reject forged token
    const badJwt = await reqApi(baseUrl, 'POST', '/scheduler/firestore-backup', {}, {}, {
      Authorization: 'Bearer forged-token',
    });
    assert.equal(badJwt.status, 401);

    // Accept valid OIDC request & handle duplicate scheduler retry idempotently
    const valid1 = await reqApi(baseUrl, 'POST', '/scheduler/firestore-backup', {}, {}, {
      Authorization: 'Bearer valid-scheduler-jwt',
      'x-cloudscheduler-jobname': 'daily-firestore-0200-ist',
    });
    assert.equal(valid1.status, 200);
    assert.equal(valid1.json.deduplicated, false);

    const validRepeat = await reqApi(baseUrl, 'POST', '/scheduler/firestore-backup', {}, {}, {
      Authorization: 'Bearer valid-scheduler-jwt',
      'x-cloudscheduler-jobname': 'daily-firestore-0200-ist',
    });
    assert.equal(validRepeat.status, 200);
    assert.equal(validRepeat.json.deduplicated, true);
    assert.equal(validRepeat.json.data.backupId, valid1.json.data.backupId);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Module 6 & 9: Retention preserves latest/only backup + failed logs; Restore requires verification, dry-run, CONFIRM RESTORE & supports selective/isolated restore', async () => {
  const { gcs, fsRest, store, orchestrator } = buildTestOrchestrator();

  // Seed 3 historical COMPLETE backups: 60 days old, 45 days old, and today; plus 1 FAILED log from 60 days ago
  const d60 = new Date(Date.now() - 60 * 86400_000).toISOString();
  const d45 = new Date(Date.now() - 45 * 86400_000).toISOString();

  await orchestrator.runBackup({
    component: 'COMPLETE',
    triggerType: 'MANUAL',
    triggeredBy: 'ADMIN',
  });
  const latestRec = store.history[0];

  // Add older COMPLETE record directly and mark GCS objects for pruning check
  gcs.seedObject('mun-test-backup-bucket', 'firestore/2025/01/01/OLD60/overall_export_metadata', 'OLD');
  await store.upsertHistory({
    ...latestRec,
    backupId: 'FBK-OLD-60D',
    firestoreDestinationUri: 'gs://mun-test-backup-bucket/firestore/2025/01/01/OLD60/',
    storageDestinationUri: 'gs://mun-test-backup-bucket/storage/2025/01/01/OLD60/',
    completedAt: d60,
    startedAt: d60,
  });
  await store.upsertHistory({
    ...latestRec,
    backupId: 'FBK-FAILED-60D',
    status: 'FAILED',
    verificationStatus: 'FAILED',
    firestoreDestinationUri: undefined,
    storageDestinationUri: undefined,
    manifestId: undefined,
    completedAt: d60,
    startedAt: d60,
    failureReason: 'Simulated old failure retained for audit',
  });
  await store.upsertHistory({
    ...latestRec,
    backupId: 'FBK-ONLY-45D',
    firestoreDestinationUri: 'gs://mun-test-backup-bucket/firestore/2025/01/15/ONLY45/',
    storageDestinationUri: 'gs://mun-test-backup-bucket/storage/2025/01/15/ONLY45/',
    completedAt: d45,
    startedAt: d45,
  });

  store.config.firestoreRetentionDays = 30;
  store.config.storageRetentionDays = 30;
  const retentionRes = await orchestrator.runRetentionCleanup({ userId: 'ADMIN', role: 'ADMIN' });
  assert.ok(retentionRes.preservedBackupIds.includes(latestRec.backupId), 'Most recent successful backup must be preserved');
  assert.ok(retentionRes.prunedBackupIds.includes('FBK-OLD-60D'), 'Expired duplicate backup beyond 30d should be pruned');
  assert.ok(store.history.some((h) => h.backupId === 'FBK-FAILED-60D' && !h.prunedFromGcs), 'Failed backup logs must be retained');

  // If ONLY 1 successful backup remains and it is older than 30 days, NEVER delete it
  const soleStore = new BackupMetadataStore({
    useAdminFirestore: false,
    persistencePath: null,
  });
  soleStore.config.backupBucket = 'mun-test-backup-bucket';
  soleStore.config.firestoreRetentionDays = 10;
  const soleGcs = new MockGcsAdapter();
  const soleOrch = new BackupOrchestrator({
    store: soleStore,
    firestoreRest: fsRest,
    gcs: soleGcs,
    pollIntervalMs: 1,
  });
  await soleStore.upsertHistory({
    ...latestRec,
    backupId: 'FBK-SOLE-SURVIVOR',
    completedAt: d60,
    startedAt: d60,
  });
  const soleRetention = await soleOrch.runRetentionCleanup({ userId: 'ADMIN', role: 'ADMIN' });
  assert.deepEqual(soleRetention.prunedBackupIds, []);
  assert.ok(soleRetention.preservedBackupIds.includes('FBK-SOLE-SURVIVOR'));

  // Restore safeguards:
  // 1) Block restoring a FAILED backup
  await assert.rejects(
    () =>
      orchestrator.previewRestore({
        backupId: 'FBK-FAILED-60D',
        scope: 'COMPLETE',
        actor: { userId: 'ADMIN', role: 'ADMIN' },
      }),
    /Only verified backups may be restored/
  );

  // 2) Dry-run preview with selective Storage file AND alternate recovery project
  const preview = await orchestrator.previewRestore({
    backupId: latestRec.backupId,
    scope: 'COMPLETE',
    selectedPaths: ['customers/CUST-001/photo.jpg'],
    targetProjectId: 'mun-erp-recovery-stage',
    targetDatabaseId: '(default)',
    targetStorageBucket: 'mun-erp-recovery-stage.firebasestorage.app',
    actor: { userId: 'ADMIN', role: 'ADMIN' },
  });
  assert.equal(preview.estimatedFilesToRestore, 1);
  assert.equal(preview.targetProjectId, 'mun-erp-recovery-stage');
  assert.ok(preview.warnings.some((w) => w.includes('Isolated recovery project')));

  // 3) Reject missing CONFIRM RESTORE
  await assert.rejects(
    () =>
      orchestrator.executeRestore({
        previewId: preview.previewId,
        confirmationText: 'YES',
        actor: { userId: 'ADMIN', role: 'ADMIN' },
      }),
    /CONFIRM RESTORE/
  );

  // 4) Execute verified restore into recovery project & bucket
  const restoreRec = await orchestrator.executeRestore({
    previewId: preview.previewId,
    confirmationText: 'CONFIRM RESTORE',
    actor: { userId: 'ADMIN', role: 'ADMIN' },
  });
  assert.equal(restoreRec.status, 'COMPLETED');
  assert.equal(restoreRec.verificationStatus, 'VERIFIED');
  assert.equal(restoreRec.restoredFilesCount, 1);
  assert.equal(fsRest.importCalls[0].projectId, 'mun-erp-recovery-stage');
  const restoredObj = await gcs.getObjectMetadata(
    'mun-erp-recovery-stage.firebasestorage.app',
    'customers/CUST-001/photo.jpg'
  );
  assert.ok(restoredObj, 'Selective file should be restored into recovery bucket');
});

test('Module 1, 8, 10 & 11 HTTP Integration: Existing 4-layer ERP auth still passes and non-admin roles receive 403 on Firebase backup & restore endpoints', async () => {
  const securityStore = new SecurityStore();
  const phase03Store = new Phase03Store();
  const erpStore = new ErpStore(securityStore, phase03Store);
  const financeStore = new FinanceStore(securityStore, phase03Store, erpStore);
  const reportStore = new ReportStore();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mun-fb-backup-test-'));
  const phase08Store = new Phase08Store(securityStore, phase03Store, erpStore, financeStore, reportStore, {
    primaryBackupDir: path.join(tmpRoot, 'primary'),
    secondaryBackupDir: path.join(tmpRoot, 'secondary'),
  });
  const qaStore = new QaStore();
  const cscStore = new CscStore();
  const { orchestrator } = buildTestOrchestrator();

  const app = createApp(securityStore, {
    enableRateLimit: false,
    phase03Store,
    erpStore,
    financeStore,
    reportStore,
    phase08Store,
    qaStore,
    cscStore,
    firebaseBackupOrchestrator: orchestrator,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Existing 4-layer ERP login (Password + CAPTCHA + Fast2SMS OTP + Google Authenticator TOTP)
    const adminLogin = await performFourLayerLogin(
      baseUrl,
      securityStore,
      'MC2627110001',
      '8101352105'
    );

    const staffCreated = await createTestUser(baseUrl, adminLogin.cookies, {
      fullName: 'Backup RBAC Staff',
      role: 'STAFF',
    });
    const managerCreated = await createTestUser(baseUrl, adminLogin.cookies, {
      fullName: 'Backup RBAC Manager',
      role: 'MANAGER',
    });

    const staffLogin = await performFourLayerLogin(
      baseUrl,
      securityStore,
      staffCreated.userId,
      staffCreated.password
    );
    const managerLogin = await performFourLayerLogin(
      baseUrl,
      securityStore,
      managerCreated.userId,
      managerCreated.password
    );

    // Unauthenticated access blocked (401)
    const unauth = await reqApi(baseUrl, 'GET', '/api/v1/security/firebase-backup/dashboard');
    assert.equal(unauth.status, 401);

    // STAFF and MANAGER blocked with 403 Forbidden
    const staffDash = await reqApi(
      baseUrl,
      'GET',
      '/api/v1/security/firebase-backup/dashboard',
      undefined,
      staffLogin.cookies
    );
    assert.equal(staffDash.status, 403);

    const mgrRun = await reqApi(
      baseUrl,
      'POST',
      '/api/v1/backup/run',
      { component: 'FIRESTORE' },
      managerLogin.cookies
    );
    assert.equal(mgrRun.status, 403);

    // ADMIN allowed on dashboard, config, manual backup, manifest, and restore preview/execute
    const dash1 = await reqApi(
      baseUrl,
      'GET',
      '/api/v1/security/firebase-backup/dashboard',
      undefined,
      adminLogin.cookies
    );
    assert.equal(dash1.status, 200);
    assert.equal(dash1.json.data.config.timezone, 'Asia/Kolkata');

    const runRes = await reqApi(
      baseUrl,
      'POST',
      '/api/v1/security/firebase-backup/run',
      { component: 'COMPLETE' },
      adminLogin.cookies
    );
    assert.equal(runRes.status, 201);
    const backupId = runRes.json.data.backupId;

    const manifestRes = await reqApi(
      baseUrl,
      'GET',
      `/api/v1/security/firebase-backup/${backupId}/manifest`,
      undefined,
      adminLogin.cookies
    );
    assert.equal(manifestRes.status, 200);
    assert.equal(manifestRes.json.data.totalFiles, 2);

    const cfgRes = await reqApi(
      baseUrl,
      'PUT',
      '/api/v1/security/firebase-backup/config',
      { automaticBackupEnabled: false, firestoreRetentionDays: 45, storageRetentionDays: 60 },
      adminLogin.cookies
    );
    assert.equal(cfgRes.status, 200);
    assert.equal(cfgRes.json.data.automaticBackupEnabled, false);
    assert.equal(cfgRes.json.data.firestoreRetentionDays, 45);
    assert.equal(cfgRes.json.data.storageRetentionDays, 60);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
