import {
  deleteObject,
  getDownloadURL,
  getMetadata,
  ref,
  uploadBytesResumable,
} from 'firebase/storage';
import { securityRequest } from './securityApi';
import {
  auth,
  extractFriendlyErrorMessage,
  isFirebaseStorageConfigured,
  resolvedFirebaseConfig,
  storage,
  waitForFirebaseAuthReady,
} from './firebase';
import {
  compressCustomerPhoto,
  isSafeRemotePhotoUrl,
  validateCustomerPhotoFile,
} from '../utils/customerValidation';

export interface CustomerPhotoUploadResult {
  photoStoragePath: string;
  photoDownloadURL: string;
  fileSizeBytes: number;
  mimeType: string;
}

function resolveImageExtension(file: File | Blob, fileName?: string): string {
  const mime = (file.type || '').toLowerCase();
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  const ext = (fileName || '').split('.').pop()?.trim().toLowerCase() || '';
  if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
    return ext === 'jpeg' ? 'jpg' : ext;
  }
  return 'jpg';
}

function formatPhotoStorageError(err: unknown, storagePath?: string): string {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: string }).code || '')
      : '';
  const pathNote = storagePath ? ` (${storagePath})` : '';
  switch (code) {
    case 'storage/unauthorized':
      return `[storage/unauthorized] Firebase Storage security rules denied photo upload${pathNote}.`;
    case 'storage/object-not-found':
      return `[storage/object-not-found] Uploaded customer photograph could not be verified in Firebase Storage${pathNote}.`;
    case 'storage/bucket-not-found':
      return `[storage/bucket-not-found] Firebase Storage bucket "${resolvedFirebaseConfig.storageBucket}" was not found. Enable Firebase Storage in Firebase Console.`;
    case 'storage/quota-exceeded':
      return '[storage/quota-exceeded] Firebase Storage quota exceeded.';
    case 'storage/canceled':
      return '[storage/canceled] Customer photo upload was cancelled.';
    case 'storage/retry-limit-exceeded':
      return '[storage/retry-limit-exceeded] Photo upload timed out due to network instability. Please retry.';
    case 'storage/unauthenticated':
      return '[storage/unauthenticated] Active ERP session authentication is required before uploading customer photos.';
    default:
      return extractFriendlyErrorMessage(
        err,
        `Unable to upload customer photograph to Firebase Storage${pathNote}.`
      );
  }
}

async function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error('Unable to read image file for upload.'));
    reader.readAsDataURL(file);
  });
}

export async function uploadCustomerPhotoToStorage(params: {
  customerId: string;
  file: File | Blob;
  fileName?: string;
  onProgress?: (percent: number) => void;
}): Promise<CustomerPhotoUploadResult> {
  const cleanCustomerId = String(params.customerId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleanCustomerId) {
    throw new Error('[invalid-argument] Valid Customer ID is required before uploading customer photograph.');
  }

  const resolvedName =
    params.fileName ||
    (params.file instanceof File ? params.file.name : `profile_${Date.now()}.jpg`);

  // Compress image on client-side using HTML5 Canvas to max width 800px and JPEG quality 0.75
  const uploadFile = await compressCustomerPhoto(params.file, {
    maxWidth: 800,
    quality: 0.75,
    preferredFileName: resolvedName,
  });

  const validationErr = validateCustomerPhotoFile({
    name: uploadFile.name,
    type: uploadFile.type || 'image/jpeg',
    size: uploadFile.size,
  });
  if (validationErr) {
    throw new Error(validationErr);
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('[unavailable] Internet connection is offline. Reconnect before uploading customer photo.');
  }

  const ext = resolveImageExtension(uploadFile, uploadFile.name);
  const mimeType = uploadFile.type || 'image/jpeg';
  const photoStoragePath = `customers/${cleanCustomerId}/profile_${Date.now()}.${ext}`;

  const activeFbUser = auth?.currentUser ?? (await waitForFirebaseAuthReady());
  if (!activeFbUser || !isFirebaseStorageConfigured() || !storage) {
    params.onProgress?.(35);
    const base64 = await fileToBase64(uploadFile);
    const res = await securityRequest<{
      storagePath: string;
      downloadUrl: string;
      fileSizeBytes: number;
      mimeType: string;
    }>('/api/erp/storage/upload', {
      method: 'POST',
      body: JSON.stringify({
        base64,
        folder: `customers/${cleanCustomerId}`,
        fileName: `profile_${Date.now()}.${ext}`,
        storagePath: photoStoragePath,
        contentType: mimeType,
        imageOnly: true,
        customMetadata: {
          customerId: cleanCustomerId,
        },
      }),
    });
    params.onProgress?.(100);
    return {
      photoStoragePath: res.data.storagePath,
      photoDownloadURL: res.data.downloadUrl,
      fileSizeBytes: res.data.fileSizeBytes,
      mimeType: res.data.mimeType,
    };
  }

  const fileRef = ref(storage, photoStoragePath);

  try {
    const task = uploadBytesResumable(fileRef, uploadFile, {
      contentType: mimeType,
      customMetadata: {
        customerId: cleanCustomerId,
        uploadedByUid: activeFbUser.uid,
        uploadedAt: new Date().toISOString(),
      },
    });

    await new Promise<void>((resolve, reject) => {
      task.on(
        'state_changed',
        (snap) => {
          if (snap.totalBytes > 0) {
            const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
            params.onProgress?.(pct);
          }
        },
        (error) => reject(error),
        () => {
          params.onProgress?.(100);
          resolve();
        }
      );
    });

    const [photoDownloadURL, verifiedMeta] = await Promise.all([
      getDownloadURL(fileRef),
      getMetadata(fileRef),
    ]);

    if (!verifiedMeta || verifiedMeta.size <= 0 || verifiedMeta.fullPath !== photoStoragePath) {
      throw new Error(
        `[storage/object-not-found] Uploaded customer photograph could not be verified at ${photoStoragePath}.`
      );
    }

    if (!isSafeRemotePhotoUrl(photoDownloadURL)) {
      throw new Error('[invalid-argument] Uploaded photo returned an invalid HTTPS download URL.');
    }

    return {
      photoStoragePath,
      photoDownloadURL,
      fileSizeBytes: verifiedMeta.size,
      mimeType: verifiedMeta.contentType || mimeType,
    };
  } catch (err) {
    const friendly = formatPhotoStorageError(err, photoStoragePath);
    throw new Error(friendly);
  }
}

export async function deleteCustomerPhotoFromStorage(photoStoragePath?: string | null): Promise<void> {
  if (!photoStoragePath || !storage || !auth?.currentUser) return;
  try {
    await deleteObject(ref(storage, photoStoragePath));
  } catch {
    // Ignore cleanup errors if object does not exist or permission limits delete
  }
}
