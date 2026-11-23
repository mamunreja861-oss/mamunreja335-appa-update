import { securityRequest } from './securityApi';

export type FirebaseBackupComponent = 'FIRESTORE' | 'STORAGE' | 'COMPLETE';
export type FirebaseBackupStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED';
export type FirebaseVerificationStatus = 'PENDING' | 'VERIFIED' | 'FAILED';

export interface FirebaseBackupConfigDto {
  id: 'default';
  automaticBackupEnabled: boolean;
  timezone: 'Asia/Kolkata';
  firestoreScheduleCron: string;
  storageScheduleCron: string;
  firestoreScheduleIst: string;
  storageScheduleIst: string;
  firestoreRetentionDays: number;
  storageRetentionDays: number;
  keepMostRecentSuccessful: boolean;
  neverDeleteOnlyBackup: boolean;
  retainFailedLogs: boolean;
  softDeleteProtectionDays: number;
  sourceProjectId: string;
  sourceDatabaseId: string;
  sourceStorageBucket: string;
  backupBucket: string;
  maxRetries: number;
  retryBaseDelayMs: number;
  timeoutMs: number;
  updatedBy: string;
  updatedAt: string;
}

export interface FirebaseBackupVerificationResult {
  verified: boolean;
  checkedAt: string;
  firestoreVerified?: boolean;
  firestoreOperationDone?: boolean;
  firestoreMetadataPresent?: boolean;
  storageVerified?: boolean;
  verifiedFilesCount?: number;
  failedFilesCount?: number;
  failureReason?: string;
}

export interface FirebaseBackupHistoryItem {
  backupId: string;
  jobId: string;
  idempotencyKey?: string;
  component: FirebaseBackupComponent;
  triggerType: 'MANUAL' | 'SCHEDULER';
  triggeredBy: string;
  status: FirebaseBackupStatus;
  verificationStatus: FirebaseVerificationStatus;
  sourceProjectId: string;
  sourceDatabaseId: string;
  sourceStorageBucket: string;
  backupBucket: string;
  firestoreDestinationUri?: string;
  firestoreOperationId?: string;
  storageDestinationUri?: string;
  manifestId?: string;
  totalSizeBytes: number;
  firestoreSizeBytes: number;
  storageSizeBytes: number;
  totalFilesBackedUp: number;
  filesDeltaSummary?: {
    newCount: number;
    changedCount: number;
    unchangedCount: number;
    deletedCount: number;
  };
  attemptCount: number;
  durationMs: number;
  verification: FirebaseBackupVerificationResult;
  startedAt: string;
  completedAt: string;
  failureReason?: string;
  prunedFromGcs?: boolean;
  prunedAt?: string;
}

export interface StorageManifestFileEntry {
  originalPath: string;
  backupPath: string;
  backupUri: string;
  originalGeneration: string;
  fileSizeBytes: number;
  contentType: string;
  checksum: string;
  crc32c?: string;
  md5Hash?: string;
  changeType: 'NEW' | 'CHANGED' | 'UNCHANGED' | 'DELETED';
  backupTimestamp: string;
  verificationStatus: 'VERIFIED' | 'FAILED' | 'SKIPPED_DELETED';
  isPublic?: boolean;
  failureReason?: string;
}

export interface FirebaseStorageManifestDto {
  manifestId: string;
  backupId: string;
  sourceBucket: string;
  backupBucket: string;
  backupPrefix: string;
  generatedAt: string;
  totalFiles: number;
  totalSizeBytes: number;
  newFilesCount: number;
  changedFilesCount: number;
  unchangedFilesCount: number;
  deletedFromSourceCount: number;
  verifiedFilesCount: number;
  failedFilesCount: number;
  entries: StorageManifestFileEntry[];
}

export interface FirebaseRestoreHistoryItem {
  restoreId: string;
  backupId: string;
  scope: FirebaseBackupComponent;
  targetProjectId: string;
  targetDatabaseId: string;
  targetStorageBucket: string;
  selectedPathsCount: number;
  restoredFilesCount: number;
  firestoreOperationId?: string;
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED';
  verificationStatus: FirebaseVerificationStatus;
  verificationNotes: string;
  executedBy: string;
  executedAt: string;
  completedAt: string;
  failureReason?: string;
}

export interface FirebaseRestorePreviewDto {
  previewId: string;
  backupId: string;
  scope: FirebaseBackupComponent;
  sourceBackupTimestamp: string;
  sourceProjectId: string;
  sourceDatabaseId: string;
  sourceStorageBucket: string;
  targetProjectId: string;
  targetDatabaseId: string;
  targetStorageBucket: string;
  firestoreExportUri?: string;
  storageBackupPrefix?: string;
  selectedPaths: string[];
  estimatedFilesToRestore: number;
  estimatedSizeBytes: number;
  integrityVerified: boolean;
  warnings: string[];
  generatedAt: string;
  expiresAt: string;
}

export interface FirebaseBackupAlertItem {
  alertId: string;
  severity: 'MEDIUM' | 'HIGH' | 'CRITICAL';
  category: 'BACKUP_FAILED' | 'BACKUP_PARTIAL' | 'VERIFICATION_FAILED' | 'RESTORE_FAILED' | 'RETENTION_WARNING';
  title: string;
  message: string;
  relatedBackupId?: string;
  status: 'OPEN' | 'RESOLVED';
  createdAt: string;
  resolvedAt?: string;
}

export interface FirebaseBackupAuditLogItem {
  logId: string;
  action: string;
  actorUserId: string;
  actorRole: string;
  detail: string;
  createdAt: string;
}

export interface FirebaseRetentionCleanupDto {
  checkedAt: string;
  firestoreRetentionDays: number;
  storageRetentionDays: number;
  preservedBackupIds: string[];
  prunedBackupIds: string[];
  deletedGcsObjectsCount: number;
  skippedReason?: string;
}

export interface FirebaseBackupDashboardTelemetry {
  firebaseConnection: {
    adminInitialized: boolean;
    firestoreConnected: boolean;
    storageConnected: boolean;
    backupBucketConfigured: boolean;
    projectId: string;
    firestoreDatabaseId: string;
    storageBucket: string;
    backupBucket: string;
    authMode: string;
    cloudRunUrlConfigured: boolean;
    error: string | null;
  };
  config: FirebaseBackupConfigDto;
  firestoreStatus: {
    lastStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'NEVER_RUN';
    lastBackupAt: string | null;
    lastOperationId: string | null;
    lastDestinationUri: string | null;
    verificationStatus: FirebaseVerificationStatus | 'N/A';
  };
  storageStatus: {
    lastStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'NEVER_RUN';
    lastBackupAt: string | null;
    lastDestinationUri: string | null;
    verificationStatus: FirebaseVerificationStatus | 'N/A';
  };
  lastSuccessfulBackup: FirebaseBackupHistoryItem | null;
  nextScheduledBackup: {
    timezone: 'Asia/Kolkata';
    firestoreNextRunIst: string;
    firestoreNextRunUtc: string;
    storageNextRunIst: string;
    storageNextRunUtc: string;
  };
  totals: {
    totalBackupSizeBytes: number;
    totalFilesBackedUp: number;
    successfulBackupsCount: number;
    failedOrPartialBackupsCount: number;
  };
  verificationStatus: FirebaseVerificationStatus | 'N/A';
  history: FirebaseBackupHistoryItem[];
  failedHistory: FirebaseBackupHistoryItem[];
  restoreHistory: FirebaseRestoreHistoryItem[];
  alerts: FirebaseBackupAlertItem[];
  auditLogs: FirebaseBackupAuditLogItem[];
  activeLocks: Array<{ lockId: string; ownerJobId: string; acquiredAt: string; expiresAt: string }>;
}

const BASE = '/api/v1/security/firebase-backup';

export const firebaseBackupApi = {
  getDashboard() {
    return securityRequest<FirebaseBackupDashboardTelemetry>(`${BASE}/dashboard`, {
      timeoutMs: 25000,
    });
  },
  updateConfig(patch: Partial<Pick<FirebaseBackupConfigDto, 'automaticBackupEnabled' | 'firestoreRetentionDays' | 'storageRetentionDays' | 'backupBucket' | 'softDeleteProtectionDays' | 'keepMostRecentSuccessful' | 'neverDeleteOnlyBackup' | 'retainFailedLogs'>>) {
    return securityRequest<FirebaseBackupConfigDto>(`${BASE}/config`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
  },
  runBackup(component: FirebaseBackupComponent) {
    return securityRequest<FirebaseBackupHistoryItem>(`${BASE}/run`, {
      method: 'POST',
      timeoutMs: 120000,
      body: JSON.stringify({ component }),
    });
  },
  verifyBackup(backupId: string) {
    return securityRequest<FirebaseBackupHistoryItem>(`${BASE}/${encodeURIComponent(backupId)}/verify`, {
      method: 'POST',
      timeoutMs: 60000,
      body: JSON.stringify({}),
    });
  },
  getManifest(backupId: string) {
    return securityRequest<FirebaseStorageManifestDto>(`${BASE}/${encodeURIComponent(backupId)}/manifest`);
  },
  runRetention() {
    return securityRequest<FirebaseRetentionCleanupDto>(`${BASE}/retention/run`, {
      method: 'POST',
      timeoutMs: 60000,
      body: JSON.stringify({}),
    });
  },
  previewRestore(payload: {
    backupId: string;
    scope: FirebaseBackupComponent;
    selectedPaths?: string[];
    targetProjectId?: string;
    targetDatabaseId?: string;
    targetStorageBucket?: string;
  }) {
    return securityRequest<FirebaseRestorePreviewDto>(`${BASE}/restore/preview`, {
      method: 'POST',
      timeoutMs: 45000,
      body: JSON.stringify(payload),
    });
  },
  executeRestore(payload: { previewId: string; confirmationText: string }) {
    return securityRequest<FirebaseRestoreHistoryItem>(`${BASE}/restore/execute`, {
      method: 'POST',
      timeoutMs: 120000,
      body: JSON.stringify(payload),
    });
  },
};
