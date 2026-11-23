import {
  collection,
  deleteDoc,
  doc,
  getDocFromServer,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  Unsubscribe,
} from 'firebase/firestore';
import {
  auth,
  db,
  extractFriendlyErrorMessage,
  handleFirestoreError,
  OperationType,
  timestampToIso,
  withStandardCloudFields,
} from './firebase';
import {
  recordCloudSyncError,
  recordCloudSyncSuccess,
  reportModuleSyncError,
  reportModuleSyncState,
  runStrictCloudWriteWithRetry,
} from './cloudSync';
import type {
  CustomReportTemplate,
  ReportArchiveItem,
  ReportAuditLogItem,
  ScheduledReportItem,
  ScheduleRunItem,
} from './reportApi';

function sanitizeDocId(val: unknown, prefix: string): string {
  const cleaned = String(val ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 128);
  return cleaned.length >= 2 ? cleaned : `${prefix}_${Date.now()}`;
}

function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = stripUndefinedDeep(v);
    }
    return out as T;
  }
  return value;
}

async function saveReportDoc<T extends Record<string, unknown>>(
  collectionName: string,
  docIdRaw: string,
  data: T,
  statusFallback: string
): Promise<T> {
  const docId = sanitizeDocId(docIdRaw, 'RPT');
  return runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const ref = doc(db, collectionName, docId);
    try {
      const existing = await getDocFromServer(ref);
      const existingData = existing.exists() ? (existing.data() as Record<string, unknown>) : undefined;
      const status = String(data.status || statusFallback).slice(0, 64) || statusFallback;
      const payload = withStandardCloudFields(
        stripUndefinedDeep({
          ...data,
          docId,
          status,
          createdAt: existingData?.createdAt ?? serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
        {
          recordId: docId,
          authUserUid: authUser.uid,
          status,
          existingData,
        }
      );

      if (existing.exists()) {
        await updateDoc(ref, payload);
      } else {
        await setDoc(ref, payload);
      }
      const verified = await getDocFromServer(ref);
      if (!verified.exists()) {
        throw new Error(`[unavailable] ${collectionName}/${docId} could not be verified on Firestore server.`);
      }
      const vData = verified.data() as Record<string, unknown>;
      return {
        ...data,
        ...vData,
        docId: verified.id,
        createdAt: timestampToIso(vData.createdAt),
        updatedAt: timestampToIso(vData.updatedAt),
      } as T;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `${collectionName}/${docId}`);
    }
  }, { fallbackIfNoClientAuth: () => data });
}

export async function saveReportTemplateToFirestore(
  template: CustomReportTemplate
): Promise<CustomReportTemplate> {
  return saveReportDoc(
    'reportTemplates',
    template.templateCode || `TPL_${template.id}`,
    template as unknown as Record<string, unknown>,
    'Active'
  ) as unknown as Promise<CustomReportTemplate>;
}

export async function deleteReportTemplateFromFirestore(templateCode: string): Promise<void> {
  const docId = sanitizeDocId(templateCode, 'TPL');
  await runStrictCloudWriteWithRetry(async () => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    try {
      await deleteDoc(doc(db, 'reportTemplates', docId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `reportTemplates/${docId}`);
    }
  }, { fallbackIfNoClientAuth: () => undefined });
}

export function subscribeReportTemplatesFromFirestore(
  onData: (templates: CustomReportTemplate[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  reportModuleSyncState('reportTemplates', { phase: 'loading' });
  return onSnapshot(
    collection(db, 'reportTemplates'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => {
          const data = d.data() as Record<string, unknown>;
          return {
            ...(data as unknown as CustomReportTemplate),
            templateCode: String(data.templateCode || d.id),
            updatedAt: timestampToIso(data.updatedAt),
          };
        })
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      reportModuleSyncState('reportTemplates', {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('reportTemplates', error);
      if (onError) onError(error);
    }
  );
}

export async function saveReportArchiveToFirestore(
  archive: ReportArchiveItem
): Promise<ReportArchiveItem> {
  return saveReportDoc(
    'reportArchives',
    archive.archiveCode || `ARC_${archive.id}`,
    archive as unknown as Record<string, unknown>,
    'Archived'
  ) as unknown as Promise<ReportArchiveItem>;
}

export function subscribeReportArchivesFromFirestore(
  onData: (archives: ReportArchiveItem[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  reportModuleSyncState('reportArchives', { phase: 'loading' });
  return onSnapshot(
    collection(db, 'reportArchives'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => {
          const data = d.data() as Record<string, unknown>;
          return {
            ...(data as unknown as ReportArchiveItem),
            archiveCode: String(data.archiveCode || d.id),
            generatedAt: String(data.generatedAt || timestampToIso(data.createdAt)),
          };
        })
        .sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')));
      reportModuleSyncState('reportArchives', {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('reportArchives', error);
      if (onError) onError(error);
    }
  );
}

export async function saveReportScheduleToFirestore(
  schedule: ScheduledReportItem
): Promise<ScheduledReportItem> {
  return saveReportDoc(
    'reportSchedules',
    schedule.scheduleCode || `SCH_${schedule.id}`,
    schedule as unknown as Record<string, unknown>,
    schedule.enabled ? 'Enabled' : 'Paused'
  ) as unknown as Promise<ScheduledReportItem>;
}

export function subscribeReportSchedulesFromFirestore(
  onData: (schedules: ScheduledReportItem[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  reportModuleSyncState('reportSchedules', { phase: 'loading' });
  return onSnapshot(
    collection(db, 'reportSchedules'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        return {
          ...(data as unknown as ScheduledReportItem),
          scheduleCode: String(data.scheduleCode || d.id),
        };
      });
      reportModuleSyncState('reportSchedules', {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('reportSchedules', error);
      if (onError) onError(error);
    }
  );
}

export async function saveReportScheduleRunToFirestore(
  run: ScheduleRunItem
): Promise<ScheduleRunItem> {
  return saveReportDoc(
    'reportScheduleRuns',
    run.runCode || `RUN_${run.id}`,
    run as unknown as Record<string, unknown>,
    run.status || 'SUCCESS'
  ) as unknown as Promise<ScheduleRunItem>;
}

export function subscribeReportScheduleRunsFromFirestore(
  onData: (runs: ScheduleRunItem[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  return onSnapshot(
    collection(db, 'reportScheduleRuns'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => {
          const data = d.data() as Record<string, unknown>;
          return {
            ...(data as unknown as ScheduleRunItem),
            runCode: String(data.runCode || d.id),
            executedAt: String(data.executedAt || timestampToIso(data.createdAt)),
          };
        })
        .sort((a, b) => String(b.executedAt || '').localeCompare(String(a.executedAt || '')));
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      if (onError) onError(error);
    }
  );
}

export async function saveReportAuditLogToFirestore(
  log: ReportAuditLogItem
): Promise<ReportAuditLogItem> {
  const docId = `RLOG_${log.id || Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  return saveReportDoc(
    'reportAuditLogs',
    docId,
    log as unknown as Record<string, unknown>,
    log.status || 'SUCCESS'
  ) as unknown as Promise<ReportAuditLogItem>;
}

export function subscribeReportAuditLogsFromFirestore(
  onData: (logs: ReportAuditLogItem[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  return onSnapshot(
    collection(db, 'reportAuditLogs'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => {
          const data = d.data() as Record<string, unknown>;
          return {
            ...(data as unknown as ReportAuditLogItem),
            createdAt: timestampToIso(data.createdAt),
          };
        })
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      if (onError) onError(error);
    }
  );
}
