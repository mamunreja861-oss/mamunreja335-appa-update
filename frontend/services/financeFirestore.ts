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

export const FINANCE_COLLECTIONS = {
  accounts: 'financeAccounts',
  vouchers: 'financeVouchers',
  periods: 'financePeriods',
  pnbCsp: 'pnbCspLedger',
  suppliers: 'financeSuppliers',
  supplierBills: 'financeSupplierBills',
  bankStatements: 'financeBankStatements',
  assetsLoans: 'financeAssetsLoans',
  vaultDocs: 'financeVaultDocs',
  tasks: 'financeTasks',
  fraudAlerts: 'financeFraudAlerts',
} as const;

export type FinanceCollectionKey = keyof typeof FINANCE_COLLECTIONS;

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

export async function saveFinanceRecordToFirestore<T extends Record<string, unknown>>(
  collectionKey: FinanceCollectionKey,
  docIdRaw: string,
  data: T,
  statusFallback = 'Active'
): Promise<T & { docId: string; recordId: string; businessId: string }> {
  const colName = FINANCE_COLLECTIONS[collectionKey];
  const docId = sanitizeDocId(docIdRaw, 'FIN');
  return runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const ref = doc(db, colName, docId);
    try {
      const existing = await getDocFromServer(ref);
      const existingData = existing.exists() ? (existing.data() as Record<string, unknown>) : undefined;
      const status = String(data.status || statusFallback).slice(0, 64) || 'Active';
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
        throw new Error(`[unavailable] ${colName}/${docId} write could not be verified on Firestore server.`);
      }
      const vData = verified.data() as Record<string, unknown>;
      return {
        ...data,
        ...vData,
        docId: verified.id,
        recordId: String(vData.recordId || verified.id),
        businessId: String(vData.businessId || 'MUN_COMPUTER_MAIN'),
        createdAt: timestampToIso(vData.createdAt),
        updatedAt: timestampToIso(vData.updatedAt),
      } as T & { docId: string; recordId: string; businessId: string };
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `${colName}/${docId}`);
    }
  }, {
    fallbackIfNoClientAuth: () => ({
      ...data,
      docId,
      recordId: docId,
      businessId: 'MUN_COMPUTER_MAIN',
    }) as T & { docId: string; recordId: string; businessId: string },
  });
}

export async function deleteFinanceRecordFromFirestore(
  collectionKey: FinanceCollectionKey,
  docIdRaw: string
): Promise<void> {
  const colName = FINANCE_COLLECTIONS[collectionKey];
  const docId = sanitizeDocId(docIdRaw, 'FIN');
  await runStrictCloudWriteWithRetry(async () => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    try {
      await deleteDoc(doc(db, colName, docId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `${colName}/${docId}`);
    }
  }, { fallbackIfNoClientAuth: () => undefined });
}

export function subscribeFinanceCollectionFromFirestore<T extends Record<string, unknown>>(
  collectionKey: FinanceCollectionKey,
  onData: (items: T[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  const colName = FINANCE_COLLECTIONS[collectionKey];
  reportModuleSyncState(`finance:${collectionKey}`, { phase: 'loading' });
  return onSnapshot(
    collection(db, colName),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        return {
          ...data,
          docId: String(data.docId || d.id),
          createdAt: timestampToIso(data.createdAt),
          updatedAt: timestampToIso(data.updatedAt),
        } as unknown as T;
      });
      reportModuleSyncState(`finance:${collectionKey}`, {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError(`finance:${collectionKey}`, error);
      if (onError) onError(error);
    }
  );
}
