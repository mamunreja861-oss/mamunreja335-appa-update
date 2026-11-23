import {
  BackupVerificationResult,
  FirestoreAdminRestAdapter,
  FirestoreManagedOperation,
  GcsBackupStorageAdapter,
} from './backupTypes.js';
import { formatIstParts } from './backupProtection.js';

export function parseGcsUri(uri: string): { bucket: string; prefix: string } {
  const match = /^gs:\/\/([^/]+)\/?(.*)$/i.exec(uri.trim());
  if (!match) {
    throw new Error(`Invalid GCS URI: ${uri}`);
  }
  return {
    bucket: match[1],
    prefix: match[2].replace(/^\/+/, ''),
  };
}

export interface FirestoreExportExecutionResult {
  operationId: string;
  destinationUri: string;
  exportSizeBytes: number;
  exportedObjectsCount: number;
  verification: BackupVerificationResult;
}

export interface FirestoreImportExecutionResult {
  operationId: string;
  sourceUri: string;
  targetProjectId: string;
  targetDatabaseId: string;
  verification: {
    verified: boolean;
    operationDone: boolean;
    checkedAt: string;
    detail: string;
  };
}

export class FirestoreBackupService {
  constructor(
    private readonly firestoreRest: FirestoreAdminRestAdapter,
    private readonly gcs: GcsBackupStorageAdapter,
    private readonly pollIntervalMs: number = 1500
  ) {}

  buildDestinationUri(backupBucket: string, now: Date = new Date(), uniqueSuffix?: string): string {
    const cleanBucket = backupBucket.replace(/^gs:\/\//i, '').trim();
    if (!cleanBucket) {
      throw new Error('BACKUP_GCS_BUCKET is not configured for Firestore export.');
    }
    const ist = formatIstParts(now);
    const folder = uniqueSuffix ? `${ist.timestampFolder}-${uniqueSuffix}` : ist.timestampFolder;
    return `gs://${cleanBucket}/firestore/${ist.year}/${ist.month}/${ist.day}/${folder}/`;
  }

  private async waitForOperationDone(operation: FirestoreManagedOperation): Promise<FirestoreManagedOperation> {
    let current = operation;
    while (!current.done) {
      if (this.pollIntervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }
      current = await this.firestoreRest.getOperationStatus(current.name);
    }
    if (current.error) {
      throw new Error(
        `Firestore managed operation failed (${current.error.code ?? 'UNKNOWN'}): ${current.error.message || 'Unknown error'}`
      );
    }
    return current;
  }

  async runFullManagedExport(params: {
    projectId: string;
    databaseId: string;
    backupBucket: string;
    now?: Date;
    uniqueSuffix?: string;
  }): Promise<FirestoreExportExecutionResult> {
    if (!params.projectId) {
      throw new Error('Firebase project ID is missing; cannot start Firestore managed export.');
    }
    const destinationUri = this.buildDestinationUri(params.backupBucket, params.now, params.uniqueSuffix);

    // Omitting collectionIds exports the ENTIRE Firestore database (all collections + nested subcollections, document IDs, native Firestore types)
    const initialOp = await this.firestoreRest.exportDocuments({
      projectId: params.projectId,
      databaseId: params.databaseId || '(default)',
      outputUriPrefix: destinationUri.replace(/\/+$/, ''),
    });

    const completedOp = await this.waitForOperationDone(initialOp);
    const verification = await this.verifyExportArtifacts(destinationUri, completedOp.name);
    if (!verification.verified) {
      throw new Error(verification.failureReason || 'Firestore export verification failed.');
    }

    const { bucket, prefix } = parseGcsUri(destinationUri);
    const objs = await this.gcs.listObjects(bucket, prefix);
    const exportSizeBytes = objs.reduce((sum, obj) => sum + Number(obj.size || 0), 0);

    return {
      operationId: completedOp.name,
      destinationUri,
      exportSizeBytes,
      exportedObjectsCount: objs.length,
      verification,
    };
  }

  async verifyExportArtifacts(destinationUri: string, operationId?: string): Promise<BackupVerificationResult> {
    const checkedAt = new Date().toISOString();
    try {
      let operationDone = true;
      if (operationId) {
        const opStatus = await this.firestoreRest.getOperationStatus(operationId);
        operationDone = Boolean(opStatus.done) && !opStatus.error;
        if (!operationDone) {
          return {
            verified: false,
            checkedAt,
            firestoreVerified: false,
            firestoreOperationDone: false,
            firestoreMetadataPresent: false,
            failureReason: opStatus.error?.message || `Firestore export operation ${operationId} is incomplete.`,
          };
        }
      }

      const { bucket, prefix } = parseGcsUri(destinationUri);
      const objects = await this.gcs.listObjects(bucket, prefix);
      const hasMetadata = objects.some((o) =>
        o.name.endsWith('overall_export_metadata') || o.name.includes('.overall_export_metadata')
      );
      if (objects.length === 0 || !hasMetadata) {
        return {
          verified: false,
          checkedAt,
          firestoreVerified: false,
          firestoreOperationDone: operationDone,
          firestoreMetadataPresent: false,
          failureReason: `Export metadata file (overall_export_metadata) not found in ${destinationUri}.`,
        };
      }

      return {
        verified: true,
        checkedAt,
        firestoreVerified: true,
        firestoreOperationDone: operationDone,
        firestoreMetadataPresent: true,
      };
    } catch (err) {
      return {
        verified: false,
        checkedAt,
        firestoreVerified: false,
        firestoreOperationDone: false,
        firestoreMetadataPresent: false,
        failureReason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async validateBackupForRestore(destinationUri: string): Promise<{
    valid: boolean;
    objectCount: number;
    totalBytes: number;
    detail: string;
  }> {
    const { bucket, prefix } = parseGcsUri(destinationUri);
    const objects = await this.gcs.listObjects(bucket, prefix);
    const hasMeta = objects.some((o) =>
      o.name.endsWith('overall_export_metadata') || o.name.includes('.overall_export_metadata')
    );
    const totalBytes = objects.reduce((sum, o) => sum + Number(o.size || 0), 0);
    if (!hasMeta) {
      return {
        valid: false,
        objectCount: objects.length,
        totalBytes,
        detail: `Firestore export metadata missing at ${destinationUri}`,
      };
    }
    return {
      valid: true,
      objectCount: objects.length,
      totalBytes,
      detail: `Verified native Firestore export (${objects.length} files, ${totalBytes} bytes).`,
    };
  }

  async runManagedImport(params: {
    targetProjectId: string;
    targetDatabaseId: string;
    inputUriPrefix: string;
    collectionIds?: string[];
  }): Promise<FirestoreImportExecutionResult> {
    const validation = await this.validateBackupForRestore(params.inputUriPrefix);
    if (!validation.valid) {
      throw new Error(validation.detail);
    }

    const initialOp = await this.firestoreRest.importDocuments({
      projectId: params.targetProjectId,
      databaseId: params.targetDatabaseId || '(default)',
      inputUriPrefix: params.inputUriPrefix.replace(/\/+$/, ''),
      ...(params.collectionIds && params.collectionIds.length > 0
        ? { collectionIds: params.collectionIds }
        : {}),
    });
    const completedOp = await this.waitForOperationDone(initialOp);
    const verifiedStatus = await this.firestoreRest.getOperationStatus(completedOp.name);
    const ok = Boolean(verifiedStatus.done) && !verifiedStatus.error;
    return {
      operationId: completedOp.name,
      sourceUri: params.inputUriPrefix,
      targetProjectId: params.targetProjectId,
      targetDatabaseId: params.targetDatabaseId || '(default)',
      verification: {
        verified: ok,
        operationDone: Boolean(verifiedStatus.done),
        checkedAt: new Date().toISOString(),
        detail: ok
          ? `Firestore managed import operation ${completedOp.name} verified complete.`
          : verifiedStatus.error?.message || 'Firestore import verification failed.',
      },
    };
  }
}
