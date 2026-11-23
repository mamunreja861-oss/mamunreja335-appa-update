import {
  GcsBackupStorageAdapter,
  RetentionCleanupResult,
  SystemBackupHistoryRecord,
} from './backupTypes.js';
import { BackupMetadataStore } from './backupMetadataStore.js';
import { parseGcsUri } from './firestoreBackupService.js';

export class RetentionService {
  constructor(
    private readonly store: BackupMetadataStore,
    private readonly gcs: GcsBackupStorageAdapter
  ) {}

  async applyRetentionPolicy(params?: {
    now?: Date;
    actorUserId?: string;
    actorRole?: string;
  }): Promise<RetentionCleanupResult> {
    const now = params?.now ?? new Date();
    const cfg = this.store.config;
    const firestoreDays = Math.max(1, Number(cfg.firestoreRetentionDays || 30));
    const storageDays = Math.max(1, Number(cfg.storageRetentionDays || 30));

    // Only consider active (not yet pruned) SUCCESS backups for retention eligibility.
    // Failed and partial logs are NEVER deleted under retention rules.
    const activeSuccessBackups = this.store.history
      .filter((h) => h.status === 'SUCCESS' && !h.prunedFromGcs)
      .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));

    const firestoreSuccesses = activeSuccessBackups.filter(
      (h) => h.component === 'FIRESTORE' || h.component === 'COMPLETE'
    );
    const storageSuccesses = activeSuccessBackups.filter(
      (h) => h.component === 'STORAGE' || h.component === 'COMPLETE'
    );

    const preservedSet = new Set<string>();
    // Guarantee #1 & #2: Always preserve the most recent successful backup AND never delete the only successful backup
    if (firestoreSuccesses.length > 0 && (cfg.keepMostRecentSuccessful || cfg.neverDeleteOnlyBackup)) {
      preservedSet.add(firestoreSuccesses[0].backupId);
    }
    if (storageSuccesses.length > 0 && (cfg.keepMostRecentSuccessful || cfg.neverDeleteOnlyBackup)) {
      preservedSet.add(storageSuccesses[0].backupId);
    }

    const prunedBackupIds: string[] = [];
    let deletedGcsObjectsCount = 0;

    for (const record of activeSuccessBackups) {
      if (preservedSet.has(record.backupId)) {
        continue;
      }

      const ageMs = now.getTime() - Date.parse(record.completedAt);
      const ageDays = ageMs / (24 * 60 * 60 * 1000);

      let expired = false;
      if (record.component === 'FIRESTORE') {
        expired = firestoreSuccesses.length > 1 && ageDays > firestoreDays;
      } else if (record.component === 'STORAGE') {
        expired = storageSuccesses.length > 1 && ageDays > storageDays;
      } else {
        // COMPLETE backup expires only when BOTH Firestore and Storage retention windows are exceeded
        // and alternative newer backups exist for both components
        expired =
          firestoreSuccesses.length > 1 &&
          storageSuccesses.length > 1 &&
          ageDays > Math.max(firestoreDays, storageDays);
      }

      if (!expired) {
        preservedSet.add(record.backupId);
        continue;
      }

      if (record.firestoreDestinationUri) {
        try {
          const { bucket, prefix } = parseGcsUri(record.firestoreDestinationUri);
          deletedGcsObjectsCount += await this.gcs.deletePrefix(bucket, prefix);
        } catch {
          // Continue cleanup if object prefix was already removed by GCS lifecycle
        }
      }
      if (record.storageDestinationUri) {
        try {
          const { bucket, prefix } = parseGcsUri(record.storageDestinationUri);
          deletedGcsObjectsCount += await this.gcs.deletePrefix(bucket, prefix);
        } catch {
          // Continue cleanup
        }
      }

      await this.store.upsertHistory({
        ...record,
        prunedFromGcs: true,
        prunedAt: now.toISOString(),
      });
      prunedBackupIds.push(record.backupId);
    }

    if (prunedBackupIds.length > 0) {
      await this.store.addAuditLog({
        logId: `BAUD-${Date.now().toString(36).toUpperCase()}-RET`,
        action: 'RETENTION_PRUNED',
        actorUserId: params?.actorUserId || 'SYSTEM_RETENTION',
        actorRole: params?.actorRole || 'SYSTEM',
        detail: `Pruned ${prunedBackupIds.length} expired backup(s) from GCS (${deletedGcsObjectsCount} objects); preserved latest/only backups and all failed logs.`,
        metadata: {
          prunedBackupIds,
          preservedBackupIds: Array.from(preservedSet),
          firestoreRetentionDays: firestoreDays,
          storageRetentionDays: storageDays,
        },
        createdAt: now.toISOString(),
      });
    }

    return {
      checkedAt: now.toISOString(),
      firestoreRetentionDays: firestoreDays,
      storageRetentionDays: storageDays,
      preservedBackupIds: Array.from(preservedSet),
      prunedBackupIds,
      deletedGcsObjectsCount,
    };
  }
}
