import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Cloud,
  Database,
  Download,
  FileCheck2,
  FolderArchive,
  History,
  Lock,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { UserProfile } from '../../modules/types';
import {
  FirebaseBackupComponent,
  FirebaseBackupDashboardTelemetry,
  FirebaseBackupHistoryItem,
  FirebaseRestorePreviewDto,
  FirebaseStorageManifestDto,
  firebaseBackupApi,
} from '../../services/firebaseBackupApi';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { StatusText } from '../../components/StatusText';
import { exportBackupBundleJson } from '../../services/clientExportService';

interface FirebaseCloudBackupPanelProps {
  currentUser: UserProfile;
  onShowToast: (type: 'success' | 'error' | 'info', title: string, description?: string) => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(2)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatIstTimestamp(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 19).replace('T', ' ');
  }
}

export const FirebaseCloudBackupPanel: React.FC<FirebaseCloudBackupPanelProps> = ({
  currentUser,
  onShowToast,
}) => {
  const isAdmin = currentUser.role === 'ADMIN';
  const [telemetry, setTelemetry] = useState<FirebaseBackupDashboardTelemetry | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [historyFilter, setHistoryFilter] = useState<'ALL' | 'FAILED'>('ALL');

  // Editable retention & bucket policy form
  const [autoEnabled, setAutoEnabled] = useState(true);
  const [firestoreRetentionDays, setFirestoreRetentionDays] = useState(30);
  const [storageRetentionDays, setStorageRetentionDays] = useState(30);
  const [softDeleteDays, setSoftDeleteDays] = useState(30);
  const [backupBucketInput, setBackupBucketInput] = useState('');

  // Manifest viewer modal
  const [manifestModalOpen, setManifestModalOpen] = useState(false);
  const [activeManifest, setActiveManifest] = useState<FirebaseStorageManifestDto | null>(null);

  // Restore Wizard modal (Admin-only)
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreSourceBackup, setRestoreSourceBackup] = useState<FirebaseBackupHistoryItem | null>(null);
  const [restoreScope, setRestoreScope] = useState<FirebaseBackupComponent>('COMPLETE');
  const [restoreTargetProjectId, setRestoreTargetProjectId] = useState('');
  const [restoreTargetDatabaseId, setRestoreTargetDatabaseId] = useState('');
  const [restoreTargetBucket, setRestoreTargetBucket] = useState('');
  const [restoreManifestFiles, setRestoreManifestFiles] = useState<FirebaseStorageManifestDto | null>(null);
  const [selectiveStorageMode, setSelectiveStorageMode] = useState(false);
  const [selectedStoragePaths, setSelectedStoragePaths] = useState<string[]>([]);
  const [restorePreview, setRestorePreview] = useState<FirebaseRestorePreviewDto | null>(null);
  const [restoreConfirmText, setRestoreConfirmText] = useState('');

  const loadTelemetry = useCallback(async () => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await firebaseBackupApi.getDashboard();
      setTelemetry(res.data);
      setAutoEnabled(res.data.config.automaticBackupEnabled);
      setFirestoreRetentionDays(res.data.config.firestoreRetentionDays);
      setStorageRetentionDays(res.data.config.storageRetentionDays);
      setSoftDeleteDays(res.data.config.softDeleteProtectionDays);
      setBackupBucketInput(res.data.config.backupBucket);
    } catch (err) {
      onShowToast(
        'error',
        'Failed to load Firebase Cloud Backup telemetry',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setLoading(false);
    }
  }, [isAdmin, onShowToast]);

  useEffect(() => {
    loadTelemetry();
  }, [loadTelemetry]);

  const handleToggleAutoBackup = async () => {
    const nextVal = !autoEnabled;
    setBusyAction('TOGGLE_AUTO');
    try {
      await firebaseBackupApi.updateConfig({ automaticBackupEnabled: nextVal });
      setAutoEnabled(nextVal);
      onShowToast(
        'success',
        nextVal ? 'Automatic Scheduled Backups Enabled' : 'Automatic Scheduled Backups Paused',
        nextVal ? 'Daily 02:00 AM IST Firestore & 02:30 AM IST Storage active.' : 'Manual backups remain available.'
      );
      await loadTelemetry();
    } catch (err) {
      onShowToast('error', 'Failed to update schedule toggle', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyAction(null);
    }
  };

  const handleSavePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyAction('SAVE_CONFIG');
    try {
      await firebaseBackupApi.updateConfig({
        automaticBackupEnabled: autoEnabled,
        firestoreRetentionDays: Number(firestoreRetentionDays),
        storageRetentionDays: Number(storageRetentionDays),
        softDeleteProtectionDays: Number(softDeleteDays),
        backupBucket: backupBucketInput.trim() || undefined,
      });
      onShowToast(
        'success',
        'Backup Retention & GCS Policy Saved',
        `Firestore: ${firestoreRetentionDays}d · Storage: ${storageRetentionDays}d`
      );
      await loadTelemetry();
    } catch (err) {
      onShowToast('error', 'Failed to save policy', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyAction(null);
    }
  };

  const handleRunBackup = async (component: FirebaseBackupComponent) => {
    setBusyAction(`RUN_${component}`);
    try {
      const res = await firebaseBackupApi.runBackup(component);
      const record = res.data;
      if (record.status === 'SUCCESS') {
        onShowToast(
          'success',
          `${component} Backup Verified`,
          `${record.backupId} · ${formatBytes(record.totalSizeBytes)}`
        );
      } else {
        onShowToast(
          'error',
          `${component} Backup ${record.status}`,
          record.failureReason || 'Verification or component execution reported issues.'
        );
      }
      await loadTelemetry();
    } catch (err) {
      onShowToast('error', `${component} Backup Failed`, err instanceof Error ? err.message : undefined);
      await loadTelemetry();
    } finally {
      setBusyAction(null);
    }
  };

  const handleVerifyRecord = async (backupId: string) => {
    setBusyAction(`VERIFY_${backupId}`);
    try {
      const res = await firebaseBackupApi.verifyBackup(backupId);
      onShowToast(
        res.data.verificationStatus === 'VERIFIED' ? 'success' : 'error',
        `Verification ${res.data.verificationStatus}`,
        res.data.verification.failureReason || `${backupId} metadata & file checksums verified.`
      );
      await loadTelemetry();
    } catch (err) {
      onShowToast('error', 'Verification failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyAction(null);
    }
  };

  const handleViewOrDownloadManifest = async (backupId: string, downloadImmediately = false) => {
    setBusyAction(`MANIFEST_${backupId}`);
    try {
      const res = await firebaseBackupApi.getManifest(backupId);
      setActiveManifest(res.data);
      if (downloadImmediately) {
        const fname = exportBackupBundleJson({ ...res.data } as Record<string, unknown>, `${backupId}_manifest`);
        onShowToast('success', 'Authorized Manifest Downloaded', fname);
      } else {
        setManifestModalOpen(true);
      }
    } catch (err) {
      onShowToast('error', 'Manifest Unavailable', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyAction(null);
    }
  };

  const handleRunRetentionCleanup = async () => {
    setBusyAction('RETENTION');
    try {
      const res = await firebaseBackupApi.runRetention();
      onShowToast(
        'info',
        'Retention Policy Evaluated',
        `Preserved: ${res.data.preservedBackupIds.length} · Pruned: ${res.data.prunedBackupIds.length}`
      );
      await loadTelemetry();
    } catch (err) {
      onShowToast('error', 'Retention check failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyAction(null);
    }
  };

  const handleOpenRestoreWizard = async (backup: FirebaseBackupHistoryItem) => {
    setRestoreSourceBackup(backup);
    const defaultScope: FirebaseBackupComponent =
      backup.component === 'FIRESTORE'
        ? 'FIRESTORE'
        : backup.component === 'STORAGE'
          ? 'STORAGE'
          : 'COMPLETE';
    setRestoreScope(defaultScope);
    setRestoreTargetProjectId(backup.sourceProjectId);
    setRestoreTargetDatabaseId(backup.sourceDatabaseId);
    setRestoreTargetBucket(backup.sourceStorageBucket);
    setRestoreManifestFiles(null);
    setSelectiveStorageMode(false);
    setSelectedStoragePaths([]);
    setRestorePreview(null);
    setRestoreConfirmText('');
    setRestoreOpen(true);

    if (backup.manifestId) {
      try {
        const res = await firebaseBackupApi.getManifest(backup.backupId);
        setRestoreManifestFiles(res.data);
      } catch {
        // Optional manifest preview if storage component absent
      }
    }
  };

  const handleGenerateRestorePreview = async () => {
    if (!restoreSourceBackup) return;
    setBusyAction('RESTORE_PREVIEW');
    try {
      const res = await firebaseBackupApi.previewRestore({
        backupId: restoreSourceBackup.backupId,
        scope: restoreScope,
        selectedPaths:
          selectiveStorageMode && selectedStoragePaths.length > 0 ? selectedStoragePaths : undefined,
        targetProjectId: restoreTargetProjectId.trim() || undefined,
        targetDatabaseId: restoreTargetDatabaseId.trim() || undefined,
        targetStorageBucket: restoreTargetBucket.trim() || undefined,
      });
      setRestorePreview(res.data);
      onShowToast('info', 'Dry-Run Preview Generated', `Preview ${res.data.previewId} ready for review.`);
    } catch (err) {
      onShowToast('error', 'Restore Preview Blocked', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyAction(null);
    }
  };

  const handleExecuteRestore = async () => {
    if (!restorePreview) return;
    setBusyAction('RESTORE_EXECUTE');
    try {
      const res = await firebaseBackupApi.executeRestore({
        previewId: restorePreview.previewId,
        confirmationText: restoreConfirmText,
      });
      onShowToast(
        res.data.status === 'COMPLETED' ? 'success' : 'error',
        `Restore ${res.data.status}`,
        `${res.data.restoreId} · ${res.data.verificationNotes}`
      );
      setRestoreOpen(false);
      await loadTelemetry();
    } catch (err) {
      onShowToast('error', 'Restore Execution Failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyAction(null);
    }
  };

  const displayedHistory = useMemo(() => {
    if (!telemetry) return [];
    return historyFilter === 'FAILED' ? telemetry.failedHistory : telemetry.history;
  }, [telemetry, historyFilter]);

  if (!isAdmin) {
    return (
      <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 space-y-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-neutral-950 dark:text-white">
          <Lock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          Administrator Access Required
        </div>
        <p className="text-xs text-neutral-600 dark:text-neutral-300">
          Firebase Managed Backup, Cloud Run Scheduler telemetry, authorized GCS manifests, retention policies, and disaster recovery restore controls are strictly restricted to ERP Administrator accounts. Automated daily backups run independently via Google Cloud Scheduler &amp; Cloud Run without requiring user login.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header & Admin Primary Backup Controls */}
      <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-base font-bold text-neutral-950 dark:text-white">
            <Cloud className="h-4 w-4 text-blue-700 dark:text-blue-400 shrink-0" />
            <span>Automatic Firebase Backup &amp; Verified Recovery</span>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Session-independent Cloud Run &amp; Cloud Scheduler (Asia/Kolkata) · Native Firestore Managed Export · Firebase Storage Delta Copy · Private GCS Vault
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={autoEnabled ? 'outline' : 'secondary'}
            size="sm"
            loading={busyAction === 'TOGGLE_AUTO'}
            onClick={handleToggleAutoBackup}
            icon={<CalendarClock className="h-3.5 w-3.5" />}
            className="whitespace-nowrap shrink-0"
          >
            {autoEnabled ? 'Auto Backup: ON' : 'Auto Backup: PAUSED'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            loading={busyAction === 'RUN_FIRESTORE'}
            onClick={() => handleRunBackup('FIRESTORE')}
            icon={<Database className="h-3.5 w-3.5" />}
            className="whitespace-nowrap shrink-0"
          >
            Firestore Backup Now
          </Button>
          <Button
            variant="outline"
            size="sm"
            loading={busyAction === 'RUN_STORAGE'}
            onClick={() => handleRunBackup('STORAGE')}
            icon={<FolderArchive className="h-3.5 w-3.5" />}
            className="whitespace-nowrap shrink-0"
          >
            Storage Backup Now
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={busyAction === 'RUN_COMPLETE'}
            onClick={() => handleRunBackup('COMPLETE')}
            icon={<Play className="h-3.5 w-3.5" />}
            className="whitespace-nowrap shrink-0"
          >
            Backup Now
          </Button>
          <Button
            variant="outline"
            size="sm"
            loading={loading}
            onClick={loadTelemetry}
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            className="whitespace-nowrap shrink-0"
          >
            Refresh
          </Button>
        </div>
      </div>

      {/* Open Failure / Partial Alerts Banner */}
      {telemetry && telemetry.alerts.some((a) => a.status === 'OPEN') && (
        <section className="bg-red-50/70 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs font-bold text-red-700 dark:text-red-400">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            Active Backup Verification / Failure Alerts ({telemetry.alerts.filter((a) => a.status === 'OPEN').length})
          </div>
          <div className="divide-y divide-red-200/70 dark:divide-red-900/60">
            {telemetry.alerts
              .filter((a) => a.status === 'OPEN')
              .slice(0, 5)
              .map((alert) => (
                <div key={alert.alertId} className="py-2 flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-xs">
                  <div>
                    <span className="font-semibold text-neutral-950 dark:text-white">{alert.title}</span>
                    <span className="text-neutral-600 dark:text-neutral-300"> · {alert.message}</span>
                  </div>
                  <span className="font-mono tabular-nums text-[11px] text-neutral-500 whitespace-nowrap">
                    {formatIstTimestamp(alert.createdAt)}
                  </span>
                </div>
              ))}
          </div>
        </section>
      )}

      {/* KPI Strip: Connection, Firestore Status, Storage Status, Schedule, Totals */}
      {telemetry && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {/* 1. Firebase Connection Status */}
          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-neutral-950 dark:text-white flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                Firebase Connection
              </span>
              <StatusText status={telemetry.firebaseConnection.firestoreConnected ? 'Connected' : 'Pending'} />
            </div>
            <div className="text-[11px] font-mono text-neutral-600 dark:text-neutral-300 truncate" title={telemetry.firebaseConnection.projectId}>
              Project: {telemetry.firebaseConnection.projectId}
            </div>
            <div className="text-[11px] font-mono text-neutral-500 dark:text-neutral-400 truncate" title={telemetry.firebaseConnection.authMode}>
              SDK: {telemetry.firebaseConnection.authMode} · Storage: {telemetry.firebaseConnection.storageConnected ? 'Ready' : 'Check SA'}
            </div>
            <div className="text-[11px] font-mono text-neutral-500 dark:text-neutral-400 truncate">
              Worker: {telemetry.firebaseConnection.cloudRunUrlConfigured ? 'External Cloud Run' : 'Integrated API Worker'}
            </div>
          </div>

          {/* 2 & 3. Firestore + Storage Backup Status */}
          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-neutral-950 dark:text-white flex items-center gap-1.5">
                <Database className="h-4 w-4 text-blue-700 dark:text-blue-400" />
                Component Status
              </span>
              <StatusText status={telemetry.verificationStatus} />
            </div>
            <div className="flex items-center justify-between text-xs pt-0.5">
              <span className="text-neutral-600 dark:text-neutral-300">Firestore Export</span>
              <StatusText status={telemetry.firestoreStatus.lastStatus} />
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-600 dark:text-neutral-300">Storage Backup</span>
              <StatusText status={telemetry.storageStatus.lastStatus} />
            </div>
            <div className="text-[11px] font-mono text-neutral-500 dark:text-neutral-400 truncate" title={telemetry.firestoreStatus.lastOperationId || ''}>
              Op ID: {telemetry.firestoreStatus.lastOperationId || 'Awaiting first run'}
            </div>
          </div>

          {/* 4 & 5. Last Successful & Next Scheduled Backup */}
          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-neutral-950 dark:text-white flex items-center gap-1.5">
                <CalendarClock className="h-4 w-4 text-blue-700 dark:text-blue-400" />
                Schedule &amp; Last Success
              </span>
              <span className="text-[11px] font-mono text-neutral-500 dark:text-neutral-400">Asia/Kolkata</span>
            </div>
            <div className="text-xs text-neutral-700 dark:text-neutral-200 font-mono tabular-nums">
              Last OK: {telemetry.lastSuccessfulBackup ? formatIstTimestamp(telemetry.lastSuccessfulBackup.completedAt) : 'None yet'}
            </div>
            <div className="text-[11px] font-mono tabular-nums text-neutral-500 dark:text-neutral-400">
              Next Firestore: {autoEnabled ? telemetry.nextScheduledBackup.firestoreNextRunIst : 'Paused'}
            </div>
            <div className="text-[11px] font-mono tabular-nums text-neutral-500 dark:text-neutral-400">
              Next Storage: {autoEnabled ? telemetry.nextScheduledBackup.storageNextRunIst : 'Paused'}
            </div>
          </div>

          {/* 6 & 7 & 11. Totals & Verification Summary */}
          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-neutral-950 dark:text-white flex items-center gap-1.5">
                <FileCheck2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                Vault Size &amp; Files
              </span>
              <span className="text-[11px] font-mono tabular-nums text-neutral-500">
                {telemetry.totals.successfulBackupsCount} OK · {telemetry.totals.failedOrPartialBackupsCount} Alert
              </span>
            </div>
            <div className="text-lg font-bold font-mono tabular-nums text-neutral-950 dark:text-white">
              {formatBytes(telemetry.totals.totalBackupSizeBytes)}
            </div>
            <div className="text-xs font-mono tabular-nums text-neutral-600 dark:text-neutral-300">
              Files Backed Up: {telemetry.totals.totalFilesBackedUp.toLocaleString('en-IN')}
            </div>
            <div className="text-[11px] font-mono text-neutral-500 dark:text-neutral-400 truncate" title={`gs://${telemetry.config.backupBucket}`}>
              Bucket: gs://{telemetry.config.backupBucket}
            </div>
          </div>
        </div>
      )}

      {/* Module 6: Configurable Retention Policy & GCS Protection Controls */}
      {telemetry && (
        <section className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
            <div>
              <h3 className="text-sm font-semibold text-neutral-950 dark:text-white">
                Backup Retention, Soft Delete Protection &amp; Destination Bucket Policy
              </h3>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                Daily default: 30 days · Most recent &amp; sole remaining successful backups are strictly protected from deletion · Failed logs preserved
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              loading={busyAction === 'RETENTION'}
              onClick={handleRunRetentionCleanup}
              icon={<Trash2 className="h-3.5 w-3.5" />}
              className="whitespace-nowrap shrink-0"
            >
              Run Retention Check
            </Button>
          </div>

          <form onSubmit={handleSavePolicy} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
            <div>
              <label className="block text-[11px] font-medium text-neutral-600 dark:text-neutral-300 mb-1">
                Firestore Retention (Days)
              </label>
              <input
                type="number"
                min={1}
                max={3650}
                value={firestoreRetentionDays}
                onChange={(e) => setFirestoreRetentionDays(Number(e.target.value))}
                className="w-full h-9 px-3 text-xs font-mono tabular-nums border border-neutral-200 dark:border-neutral-700 rounded-md bg-white dark:bg-neutral-950 text-neutral-950 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-neutral-600 dark:text-neutral-300 mb-1">
                Storage Retention (Days)
              </label>
              <input
                type="number"
                min={1}
                max={3650}
                value={storageRetentionDays}
                onChange={(e) => setStorageRetentionDays(Number(e.target.value))}
                className="w-full h-9 px-3 text-xs font-mono tabular-nums border border-neutral-200 dark:border-neutral-700 rounded-md bg-white dark:bg-neutral-950 text-neutral-950 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-neutral-600 dark:text-neutral-300 mb-1">
                GCS Soft Delete (Days)
              </label>
              <input
                type="number"
                min={7}
                max={90}
                value={softDeleteDays}
                onChange={(e) => setSoftDeleteDays(Number(e.target.value))}
                className="w-full h-9 px-3 text-xs font-mono tabular-nums border border-neutral-200 dark:border-neutral-700 rounded-md bg-white dark:bg-neutral-950 text-neutral-950 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-neutral-600 dark:text-neutral-300 mb-1">
                Backup GCS Bucket Name
              </label>
              <input
                type="text"
                value={backupBucketInput}
                onChange={(e) => setBackupBucketInput(e.target.value)}
                placeholder="mun-erp-firebase-backups"
                className="w-full h-9 px-3 text-xs font-mono border border-neutral-200 dark:border-neutral-700 rounded-md bg-white dark:bg-neutral-950 text-neutral-950 dark:text-white"
              />
            </div>
            <div>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={busyAction === 'SAVE_CONFIG'}
                icon={<Save className="h-3.5 w-3.5" />}
                className="w-full h-9 whitespace-nowrap"
              >
                Save Policy
              </Button>
            </div>
          </form>
        </section>
      )}

      {/* 8 & 9. Backup History & Failed Backup History */}
      <section className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-neutral-200 dark:border-neutral-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-neutral-950 dark:text-white flex items-center gap-2">
              <History className="h-4 w-4 text-neutral-600 dark:text-neutral-300" />
              Firebase Backup History ({displayedHistory.length})
            </h3>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Immutable timestamped GCS folders · Every run must pass verification before reporting SUCCESS
            </p>
          </div>
          <div className="inline-flex border border-neutral-200 dark:border-neutral-700 rounded-md overflow-hidden">
            <button
              type="button"
              onClick={() => setHistoryFilter('ALL')}
              className={`px-3 py-1.5 text-xs font-medium cursor-pointer whitespace-nowrap ${
                historyFilter === 'ALL'
                  ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-950'
                  : 'bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800'
              }`}
            >
              All Backups ({telemetry?.history.length ?? 0})
            </button>
            <button
              type="button"
              onClick={() => setHistoryFilter('FAILED')}
              className={`px-3 py-1.5 text-xs font-medium cursor-pointer whitespace-nowrap border-l border-neutral-200 dark:border-neutral-700 ${
                historyFilter === 'FAILED'
                  ? 'bg-red-600 text-white'
                  : 'bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800'
              }`}
            >
              Failed &amp; Partial ({telemetry?.failedHistory.length ?? 0})
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-neutral-50 dark:bg-neutral-950 border-b border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-300">
                <th className="px-4 py-3 font-semibold">Backup ID &amp; Timestamp</th>
                <th className="px-4 py-3 font-semibold">Component &amp; Trigger</th>
                <th className="px-4 py-3 font-semibold">Status &amp; Verification</th>
                <th className="px-4 py-3 font-semibold">Size &amp; Files</th>
                <th className="px-4 py-3 font-semibold">GCS Destination / Op</th>
                <th className="px-4 py-3 font-semibold text-right">Admin Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {displayedHistory.length === 0 && !loading && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-neutral-500 dark:text-neutral-400">
                    {historyFilter === 'FAILED'
                      ? 'No failed or partial Firebase backups recorded.'
                      : 'No Firebase backups recorded yet. Click "Backup Now" to execute and verify your first snapshot.'}
                  </td>
                </tr>
              )}
              {displayedHistory.map((b) => (
                <tr key={b.backupId} className="hover:bg-neutral-50/70 dark:hover:bg-neutral-800/30">
                  <td className="px-4 py-3 align-top">
                    <div className="font-mono font-semibold text-neutral-950 dark:text-white">{b.backupId}</div>
                    <div className="text-[11px] font-mono tabular-nums text-neutral-500 dark:text-neutral-400">
                      {formatIstTimestamp(b.completedAt)}
                    </div>
                    {b.prunedFromGcs && (
                      <div className="text-[11px] font-mono text-neutral-400">Pruned by retention policy</div>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top font-mono">
                    <div className="text-neutral-900 dark:text-neutral-100 font-semibold">{b.component}</div>
                    <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                      {b.triggerType} · {b.triggeredBy}
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <div className="space-y-1">
                      <StatusText status={b.status} />
                      <div className="text-[11px] font-mono text-neutral-500 dark:text-neutral-400">
                        Verify: {b.verificationStatus}
                      </div>
                      {b.failureReason && (
                        <div className="text-[11px] text-red-600 dark:text-red-400 max-w-[220px]" title={b.failureReason}>
                          {b.failureReason}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top font-mono tabular-nums">
                    <div className="text-neutral-950 dark:text-white">{formatBytes(b.totalSizeBytes)}</div>
                    <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                      {b.totalFilesBackedUp} files
                      {b.filesDeltaSummary
                        ? ` · +${b.filesDeltaSummary.newCount} / ~${b.filesDeltaSummary.changedCount} / -${b.filesDeltaSummary.deletedCount}`
                        : ''}
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top font-mono text-[11px] text-neutral-600 dark:text-neutral-300 max-w-[240px]">
                    {b.firestoreDestinationUri && (
                      <div className="truncate" title={b.firestoreDestinationUri}>
                        FS: {b.firestoreDestinationUri}
                      </div>
                    )}
                    {b.storageDestinationUri && (
                      <div className="truncate" title={b.storageDestinationUri}>
                        ST: {b.storageDestinationUri}
                      </div>
                    )}
                    {b.firestoreOperationId && (
                      <div className="truncate text-neutral-400" title={b.firestoreOperationId}>
                        Op: {b.firestoreOperationId}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top text-right">
                    <div className="inline-flex flex-wrap justify-end gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        loading={busyAction === `VERIFY_${b.backupId}`}
                        onClick={() => handleVerifyRecord(b.backupId)}
                        icon={<CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />}
                        className="whitespace-nowrap shrink-0"
                      >
                        Verify
                      </Button>
                      {b.manifestId && (
                        <Button
                          variant="outline"
                          size="sm"
                          loading={busyAction === `MANIFEST_${b.backupId}`}
                          onClick={() => handleViewOrDownloadManifest(b.backupId, false)}
                          icon={<Download className="h-3.5 w-3.5" />}
                          className="whitespace-nowrap shrink-0"
                        >
                          Manifest
                        </Button>
                      )}
                      {!b.prunedFromGcs && (b.status === 'SUCCESS' || b.status === 'PARTIAL') && (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => handleOpenRestoreWizard(b)}
                          icon={<RotateCcw className="h-3.5 w-3.5" />}
                          className="whitespace-nowrap shrink-0"
                        >
                          Restore
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Restore History */}
      {telemetry && telemetry.restoreHistory.length > 0 && (
        <section className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-neutral-950 dark:text-white">
            Verified Firebase Restore History ({telemetry.restoreHistory.length})
          </h3>
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800 text-xs font-mono">
            {telemetry.restoreHistory.map((r) => (
              <div key={r.restoreId} className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="space-y-0.5">
                  <div className="text-neutral-950 dark:text-white font-semibold">
                    {r.restoreId} · From {r.backupId} · Scope: {r.scope}
                  </div>
                  <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                    Target: {r.targetProjectId} ({r.targetDatabaseId}) · Files: {r.restoredFilesCount} · {r.verificationNotes}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <StatusText status={r.status} />
                  <span className="text-[11px] tabular-nums text-neutral-500">
                    {formatIstTimestamp(r.completedAt)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Manifest Inspection & Download Modal */}
      <Modal
        isOpen={manifestModalOpen}
        onClose={() => setManifestModalOpen(false)}
        title={`Authorized Storage Backup Manifest · ${activeManifest?.backupId || ''}`}
        size="lg"
      >
        {activeManifest && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono tabular-nums">
              <div className="p-2.5 border border-neutral-200 dark:border-neutral-800 rounded">
                <div className="text-[11px] text-neutral-500">Total Files</div>
                <div className="font-bold text-neutral-950 dark:text-white">{activeManifest.totalFiles}</div>
              </div>
              <div className="p-2.5 border border-neutral-200 dark:border-neutral-800 rounded">
                <div className="text-[11px] text-neutral-500">Verified Files</div>
                <div className="font-bold text-emerald-700 dark:text-emerald-400">{activeManifest.verifiedFilesCount}</div>
              </div>
              <div className="p-2.5 border border-neutral-200 dark:border-neutral-800 rounded">
                <div className="text-[11px] text-neutral-500">Delta (New/Chg/Del)</div>
                <div className="font-bold text-neutral-950 dark:text-white">
                  +{activeManifest.newFilesCount} / ~{activeManifest.changedFilesCount} / -{activeManifest.deletedFromSourceCount}
                </div>
              </div>
              <div className="p-2.5 border border-neutral-200 dark:border-neutral-800 rounded">
                <div className="text-[11px] text-neutral-500">Total Size</div>
                <div className="font-bold text-neutral-950 dark:text-white">{formatBytes(activeManifest.totalSizeBytes)}</div>
              </div>
            </div>

            <div className="max-h-72 overflow-y-auto border border-neutral-200 dark:border-neutral-800 rounded">
              <table className="w-full text-left text-[11px] font-mono border-collapse">
                <thead className="bg-neutral-50 dark:bg-neutral-950 sticky top-0 border-b border-neutral-200 dark:border-neutral-800">
                  <tr>
                    <th className="px-3 py-2">Original Path</th>
                    <th className="px-3 py-2">Delta</th>
                    <th className="px-3 py-2">Size</th>
                    <th className="px-3 py-2">Gen / Checksum</th>
                    <th className="px-3 py-2">Verify</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {activeManifest.entries.map((entry) => (
                    <tr key={`${entry.originalPath}-${entry.originalGeneration}`}>
                      <td className="px-3 py-2 truncate max-w-[200px]" title={entry.originalPath}>
                        {entry.originalPath}
                      </td>
                      <td className="px-3 py-2">{entry.changeType}</td>
                      <td className="px-3 py-2 tabular-nums">{formatBytes(entry.fileSizeBytes)}</td>
                      <td className="px-3 py-2 truncate max-w-[140px]" title={`${entry.originalGeneration} | ${entry.checksum}`}>
                        g:{entry.originalGeneration} · {entry.checksum.slice(0, 10)}
                      </td>
                      <td className="px-3 py-2">
                        <StatusText status={entry.verificationStatus} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setManifestModalOpen(false)}>
                Close
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={<Download className="h-3.5 w-3.5" />}
                onClick={() => {
                  const filename = exportBackupBundleJson({ ...activeManifest } as Record<string, unknown>, `${activeManifest.backupId}_manifest`);
                  onShowToast('success', 'Manifest JSON Downloaded', filename);
                }}
              >
                Download Authorized Manifest JSON
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Module 9: Admin-Only Firebase Restore Wizard Modal */}
      <Modal
        isOpen={restoreOpen}
        onClose={() => setRestoreOpen(false)}
        title={`Verified Firebase Restore Wizard · ${restoreSourceBackup?.backupId || ''}`}
        size="lg"
      >
        {restoreSourceBackup && (
          <div className="space-y-4">
            <div className="p-3 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded text-xs space-y-1">
              <div className="font-semibold flex items-center gap-1.5 text-neutral-950 dark:text-white">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                Zero-Silent-Overwrite Disaster Recovery Protocol
              </div>
              <p className="text-neutral-600 dark:text-neutral-300">
                1) Select restore scope &amp; target project/bucket (or stage into an alternate recovery project) &rarr; 2) Generate mandatory dry-run preview &rarr; 3) Confirm explicitly by typing CONFIRM RESTORE.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  Restore Scope
                </label>
                <select
                  value={restoreScope}
                  onChange={(e) => {
                    setRestoreScope(e.target.value as FirebaseBackupComponent);
                    setRestorePreview(null);
                  }}
                  className="w-full h-9 px-3 text-xs font-mono border border-neutral-200 dark:border-neutral-700 rounded-md bg-white dark:bg-neutral-950 text-neutral-950 dark:text-white"
                >
                  {restoreSourceBackup.firestoreDestinationUri && restoreSourceBackup.storageDestinationUri && (
                    <option value="COMPLETE">COMPLETE (Firestore + Storage)</option>
                  )}
                  {restoreSourceBackup.firestoreDestinationUri && (
                    <option value="FIRESTORE">FIRESTORE DATABASE ONLY</option>
                  )}
                  {restoreSourceBackup.storageDestinationUri && (
                    <option value="STORAGE">STORAGE FILES ONLY</option>
                  )}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  Target Firebase Project ID (Recovery / Primary)
                </label>
                <input
                  type="text"
                  value={restoreTargetProjectId}
                  onChange={(e) => {
                    setRestoreTargetProjectId(e.target.value);
                    setRestorePreview(null);
                  }}
                  className="w-full h-9 px-3 text-xs font-mono border border-neutral-200 dark:border-neutral-700 rounded-md bg-white dark:bg-neutral-950 text-neutral-950 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  Target Firestore Database ID
                </label>
                <input
                  type="text"
                  value={restoreTargetDatabaseId}
                  onChange={(e) => {
                    setRestoreTargetDatabaseId(e.target.value);
                    setRestorePreview(null);
                  }}
                  className="w-full h-9 px-3 text-xs font-mono border border-neutral-200 dark:border-neutral-700 rounded-md bg-white dark:bg-neutral-950 text-neutral-950 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  Target Storage Bucket
                </label>
                <input
                  type="text"
                  value={restoreTargetBucket}
                  onChange={(e) => {
                    setRestoreTargetBucket(e.target.value);
                    setRestorePreview(null);
                  }}
                  className="w-full h-9 px-3 text-xs font-mono border border-neutral-200 dark:border-neutral-700 rounded-md bg-white dark:bg-neutral-950 text-neutral-950 dark:text-white"
                />
              </div>
            </div>

            {/* Selective Storage File Picker */}
            {restoreManifestFiles && (restoreScope === 'STORAGE' || restoreScope === 'COMPLETE') && (
              <div className="border border-neutral-200 dark:border-neutral-800 rounded-md p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-neutral-950 dark:text-white">
                    Storage File Selection ({restoreManifestFiles.entries.length} available in manifest)
                  </span>
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectiveStorageMode}
                      onChange={(e) => {
                        setSelectiveStorageMode(e.target.checked);
                        setRestorePreview(null);
                      }}
                    />
                    <span>Restore Specific Files Only</span>
                  </label>
                </div>
                {selectiveStorageMode && (
                  <div className="max-h-36 overflow-y-auto divide-y divide-neutral-100 dark:divide-neutral-800 text-[11px] font-mono">
                    {restoreManifestFiles.entries
                      .filter((item) => item.changeType !== 'DELETED')
                      .map((item) => {
                        const checked = selectedStoragePaths.includes(item.originalPath);
                        return (
                          <label key={item.originalPath} className="py-1.5 flex items-center justify-between gap-2 cursor-pointer">
                            <span className="inline-flex items-center gap-2 truncate">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  setRestorePreview(null);
                                  if (e.target.checked) {
                                    setSelectedStoragePaths((prev) => [...prev, item.originalPath]);
                                  } else {
                                    setSelectedStoragePaths((prev) => prev.filter((p) => p !== item.originalPath));
                                  }
                                }}
                              />
                              <span className="truncate">{item.originalPath}</span>
                            </span>
                            <span className="text-neutral-500 shrink-0 tabular-nums">{formatBytes(item.fileSizeBytes)}</span>
                          </label>
                        );
                      })}
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                loading={busyAction === 'RESTORE_PREVIEW'}
                onClick={handleGenerateRestorePreview}
                icon={<ShieldCheck className="h-3.5 w-3.5" />}
              >
                Generate Dry-Run Preview
              </Button>
            </div>

            {restorePreview && (
              <div className="space-y-3 border border-neutral-200 dark:border-neutral-800 rounded-md p-4 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2 font-mono">
                  <span>
                    Preview ID: <strong>{restorePreview.previewId}</strong>
                  </span>
                  <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
                    INTEGRITY VERIFIED
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 font-mono text-[11px]">
                  <div className="p-2 border border-neutral-200 dark:border-neutral-800 rounded">
                    Target Project: <strong>{restorePreview.targetProjectId}</strong>
                  </div>
                  <div className="p-2 border border-neutral-200 dark:border-neutral-800 rounded">
                    Files to Restore: <strong className="tabular-nums">{restorePreview.estimatedFilesToRestore}</strong>
                  </div>
                  <div className="p-2 border border-neutral-200 dark:border-neutral-800 rounded">
                    Estimated Size: <strong className="tabular-nums">{formatBytes(restorePreview.estimatedSizeBytes)}</strong>
                  </div>
                </div>
                <ul className="list-disc pl-4 text-neutral-600 dark:text-neutral-300 space-y-1">
                  {restorePreview.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>

                <div className="pt-2 border-t border-neutral-200 dark:border-neutral-800">
                  <label className="block text-xs font-semibold mb-1 text-neutral-950 dark:text-white">
                    Type <span className="font-mono">CONFIRM RESTORE</span> to execute disaster recovery restore:
                  </label>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="text"
                      value={restoreConfirmText}
                      onChange={(e) => setRestoreConfirmText(e.target.value)}
                      placeholder="CONFIRM RESTORE"
                      className="flex-1 h-9 px-3 text-xs font-mono border border-neutral-200 dark:border-neutral-700 rounded-md bg-white dark:bg-neutral-950 text-neutral-950 dark:text-white"
                    />
                    <Button
                      variant="danger"
                      size="sm"
                      loading={busyAction === 'RESTORE_EXECUTE'}
                      disabled={restoreConfirmText.trim().toUpperCase() !== 'CONFIRM RESTORE'}
                      onClick={handleExecuteRestore}
                      className="whitespace-nowrap shrink-0"
                    >
                      Execute Verified Restore
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
};
