export const MAX_CUSTOMER_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB

export const ALLOWED_CUSTOMER_PHOTO_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

export const ALLOWED_CUSTOMER_PHOTO_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);

export interface SanitizedInputResult {
  value: string;
  wasTrimmed: boolean;
  notice?: string;
}

export function sanitizeMobileInput(raw: string): SanitizedInputResult {
  const trimmed = String(raw ?? '').trim();
  const withoutPlus91 = /^\+91[\s-]*(.*)$/.exec(trimmed);
  const candidate = withoutPlus91 ? withoutPlus91[1] : trimmed;
  const digitsOnly = candidate.replace(/\D/g, '');
  const capped = digitsOnly.slice(0, 10);

  if (digitsOnly.length > 10) {
    return {
      value: capped,
      wasTrimmed: true,
      notice: 'Extra digits trimmed — Mobile Number accepts maximum 10 digits.',
    };
  }
  if (/[^0-9]/.test(candidate)) {
    return {
      value: capped,
      wasTrimmed: true,
      notice: 'Only digits 0–9 are allowed in Mobile Number.',
    };
  }
  return { value: capped, wasTrimmed: false };
}

export function sanitizeAadhaarInput(raw: string): SanitizedInputResult {
  const input = String(raw ?? '');
  const digitsOnly = input.replace(/\D/g, '');
  const capped = digitsOnly.slice(0, 12);

  if (digitsOnly.length > 12) {
    return {
      value: capped,
      wasTrimmed: true,
      notice: 'Extra digits trimmed — Aadhaar Number accepts maximum 12 digits.',
    };
  }
  if (/[^0-9]/.test(input)) {
    return {
      value: capped,
      wasTrimmed: true,
      notice: 'Only digits 0–9 are allowed in Aadhaar Number.',
    };
  }
  return { value: capped, wasTrimmed: false };
}

export function sanitizePinCodeInput(raw: string): SanitizedInputResult {
  const input = String(raw ?? '');
  const digitsOnly = input.replace(/\D/g, '');
  const capped = digitsOnly.slice(0, 6);

  if (digitsOnly.length > 6) {
    return {
      value: capped,
      wasTrimmed: true,
      notice: 'Extra digits trimmed — PIN Code accepts maximum 6 digits.',
    };
  }
  if (/[^0-9]/.test(input)) {
    return {
      value: capped,
      wasTrimmed: true,
      notice: 'Only digits 0–9 are allowed in PIN Code.',
    };
  }
  return { value: capped, wasTrimmed: false };
}

export function sanitizePanInput(raw: string): SanitizedInputResult {
  const upper = String(raw ?? '').toUpperCase().replace(/[\s-]/g, '');
  let out = '';
  let rejected = false;

  for (let i = 0; i < upper.length; i += 1) {
    if (out.length >= 10) {
      rejected = true;
      break;
    }
    const ch = upper[i];
    const pos = out.length;
    if (pos < 5) {
      if (/[A-Z]/.test(ch)) {
        out += ch;
      } else {
        rejected = true;
      }
    } else if (pos < 9) {
      if (/[0-9]/.test(ch)) {
        out += ch;
      } else {
        rejected = true;
      }
    } else {
      if (/[A-Z]/.test(ch)) {
        out += ch;
      } else {
        rejected = true;
      }
    }
  }

  if (rejected) {
    return {
      value: out,
      wasTrimmed: true,
      notice: 'PAN format is AAAAA9999A (5 letters, 4 digits, 1 letter).',
    };
  }
  return { value: out, wasTrimmed: false };
}

export function validateFullName(val: string): string | null {
  const clean = String(val ?? '').trim();
  if (clean.length < 2) {
    return 'Full name must be at least 2 characters.';
  }
  return null;
}

export function validateVillage(val: string): string | null {
  const clean = String(val ?? '').trim();
  if (clean.length < 2) {
    return 'Village / Locality is required (at least 2 characters).';
  }
  return null;
}

export function validateMobileNumber(val: string, required = true): string | null {
  const clean = String(val ?? '').trim();
  if (!clean) {
    return required ? '10-digit mobile number is required.' : null;
  }
  if (!/^[0-9]{10}$/.test(clean)) {
    return `Mobile number must be exactly 10 digits (${clean.length}/10).`;
  }
  return null;
}

export function validateAadhaarNumber(val: string, required = false): string | null {
  const clean = String(val ?? '').trim();
  if (!clean) {
    return required ? '12-digit Aadhaar number is required.' : null;
  }
  if (!/^[0-9]{12}$/.test(clean)) {
    return `Aadhaar number must be exactly 12 digits (${clean.length}/12).`;
  }
  return null;
}

export function validatePinCode(val: string, required = false): string | null {
  const clean = String(val ?? '').trim();
  if (!clean) {
    return required ? '6-digit PIN Code is required.' : null;
  }
  if (!/^[0-9]{6}$/.test(clean)) {
    return `PIN Code must be exactly 6 digits (${clean.length}/6).`;
  }
  return null;
}

export function validatePanNumber(val: string, required = false): string | null {
  const clean = String(val ?? '').trim().toUpperCase();
  if (!clean) {
    return required ? 'PAN number is required.' : null;
  }
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(clean)) {
    return 'PAN must follow standard format AAAAA9999A (e.g., ABCDE1234F).';
  }
  return null;
}

export function validateCustomerPhotoFile(file: {
  name?: string;
  type?: string;
  size: number;
}): string | null {
  if (!file || typeof file.size !== 'number' || file.size <= 0) {
    return 'Selected photograph file is empty or unreadable.';
  }
  if (file.size > MAX_CUSTOMER_PHOTO_BYTES) {
    const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
    return `Photograph size (${sizeMb} MB) exceeds the 5 MB maximum limit.`;
  }

  const mime = String(file.type ?? '').trim().toLowerCase();
  const ext = String(file.name ?? '').split('.').pop()?.trim().toLowerCase() || '';

  const mimeOk = mime ? ALLOWED_CUSTOMER_PHOTO_MIMES.has(mime) : false;
  const extOk = ext ? ALLOWED_CUSTOMER_PHOTO_EXTS.has(ext) : false;

  if (mime && !mimeOk) {
    return 'Unsupported image format. Please use JPG, JPEG, PNG, or WEBP.';
  }
  if (!mime && !extOk) {
    return 'Unsupported image format. Please use JPG, JPEG, PNG, or WEBP.';
  }
  if (ext && !ALLOWED_CUSTOMER_PHOTO_EXTS.has(ext) && !mimeOk) {
    return 'Unsupported image format. Please use JPG, JPEG, PNG, or WEBP.';
  }

  return null;
}

export function isSafeRemotePhotoUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (/^(blob:|javascript:|data:|vbscript:)/i.test(trimmed)) return false;
  return /^(https:\/\/|\/api\/erp\/storage\/files\/)[^\s]+$/i.test(trimmed);
}

export function maskAadhaarValue(aadhaar: unknown): string {
  const raw = String(aadhaar ?? '').trim();
  if (!raw) return '';
  if (/^XXXX-XXXX-\d{4}$/i.test(raw)) return raw.toUpperCase();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 4) return '';
  return `XXXX-XXXX-${digits.slice(-4)}`;
}

export interface CompressPhotoOptions {
  maxWidth?: number;
  quality?: number;
  preferredFileName?: string;
}

export async function compressCustomerPhoto(
  input: File | Blob,
  options: CompressPhotoOptions = {}
): Promise<File> {
  const maxWidth = options.maxWidth ?? 800;
  const quality = options.quality ?? 0.75;
  const rawName =
    options.preferredFileName ||
    (input instanceof File ? input.name : `customer_photo_${Date.now()}.jpg`);
  const safeName = rawName.replace(/\.[^.]+$/, '') + '.jpg';

  // Fallback for non-browser environments (e.g. Node.js unit tests)
  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    typeof Image === 'undefined'
  ) {
    if (input instanceof File) return input;
    return new File([input], safeName, { type: 'image/jpeg' });
  }

  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(input);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      try {
        const origWidth = img.naturalWidth || img.width;
        const origHeight = img.naturalHeight || img.height;

        let targetWidth = origWidth;
        let targetHeight = origHeight;

        if (targetWidth > maxWidth) {
          const ratio = maxWidth / targetWidth;
          targetWidth = maxWidth;
          targetHeight = Math.max(1, Math.round(origHeight * ratio));
        }

        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error('Canvas 2D context is unavailable for photo compression.');
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error('Failed to compress photograph on canvas.'));
              return;
            }
            const compressedFile = new File([blob], safeName, {
              type: 'image/jpeg',
              lastModified: Date.now(),
            });
            resolve(compressedFile);
          },
          'image/jpeg',
          quality
        );
      } catch (err) {
        reject(err);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Unable to decode photograph image data for compression.'));
    };

    img.src = objectUrl;
  });
}

