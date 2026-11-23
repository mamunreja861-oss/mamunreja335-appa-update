import {
  getFirebaseAdminStorage,
  getGoogleCloudAccessToken,
} from '../firebaseAdminDb.js';
import {
  FirestoreAdminRestAdapter,
  FirestoreManagedOperation,
  GcsBackupStorageAdapter,
  GcsObjectInfo,
} from './backupTypes.js';

export class GoogleFirestoreManagedRestAdapter implements FirestoreAdminRestAdapter {
  private buildDatabasePath(projectId: string, databaseId: string): string {
    const cleanProject = encodeURIComponent(projectId.trim());
    const cleanDb = encodeURIComponent((databaseId || '(default)').trim());
    return `projects/${cleanProject}/databases/${cleanDb}`;
  }

  async exportDocuments(params: {
    projectId: string;
    databaseId: string;
    outputUriPrefix: string;
    collectionIds?: string[];
  }): Promise<FirestoreManagedOperation> {
    const token = await getGoogleCloudAccessToken([
      'https://www.googleapis.com/auth/datastore',
      'https://www.googleapis.com/auth/cloud-platform',
    ]);
    const dbPath = this.buildDatabasePath(params.projectId, params.databaseId);
    const url = `https://firestore.googleapis.com/v1/${dbPath}:exportDocuments`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        outputUriPrefix: params.outputUriPrefix.replace(/\/+$/, ''),
        ...(params.collectionIds && params.collectionIds.length > 0
          ? { collectionIds: params.collectionIds }
          : {}),
      }),
    });

    const data = (await resp.json()) as FirestoreManagedOperation & {
      error?: { code?: number; message?: string };
    };
    if (!resp.ok) {
      throw new Error(
        `Firestore Managed Export API failed (${resp.status}): ${data?.error?.message || resp.statusText}`
      );
    }
    return data;
  }

  async importDocuments(params: {
    projectId: string;
    databaseId: string;
    inputUriPrefix: string;
    collectionIds?: string[];
  }): Promise<FirestoreManagedOperation> {
    const token = await getGoogleCloudAccessToken([
      'https://www.googleapis.com/auth/datastore',
      'https://www.googleapis.com/auth/cloud-platform',
    ]);
    const dbPath = this.buildDatabasePath(params.projectId, params.databaseId);
    const url = `https://firestore.googleapis.com/v1/${dbPath}:importDocuments`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputUriPrefix: params.inputUriPrefix.replace(/\/+$/, ''),
        ...(params.collectionIds && params.collectionIds.length > 0
          ? { collectionIds: params.collectionIds }
          : {}),
      }),
    });

    const data = (await resp.json()) as FirestoreManagedOperation & {
      error?: { code?: number; message?: string };
    };
    if (!resp.ok) {
      throw new Error(
        `Firestore Managed Import API failed (${resp.status}): ${data?.error?.message || resp.statusText}`
      );
    }
    return data;
  }

  async getOperationStatus(operationName: string): Promise<FirestoreManagedOperation> {
    const token = await getGoogleCloudAccessToken([
      'https://www.googleapis.com/auth/datastore',
      'https://www.googleapis.com/auth/cloud-platform',
    ]);
    const cleanName = operationName.replace(/^\/+/, '');
    const url = `https://firestore.googleapis.com/v1/${cleanName}`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const data = (await resp.json()) as FirestoreManagedOperation & {
      error?: { code?: number; message?: string };
    };
    if (!resp.ok) {
      throw new Error(
        `Firestore operation status query failed (${resp.status}): ${data?.error?.message || resp.statusText}`
      );
    }
    return data;
  }
}

export class FirebaseAdminGcsBackupAdapter implements GcsBackupStorageAdapter {
  private getBucket(bucketName: string) {
    const storage = getFirebaseAdminStorage();
    if (!storage) {
      throw new Error('Firebase Admin Storage is not initialized.');
    }
    const clean = bucketName.replace(/^gs:\/\//i, '').trim();
    if (!clean) {
      throw new Error('Target GCS bucket name is required.');
    }
    return storage.bucket(clean);
  }

  private mapMetadata(bucketName: string, fileName: string, meta: Record<string, unknown>): GcsObjectInfo {
    const rawCustom =
      meta.metadata && typeof meta.metadata === 'object'
        ? (meta.metadata as Record<string, unknown>)
        : {};
    const customMeta: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawCustom)) {
      if (v !== undefined && v !== null) {
        customMeta[k] = String(v);
      }
    }
    return {
      name: fileName,
      bucket: bucketName,
      generation: String(meta.generation || ''),
      size: Number(meta.size || 0),
      contentType: String(meta.contentType || 'application/octet-stream'),
      md5Hash: String(meta.md5Hash || ''),
      crc32c: String(meta.crc32c || ''),
      updated: typeof meta.updated === 'string' ? meta.updated : undefined,
      metadata: customMeta,
      isPublic: false,
    };
  }

  async listObjects(bucketName: string, prefix?: string): Promise<GcsObjectInfo[]> {
    const bucket = this.getBucket(bucketName);
    const [files] = await bucket.getFiles({
      ...(prefix ? { prefix } : {}),
      autoPaginate: true,
    });
    const out: GcsObjectInfo[] = [];
    for (const file of files) {
      const meta = (file.metadata || {}) as Record<string, unknown>;
      out.push(this.mapMetadata(bucket.name, file.name, meta));
    }
    return out;
  }

  async copyObject(params: {
    sourceBucket: string;
    sourceName: string;
    destBucket: string;
    destName: string;
    contentType?: string;
    metadata?: Record<string, string>;
  }): Promise<GcsObjectInfo> {
    const srcBucket = this.getBucket(params.sourceBucket);
    const dstBucket = this.getBucket(params.destBucket);
    const srcFile = srcBucket.file(params.sourceName);
    const dstFile = dstBucket.file(params.destName);

    await srcFile.copy(dstFile);
    if (params.contentType || params.metadata) {
      await dstFile.setMetadata({
        ...(params.contentType ? { contentType: params.contentType } : {}),
        ...(params.metadata ? { metadata: params.metadata } : {}),
      });
    }
    // Explicitly enforce non-public object access by never granting public ACLs
    const [meta] = await dstFile.getMetadata();
    return this.mapMetadata(dstBucket.name, dstFile.name, meta as Record<string, unknown>);
  }

  async getObjectMetadata(bucketName: string, name: string): Promise<GcsObjectInfo | null> {
    const bucket = this.getBucket(bucketName);
    const file = bucket.file(name);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [meta] = await file.getMetadata();
    return this.mapMetadata(bucket.name, file.name, meta as Record<string, unknown>);
  }

  async writeJsonObject(bucketName: string, name: string, payload: unknown): Promise<void> {
    const bucket = this.getBucket(bucketName);
    const file = bucket.file(name);
    await file.save(JSON.stringify(payload, null, 2), {
      contentType: 'application/json',
      resumable: false,
      private: true,
    });
  }

  async readJsonObject<T = unknown>(bucketName: string, name: string): Promise<T | null> {
    const bucket = this.getBucket(bucketName);
    const file = bucket.file(name);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buf] = await file.download();
    return JSON.parse(buf.toString('utf8')) as T;
  }

  async deletePrefix(bucketName: string, prefix: string): Promise<number> {
    const bucket = this.getBucket(bucketName);
    const [files] = await bucket.getFiles({ prefix });
    if (files.length === 0) return 0;
    await bucket.deleteFiles({ prefix, force: true });
    return files.length;
  }
}
