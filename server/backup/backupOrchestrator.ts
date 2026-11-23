import crypto from 'node:crypto';
import {
  checkFirebaseConnectionHealth,
  getResolvedFirebaseAdminConfig,
} from '../firebaseAdminDb.js';
import {
  BackupComponentType,
  BackupDashboardTelemetry,
  BackupVerificationResult,
  FirestoreAdminRestAdapter,
  GcsBackupStorageAdapter,
  RestorePreviewResult,
  RetentionCleanupResult,
  SystemBackupConfig,
  SystemBackupHistoryRecord,
  SystemBackupJob,
  SystemBackupManifest,
  SystemRestoreHistoryRecord,
} from './backupTypes.js';
import { BackupMetadataStore } from './backupMetadataStore.js';
import {
  computeNextIstScheduleRun,
  executeWithRetryBackoff,
} from './backupProtection.js';
import { FirestoreBackupService } from './firestoreBackupService.js';
import { StorageBackupService } from './storageBackupService.js';
import { RetentionService } from './retentionService.js';
import {
  FirebaseAdminGcsBackupAdapter,
  GoogleFirestoreManagedRestAdapter,
} from './gcpAdapters.js';

export class BackupOrchestrator {
  public readonly store: BackupMetadataStore;
  public readonly firestoreService: FirestoreBackupService;
  public readonly storageService: StorageBackupService;
  public readonly retentionService: RetentionService;
  private readonly healthChecker?: () => Promise<BackupDashboardTelemetry['firebaseConnection']>;

  constructor(options?: {
    store?: BackupMetadataStore;
    firestoreRest?: FirestoreAdminRestAdapter;
    gcs?: GcsBackupStorageAdapter;
    pollIntervalMs?: number;
    healthChecker?: () => Promise<BackupDashboardTelemetry['firebaseConnection']>;
  }) {
    this.store = options?.store ?? new BackupMetadataStore();
    const firestoreRest = options?.firestoreRest ?? new GoogleFirestoreManagedRestAdapter();
    const gcs = options?.gcs ?? new FirebaseAdminGcsBackupAdapter();
    const pollMs = options?.pollIntervalMs ?? (process.env.NODE_ENV === 'test' ? 1 : 1500);
    this.firestoreService = new FirestoreBackupService(firestoreRest, gcs, pollMs);
    this.storageService = new StorageBackupService(gcs);
    this.retentionService = new RetentionService(this.store, gcs);
    this.healthChecker = options?.healthChecker;
  }

  private nextId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  }

  private async buildConnectionStatus(): Promise<BackupDashboardTelemetry['firebaseConnection']> {
    if (this.healthChecker) {
      return this.healthChecker();
    }
    const health = await checkFirebaseConnectionHealth();
    const cfg = this.store.config;
    return {
      adminInitialized: health.adminInitialized,
      firestoreConnected: health.firestoreConnected,
      storageConnected: health.storageConnected,
      backupBucketConfigured: Boolean(cfg.backupBucket),
      projectId: cfg.sourceProjectId || health.projectId,
      firestoreDatabaseId: cfg.sourceDatabaseId || health.firestoreDatabaseId,
      storageBucket: cfg.sourceStorageBucket || health.storageBucket,
      backupBucket: cfg.backupBucket,
      authMode: health.authMode,
      cloudRunUrlConfigured: Boolean((process.env.BACKUP_CLOUD_RUN_URL || '').trim()),
      error: health.error,
    };
  }

  async getDashboardTelemetry(): Promise<BackupDashboardTelemetry> {
    const cfg = this.store.config;
    const conn = await this.buildConnectionStatus();

    const latestFs = this.store.history.find(
      (h) => h.component === 'FIRESTORE' || h.component === 'COMPLETE'
    );
    const latestStorage = this.store.history.find(
      (h) => h.component === 'STORAGE' || h.component === 'COMPLETE'
    );
    const lastSuccessfulBackup =
      this.store.history.find((h) => h.status === 'SUCCESS') ?? null;

    const fsSchedule = computeNextIstScheduleRun(2, 0);
    const stSchedule = computeNextIstScheduleRun(2, 30);

    const activeBackups = this.store.history.filter((h) => !h.prunedFromGcs);
    const totalBackupSizeBytes = activeBackups
      .filter((h) => h.status === 'SUCCESS' || h.status === 'PARTIAL')
      .reduce((sum, h) => sum + Number(h.totalSizeBytes || 0), 0);

    const latestStorageManifest = this.store.getLatestSuccessfulManifest();
    const totalFilesBackedUp =
      latestStorageManifest?.totalFiles ??
      (latestStorage?.totalFilesBackedUp || 0);

    const nowMs = Date.now();
    const activeLocks = Array.from(this.store.locks.values()).filter(
      (l) => Date.parse(l.expiresAt) > nowMs
    );

    const failedHistory = this.store.history.filter(
      (h) => h.status === 'FAILED' || h.status === 'PARTIAL'
    );

    return {
      firebaseConnection: conn,
      config: cfg,
      firestoreStatus: {
        lastStatus: latestFs ? latestFs.status : 'NEVER_RUN',
        lastBackupAt: latestFs?.completedAt ?? null,
        lastOperationId: latestFs?.firestoreOperationId ?? null,
        lastDestinationUri: latestFs?.firestoreDestinationUri ?? null,
        verificationStatus: latestFs?.verificationStatus ?? 'N/A',
      },
      storageStatus: {
        lastStatus: latestStorage ? latestStorage.status : 'NEVER_RUN',
        lastBackupAt: latestStorage?.completedAt ?? null,
        lastDestinationUri: latestStorage?.storageDestinationUri ?? null,
        verificationStatus: latestStorage?.verificationStatus ?? 'N/A',
      },
      lastSuccessfulBackup,
      nextScheduledBackup: {
        timezone: 'Asia/Kolkata',
        firestoreNextRunIst: cfg.automaticBackupEnabled ? fsSchedule.nextRunIst : 'PAUSED',
        firestoreNextRunUtc: fsSchedule.nextRunUtc,
        storageNextRunIst: cfg.automaticBackupEnabled ? stSchedule.nextRunIst : 'PAUSED',
        storageNextRunUtc: stSchedule.nextRunUtc,
      },
      totals: {
        totalBackupSizeBytes,
        totalFilesBackedUp,
        successfulBackupsCount: this.store.history.filter((h) => h.status === 'SUCCESS').length,
        failedOrPartialBackupsCount: failedHistory.length,
      },
      verificationStatus: lastSuccessfulBackup?.verificationStatus ?? (this.store.history[0]?.verificationStatus ?? 'N/A'),
      history: this.store.history.slice(0, 100),
      failedHistory: failedHistory.slice(0, 100),
      restoreHistory: this.store.restoreHistory.slice(0, 50),
      alerts: this.store.alerts.slice(0, 50),
      auditLogs: this.store.auditLogs.slice(0, 100),
      activeLocks,
    };
  }

  async updateConfig(
    patch: Partial<
      Pick<
        SystemBackupConfig,
        | 'automaticBackupEnabled'
        | 'firestoreRetentionDays'
        | 'storageRetentionDays'
        | 'backupBucket'
        | 'maxRetries'
        | 'softDeleteProtectionDays'
      >
    >,
    actor: { userId: string; role: string }
  ): Promise<SystemBackupConfig> {
    const cur = this.store.config;
    const next: SystemBackupConfig = {
      ...cur,
      ...(typeof patch.automaticBackupEnabled === 'boolean'
        ? { automaticBackupEnabled: patch.automaticBackupEnabled }
        : {}),
      ...(patch.firestoreRetentionDays !== undefined
        ? { firestoreRetentionDays: Math.min(3650, Math.max(1, Math.floor(Number(patch.firestoreRetentionDays)))) }
        : {}),
      ...(patch.storageRetentionDays !== undefined
        ? { storageRetentionDays: Math.min(3650, Math.max(1, Math.floor(Number(patch.storageRetentionDays)))) }
        : {}),
      ...(typeof patch.backupBucket === 'string' && patch.backupBucket.trim()
        ? { backupBucket: patch.backupBucket.replace(/^gs:\/\//i, '').trim() }
        : {}),
      ...(patch.maxRetries !== undefined
        ? { maxRetries: Math.min(5, Math.max(0, Math.floor(Number(patch.maxRetries)))) }
        : {}),
      ...(patch.softDeleteProtectionDays !== undefined
        ? { softDeleteProtectionDays: Math.min(90, Math.max(7, Math.floor(Number(patch.softDeleteProtectionDays)))) }
        : {}),
      updatedBy: actor.userId,
      updatedAt: new Date().toISOString(),
    };
    const saved = await this.store.saveConfig(next);
    await this.store.addAuditLog({
      logId: this.nextId('BAUD'),
      action: 'CONFIG_UPDATED',
      actorUserId: actor.userId,
      actorRole: actor.role,
      detail: `Updated backup config (auto=${saved.automaticBackupEnabled}, firestoreRetention=${saved.firestoreRetentionDays}d, storageRetention=${saved.storageRetentionDays}d, bucket=${saved.backupBucket}).`,
      metadata: {
        automaticBackupEnabled: saved.automaticBackupEnabled,
        firestoreRetentionDays: saved.firestoreRetentionDays,
        storageRetentionDays: saved.storageRetentionDays,
        backupBucket: saved.backupBucket,
      },
      createdAt: saved.updatedAt,
    });
    return saved;
  }

  async runBackup(params: {
    component: BackupComponentType;
    triggerType: 'MANUAL' | 'SCHEDULER';
    triggeredBy: string;
    actorRole?: string;
    idempotencyKey?: string;
  }): Promise<{ record: SystemBackupHistoryRecord; deduplicated: boolean }> {
    const cfg = this.store.config;

    // Respect automatic schedule pause only for SCHEDULER trigger; manual backups can always run
    if (params.triggerType === 'SCHEDULER' && !cfg.automaticBackupEnabled) {
      throw new Error('Automatic scheduled backups are currently paused by Administrator.');
    }

    // Idempotency check for Cloud Scheduler at-least-once delivery
    if (params.idempotencyKey) {
      const existingHistory = this.store.findHistoryByIdempotencyKey(params.idempotencyKey);
      if (existingHistory && (existingHistory.status === 'SUCCESS' || existingHistory.status === 'PARTIAL')) {
        return { record: existingHistory, deduplicated: true };
      }
      const existingJob = this.store.findJobByIdempotencyKey(params.idempotencyKey);
      if (existingJob && (existingJob.status === 'RUNNING' || existingJob.status === 'VERIFYING')) {
        throw new Error(`Backup job ${existingJob.jobId} is already in progress for key ${params.idempotencyKey}.`);
      }
    }

    const jobId = this.nextId('BJOB');
    const lockId = `backup_execution_${params.component}`;
    const acquired = await this.store.tryAcquireFirestoreLock(
      lockId,
      jobId,
      Math.max(cfg.timeoutMs * 2, 120_000)
    );
    if (!acquired) {
      throw new Error(`Duplicate backup blocked: execution lock held for ${params.component}.`);
    }

    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    const backupId = this.nextId('FBK');

    const job: SystemBackupJob = {
      jobId,
      idempotencyKey: params.idempotencyKey,
      component: params.component,
      triggerType: params.triggerType,
      triggeredBy: params.triggeredBy,
      status: 'RUNNING',
      attemptCount: 1,
      maxRetries: cfg.maxRetries,
      startedAt,
      completedAt: null,
      backupId,
    };
    await this.store.upsertJob(job);
    await this.store.addAuditLog({
      logId: this.nextId('BAUD'),
      action: 'BACKUP_STARTED',
      actorUserId: params.triggeredBy,
      actorRole: params.actorRole || (params.triggerType === 'SCHEDULER' ? 'CLOUD_SCHEDULER' : 'ADMIN'),
      detail: `Started ${params.component} backup (${backupId}) via ${params.triggerType}.`,
      createdAt: startedAt,
    });

    const resolvedAdmin = getResolvedFirebaseAdminConfig();
    const projectId = cfg.sourceProjectId || resolvedAdmin.projectId;
    const databaseId = cfg.sourceDatabaseId || resolvedAdmin.firestoreDatabaseId || '(default)';
    const sourceBucket = cfg.sourceStorageBucket || resolvedAdmin.storageBucket;
    const backupBucket = cfg.backupBucket;

    let firestoreUri: string | undefined;
    let firestoreOpId: string | undefined;
    let firestoreBytes = 0;
    let firestoreVerification: BackupVerificationResult | undefined;
    let firestoreError: string | undefined;

    let storageUri: string | undefined;
    let storageManifest: SystemBackupManifest | undefined;
    let storageBytes = 0;
    let storageFilesCount = 0;
    let storageDelta: SystemBackupHistoryRecord['filesDeltaSummary'] | undefined;
    let storageVerification: BackupVerificationResult | undefined;
    let storageError: string | undefined;

    let maxAttemptsUsed = 1;
    const uniqueSuffix = backupId.slice(-6);

    try {
      const needsFirestore = params.component === 'FIRESTORE' || params.component === 'COMPLETE';
      const needsStorage = params.component === 'STORAGE' || params.component === 'COMPLETE';

      if (needsFirestore) {
        try {
          const outcome = await executeWithRetryBackoff(
            'Firestore Managed Export',
            async () =>
              this.firestoreService.runFullManagedExport({
                projectId,
                databaseId,
                backupBucket,
                uniqueSuffix,
              }),
            {
              maxRetries: cfg.maxRetries,
              baseDelayMs: cfg.retryBaseDelayMs,
              timeoutMs: cfg.timeoutMs,
            }
          );
          maxAttemptsUsed = Math.max(maxAttemptsUsed, outcome.attempts);
          firestoreUri = outcome.value.destinationUri;
          firestoreOpId = outcome.value.operationId;
          firestoreBytes = outcome.value.exportSizeBytes;
          firestoreVerification = outcome.value.verification;
        } catch (err) {
          maxAttemptsUsed = Math.max(
            maxAttemptsUsed,
            Number((err as { attempts?: number })?.attempts || 1)
          );
          firestoreError = err instanceof Error ? err.message : String(err);
          firestoreVerification = {
            verified: false,
            checkedAt: new Date().toISOString(),
            firestoreVerified: false,
            failureReason: firestoreError,
          };
        }
      }

      if (needsStorage) {
        const previousManifest = this.store.getLatestSuccessfulManifest();
        try {
          const manifestId = this.nextId('MAN');
          const outcome = await executeWithRetryBackoff(
            'Firebase Storage Backup',
            async () =>
              this.storageService.runStorageBackup({
                backupId,
                manifestId,
                sourceBucket,
                backupBucket,
                previousManifest,
                uniqueSuffix,
              }),
            {
              maxRetries: cfg.maxRetries,
              baseDelayMs: cfg.retryBaseDelayMs,
              timeoutMs: cfg.timeoutMs,
            }
          );
          maxAttemptsUsed = Math.max(maxAttemptsUsed, outcome.attempts);
          storageUri = outcome.value.destinationUri;
          storageManifest = outcome.value.manifest;
          storageBytes = outcome.value.totalSizeBytes;
          storageFilesCount = outcome.value.totalFilesBackedUp;
          storageDelta = outcome.value.deltaSummary;
          storageVerification = outcome.value.verification;
          await this.store.saveManifest(storageManifest);
        } catch (err) {
          maxAttemptsUsed = Math.max(
            maxAttemptsUsed,
            Number((err as { attempts?: number })?.attempts || 1)
          );
          storageError = err instanceof Error ? err.message : String(err);
          storageVerification = {
            verified: false,
            checkedAt: new Date().toISOString(),
            storageVerified: false,
            failureReason: storageError,
          };
        }
      }

      const firestoreOk = !needsFirestore || Boolean(firestoreVerification?.verified && !firestoreError);
      const storageOk = !needsStorage || Boolean(storageVerification?.verified && !storageError);

      let finalStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED';
      let finalVerificationStatus: 'VERIFIED' | 'FAILED';
      let failureReason: string | undefined;

      if (firestoreOk && storageOk) {
        finalStatus = 'SUCCESS';
        finalVerificationStatus = 'VERIFIED';
      } else if (
        params.component === 'COMPLETE' &&
        ((firestoreOk && !storageOk) || (!firestoreOk && storageOk))
      ) {
        finalStatus = 'PARTIAL';
        finalVerificationStatus = 'FAILED';
        failureReason = [firestoreError || firestoreVerification?.failureReason, storageError || storageVerification?.failureReason]
          .filter(Boolean)
          .join(' | ');
      } else {
        finalStatus = 'FAILED';
        finalVerificationStatus = 'FAILED';
        failureReason = [firestoreError || firestoreVerification?.failureReason, storageError || storageVerification?.failureReason]
          .filter(Boolean)
          .join(' | ');
      }

      const completedAt = new Date().toISOString();
      const durationMs = Math.max(1, Date.now() - startedMs);

      const combinedVerification: BackupVerificationResult = {
        verified: finalVerificationStatus === 'VERIFIED',
        checkedAt: completedAt,
        ...(firestoreVerification
          ? {
              firestoreVerified: firestoreVerification.firestoreVerified,
              firestoreOperationDone: firestoreVerification.firestoreOperationDone,
              firestoreMetadataPresent: firestoreVerification.firestoreMetadataPresent,
            }
          : {}),
        ...(storageVerification
          ? {
              storageVerified: storageVerification.storageVerified,
              verifiedFilesCount: storageVerification.verifiedFilesCount,
              failedFilesCount: storageVerification.failedFilesCount,
            }
          : {}),
        ...(failureReason ? { failureReason } : {}),
      };

      const historyRecord: SystemBackupHistoryRecord = {
        backupId,
        jobId,
        idempotencyKey: params.idempotencyKey,
        component: params.component,
        triggerType: params.triggerType,
        triggeredBy: params.triggeredBy,
        status: finalStatus,
        verificationStatus: finalVerificationStatus,
        sourceProjectId: projectId,
        sourceDatabaseId: databaseId,
        sourceStorageBucket: sourceBucket,
        backupBucket,
        firestoreDestinationUri: firestoreUri,
        firestoreOperationId: firestoreOpId,
        storageDestinationUri: storageUri,
        manifestId: storageManifest?.manifestId,
        totalSizeBytes: firestoreBytes + storageBytes,
        firestoreSizeBytes: firestoreBytes,
        storageSizeBytes: storageBytes,
        totalFilesBackedUp: storageFilesCount,
        filesDeltaSummary: storageDelta,
        attemptCount: maxAttemptsUsed,
        durationMs,
        verification: combinedVerification,
        startedAt,
        completedAt,
        ...(failureReason ? { failureReason } : {}),
      };

      await this.store.upsertHistory(historyRecord);
      await this.store.upsertJob({
        ...job,
        status: finalStatus,
        attemptCount: maxAttemptsUsed,
        completedAt,
        ...(failureReason ? { errorMessage: failureReason } : {}),
      });

      if (finalStatus !== 'SUCCESS') {
        await this.store.addAlert({
          alertId: this.nextId('BALR'),
          severity: finalStatus === 'FAILED' ? 'CRITICAL' : 'HIGH',
          category: finalStatus === 'PARTIAL' ? 'BACKUP_PARTIAL' : 'BACKUP_FAILED',
          title:
            finalStatus === 'PARTIAL'
              ? `Partial Backup Alert (${backupId})`
              : `Backup Failed (${backupId})`,
          message: failureReason || 'Backup verification or execution failed.',
          relatedBackupId: backupId,
          status: 'OPEN',
          createdAt: completedAt,
        });
      }

      await this.store.addAuditLog({
        logId: this.nextId('BAUD'),
        action:
          finalStatus === 'SUCCESS'
            ? 'BACKUP_COMPLETED'
            : finalStatus === 'PARTIAL'
              ? 'BACKUP_PARTIAL'
              : 'BACKUP_FAILED',
        actorUserId: params.triggeredBy,
        actorRole: params.actorRole || (params.triggerType === 'SCHEDULER' ? 'CLOUD_SCHEDULER' : 'ADMIN'),
        detail: `${params.component} backup ${backupId} finished with status ${finalStatus} (verification=${finalVerificationStatus}).`,
        metadata: {
          backupId,
          status: finalStatus,
          verificationStatus: finalVerificationStatus,
          totalSizeBytes: historyRecord.totalSizeBytes,
          totalFilesBackedUp: historyRecord.totalFilesBackedUp,
        },
        createdAt: completedAt,
      });

      // Automatically trigger retention check after successful scheduled or manual backup
      if (finalStatus === 'SUCCESS') {
        await this.retentionService.applyRetentionPolicy({
          actorUserId: params.triggeredBy,
          actorRole: params.actorRole || 'SYSTEM',
        });
      }

      return { record: historyRecord, deduplicated: false };
    } finally {
      await this.store.releaseLock(lockId, jobId);
    }
  }

  async verifyBackup(
    backupId: string,
    actor: { userId: string; role: string }
  ): Promise<SystemBackupHistoryRecord> {
    const existing = this.store.history.find((h) => h.backupId === backupId);
    if (!existing) {
      throw new Error(`Backup record ${backupId} not found.`);
    }

    let fsVer: BackupVerificationResult | undefined;
    let stVer: BackupVerificationResult | undefined;

    if (existing.firestoreDestinationUri) {
      fsVer = await this.firestoreService.verifyExportArtifacts(
        existing.firestoreDestinationUri,
        existing.firestoreOperationId
      );
    }
    if (existing.manifestId) {
      const manifest = this.store.manifests.find((m) => m.manifestId === existing.manifestId);
      if (manifest) {
        stVer = await this.storageService.verifyCopiedManifest(manifest.backupBucket, manifest.entries);
        manifest.verifiedFilesCount = stVer.verifiedFilesCount || 0;
        manifest.failedFilesCount = stVer.failedFilesCount || 0;
        await this.store.saveManifest(manifest);
      } else {
        stVer = {
          verified: false,
          checkedAt: new Date().toISOString(),
          storageVerified: false,
          failureReason: `Manifest ${existing.manifestId} missing from metadata store.`,
        };
      }
    }

    const fsOk = !existing.firestoreDestinationUri || Boolean(fsVer?.verified);
    const stOk = !existing.storageDestinationUri || Boolean(stVer?.verified);
    const verified = fsOk && stOk;

    const checkedAt = new Date().toISOString();
    const reasons = [fsVer?.failureReason, stVer?.failureReason].filter(Boolean).join(' | ');
    const nextStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED' = verified
      ? 'SUCCESS'
      : existing.component === 'COMPLETE' && (fsOk || stOk)
        ? 'PARTIAL'
        : 'FAILED';

    const updated: SystemBackupHistoryRecord = {
      ...existing,
      status: nextStatus,
      verificationStatus: verified ? 'VERIFIED' : 'FAILED',
      verification: {
        verified,
        checkedAt,
        ...(fsVer
          ? {
              firestoreVerified: fsVer.firestoreVerified,
              firestoreOperationDone: fsVer.firestoreOperationDone,
              firestoreMetadataPresent: fsVer.firestoreMetadataPresent,
            }
          : {}),
        ...(stVer
          ? {
              storageVerified: stVer.storageVerified,
              verifiedFilesCount: stVer.verifiedFilesCount,
              failedFilesCount: stVer.failedFilesCount,
            }
          : {}),
        ...(reasons ? { failureReason: reasons } : {}),
      },
      ...(reasons ? { failureReason: reasons } : { failureReason: undefined }),
    };

    await this.store.upsertHistory(updated);
    await this.store.addAuditLog({
      logId: this.nextId('BAUD'),
      action: 'BACKUP_VERIFIED',
      actorUserId: actor.userId,
      actorRole: actor.role,
      detail: `Re-verified backup ${backupId}: status=${updated.status}, verification=${updated.verificationStatus}.`,
      createdAt: checkedAt,
    });
    return updated;
  }

  async getAuthorizedManifest(
    backupId: string,
    actor: { userId: string; role: string }
  ): Promise<SystemBackupManifest> {
    const record = this.store.history.find((h) => h.backupId === backupId);
    if (!record || !record.manifestId) {
      throw new Error(`Storage backup manifest not found for backup ${backupId}.`);
    }
    const manifest = this.store.manifests.find((m) => m.manifestId === record.manifestId);
    if (!manifest) {
      throw new Error(`Manifest ${record.manifestId} not found.`);
    }
    await this.store.addAuditLog({
      logId: this.nextId('BAUD'),
      action: 'MANIFEST_DOWNLOADED',
      actorUserId: actor.userId,
      actorRole: actor.role,
      detail: `Downloaded authorized backup manifest ${manifest.manifestId} for ${backupId}.`,
      createdAt: new Date().toISOString(),
    });
    return manifest;
  }

  async previewRestore(params: {
    backupId: string;
    scope: 'FIRESTORE' | 'STORAGE' | 'COMPLETE';
    selectedPaths?: string[];
    targetProjectId?: string;
    targetDatabaseId?: string;
    targetStorageBucket?: string;
    actor: { userId: string; role: string };
  }): Promise<RestorePreviewResult> {
    const record = this.store.history.find((h) => h.backupId === params.backupId);
    if (!record) {
      throw new Error(`Backup ${params.backupId} does not exist.`);
    }
    if (record.prunedFromGcs) {
      throw new Error(`Backup ${params.backupId} was already pruned under retention rules and is no longer available in GCS.`);
    }
    if (record.status === 'FAILED' || record.verificationStatus !== 'VERIFIED') {
      throw new Error(
        `Restore blocked: backup ${params.backupId} has status ${record.status} and verification ${record.verificationStatus}. Only verified backups may be restored.`
      );
    }

    const needsFirestore = params.scope === 'FIRESTORE' || params.scope === 'COMPLETE';
    const needsStorage = params.scope === 'STORAGE' || params.scope === 'COMPLETE';

    if (needsFirestore && !record.firestoreDestinationUri) {
      throw new Error(`Backup ${params.backupId} does not include a Firestore export.`);
    }
    if (needsStorage && !record.storageDestinationUri) {
      throw new Error(`Backup ${params.backupId} does not include a Storage backup.`);
    }

    const warnings: string[] = [];
    let estimatedFilesToRestore = 0;
    let estimatedSizeBytes = 0;
    let selectedPaths: string[] = [];

    if (needsFirestore && record.firestoreDestinationUri) {
      const validation = await this.firestoreService.validateBackupForRestore(
        record.firestoreDestinationUri
      );
      if (!validation.valid) {
        throw new Error(validation.detail);
      }
      estimatedSizeBytes += validation.totalBytes;
      warnings.push(
        `Firestore Managed Import will overwrite matching document IDs in target database (${params.targetDatabaseId || record.sourceDatabaseId}).`
      );
    }

    if (needsStorage && record.manifestId) {
      const manifest = this.store.manifests.find((m) => m.manifestId === record.manifestId);
      if (!manifest) {
        throw new Error(`Storage manifest ${record.manifestId} not found.`);
      }
      const activeEntries = manifest.entries.filter((e) => e.changeType !== 'DELETED');
      const filtered =
        params.selectedPaths && params.selectedPaths.length > 0
          ? activeEntries.filter((e) => params.selectedPaths!.includes(e.originalPath))
          : activeEntries;
      if (filtered.length === 0) {
        throw new Error('No matching files selected for Storage restore.');
      }
      selectedPaths = filtered.map((e) => e.originalPath);
      estimatedFilesToRestore = filtered.length;
      estimatedSizeBytes += filtered.reduce((sum, e) => sum + Number(e.fileSizeBytes || 0), 0);
      warnings.push(
        `${filtered.length} file(s) will be restored with checksum verification into ${params.targetStorageBucket || record.sourceStorageBucket}.`
      );
    }

    const targetProjectId = (params.targetProjectId || record.sourceProjectId).trim();
    const targetDatabaseId = (params.targetDatabaseId || record.sourceDatabaseId || '(default)').trim();
    const targetStorageBucket = (
      params.targetStorageBucket ||
      (targetProjectId !== record.sourceProjectId
        ? `${targetProjectId}.firebasestorage.app`
        : record.sourceStorageBucket)
    )
      .replace(/^gs:\/\//i, '')
      .trim();

    if (targetProjectId !== record.sourceProjectId) {
      warnings.push(
        `Isolated recovery project selected: restoring into ${targetProjectId} instead of source project ${record.sourceProjectId}.`
      );
    }

    const previewId = this.nextId('RPRV');
    const now = Date.now();
    const preview: RestorePreviewResult = {
      previewId,
      backupId: record.backupId,
      scope: params.scope,
      sourceBackupTimestamp: record.completedAt,
      sourceProjectId: record.sourceProjectId,
      sourceDatabaseId: record.sourceDatabaseId,
      sourceStorageBucket: record.sourceStorageBucket,
      targetProjectId,
      targetDatabaseId,
      targetStorageBucket,
      firestoreExportUri: record.firestoreDestinationUri,
      storageBackupPrefix: record.storageDestinationUri,
      selectedPaths,
      estimatedFilesToRestore,
      estimatedSizeBytes,
      integrityVerified: true,
      warnings,
      generatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
    };

    this.store.restorePreviews.set(previewId, preview);
    await this.store.addAuditLog({
      logId: this.nextId('BAUD'),
      action: 'RESTORE_PREVIEWED',
      actorUserId: params.actor.userId,
      actorRole: params.actor.role,
      detail: `Generated dry-run restore preview ${previewId} for backup ${record.backupId} (targetProject=${targetProjectId}, db=${targetDatabaseId}).`,
      createdAt: preview.generatedAt,
    });
    return preview;
  }

  async executeRestore(params: {
    previewId: string;
    confirmationText: string;
    actor: { userId: string; role: string };
  }): Promise<SystemRestoreHistoryRecord> {
    if (String(params.confirmationText || '').trim().toUpperCase() !== 'CONFIRM RESTORE') {
      throw new Error('Explicit confirmation text "CONFIRM RESTORE" is required before executing restore.');
    }

    const preview = this.store.restorePreviews.get(params.previewId);
    if (!preview) {
      throw new Error('Valid non-expired restore preview ID is required. Run dry-run preview first.');
    }
    if (Date.parse(preview.expiresAt) < Date.now()) {
      this.store.restorePreviews.delete(params.previewId);
      throw new Error('Restore preview expired. Re-run dry-run preview before restoring.');
    }

    const lockId = 'backup_execution_RESTORE';
    const restoreId = this.nextId('FRST');
    const acquired = await this.store.tryAcquireFirestoreLock(lockId, restoreId, 300_000);
    if (!acquired) {
      throw new Error('Another restore operation is currently running.');
    }

    const executedAt = new Date().toISOString();
    try {
      let firestoreOpId: string | undefined;
      let fsVerified = true;
      let restoredFilesCount = 0;
      let storageVerified = true;
      const notes: string[] = [];

      if (preview.scope === 'FIRESTORE' || preview.scope === 'COMPLETE') {
        if (!preview.firestoreExportUri) {
          throw new Error('Preview does not contain a Firestore export URI.');
        }
        const fsRes = await this.firestoreService.runManagedImport({
          targetProjectId: preview.targetProjectId,
          targetDatabaseId: preview.targetDatabaseId,
          inputUriPrefix: preview.firestoreExportUri,
        });
        firestoreOpId = fsRes.operationId;
        fsVerified = fsRes.verification.verified;
        notes.push(fsRes.verification.detail);
      }

      if (preview.scope === 'STORAGE' || preview.scope === 'COMPLETE') {
        const record = this.store.history.find((h) => h.backupId === preview.backupId);
        const manifest = record?.manifestId
          ? this.store.manifests.find((m) => m.manifestId === record.manifestId)
          : undefined;
        if (!manifest) {
          throw new Error('Storage manifest missing for restore.');
        }
        const stRes = await this.storageService.restoreFilesFromManifest({
          manifest,
          targetBucket: preview.targetStorageBucket,
          selectedPaths: preview.selectedPaths.length > 0 ? preview.selectedPaths : undefined,
        });
        restoredFilesCount = stRes.restoredFilesCount;
        storageVerified = stRes.failedFiles.length === 0;
        notes.push(
          storageVerified
            ? `Verified ${stRes.verifiedFilesCount}/${stRes.restoredFilesCount} restored storage files.`
            : `Failed checksum verification on ${stRes.failedFiles.join(', ')}`
        );
      }

      const overallVerified = fsVerified && storageVerified;
      const completedAt = new Date().toISOString();
      const historyRecord: SystemRestoreHistoryRecord = {
        restoreId,
        backupId: preview.backupId,
        scope: preview.scope,
        targetProjectId: preview.targetProjectId,
        targetDatabaseId: preview.targetDatabaseId,
        targetStorageBucket: preview.targetStorageBucket,
        selectedPathsCount: preview.selectedPaths.length,
        restoredFilesCount,
        firestoreOperationId: firestoreOpId,
        status: overallVerified ? 'COMPLETED' : 'PARTIAL',
        verificationStatus: overallVerified ? 'VERIFIED' : 'FAILED',
        verificationNotes: notes.join(' | '),
        executedBy: params.actor.userId,
        executedAt,
        completedAt,
      };

      await this.store.addRestoreHistory(historyRecord);
      this.store.restorePreviews.delete(params.previewId);
      await this.store.addAuditLog({
        logId: this.nextId('BAUD'),
        action: 'RESTORE_EXECUTED',
        actorUserId: params.actor.userId,
        actorRole: params.actor.role,
        detail: `Executed ${preview.scope} restore ${restoreId} from ${preview.backupId} to ${preview.targetProjectId}/${preview.targetDatabaseId} (${historyRecord.status}).`,
        metadata: {
          restoreId,
          backupId: preview.backupId,
          targetProjectId: preview.targetProjectId,
          targetDatabaseId: preview.targetDatabaseId,
          restoredFilesCount,
        },
        createdAt: completedAt,
      });
      return historyRecord;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const completedAt = new Date().toISOString();
      const failedRecord: SystemRestoreHistoryRecord = {
        restoreId,
        backupId: preview.backupId,
        scope: preview.scope,
        targetProjectId: preview.targetProjectId,
        targetDatabaseId: preview.targetDatabaseId,
        targetStorageBucket: preview.targetStorageBucket,
        selectedPathsCount: preview.selectedPaths.length,
        restoredFilesCount: 0,
        status: 'FAILED',
        verificationStatus: 'FAILED',
        verificationNotes: msg,
        executedBy: params.actor.userId,
        executedAt,
        completedAt,
        failureReason: msg,
      };
      await this.store.addRestoreHistory(failedRecord);
      await this.store.addAlert({
        alertId: this.nextId('BALR'),
        severity: 'CRITICAL',
        category: 'RESTORE_FAILED',
        title: `Restore Failed (${restoreId})`,
        message: msg,
        relatedBackupId: preview.backupId,
        status: 'OPEN',
        createdAt: completedAt,
      });
      await this.store.addAuditLog({
        logId: this.nextId('BAUD'),
        action: 'RESTORE_FAILED',
        actorUserId: params.actor.userId,
        actorRole: params.actor.role,
        detail: `Restore ${restoreId} failed: ${msg}`,
        createdAt: completedAt,
      });
      throw err;
    } finally {
      await this.store.releaseLock(lockId, restoreId);
    }
  }

  async runRetentionCleanup(actor: { userId: string; role: string }): Promise<RetentionCleanupResult> {
    return this.retentionService.applyRetentionPolicy({
      actorUserId: actor.userId,
      actorRole: actor.role,
    });
  }
}
