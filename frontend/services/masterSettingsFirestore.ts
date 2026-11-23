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
import type {
  ApiIntegrationItem,
  BranchItem,
  CounterItem,
  ServiceRateItem,
  SettingsProposalItem,
  UploadedDocumentItem,
} from '../modules/types';
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

export type CloudUploadedDocumentItem = UploadedDocumentItem & {
  storagePath?: string;
  downloadUrl?: string;
};

function sanitizeId(val: unknown, prefix: string): string {
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

const SENSITIVE_KEY_PATTERN = /(api[_-]?key|secret|token|password|private[_-]?key|auth[_-]?token|webhook[_-]?secret|bot[_-]?token|client[_-]?secret)/i;

/**
 * Strips any secret/credential fields from third-party integrations config so secrets are NEVER stored in Firestore.
 */
export function sanitizeNonSecretIntegrationsConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      safe[key] = sanitizeNonSecretIntegrationsConfig(value as Record<string, unknown>);
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

async function saveMasterCollectionDoc<T extends Record<string, unknown>>(
  collectionName: string,
  docIdRaw: string,
  data: T,
  statusFallback: string
): Promise<T> {
  const docId = sanitizeId(docIdRaw, 'MST');
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
        createdAt: timestampToIso(vData.createdAt),
        updatedAt: timestampToIso(vData.updatedAt),
      } as T;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `${collectionName}/${docId}`);
    }
  }, { fallbackIfNoClientAuth: () => data });
}

export function saveServiceRateToFirestore(rate: ServiceRateItem): Promise<ServiceRateItem> {
  const docId = rate.serviceCode || `RATE_${rate.id}`;
  return saveMasterCollectionDoc(
    'serviceRates',
    docId,
    rate as unknown as Record<string, unknown>,
    rate.status || 'active'
  ) as unknown as Promise<ServiceRateItem>;
}

export function subscribeServiceRatesFromFirestore(
  onData: (rates: ServiceRateItem[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  reportModuleSyncState('serviceRates', { phase: 'loading' });
  return onSnapshot(
    collection(db, 'serviceRates'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs.map((d) => d.data() as ServiceRateItem);
      reportModuleSyncState('serviceRates', {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('serviceRates', error);
      if (onError) onError(error);
    }
  );
}

export function saveBranchToFirestore(branch: BranchItem): Promise<BranchItem> {
  return saveMasterCollectionDoc(
    'branches',
    branch.branchCode || `BR_${branch.id}`,
    branch as unknown as Record<string, unknown>,
    branch.status || 'active'
  ) as unknown as Promise<BranchItem>;
}

export function subscribeBranchesFromFirestore(
  onData: (branches: BranchItem[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  reportModuleSyncState('branches', { phase: 'loading' });
  return onSnapshot(
    collection(db, 'branches'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs.map((d) => d.data() as BranchItem);
      reportModuleSyncState('branches', {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('branches', error);
      if (onError) onError(error);
    }
  );
}

export function saveCounterToFirestore(counter: CounterItem): Promise<CounterItem> {
  return saveMasterCollectionDoc(
    'counters',
    counter.counterCode || `CTR_${counter.id}`,
    counter as unknown as Record<string, unknown>,
    counter.status || 'active'
  ) as unknown as Promise<CounterItem>;
}

export function subscribeCountersFromFirestore(
  onData: (counters: CounterItem[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  reportModuleSyncState('counters', { phase: 'loading' });
  return onSnapshot(
    collection(db, 'counters'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs.map((d) => d.data() as CounterItem);
      reportModuleSyncState('counters', {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('counters', error);
      if (onError) onError(error);
    }
  );
}

export function saveSettingsProposalToFirestore(proposal: SettingsProposalItem): Promise<SettingsProposalItem> {
  return saveMasterCollectionDoc(
    'settingsProposals',
    proposal.proposalId || `PROP_${proposal.id || Date.now()}`,
    proposal as unknown as Record<string, unknown>,
    proposal.approvalStatus || 'Pending'
  ) as unknown as Promise<SettingsProposalItem>;
}

export function subscribeSettingsProposalsFromFirestore(
  onData: (proposals: SettingsProposalItem[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  reportModuleSyncState('settingsProposals', { phase: 'loading' });
  return onSnapshot(
    collection(db, 'settingsProposals'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs.map((d) => d.data() as SettingsProposalItem);
      reportModuleSyncState('settingsProposals', {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('settingsProposals', error);
      if (onError) onError(error);
    }
  );
}

export function saveUploadedDocumentMetaToFirestore(
  docItem: CloudUploadedDocumentItem
): Promise<CloudUploadedDocumentItem> {
  return saveMasterCollectionDoc(
    'uploadedDocuments',
    docItem.fileUuid || `DOC_${docItem.id || Date.now()}`,
    docItem as unknown as Record<string, unknown>,
    docItem.status || 'active'
  ) as unknown as Promise<CloudUploadedDocumentItem>;
}

export async function deleteUploadedDocumentMetaFromFirestore(fileUuid: string): Promise<void> {
  const docId = sanitizeId(fileUuid, 'DOC');
  await runStrictCloudWriteWithRetry(async () => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const docRef = doc(db, 'uploadedDocuments', docId);
    try {
      await deleteDoc(docRef);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `uploadedDocuments/${docId}`);
    }
  }, { fallbackIfNoClientAuth: () => undefined });
}

export function subscribeUploadedDocumentsFromFirestore(
  onData: (docs: CloudUploadedDocumentItem[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  reportModuleSyncState('uploadedDocuments', { phase: 'loading' });
  return onSnapshot(
    collection(db, 'uploadedDocuments'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => d.data() as CloudUploadedDocumentItem)
        .filter((d) => d.status !== 'deleted');
      reportModuleSyncState('uploadedDocuments', {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('uploadedDocuments', error);
      if (onError) onError(error);
    }
  );
}

export async function saveIntegrationsMetadataToFirestore(
  integrationsConfig: Record<string, unknown>
): Promise<void> {
  const safeConfig = sanitizeNonSecretIntegrationsConfig(stripUndefinedDeep(integrationsConfig));
  await runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const docRef = doc(db, 'settings', 'integrationsConfig');
    try {
      const existing = await getDocFromServer(docRef);
      const existingData = existing.exists() ? (existing.data() as Record<string, unknown>) : undefined;
      const prevConfig =
        existingData?.integrationsConfig && typeof existingData.integrationsConfig === 'object'
          ? (existingData.integrationsConfig as Record<string, unknown>)
          : {};
      const payload = withStandardCloudFields(
        {
          settingKey: 'integrationsConfig',
          integrationsConfig: { ...prevConfig, ...safeConfig },
          updatedByUid: authUser.uid,
          createdAt: existingData?.createdAt ?? serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        {
          recordId: 'integrationsConfig',
          authUserUid: authUser.uid,
          status: 'Active',
          existingData,
        }
      );
      if (existing.exists()) {
        await updateDoc(docRef, payload);
      } else {
        await setDoc(docRef, payload);
      }
      const verified = await getDocFromServer(docRef);
      if (!verified.exists()) {
        throw new Error('[unavailable] Integrations config could not be verified on Firestore server.');
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'settings/integrationsConfig');
    }
  }, { fallbackIfNoClientAuth: () => undefined });
}

export function subscribeIntegrationsMetadataFromFirestore(
  onData: (config: Record<string, Partial<ApiIntegrationItem>> | null) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  return onSnapshot(
    doc(db, 'settings', 'integrationsConfig'),
    (snap) => {
      recordCloudSyncSuccess();
      if (!snap.exists()) {
        onData(null);
        return;
      }
      const raw = snap.data() as { integrationsConfig?: Record<string, Partial<ApiIntegrationItem>> };
      onData(raw.integrationsConfig ?? null);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      if (onError) onError(error);
    }
  );
}
