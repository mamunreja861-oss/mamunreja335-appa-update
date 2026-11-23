export type BackupComponentType = 'FIRESTORE' | 'STORAGE' | 'COMPLETE';

export type BackupStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'VERIFYING'
  | 'SUCCESS'
  | 'PARTIAL'
  | 'FAILED';

export type VerificationStatus = 'PENDING' | 'VERIFIED' | 'FAILED';

export type ObjectChangeType = 'NEW' | 'CHANGED' | 'UNCHANGED' | 'DELETED';

export interface SystemBackupConfig {
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

export interface BackupVerificationResult {
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

export interface SystemBackupJob {
  jobId: string;
  idempotencyKey?: string;
  component: BackupComponentType;
  triggerType: 'MANUAL' | 'SCHEDULER' | 'VERIFY';
  triggeredBy: string;
  status: BackupStatus;
  attemptCount: number;
  maxRetries: number;
  startedAt: string;
  completedAt: string | null;
  backupId?: string;
  errorMessage?: string;
}

export interface SystemBackupHistoryRecord {
  backupId: string;
  jobId: string;
  idempotencyKey?: string;
  component: BackupComponentType;
  triggerType: 'MANUAL' | 'SCHEDULER';
  triggeredBy: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  verificationStatus: VerificationStatus;
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
  verification: BackupVerificationResult;
  startedAt: string;
  completedAt: string;
  failureReason?: string;
  prunedFromGcs?: boolean;
  prunedAt?: string;
}

export interface StorageBackupManifestEntry {
  originalPath: string;
  backupPath: string;
  backupUri: string;
  originalGeneration: string;
  fileSizeBytes: number;
  contentType: string;
  checksum: string;
  crc32c?: string;
  md5Hash?: string;
  changeType: ObjectChangeType;
  backupTimestamp: string;
  verificationStatus: 'VERIFIED' | 'FAILED' | 'SKIPPED_DELETED';
  isPublic?: boolean;
  failureReason?: string;
}

export interface SystemBackupManifest {
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
  entries: StorageBackupManifestEntry[];
}

export interface SystemRestoreHistoryRecord {
  restoreId: string;
  backupId: string;
  scope: 'FIRESTORE' | 'STORAGE' | 'COMPLETE';
  targetProjectId: string;
  targetDatabaseId: string;
  targetStorageBucket: string;
  selectedPathsCount: number;
  restoredFilesCount: number;
  firestoreOperationId?: string;
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED';
  verificationStatus: VerificationStatus;
  verificationNotes: string;
  executedBy: string;
  executedAt: string;
  completedAt: string;
  failureReason?: string;
}

export interface RestorePreviewResult {
  previewId: string;
  backupId: string;
  scope: 'FIRESTORE' | 'STORAGE' | 'COMPLETE';
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

export interface SystemBackupAlert {
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

export interface SystemBackupAuditLog {
  logId: string;
  action:
    | 'CONFIG_UPDATED'
    | 'BACKUP_STARTED'
    | 'BACKUP_COMPLETED'
    | 'BACKUP_PARTIAL'
    | 'BACKUP_FAILED'
    | 'BACKUP_VERIFIED'
    | 'MANIFEST_DOWNLOADED'
    | 'RESTORE_PREVIEWED'
    | 'RESTORE_EXECUTED'
    | 'RESTORE_FAILED'
    | 'RETENTION_PRUNED';
  actorUserId: string;
  actorRole: string;
  detail: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface BackupExecutionLock {
  lockId: string;
  ownerJobId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface GcsObjectInfo {
  name: string;
  bucket: string;
  generation: string;
  size: number;
  contentType: string;
  md5Hash: string;
  crc32c: string;
  updated?: string;
  metadata?: Record<string, string>;
  isPublic?: boolean;
}

export interface FirestoreManagedOperation {
  name: string;
  done: boolean;
  error?: { code?: number; message?: string };
  metadata?: Record<string, unknown>;
  response?: Record<string, unknown>;
}

export interface FirestoreAdminRestAdapter {
  exportDocuments(params: {
    projectId: string;
    databaseId: string;
    outputUriPrefix: string;
    collectionIds?: string[];
  }): Promise<FirestoreManagedOperation>;
  importDocuments(params: {
    projectId: string;
    databaseId: string;
    inputUriPrefix: string;
    collectionIds?: string[];
  }): Promise<FirestoreManagedOperation>;
  getOperationStatus(operationName: string): Promise<FirestoreManagedOperation>;
}

export interface GcsBackupStorageAdapter {
  listObjects(bucket: string, prefix?: string): Promise<GcsObjectInfo[]>;
  copyObject(params: {
    sourceBucket: string;
    sourceName: string;
    destBucket: string;
    destName: string;
    contentType?: string;
    metadata?: Record<string, string>;
  }): Promise<GcsObjectInfo>;
  getObjectMetadata(bucket: string, name: string): Promise<GcsObjectInfo | null>;
  writeJsonObject(bucket: string, name: string, payload: unknown): Promise<void>;
  readJsonObject<T = unknown>(bucket: string, name: string): Promise<T | null>;
  deletePrefix(bucket: string, prefix: string): Promise<number>;
}

export interface RetentionCleanupResult {
  checkedAt: string;
  firestoreRetentionDays: number;
  storageRetentionDays: number;
  preservedBackupIds: string[];
  prunedBackupIds: string[];
  deletedGcsObjectsCount: number;
  skippedReason?: string;
}

export interface BackupDashboardTelemetry {
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
  config: SystemBackupConfig;
  firestoreStatus: {
    lastStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'NEVER_RUN';
    lastBackupAt: string | null;
    lastOperationId: string | null;
    lastDestinationUri: string | null;
    verificationStatus: VerificationStatus | 'N/A';
  };
  storageStatus: {
    lastStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'NEVER_RUN';
    lastBackupAt: string | null;
    lastDestinationUri: string | null;
    verificationStatus: VerificationStatus | 'N/A';
  };
  lastSuccessfulBackup: SystemBackupHistoryRecord | null;
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
  verificationStatus: VerificationStatus | 'N/A';
  history: SystemBackupHistoryRecord[];
  failedHistory: SystemBackupHistoryRecord[];
  restoreHistory: SystemRestoreHistoryRecord[];
  alerts: SystemBackupAlert[];
  auditLogs: SystemBackupAuditLog[];
  activeLocks: BackupExecutionLock[];
}
