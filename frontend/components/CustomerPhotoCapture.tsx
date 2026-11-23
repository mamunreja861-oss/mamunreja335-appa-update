import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  User,
  X,
} from 'lucide-react';
import { Button } from './Button';
import {
  compressCustomerPhoto,
  validateCustomerPhotoFile,
} from '../utils/customerValidation';

export interface SelectedCustomerPhoto {
  file: File;
  previewUrl: string;
  source: 'camera' | 'upload';
  fileName: string;
  fileSizeBytes: number;
  originalSizeBytes?: number;
  compressed?: boolean;
}

interface CustomerPhotoCaptureProps {
  value: SelectedCustomerPhoto | null;
  onChange: (next: SelectedCustomerPhoto | null) => void;
  disabled?: boolean;
  isModalOpen?: boolean;
  uploadProgress?: number | null;
  uploadStatus?: string | null;
  uploadStalled?: boolean;
  onSaveInBackground?: () => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const CustomerPhotoCapture: React.FC<CustomerPhotoCaptureProps> = ({
  value,
  onChange,
  disabled = false,
  isModalOpen = true,
  uploadProgress = null,
  uploadStatus = null,
  uploadStalled = false,
  onSaveInBackground,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastPreviewUrlRef = useRef<string | null>(null);

  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [compressing, setCompressing] = useState(false);


  const stopCameraStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Ignore track stop errors
        }
      });
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraOpen(false);
    setCameraStarting(false);
  }, []);

  // Always stop camera when modal closes or component unmounts
  useEffect(() => {
    if (!isModalOpen) {
      stopCameraStream();
    }
  }, [isModalOpen, stopCameraStream]);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
            // Ignore cleanup errors
          }
        });
        streamRef.current = null;
      }
      if (lastPreviewUrlRef.current && lastPreviewUrlRef.current.startsWith('blob:')) {
        URL.revokeObjectURL(lastPreviewUrlRef.current);
        lastPreviewUrlRef.current = null;
      }
    };
  }, []);

  // Track temporary blob URLs for preview cleanup when photo changes or clears
  useEffect(() => {
    const prev = lastPreviewUrlRef.current;
    const next = value?.previewUrl ?? null;
    if (prev && prev !== next && prev.startsWith('blob:')) {
      URL.revokeObjectURL(prev);
    }
    lastPreviewUrlRef.current = next;
  }, [value?.previewUrl]);

  // Attach active MediaStream to <video> whenever camera view mounts
  useEffect(() => {
    if (cameraOpen && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      void videoRef.current.play().catch(() => {});
    }
  }, [cameraOpen]);

  const startCamera = async (preferredFacing: 'user' | 'environment' = facingMode) => {
    setPhotoError(null);
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setPhotoError(
        'Camera capture is unavailable in this browser or requires a secure HTTPS connection. You can upload a photograph instead.'
      );
      return;
    }

    stopCameraStream();
    setCameraStarting(true);

    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: preferredFacing },
            width: { ideal: 1280 },
            height: { ideal: 960 },
          },
          audio: false,
        });
      } catch (constraintErr) {
        const name = constraintErr instanceof Error ? constraintErr.name : '';
        if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        } else {
          throw constraintErr;
        }
      }

      streamRef.current = stream;
      setFacingMode(preferredFacing);
      setCameraOpen(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setPhotoError(
          'Camera permission was denied. Allow camera access in your browser settings or upload a photo file instead.'
        );
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setPhotoError('No camera device found on this system. Please upload a photograph.');
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        setPhotoError('Camera is currently in use by another application.');
      } else {
        setPhotoError(
          err instanceof Error ? err.message : 'Unable to start device camera. Please upload a photo instead.'
        );
      }
      stopCameraStream();
    } finally {
      setCameraStarting(false);
    }
  };

  const handleCaptureFrame = () => {
    setPhotoError(null);
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const width = video.videoWidth || 640;
    const height = video.videoHeight || 480;
    if (width <= 0 || height <= 0) {
      setPhotoError('Camera feed is still initializing. Wait a second and try capturing again.');
      return;
    }

    const maxWidth = 800;
    const targetWidth = width > maxWidth ? maxWidth : width;
    const targetHeight = width > maxWidth ? Math.max(1, Math.round((height * maxWidth) / width)) : height;

    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setPhotoError('Unable to process camera image frame.');
      return;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(video, 0, 0, targetWidth, targetHeight);

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setPhotoError('Failed to capture image from camera.');
          return;
        }
        const fileName = `camera_capture_${Date.now()}.jpg`;
        const capturedFile = new File([blob], fileName, { type: 'image/jpeg' });
        const validationErr = validateCustomerPhotoFile(capturedFile);
        if (validationErr) {
          setPhotoError(validationErr);
          return;
        }
        const previewUrl = URL.createObjectURL(capturedFile);
        onChange({
          file: capturedFile,
          previewUrl,
          source: 'camera',
          fileName,
          fileSizeBytes: capturedFile.size,
          compressed: true,
        });
        stopCameraStream();
      },
      'image/jpeg',
      0.75
    );
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setPhotoError(null);
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const validationErr = validateCustomerPhotoFile(file);
    if (validationErr) {
      setPhotoError(validationErr);
      return;
    }

    stopCameraStream();
    setCompressing(true);
    try {
      const compressedFile = await compressCustomerPhoto(file, { maxWidth: 800, quality: 0.75 });
      const previewUrl = URL.createObjectURL(compressedFile);
      onChange({
        file: compressedFile,
        previewUrl,
        source: 'upload',
        fileName: compressedFile.name,
        fileSizeBytes: compressedFile.size,
        originalSizeBytes: file.size,
        compressed: true,
      });
    } catch {
      const previewUrl = URL.createObjectURL(file);
      onChange({
        file,
        previewUrl,
        source: 'upload',
        fileName: file.name,
        fileSizeBytes: file.size,
      });
    } finally {
      setCompressing(false);
    }
  };

  const handleRemovePhoto = () => {
    setPhotoError(null);
    stopCameraStream();
    onChange(null);
  };


  return (
    <div className="border border-neutral-200 dark:border-neutral-800 rounded-lg p-3.5 bg-neutral-50/70 dark:bg-neutral-950/60 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-neutral-900 dark:text-white flex items-center gap-1.5">
            <Camera className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
            Customer Photograph (Camera or Upload)
          </div>
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-0.5">
            Supports JPG, JPEG, PNG, WEBP up to 5 MB. Saved permanently to Firebase Storage.
          </p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
          onChange={handleFileSelected}
          className="hidden"
          aria-label="Upload customer photograph"
          disabled={disabled}
        />
        <canvas ref={canvasRef} className="hidden" />
      </div>

      {photoError && (
        <div
          role="alert"
          className="px-3 py-2 text-xs rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300"
        >
          {photoError}
        </div>
      )}

      {cameraOpen ? (
        <div className="space-y-3">
          <div className="relative rounded-lg overflow-hidden bg-black border border-neutral-300 dark:border-neutral-700 max-h-64 flex items-center justify-center">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full max-h-64 object-contain"
            />
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="w-36 h-44 border-2 border-dashed border-white/60 rounded-lg" />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="primary"
                onClick={handleCaptureFrame}
                disabled={disabled}
                icon={<Camera className="h-3.5 w-3.5" />}
              >
                Capture
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => startCamera(facingMode === 'user' ? 'environment' : 'user')}
                disabled={disabled || cameraStarting}
                icon={<RefreshCw className="h-3.5 w-3.5" />}
              >
                Switch Camera
              </Button>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={stopCameraStream}
              icon={<X className="h-3.5 w-3.5" />}
            >
              Cancel Camera
            </Button>
          </div>
        </div>
      ) : value ? (
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <div className="w-24 h-28 rounded-md overflow-hidden border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 shrink-0">
            <img
              src={value.previewUrl}
              alt="Selected customer photograph preview"
              className="w-full h-full object-cover"
            />
          </div>

          <div className="flex-1 min-w-0 space-y-2 text-xs">
            <div className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              <span>
                {value.source === 'camera'
                  ? 'Captured via Camera (Optimized 800px, 75%)'
                  : 'Photograph Ready (Optimized 800px, 75%)'}
              </span>
            </div>
            <div className="text-[11px] text-neutral-600 dark:text-neutral-300 truncate font-mono">
              {value.fileName} · {formatFileSize(value.fileSizeBytes)}
              {value.originalSizeBytes && value.originalSizeBytes > value.fileSizeBytes && (
                <span className="text-emerald-600 dark:text-emerald-400 font-semibold ml-1.5">
                  ({Math.round(((value.originalSizeBytes - value.fileSizeBytes) / value.originalSizeBytes) * 100)}% smaller than {formatFileSize(value.originalSizeBytes)})
                </span>
              )}
            </div>

            {compressing && (
              <div className="flex items-center gap-2 p-2 rounded bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 text-blue-700 dark:text-blue-300 text-xs">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Optimizing image on canvas (max 800px, 75% JPEG)...</span>
              </div>
            )}

            {typeof uploadProgress === 'number' && (
              <div className="space-y-1.5 pt-1">
                <div className="flex justify-between text-[11px] font-mono text-blue-700 dark:text-blue-300">
                  <span>{uploadStatus || 'Uploading to Firebase Storage...'}</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="w-full h-1.5 bg-neutral-200 dark:bg-neutral-800 rounded overflow-hidden">
                  <div
                    className="h-full bg-blue-600 transition-all duration-150"
                    style={{ width: `${Math.min(100, Math.max(0, uploadProgress))}%` }}
                  />
                </div>
                {uploadStalled && onSaveInBackground && (
                  <div className="pt-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={onSaveInBackground}
                      className="w-full text-xs font-medium"
                    >
                      Upload Stalled at 0% (&gt;8s) — Save Customer Now &amp; Attach in Background
                    </Button>
                  </div>
                )}
              </div>
            )}


            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => startCamera(facingMode)}
                icon={<RotateCcw className="h-3 w-3" />}
              >
                {value.source === 'camera' ? 'Retake' : 'Use Camera'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => fileInputRef.current?.click()}
                icon={<Upload className="h-3 w-3" />}
              >
                Change Photo
              </Button>
              <Button
                type="button"
                size="sm"
                variant="danger"
                disabled={disabled}
                onClick={handleRemovePhoto}
                icon={<Trash2 className="h-3 w-3" />}
              >
                Remove
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row items-center gap-4">
          <div className="w-20 h-24 rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 flex flex-col items-center justify-center text-neutral-400 shrink-0">
            <User className="h-7 w-7" />
            <span className="text-[10px] mt-1">No Photo</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || cameraStarting}
              loading={cameraStarting}
              onClick={() => startCamera('user')}
              icon={<Camera className="h-3.5 w-3.5" />}
            >
              Open Live Camera
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
              icon={<Upload className="h-3.5 w-3.5" />}
            >
              Upload Photograph
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
