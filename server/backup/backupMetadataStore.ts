import fs from 'node:fs';
import path from 'node:path';
import {
  getFirebaseAdminFirestore,
  getResolvedFirebaseAdminConfig,
} from '../firebaseAdminDb.js';
import {
  BackupExecutionLock,
  RestorePreviewResult,
  SystemBackupAlert,
  SystemBackupAuditLog,
  SystemBackupConfig,
  SystemBackupHistoryRecord,
  SystemBackupJob,
  SystemBackupManifest,
  SystemRestoreHistoryRecord,
} from './backupTypes.js';

const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|secret|token|password|private[_-]?key|credential|auth[_-]?header|service[_-]?account)/i;

export function stripSensitiveBackupFields<T>(input: T): T {
  if (Array.isArray(input)) {
    return input.map((item) => stripSensitiveBackupFields(item)) as unknown as T;
  }
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) continue;
      if (v !== undefined) {
        out[k] = stripSensitiveBackupFields(v);
      }
    }
    return out as T;
  }
  return input;
}

export const BACKUP_COLLECTIONS = {
  config: 'system_backup_config',
  jobs: 'system_backup_jobs',
  history: 'system_backup_history',
  manifests: 'system_backup_manifests',
  restoreHistory: 'system_restore_history',
  alerts: 'system_backup_alerts',
  auditLogs: 'system_backup_audit_logs',
  locks: 'system_backup_locks',
} as const;

interface PersistedBackupSnapshot {
  config: SystemBackupConfig;
  jobs: SystemBackupJob[];
  history: SystemBackupHistoryRecord[];
  manifests: SystemBackupManifest[];
  restoreHistory: SystemRestoreHistoryRecord[];
  alerts: SystemBackupAlert[];
  auditLogs: SystemBackupAuditLog[];
}

export class BackupMetadataStore {
  public config: SystemBackupConfig;
  public jobs: SystemBackupJob[] = [];
  public history: SystemBackupHistoryRecord[] = [];
  public manifests: SystemBackupManifest[] = [];
  public restoreHistory: SystemRestoreHistoryRecord[] = [];
  public alerts: SystemBackupAlert[] = [];
  public auditLogs: SystemBackupAuditLog[] = [];
  public locks = new Map<string, BackupExecutionLock>();
  public restorePreviews = new Map<string, RestorePreviewResult>();

  private readonly persistencePath: string | null;
  private readonly useAdminFirestore: boolean;

  constructor(options?: {
    persistencePath?: string | null;
    useAdminFirestore?: boolean;
    defaultBackupBucket?: string;
  }) {
    const resolved = getResolvedFirebaseAdminConfig();
    const envBucket = (process.env.BACKUP_GCS_BUCKET || '')
      .replace(/^gs:\/\//i, '')
      .trim();
    const defaultBucket =
      (options?.defaultBackupBucket || envBucket || (resolved.projectId ? `${resolved.projectId}-mun-backups` : ''))
        .replace(/^gs:\/\//i, '')
        .trim();

    this.useAdminFirestore = options?.useAdminFirestore ?? process.env.NODE_ENV !== 'test';
    if (options?.persistencePath !== undefined) {
      this.persistencePath = options.persistencePath;
    } else if (process.env.MUN_FIREBASE_BACKUP_PERSISTENCE_PATH) {
      this.persistencePath = process.env.MUN_FIREBASE_BACKUP_PERSISTENCE_PATH;
    } else if (process.env.NODE_ENV === 'test') {
      this.persistencePath = null;
    } else {
      const runtimeDir = process.env.VERCEL ? '/tmp' : path.resolve(process.cwd(), '.data');
      this.persistencePath = path.join(runtimeDir, 'firebase-backup-metadata.json');
    }

    this.config = {
      id: 'default',
      automaticBackupEnabled: true,
      timezone: 'Asia/Kolkata',
      firestoreScheduleCron: '0 2 * * *',
      storageScheduleCron: '30 2 * * *',
      firestoreScheduleIst: '02:00 AM IST',
      storageScheduleIst: '02:30 AM IST',
      firestoreRetentionDays: 30,
      storageRetentionDays: 30,
      keepMostRecentSuccessful: true,
      neverDeleteOnlyBackup: true,
      retainFailedLogs: true,
      softDeleteProtectionDays: 30,
      sourceProjectId: resolved.projectId,
      sourceDatabaseId: resolved.firestoreDatabaseId || '(default)',
      sourceStorageBucket: resolved.storageBucket,
      backupBucket: defaultBucket,
      maxRetries: 3,
      retryBaseDelayMs: 500,
      timeoutMs: 300_000,
      updatedBy: 'SYSTEM',
      updatedAt: new Date().toISOString(),
    };

    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!this.persistencePath) return;
    try {
      if (!fs.existsSync(this.persistencePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.persistencePath, 'utf8')) as Partial<PersistedBackupSnapshot>;
      if (raw.config) {
        this.config = {
          ...this.config,
          ...raw.config,
          id: 'default',
          timezone: 'Asia/Kolkata',
        };
      }
      if (Array.isArray(raw.jobs)) this.jobs = raw.jobs;
      if (Array.isArray(raw.history)) this.history = raw.history;
      if (Array.isArray(raw.manifests)) this.manifests = raw.manifests;
      if (Array.isArray(raw.restoreHistory)) this.restoreHistory = raw.restoreHistory;
      if (Array.isArray(raw.alerts)) this.alerts = raw.alerts;
      if (Array.isArray(raw.auditLogs)) this.auditLogs = raw.auditLogs;
    } catch {
      // Ignore corrupt local cache; fresh metadata remains valid
    }
  }

  private persistToDisk(): void {
    if (!this.persistencePath) return;
    try {
      const dir = path.dirname(this.persistencePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const snapshot: PersistedBackupSnapshot = stripSensitiveBackupFields({
        config: this.config,
        jobs: this.jobs.slice(0, 200),
        history: this.history.slice(0, 500),
        manifests: this.manifests.slice(0, 200),
        restoreHistory: this.restoreHistory.slice(0, 200),
        alerts: this.alerts.slice(0, 200),
        auditLogs: this.auditLogs.slice(0, 500),
      });
      fs.writeFileSync(this.persistencePath, JSON.stringify(snapshot, null, 2), 'utf8');
    } catch {
      // Ignore readonly filesystem edge cases on serverless environments
    }
  }

  private async writeFirestoreDoc(collectionName: string, docId: string, data: unknown): Promise<void> {
    if (!this.useAdminFirestore) return;
    const db = getFirebaseAdminFirestore();
    if (!db) return;
    try {
      const clean = stripSensitiveBackupFields(data) as Record<string, unknown>;
      await db.collection(collectionName).doc(docId).set(clean, { merge: true });
    } catch (err) {
      console.warn(
        `[BackupMetadataStore] Firestore sync skipped (${collectionName}/${docId}):`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  async hydrateFromFirestore(): Promise<void> {
    if (!this.useAdminFirestore) return;
    const db = getFirebaseAdminFirestore();
    if (!db) return;
    try {
      const [cfgSnap, histSnap, jobsSnap, manSnap, rstSnap, alertSnap, auditSnap] = await Promise.all([
        db.collection(BACKUP_COLLECTIONS.config).doc('default').get(),
        db.collection(BACKUP_COLLECTIONS.history).orderBy('startedAt', 'desc').limit(200).get(),
        db.collection(BACKUP_COLLECTIONS.jobs).orderBy('startedAt', 'desc').limit(150).get(),
        db.collection(BACKUP_COLLECTIONS.manifests).orderBy('generatedAt', 'desc').limit(100).get(),
        db.collection(BACKUP_COLLECTIONS.restoreHistory).orderBy('executedAt', 'desc').limit(100).get(),
        db.collection(BACKUP_COLLECTIONS.alerts).orderBy('createdAt', 'desc').limit(100).get(),
        db.collection(BACKUP_COLLECTIONS.auditLogs).orderBy('createdAt', 'desc').limit(200).get(),
      ]);
      if (cfgSnap.exists) {
        this.config = { ...this.config, ...(cfgSnap.data() as Partial<SystemBackupConfig>), id: 'default' };
      }
      if (!histSnap.empty) this.history = histSnap.docs.map((d) => d.data() as SystemBackupHistoryRecord);
      if (!jobsSnap.empty) this.jobs = jobsSnap.docs.map((d) => d.data() as SystemBackupJob);
      if (!manSnap.empty) this.manifests = manSnap.docs.map((d) => d.data() as SystemBackupManifest);
      if (!rstSnap.empty) this.restoreHistory = rstSnap.docs.map((d) => d.data() as SystemRestoreHistoryRecord);
      if (!alertSnap.empty) this.alerts = alertSnap.docs.map((d) => d.data() as SystemBackupAlert);
      if (!auditSnap.empty) this.auditLogs = auditSnap.docs.map((d) => d.data() as SystemBackupAuditLog);
      this.persistToDisk();
    } catch {
      // Fallback safely to in-memory / local disk cache when Firestore collections are not initialized yet
    }
  }

  async saveConfig(nextConfig: SystemBackupConfig): Promise<SystemBackupConfig> {
    this.config = {
      ...nextConfig,
      id: 'default',
      timezone: 'Asia/Kolkata',
    };
    this.persistToDisk();
    await this.writeFirestoreDoc(BACKUP_COLLECTIONS.config, 'default', this.config);
    return this.config;
  }

  async upsertJob(job: SystemBackupJob): Promise<SystemBackupJob> {
    const idx = this.jobs.findIndex((j) => j.jobId === job.jobId);
    if (idx >= 0) {
      this.jobs[idx] = job;
    } else {
      this.jobs.unshift(job);
    }
    this.persistToDisk();
    await this.writeFirestoreDoc(BACKUP_COLLECTIONS.jobs, job.jobId, job);
    return job;
  }

  findJobByIdempotencyKey(key: string): SystemBackupJob | undefined {
    return this.jobs.find((j) => j.idempotencyKey === key);
  }

  findHistoryByIdempotencyKey(key: string): SystemBackupHistoryRecord | undefined {
    return this.history.find((h) => h.idempotencyKey === key);
  }

  async upsertHistory(record: SystemBackupHistoryRecord): Promise<SystemBackupHistoryRecord> {
    const idx = this.history.findIndex((h) => h.backupId === record.backupId);
    if (idx >= 0) {
      this.history[idx] = record;
    } else {
      this.history.unshift(record);
    }
    this.persistToDisk();
    await this.writeFirestoreDoc(BACKUP_COLLECTIONS.history, record.backupId, record);
    return record;
  }

  async saveManifest(manifest: SystemBackupManifest): Promise<SystemBackupManifest> {
    const idx = this.manifests.findIndex((m) => m.manifestId === manifest.manifestId);
    if (idx >= 0) {
      this.manifests[idx] = manifest;
    } else {
      this.manifests.unshift(manifest);
    }
    this.persistToDisk();
    await this.writeFirestoreDoc(BACKUP_COLLECTIONS.manifests, manifest.manifestId, manifest);
    return manifest;
  }

  getLatestSuccessfulManifest(): SystemBackupManifest | undefined {
    const latestStorageSuccess = this.history.find(
      (h) =>
        (h.component === 'STORAGE' || h.component === 'COMPLETE') &&
        h.status === 'SUCCESS' &&
        h.manifestId &&
        !h.prunedFromGcs
    );
    if (latestStorageSuccess?.manifestId) {
      return this.manifests.find((m) => m.manifestId === latestStorageSuccess.manifestId);
    }
    return this.manifests.find((m) => m.failedFilesCount === 0);
  }

  getManifestByBackupId(backupId: string): SystemBackupManifest | undefined {
    return this.manifests.find((m) => m.backupId === backupId);
  }

  async addRestoreHistory(record: SystemRestoreHistoryRecord): Promise<SystemRestoreHistoryRecord> {
    this.restoreHistory.unshift(record);
    this.persistToDisk();
    await this.writeFirestoreDoc(BACKUP_COLLECTIONS.restoreHistory, record.restoreId, record);
    return record;
  }

  async addAlert(alert: SystemBackupAlert): Promise<SystemBackupAlert> {
    this.alerts.unshift(alert);
    this.persistToDisk();
    await this.writeFirestoreDoc(BACKUP_COLLECTIONS.alerts, alert.alertId, alert);
    return alert;
  }

  async addAuditLog(log: SystemBackupAuditLog): Promise<SystemBackupAuditLog> {
    const cleanLog = stripSensitiveBackupFields(log);
    this.auditLogs.unshift(cleanLog);
    this.persistToDisk();
    await this.writeFirestoreDoc(BACKUP_COLLECTIONS.auditLogs, cleanLog.logId, cleanLog);
    return cleanLog;
  }

  async tryAcquireFirestoreLock(lockId: string, ownerJobId: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const existing = this.locks.get(lockId);
    if (existing && Date.parse(existing.expiresAt) > now && existing.ownerJobId !== ownerJobId) {
      return false;
    }

    const nextLock: BackupExecutionLock = {
      lockId,
      ownerJobId,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };

    if (this.useAdminFirestore) {
      const db = getFirebaseAdminFirestore();
      if (db) {
        try {
          const ref = db.collection(BACKUP_COLLECTIONS.locks).doc(lockId);
          const acquired = await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (snap.exists) {
              const data = snap.data() as BackupExecutionLock;
              if (Date.parse(data.expiresAt) > now && data.ownerJobId !== ownerJobId) {
                return false;
              }
            }
            tx.set(ref, nextLock);
            return true;
          });
          if (!acquired) return false;
        } catch {
          // Proceed with local lock if Firestore transaction cannot execute in offline/unprovisioned dev env
        }
      }
    }

    this.locks.set(lockId, nextLock);
    return true;
  }

  async releaseLock(lockId: string, ownerJobId: string): Promise<void> {
    const current = this.locks.get(lockId);
    if (current && current.ownerJobId === ownerJobId) {
      this.locks.delete(lockId);
    }
    if (this.useAdminFirestore) {
      const db = getFirebaseAdminFirestore();
      if (db) {
        try {
          const ref = db.collection(BACKUP_COLLECTIONS.locks).doc(lockId);
          await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (snap.exists && (snap.data() as BackupExecutionLock).ownerJobId === ownerJobId) {
              tx.delete(ref);
            }
          });
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }
}
