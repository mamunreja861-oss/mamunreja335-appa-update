import { getDownloadURL, getMetadata, ref, uploadBytes, uploadString } from 'firebase/storage';
import {
  markCloudSyncActivity,
  recordCloudSyncError,
  recordCloudSyncSuccess,
} from './cloudSync';
import { securityRequest } from './securityApi';
import {
  auth,
  extractFriendlyErrorMessage,
  isFirebaseStorageConfigured,
  isRetryableFirestoreError,
  storage,
  waitForFirebaseAuthReady,
} from './firebase';

export interface UploadedCloudAttachment {
  storagePath: string;
  downloadUrl: string;
  fileSizeBytes: number;
  mimeType: string;
}

const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function sanitizeSegment(raw: string, fallback = 'item'): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

function formatStorageError(err: unknown): string {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: string }).code || '')
      : '';
  switch (code) {
    case 'storage/unauthorized':
      return '[storage/unauthorized] Cloud Storage permission denied. Ensure your Firebase account is signed in and Storage rules allow uploads.';
    case 'storage/quota-exceeded':
      return '[storage/quota-exceeded] Cloud Storage quota exceeded.';
    case 'storage/canceled':
      return '[storage/canceled] File upload was cancelled.';
    case 'storage/retry-limit-exceeded':
      return '[storage/retry-limit-exceeded] Upload timed out due to network instability. Please try again.';
    case 'storage/object-not-found':
      return '[storage/object-not-found] Uploaded file could not be verified in Firebase Storage.';
    case 'storage/unauthenticated':
      return '[storage/unauthenticated] Please authenticate your Cloud DB session before uploading files.';
    default:
      return extractFriendlyErrorMessage(err, 'Failed to upload file attachment to Firebase Storage.');
  }
}

function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const val = typeof reader.result === 'string' ? reader.result : '';
      const idx = val.indexOf(',');
      resolve(idx >= 0 ? val.slice(idx + 1) : val);
    };
    reader.onerror = () => reject(new Error('Failed to read selected file for upload.'));
    reader.readAsDataURL(blob);
  });
}

export async function uploadAttachmentToFirebaseStorage(params: {
  file?: File | null;
  base64?: string;
  folder: string;
  fileName: string;
  contentType?: string;
  imageOnly?: boolean;
}): Promise<UploadedCloudAttachment> {
  const maxBytes = params.imageOnly ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
  const allowedMimes = params.imageOnly ? ALLOWED_IMAGE_MIME_TYPES : ALLOWED_DOCUMENT_MIME_TYPES;

  let resolvedMime = (params.contentType || params.file?.type || 'application/pdf').toLowerCase();
  let cleanBase64 = '';
  let resolvedSize = params.file?.size || 0;

  if (!params.file && params.base64) {
    const dataUrlMatch = /^data:([^;]+);base64,(.*)$/s.exec(params.base64.trim());
    cleanBase64 = dataUrlMatch ? dataUrlMatch[2] : params.base64.trim();
    if (dataUrlMatch?.[1]) {
      resolvedMime = dataUrlMatch[1].toLowerCase();
    }
    resolvedSize = Math.round((cleanBase64.length * 3) / 4);
  }

  if (!params.file && !cleanBase64) {
    throw new Error('[invalid-argument] Select a valid file attachment to upload.');
  }

  if (resolvedSize <= 0 || resolvedSize > maxBytes) {
    throw new Error(
      `[invalid-argument] File size (${Math.round(resolvedSize / 1024)} KB) exceeds the ${
        params.imageOnly ? '5 MB image' : '10 MB document'
      } limit.`
    );
  }

  if (!allowedMimes.has(resolvedMime)) {
    throw new Error(
      `[invalid-argument] Unsupported file type (${resolvedMime}). Allowed formats: ${
        params.imageOnly ? 'JPEG, PNG, WEBP' : 'PDF, JPEG, PNG, WEBP, CSV, XLSX'
      }.`
    );
  }

  const safeFolder = params.folder
    .split('/')
    .filter(Boolean)
    .map((seg) => sanitizeSegment(seg))
    .join('/');
  const safeName = sanitizeSegment(params.fileName, 'document');
  const storagePath = `${safeFolder || 'documents'}/${Date.now()}_${safeName}`;

  const authUser = auth?.currentUser ?? (await waitForFirebaseAuthReady());
  if (!authUser || !isFirebaseStorageConfigured() || !storage) {
    markCloudSyncActivity(true);
    try {
      const payloadBase64 = cleanBase64 || (params.file ? await readBlobAsBase64(params.file) : '');
      const res = await securityRequest<UploadedCloudAttachment>('/api/erp/storage/upload', {
        method: 'POST',
        body: JSON.stringify({
          base64: payloadBase64,
          folder: safeFolder || 'documents',
          fileName: safeName,
          storagePath,
          contentType: resolvedMime,
          imageOnly: Boolean(params.imageOnly),
        }),
      });
      recordCloudSyncSuccess();
      return res.data;
    } catch (err) {
      const friendly = formatStorageError(err);
      recordCloudSyncError(friendly);
      throw new Error(friendly);
    } finally {
      markCloudSyncActivity(false);
    }
  }

  const fileRef = ref(storage, storagePath);

  markCloudSyncActivity(true);
  try {
    let lastErr: unknown;
    let verifiedSize = resolvedSize;
    let verifiedMime = resolvedMime;
    let downloadUrl = '';

    for (let attempt = 0; attempt <= 2; attempt += 1) {
      try {
        if (params.file) {
          const snap = await uploadBytes(fileRef, params.file, {
            contentType: resolvedMime,
            customMetadata: {
              uploadedByUid: authUser.uid,
              originalName: safeName,
            },
          });
          verifiedSize = snap.metadata.size || params.file.size;
          verifiedMime = snap.metadata.contentType || resolvedMime;
        } else {
          const snap = await uploadString(fileRef, cleanBase64, 'base64', {
            contentType: resolvedMime,
            customMetadata: {
              uploadedByUid: authUser.uid,
              originalName: safeName,
            },
          });
          verifiedSize = snap.metadata.size || resolvedSize;
          verifiedMime = snap.metadata.contentType || resolvedMime;
        }

        const verifiedMeta = await getMetadata(fileRef);
        verifiedSize = Number(verifiedMeta.size || verifiedSize);
        if (verifiedSize <= 0) {
          throw new Error('[storage/object-not-found] Uploaded storage object is empty.');
        }

        downloadUrl = await getDownloadURL(fileRef);
        if (!/^https:\/\//i.test(downloadUrl)) {
          throw new Error('[invalid-argument] Firebase Storage returned a non-HTTPS download URL.');
        }
        break;
      } catch (err) {
        lastErr = err;
        if (attempt >= 2 || !isRetryableFirestoreError(err)) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 300 * Math.pow(2, attempt)));
      }
    }

    if (!downloadUrl) {
      throw lastErr || new Error('Upload verification failed.');
    }

    recordCloudSyncSuccess();
    return {
      storagePath,
      downloadUrl,
      fileSizeBytes: verifiedSize,
      mimeType: verifiedMime,
    };
  } catch (err) {
    const friendly = formatStorageError(err);
    recordCloudSyncError(friendly);
    throw new Error(friendly);
  } finally {
    markCloudSyncActivity(false);
  }
}

export async function uploadImageAssetToFirebaseStorage(params: {
  file: File;
  folder: string;
  assetKey: string;
}): Promise<UploadedCloudAttachment> {
  return uploadAttachmentToFirebaseStorage({
    file: params.file,
    folder: params.folder,
    fileName: `${sanitizeSegment(params.assetKey)}_${params.file.name}`,
    contentType: params.file.type || 'image/png',
    imageOnly: true,
  });
}

export async function resolveStorageDownloadUrl(
  storagePath?: string | null,
  fallbackUrl?: string | null
): Promise<string | null> {
  if (fallbackUrl && /^(https?:\/\/|\/api\/erp\/storage\/files\/)/i.test(fallbackUrl)) {
    return fallbackUrl;
  }
  if (storage && storagePath) {
    try {
      return await getDownloadURL(ref(storage, storagePath));
    } catch {
      return fallbackUrl || null;
    }
  }
  return fallbackUrl || null;
}

export async function downloadCloudAttachment(params: {
  storageUrl?: string | null;
  storagePath?: string | null;
  fileName: string;
  fallbackBase64?: string | null;
  fallbackMimeType?: string;
}): Promise<boolean> {
  const url = await resolveStorageDownloadUrl(params.storagePath, params.storageUrl);
  if (url) {
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const blob = await resp.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = params.fileName || 'document';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
        return true;
      }
    } catch {
      // Fallback to direct anchor download when CORS restricts fetch
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = params.fileName || 'document';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  }

  if (params.fallbackBase64) {
    const raw = params.fallbackBase64.includes(',')
      ? params.fallbackBase64.split(',')[1]
      : params.fallbackBase64;
    const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: params.fallbackMimeType || 'application/pdf' });
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = params.fileName || 'document';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
    return true;
  }

  return false;
}
