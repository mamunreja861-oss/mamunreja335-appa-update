import {
  BackupVerificationResult,
  GcsBackupStorageAdapter,
  GcsObjectInfo,
  StorageBackupManifestEntry,
  SystemBackupManifest,
} from './backupTypes.js';
import { formatIstParts } from './backupProtection.js';

export interface StorageBackupExecutionResult {
  destinationUri: string;
  backupPrefix: string;
  manifest: SystemBackupManifest;
  totalSizeBytes: number;
  totalFilesBackedUp: number;
  deltaSummary: {
    newCount: number;
    changedCount: number;
    unchangedCount: number;
    deletedCount: number;
  };
  verification: BackupVerificationResult;
}

export interface StorageRestoreExecutionResult {
  targetBucket: string;
  restoredFilesCount: number;
  verifiedFilesCount: number;
  failedFiles: string[];
  checkedAt: string;
}

export class StorageBackupService {
  constructor(private readonly gcs: GcsBackupStorageAdapter) {}

  buildBackupPrefix(now: Date = new Date(), uniqueSuffix?: string): string {
    const ist = formatIstParts(now);
    const folder = uniqueSuffix ? `${ist.timestampFolder}-${uniqueSuffix}` : ist.timestampFolder;
    return `storage/${ist.year}/${ist.month}/${ist.day}/${folder}/`;
  }

  private resolveChecksum(obj: Pick<GcsObjectInfo, 'md5Hash' | 'crc32c' | 'generation' | 'size'>): string {
    return obj.md5Hash || obj.crc32c || `${obj.generation}:${obj.size}`;
  }

  private isObjectChanged(current: GcsObjectInfo, previous?: StorageBackupManifestEntry): boolean {
    if (!previous) return true;
    const prevChecksum = previous.md5Hash || previous.checksum;
    const curChecksum = current.md5Hash || this.resolveChecksum(current);
    return (
      previous.originalGeneration !== current.generation ||
      previous.fileSizeBytes !== current.size ||
      prevChecksum !== curChecksum
    );
  }

  async runStorageBackup(params: {
    backupId: string;
    manifestId: string;
    sourceBucket: string;
    backupBucket: string;
    previousManifest?: SystemBackupManifest;
    now?: Date;
    uniqueSuffix?: string;
  }): Promise<StorageBackupExecutionResult> {
    const cleanSource = params.sourceBucket.replace(/^gs:\/\//i, '').trim();
    const cleanBackup = params.backupBucket.replace(/^gs:\/\//i, '').trim();
    if (!cleanSource || !cleanBackup) {
      throw new Error('Both source Firebase Storage bucket and destination GCS backup bucket must be configured.');
    }

    const now = params.now ?? new Date();
    const backupPrefix = this.buildBackupPrefix(now, params.uniqueSuffix);
    const destinationUri = `gs://${cleanBackup}/${backupPrefix}`;
    const backupTimestamp = now.toISOString();

    const sourceObjects = await this.gcs.listObjects(cleanSource);
    const prevMap = new Map<string, StorageBackupManifestEntry>();
    if (params.previousManifest) {
      for (const entry of params.previousManifest.entries) {
        if (entry.changeType !== 'DELETED') {
          prevMap.set(entry.originalPath, entry);
        }
      }
    }

    const activeSourcePaths = new Set<string>();
    const entries: StorageBackupManifestEntry[] = [];
    let newCount = 0;
    let changedCount = 0;
    let unchangedCount = 0;
    let deletedCount = 0;
    let totalSizeBytes = 0;

    // Copy every non-directory object while preserving exact original paths and metadata.
    // Never delete or modify any object in cleanSource.
    for (const srcObj of sourceObjects) {
      if (!srcObj.name || srcObj.name.endsWith('/')) continue;
      activeSourcePaths.add(srcObj.name);

      const prevEntry = prevMap.get(srcObj.name);
      const changeType = !prevEntry
        ? 'NEW'
        : this.isObjectChanged(srcObj, prevEntry)
          ? 'CHANGED'
          : 'UNCHANGED';
      if (changeType === 'NEW') newCount += 1;
      else if (changeType === 'CHANGED') changedCount += 1;
      else unchangedCount += 1;

      const destPath = `${backupPrefix}${srcObj.name.replace(/^\/+/, '')}`;
      const copied = await this.gcs.copyObject({
        sourceBucket: cleanSource,
        sourceName: srcObj.name,
        destBucket: cleanBackup,
        destName: destPath,
        contentType: srcObj.contentType || 'application/octet-stream',
        metadata: {
          ...(srcObj.metadata || {}),
          munOriginalPath: srcObj.name,
          munOriginalGeneration: srcObj.generation,
          munSourceBucket: cleanSource,
          munBackupTimestamp: backupTimestamp,
          munSourceMd5Hash: srcObj.md5Hash || '',
          munSourceCrc32c: srcObj.crc32c || '',
        },
      });

      if (copied.isPublic) {
        throw new Error(`Security policy violation: backup object ${destPath} must remain non-public.`);
      }

      const checksum = this.resolveChecksum(srcObj);
      entries.push({
        originalPath: srcObj.name,
        backupPath: destPath,
        backupUri: `gs://${cleanBackup}/${destPath}`,
        originalGeneration: srcObj.generation,
        fileSizeBytes: srcObj.size,
        contentType: srcObj.contentType || 'application/octet-stream',
        checksum,
        md5Hash: srcObj.md5Hash || copied.md5Hash,
        crc32c: srcObj.crc32c || copied.crc32c,
        changeType,
        backupTimestamp,
        verificationStatus: 'VERIFIED',
        isPublic: false,
      });
      totalSizeBytes += Number(srcObj.size || 0);
    }

    // Record objects deleted from source since last manifest without deleting historical copies
    for (const [prevPath, prevEntry] of prevMap.entries()) {
      if (!activeSourcePaths.has(prevPath)) {
        deletedCount += 1;
        entries.push({
          ...prevEntry,
          changeType: 'DELETED',
          backupTimestamp,
          verificationStatus: 'SKIPPED_DELETED',
        });
      }
    }

    // Mandatory post-backup verification of every copied file
    const verifyResult = await this.verifyCopiedManifest(cleanBackup, entries);

    const manifest: SystemBackupManifest = {
      manifestId: params.manifestId,
      backupId: params.backupId,
      sourceBucket: cleanSource,
      backupBucket: cleanBackup,
      backupPrefix,
      generatedAt: backupTimestamp,
      totalFiles: activeSourcePaths.size,
      totalSizeBytes,
      newFilesCount: newCount,
      changedFilesCount: changedCount,
      unchangedFilesCount: unchangedCount,
      deletedFromSourceCount: deletedCount,
      verifiedFilesCount: verifyResult.verifiedFilesCount || 0,
      failedFilesCount: verifyResult.failedFilesCount || 0,
      entries,
    };

    // Persist private manifest inside the backup folder as well
    await this.gcs.writeJsonObject(cleanBackup, `${backupPrefix}_manifest.json`, manifest);

    return {
      destinationUri,
      backupPrefix,
      manifest,
      totalSizeBytes,
      totalFilesBackedUp: activeSourcePaths.size,
      deltaSummary: {
        newCount,
        changedCount,
        unchangedCount,
        deletedCount,
      },
      verification: verifyResult,
    };
  }

  async verifyCopiedManifest(
    backupBucket: string,
    entries: StorageBackupManifestEntry[]
  ): Promise<BackupVerificationResult> {
    const checkedAt = new Date().toISOString();
    let verifiedFilesCount = 0;
    let failedFilesCount = 0;
    const failureDetails: string[] = [];

    for (const entry of entries) {
      if (entry.changeType === 'DELETED') continue;
      const meta = await this.gcs.getObjectMetadata(backupBucket, entry.backupPath);
      if (!meta) {
        entry.verificationStatus = 'FAILED';
        entry.failureReason = 'Copied backup object missing from GCS.';
        failedFilesCount += 1;
        failureDetails.push(`${entry.originalPath}: missing in backup bucket`);
        continue;
      }
      if (meta.isPublic) {
        entry.verificationStatus = 'FAILED';
        entry.failureReason = 'Security error: backup object exposed publicly.';
        failedFilesCount += 1;
        failureDetails.push(`${entry.originalPath}: public access detected`);
        continue;
      }
      const metaChecksum = meta.md5Hash || meta.crc32c || `${meta.generation}:${meta.size}`;
      const sizeMismatch = meta.size !== entry.fileSizeBytes;
      const checksumMismatch =
        Boolean(entry.md5Hash && meta.md5Hash && entry.md5Hash !== meta.md5Hash) ||
        Boolean(entry.crc32c && meta.crc32c && entry.crc32c !== meta.crc32c) ||
        (!entry.md5Hash && !entry.crc32c && metaChecksum !== entry.checksum);

      if (sizeMismatch || checksumMismatch) {
        entry.verificationStatus = 'FAILED';
        entry.failureReason = sizeMismatch
          ? `Size mismatch (expected ${entry.fileSizeBytes}, got ${meta.size})`
          : 'Checksum mismatch after server-side copy';
        failedFilesCount += 1;
        failureDetails.push(`${entry.originalPath}: ${entry.failureReason}`);
        continue;
      }
      entry.verificationStatus = 'VERIFIED';
      verifiedFilesCount += 1;
    }

    return {
      verified: failedFilesCount === 0,
      checkedAt,
      storageVerified: failedFilesCount === 0,
      verifiedFilesCount,
      failedFilesCount,
      ...(failureDetails.length > 0
        ? { failureReason: failureDetails.slice(0, 5).join('; ') }
        : {}),
    };
  }

  async restoreFilesFromManifest(params: {
    manifest: SystemBackupManifest;
    targetBucket: string;
    selectedPaths?: string[];
  }): Promise<StorageRestoreExecutionResult> {
    const cleanTarget = params.targetBucket.replace(/^gs:\/\//i, '').trim();
    const candidates = params.manifest.entries.filter((e) => e.changeType !== 'DELETED');
    const selectedSet =
      params.selectedPaths && params.selectedPaths.length > 0
        ? new Set(params.selectedPaths)
        : null;
    const toRestore = selectedSet
      ? candidates.filter((e) => selectedSet.has(e.originalPath))
      : candidates;

    if (toRestore.length === 0) {
      throw new Error('No matching backup files found in manifest for the selected restore scope.');
    }

    let restoredFilesCount = 0;
    let verifiedFilesCount = 0;
    const failedFiles: string[] = [];

    for (const entry of toRestore) {
      const copied = await this.gcs.copyObject({
        sourceBucket: params.manifest.backupBucket,
        sourceName: entry.backupPath,
        destBucket: cleanTarget,
        destName: entry.originalPath,
        contentType: entry.contentType,
        metadata: {
          restoredFromBackupId: params.manifest.backupId,
          restoredAt: new Date().toISOString(),
        },
      });
      restoredFilesCount += 1;
      const meta = await this.gcs.getObjectMetadata(cleanTarget, entry.originalPath);
      const ok =
        Boolean(meta) &&
        !copied.isPublic &&
        meta!.size === entry.fileSizeBytes &&
        (!entry.md5Hash || !meta!.md5Hash || entry.md5Hash === meta!.md5Hash);
      if (ok) {
        verifiedFilesCount += 1;
      } else {
        failedFiles.push(entry.originalPath);
      }
    }

    return {
      targetBucket: cleanTarget,
      restoredFilesCount,
      verifiedFilesCount,
      failedFiles,
      checkedAt: new Date().toISOString(),
    };
  }
}
