import {
  collection,
  deleteDoc,
  doc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  Unsubscribe,
} from 'firebase/firestore';
import { User } from 'firebase/auth';
import { CustomerSegment } from '../modules/types';
import { ErpCustomerItem } from './erpApi';
import { isSafeRemotePhotoUrl, maskAadhaarValue } from '../utils/customerValidation';
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

const CUSTOMERS_COLLECTION = 'customers';
const VALID_SEGMENTS: CustomerSegment[] = [
  'Regular',
  'General',
  'VIP',
  'Individual',
  'Corporate',
  'Government',
];

function normalizeSegment(value: unknown): CustomerSegment {
  const s = String(value ?? '').trim() as CustomerSegment;
  return VALID_SEGMENTS.includes(s) ? s : 'Regular';
}

function boundStr(value: unknown, maxLen: number): string {
  return String(value ?? '').trim().slice(0, maxLen);
}

function sanitizeArrayOfMaps<T extends object>(arr: unknown, maxItems: number): T[] {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, maxItems).map((item) => {
    const clean: Record<string, unknown> = {};
    if (item && typeof item === 'object') {
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
        if (v !== undefined) clean[k] = v;
      }
    }
    return clean as T;
  });
}

function buildCustomerFirestorePayload(
  customer: ErpCustomerItem,
  authUser: User,
  isCreate: boolean,
  existingData?: Record<string, unknown>
): Record<string, unknown> {
  const cleanMobile = boundStr(customer.mobile, 24);
  const cleanVillage = boundStr(customer.village || 'Local Area', 120) || 'Local Area';
  const rawName = boundStr(customer.fullName || customer.name, 120);
  const safeName = rawName.length >= 2 ? rawName : `${rawName} Customer`;
  const validGender =
    customer.gender === 'Male' || customer.gender === 'Female' || customer.gender === 'Other'
      ? customer.gender
      : 'Male';
  const validSegment = normalizeSegment(customer.segment);
  const validStatus =
    customer.status === 'Active' ||
    customer.status === 'Inactive' ||
    customer.status === 'Blocked'
      ? customer.status
      : 'Active';
  const cleanPan = boundStr(customer.panNumber || customer.pan, 20).toUpperCase();
  const cleanAadhaar = boundStr(maskAadhaarValue(customer.aadhaarMasked || customer.aadhaar), 24);
  const totalBusiness = Math.max(
    0,
    Number(customer.totalBusiness ?? customer.stats?.totalPaid ?? 0) || 0
  );
  const resolvedCustomerId = boundStr(existingData?.customerId || customer.customerId, 64);
  const resolvedReferenceNo = boundStr(
    existingData?.referenceNo ||
      customer.referenceNo ||
      (resolvedCustomerId ? `MCR-${resolvedCustomerId.replace(/^MCC-/, '')}` : ''),
    64
  );
  const rawPhotoUrl = String(customer.photoDownloadURL || customer.photoUrl || '').trim();
  const safePhotoUrl = isSafeRemotePhotoUrl(rawPhotoUrl) ? rawPhotoUrl.slice(0, 1000) : '';
  const safePhotoStoragePath = boundStr(customer.photoStoragePath, 300);

  const payload: Record<string, unknown> = {
    customerId: resolvedCustomerId,
    referenceNo: resolvedReferenceNo,
    fullName: safeName,
    name: safeName,
    fatherOrHusbandName: boundStr(customer.fatherOrHusbandName, 120),
    dob: boundStr(customer.dob, 32),
    gender: validGender,
    mobile: cleanMobile.length >= 8 ? cleanMobile : cleanMobile.padEnd(10, '0'),
    whatsapp: boundStr(customer.whatsapp || cleanMobile, 24),
    email: boundStr(customer.email, 160),
    aadhaarMasked: cleanAadhaar,
    aadhaar: cleanAadhaar,
    panNumber: cleanPan,
    pan: cleanPan,
    voterId: boundStr(customer.voterId, 32),
    village: cleanVillage,
    postOffice: boundStr(customer.postOffice, 120),
    policeStation: boundStr(customer.policeStation, 120),
    district: boundStr(customer.district, 120),
    pinCode: boundStr(customer.pinCode, 16),
    presentAddress: boundStr(customer.presentAddress, 300),
    permanentAddress: boundStr(customer.permanentAddress, 300),
    sameAsPresent: customer.sameAsPresent !== false,
    photoStoragePath: safePhotoStoragePath,
    photoDownloadURL: safePhotoUrl,
    photoUrl: safePhotoUrl,
    segment: validSegment,
    crmTag: boundStr(customer.crmTag || (validSegment === 'VIP' ? 'VIP' : 'New'), 64),
    status: validStatus,
    verificationStatus: boundStr(customer.verificationStatus || 'Unverified', 64),
    mobileOtpVerifiedAt: customer.mobileOtpVerifiedAt
      ? boundStr(customer.mobileOtpVerifiedAt, 64)
      : null,
    totalBusiness,
    consents: sanitizeArrayOfMaps(customer.consents, 15),
    consentHistory: sanitizeArrayOfMaps(customer.consentHistory, 100),
    contactHistory: sanitizeArrayOfMaps(customer.contactHistory, 50),
    notesAndFollowUps: sanitizeArrayOfMaps(customer.notesAndFollowUps, 100),
    deletedAt: customer.deletedAt ? boundStr(customer.deletedAt, 64) : null,
    isArchived: Boolean(customer.isArchived || customer.deletedAt),
    updatedAt: serverTimestamp(),
  };

  if (typeof customer.id === 'number' && Number.isFinite(customer.id)) {
    payload.id = customer.id;
  }

  const hasValidUid =
    typeof existingData?.createdByUid === 'string' && existingData.createdByUid.length > 0;
  payload.createdByUid = hasValidUid ? existingData.createdByUid : authUser.uid;
  payload.createdBy =
    (typeof existingData?.createdBy === 'string' && existingData.createdBy.length > 0
      ? existingData.createdBy
      : boundStr(customer.createdBy || authUser.email || authUser.uid, 64)) || 'SYSTEM';

  if (isCreate || !existingData?.createdAt) {
    payload.createdAt = serverTimestamp();
  } else {
    payload.createdAt = existingData.createdAt;
  }

  return withStandardCloudFields(payload, {
    recordId: resolvedCustomerId || 'MCC_TEMP',
    authUserUid: authUser.uid,
    businessId: existingData?.businessId,
    status: validStatus,
    existingData,
  });
}

export function mapFirestoreCustomerDoc(
  docId: string,
  data: Record<string, unknown>
): ErpCustomerItem {
  const deletedAt = typeof data.deletedAt === 'string' && data.deletedAt.length > 0 ? data.deletedAt : null;
  const isArchived = typeof data.isArchived === 'boolean' ? data.isArchived : Boolean(deletedAt);
  const fullName = String(data.fullName || data.name || '');
  const panNumber = data.panNumber
    ? String(data.panNumber)
    : data.pan
    ? String(data.pan)
    : undefined;
  const aadhaarMaskedRaw = data.aadhaarMasked
    ? String(data.aadhaarMasked)
    : data.aadhaar
    ? String(data.aadhaar)
    : '';
  const aadhaarMasked = aadhaarMaskedRaw ? maskAadhaarValue(aadhaarMaskedRaw) || undefined : undefined;
  const totalBusiness = typeof data.totalBusiness === 'number' ? data.totalBusiness : 0;
  const resolvedId = String(data.customerId || docId);
  const rawPhotoUrl = String(data.photoDownloadURL || data.photoUrl || '').trim();
  const safePhotoUrl = isSafeRemotePhotoUrl(rawPhotoUrl) ? rawPhotoUrl : undefined;
  const photoStoragePath =
    typeof data.photoStoragePath === 'string' && data.photoStoragePath.trim().length > 0
      ? data.photoStoragePath.trim()
      : undefined;

  return {
    id: typeof data.id === 'number' ? data.id : Math.abs(hashStringToPositiveInt(docId)),
    customerId: resolvedId,
    referenceNo:
      typeof data.referenceNo === 'string' && data.referenceNo.trim().length > 0
        ? data.referenceNo.trim()
        : `MCR-${resolvedId.replace(/^MCC-/, '')}`,
    fullName,
    name: fullName,
    fatherOrHusbandName: String(data.fatherOrHusbandName || ''),
    dob: String(data.dob || ''),
    gender: (data.gender as 'Male' | 'Female' | 'Other') || 'Male',
    mobile: String(data.mobile || ''),
    whatsapp: String(data.whatsapp || data.mobile || ''),
    email: String(data.email || ''),
    aadhaarMasked,
    aadhaar: aadhaarMasked,
    panNumber,
    pan: panNumber,
    voterId: data.voterId ? String(data.voterId) : undefined,
    village: String(data.village || ''),
    postOffice: String(data.postOffice || ''),
    policeStation: String(data.policeStation || ''),
    district: String(data.district || ''),
    pinCode: String(data.pinCode || ''),
    presentAddress: String(data.presentAddress || ''),
    permanentAddress: String(data.permanentAddress || ''),
    sameAsPresent: data.sameAsPresent !== false,
    photoStoragePath,
    photoDownloadURL: safePhotoUrl,
    photoUrl: safePhotoUrl,
    segment: normalizeSegment(data.segment),
    crmTag: String(data.crmTag || 'New'),
    status: (data.status as 'Active' | 'Inactive' | 'Blocked') || 'Active',
    verificationStatus: String(data.verificationStatus || 'Unverified'),
    mobileOtpVerifiedAt:
      typeof data.mobileOtpVerifiedAt === 'string' ? data.mobileOtpVerifiedAt : null,
    totalBusiness,
    consents: Array.isArray(data.consents) ? (data.consents as ErpCustomerItem['consents']) : [],
    consentHistory: Array.isArray(data.consentHistory)
      ? (data.consentHistory as ErpCustomerItem['consentHistory'])
      : [],
    contactHistory: Array.isArray(data.contactHistory) ? data.contactHistory : [],
    notesAndFollowUps: Array.isArray(data.notesAndFollowUps)
      ? (data.notesAndFollowUps as ErpCustomerItem['notesAndFollowUps'])
      : [],
    deletedAt,
    isArchived,
    createdBy: String(data.createdBy || ''),
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

function hashStringToPositiveInt(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.max(1, Math.abs(hash));
}

function makeUniqueCollisionSafeCustomerId(baseId: string): string {
  const suffix = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`.toUpperCase();
  const cleanBase = baseId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50) || 'MCC';
  return `${cleanBase}_${suffix}`.slice(0, 64);
}

function normalizePhoneDigits(mobile: string): string {
  return String(mobile || '').replace(/[^\d]/g, '').slice(-10);
}

function getCurrentFinancialYearString(date = new Date()): string {
  const istOffsetMs = 330 * 60_000;
  const ist = new Date(date.getTime() + istOffsetMs);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth() + 1;
  const startYear = month >= 4 ? year : year - 1;
  const endShort = String(startYear + 1).slice(-2);
  return `${startYear}-${endShort}`;
}

/**
 * Inspects authoritative Firestore `customers` documents on the server to:
 * 1) Prevent duplicate active customer creation by mobile or Aadhaar across cold-started servers.
 * 2) Ensure the Customer ID & Reference Number sequence exceeds every existing Firestore customer ID.
 */
export async function ensureFirestoreUniqueCustomerAllocation(params: {
  candidateId: string;
  referenceNo?: string;
  mobile: string;
  aadhaarNumber?: string;
  overrideDuplicateReason?: string;
}): Promise<{ customerId: string; referenceNo: string; maxExistingSequence: number }> {
  if (!db || !auth?.currentUser) {
    const cleanId = String(params.candidateId || '').trim();
    return {
      customerId: cleanId,
      referenceNo: params.referenceNo || (cleanId ? `MCR-${cleanId.replace(/^MCC-/, '')}` : ''),
      maxExistingSequence: 0,
    };
  }

  let snap;
  try {
    snap = await getDocsFromServer(collection(db, CUSTOMERS_COLLECTION));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, CUSTOMERS_COLLECTION);
  }

  const fy = getCurrentFinancialYearString();
  const fyPrefix = `MCC-${fy}-`;
  const targetMob = normalizePhoneDigits(params.mobile);
  const cleanAadhaar = params.aadhaarNumber ? params.aadhaarNumber.replace(/[\s-]/g, '') : '';
  const targetAadhaarMasked = cleanAadhaar.length === 12 ? maskAadhaarValue(cleanAadhaar) : '';

  const existingIds = new Set<string>();
  let maxSeq = 0;

  for (const d of snap.docs) {
    const data = d.data() as Record<string, unknown>;
    const docCustomerId = String(data.customerId || d.id || '').trim();
    if (docCustomerId) {
      existingIds.add(docCustomerId);
      if (docCustomerId.startsWith(fyPrefix)) {
        const suffix = docCustomerId.slice(fyPrefix.length);
        const parsedSeq = /^\d+$/.test(suffix) ? Number(suffix) : 0;
        if (parsedSeq > maxSeq) maxSeq = parsedSeq;
      }
    }

    const isArchived = Boolean(data.deletedAt || data.isArchived);
    if (isArchived) continue;

    if (targetMob && !params.overrideDuplicateReason) {
      const existingMob = normalizePhoneDigits(String(data.mobile || ''));
      if (existingMob && existingMob === targetMob) {
        throw new Error(
          `Potential duplicate customer detected in Firestore (${docCustomerId} matches mobile ${data.mobile}). Provide authorized override reason to create anyway.`
        );
      }
    }

    if (targetAadhaarMasked && !params.overrideDuplicateReason) {
      const existingMasked = String(data.aadhaarMasked || data.aadhaar || '').trim();
      if (existingMasked && existingMasked === targetAadhaarMasked) {
        throw new Error(
          `Potential duplicate customer detected in Firestore (${docCustomerId} matches Aadhaar ${existingMasked}). Provide authorized override reason to create anyway.`
        );
      }
    }
  }

  let finalCustomerId = String(params.candidateId || '').trim();
  const candidateSuffix = finalCustomerId.startsWith(fyPrefix)
    ? finalCustomerId.slice(fyPrefix.length)
    : '';
  const candidateSeq = /^\d+$/.test(candidateSuffix) ? Number(candidateSuffix) : 0;

  if (!finalCustomerId || existingIds.has(finalCustomerId) || candidateSeq <= maxSeq) {
    let nextSeq = Math.max(maxSeq, candidateSeq) + 1;
    finalCustomerId = `${fyPrefix}${String(nextSeq).padStart(6, '0')}`;
    while (existingIds.has(finalCustomerId)) {
      nextSeq += 1;
      finalCustomerId = `${fyPrefix}${String(nextSeq).padStart(6, '0')}`;
    }
  }

  const finalReferenceNo =
    params.referenceNo && finalCustomerId === params.candidateId
      ? params.referenceNo
      : `MCR-${finalCustomerId.replace(/^MCC-/, '')}`;

  return {
    customerId: finalCustomerId,
    referenceNo: finalReferenceNo,
    maxExistingSequence: maxSeq,
  };
}

export async function getMaxFirestoreCustomerSequence(): Promise<number> {
  if (!db || !auth?.currentUser) return 0;
  try {
    const snap = await getDocsFromServer(collection(db, CUSTOMERS_COLLECTION));
    const fyPrefix = `MCC-${getCurrentFinancialYearString()}-`;
    let maxSeq = 0;
    for (const d of snap.docs) {
      const docCustomerId = String((d.data() as Record<string, unknown>).customerId || d.id || '').trim();
      if (docCustomerId.startsWith(fyPrefix)) {
        const suffix = docCustomerId.slice(fyPrefix.length);
        if (/^\d+$/.test(suffix)) {
          maxSeq = Math.max(maxSeq, Number(suffix));
        }
      }
    }
    return maxSeq;
  } catch {
    return 0;
  }
}

export async function saveNewCustomerToFirestore(
  customer: ErpCustomerItem
): Promise<ErpCustomerItem> {
  return runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) {
      throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    }
    let targetCustomer = {
      ...customer,
      name: customer.fullName || customer.name || '',
      segment: normalizeSegment(customer.segment),
      status: customer.status || 'Active',
      isArchived: Boolean(customer.isArchived || customer.deletedAt),
      totalBusiness: Number(customer.totalBusiness ?? customer.stats?.totalPaid ?? 0) || 0,
    };
    let ref = doc(db, CUSTOMERS_COLLECTION, targetCustomer.customerId);
    try {
      const existing = await getDocFromServer(ref);
      if (existing.exists()) {
        const existingData = existing.data() as Record<string, unknown>;
        const samePerson =
          normalizePhoneDigits(String(existingData.mobile || '')) ===
            normalizePhoneDigits(String(customer.mobile || '')) &&
          String(existingData.fullName || existingData.name || '').trim().toLowerCase() ===
            String(customer.fullName || customer.name || '').trim().toLowerCase();
        if (!samePerson) {
          // Express memory restarted after cold-start and reissued an existing sequence ID.
          // Generate a non-colliding ID so existing customer data is preserved intact.
          const newId = makeUniqueCollisionSafeCustomerId(customer.customerId);
          targetCustomer = {
            ...targetCustomer,
            customerId: newId,
            referenceNo: `MCR-${newId.replace(/^MCC-/, '')}`,
          };
          ref = doc(db, CUSTOMERS_COLLECTION, newId);
          const createPayload = buildCustomerFirestorePayload(targetCustomer, authUser, true);
          await setDoc(ref, createPayload);
        } else {
          const updatePayload = buildCustomerFirestorePayload(
            targetCustomer,
            authUser,
            false,
            existingData
          );
          await updateDoc(ref, updatePayload);
        }
      } else {
        const createPayload = buildCustomerFirestorePayload(targetCustomer, authUser, true);
        await setDoc(ref, createPayload);
      }

      // Strictly verify the saved document from the Firestore server (no local cache fallback)
      const verifiedSnap = await getDocFromServer(ref);
      if (!verifiedSnap.exists()) {
        throw new Error(
          `[unavailable] Customer document write (${CUSTOMERS_COLLECTION}/${targetCustomer.customerId}) could not be verified on Firestore server.`
        );
      }
      const verifiedData = verifiedSnap.data() as Record<string, unknown>;
      if (
        targetCustomer.photoDownloadURL &&
        !isSafeRemotePhotoUrl(String(verifiedData.photoDownloadURL || verifiedData.photoUrl || ''))
      ) {
        throw new Error(
          `[invalid-argument] Customer photo URL was not preserved in verified Firestore document (${CUSTOMERS_COLLECTION}/${targetCustomer.customerId}).`
        );
      }
      return mapFirestoreCustomerDoc(verifiedSnap.id, verifiedData);
    } catch (err) {
      handleFirestoreError(
        err,
        OperationType.WRITE,
        `${CUSTOMERS_COLLECTION}/${targetCustomer.customerId}`
      );
    }
  }, { fallbackIfNoClientAuth: () => customer });
}

export async function saveCustomerToFirestore(customer: ErpCustomerItem): Promise<boolean> {
  await runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) {
      throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    }
    const ref = doc(db, CUSTOMERS_COLLECTION, customer.customerId);
    try {
      const existing = await getDocFromServer(ref);
      if (existing.exists()) {
        const updatePayload = buildCustomerFirestorePayload(
          customer,
          authUser,
          false,
          existing.data() as Record<string, unknown>
        );
        await updateDoc(ref, updatePayload);
      } else {
        const createPayload = buildCustomerFirestorePayload(customer, authUser, true);
        await setDoc(ref, createPayload);
      }
      const verified = await getDocFromServer(ref);
      if (!verified.exists()) {
        throw new Error(
          `[unavailable] Customer update (${CUSTOMERS_COLLECTION}/${customer.customerId}) could not be verified on Firestore server.`
        );
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `${CUSTOMERS_COLLECTION}/${customer.customerId}`);
    }
  }, { fallbackIfNoClientAuth: () => undefined });
  return true;
}

export async function saveCustomersBatchToFirestore(
  customers: ErpCustomerItem[]
): Promise<ErpCustomerItem[]> {
  const saved: ErpCustomerItem[] = [];
  for (const cust of customers) {
    const res = await saveNewCustomerToFirestore(cust);
    saved.push(res);
  }
  return saved;
}

export async function deleteCustomerFromFirestore(customerId: string): Promise<boolean> {
  await runStrictCloudWriteWithRetry(async () => {
    if (!db) {
      throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    }
    const path = `${CUSTOMERS_COLLECTION}/${customerId}`;
    try {
      await deleteDoc(doc(db, CUSTOMERS_COLLECTION, customerId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  }, { fallbackIfNoClientAuth: () => undefined });
  return true;
}

export async function fetchCustomerFromFirestoreServer(
  customerId: string
): Promise<ErpCustomerItem | null> {
  if (!db || !auth?.currentUser || !customerId) return null;
  const path = `${CUSTOMERS_COLLECTION}/${customerId}`;
  try {
    const snap = await getDocFromServer(doc(db, CUSTOMERS_COLLECTION, customerId));
    if (!snap.exists()) return null;
    recordCloudSyncSuccess();
    return mapFirestoreCustomerDoc(snap.id, snap.data() as Record<string, unknown>);
  } catch (err) {
    recordCloudSyncError(extractFriendlyErrorMessage(err));
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function fetchCustomersFromFirestore(): Promise<ErpCustomerItem[]> {
  if (!db || !auth?.currentUser) return [];
  try {
    const customersQuery = query(
      collection(db, CUSTOMERS_COLLECTION),
      orderBy('createdAt', 'desc')
    );
    const snap = await getDocs(customersQuery);
    recordCloudSyncSuccess();
    return snap.docs.map((d) =>
      mapFirestoreCustomerDoc(d.id, d.data() as Record<string, unknown>)
    );
  } catch (err) {
    recordCloudSyncError(extractFriendlyErrorMessage(err));
    handleFirestoreError(err, OperationType.LIST, CUSTOMERS_COLLECTION);
  }
}

export function subscribeCustomersFromFirestore(
  onData: (customers: ErpCustomerItem[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) {
    return () => {};
  }
  reportModuleSyncState('customers', { phase: 'loading' });
  const customersQuery = query(
    collection(db, CUSTOMERS_COLLECTION),
    orderBy('createdAt', 'desc')
  );
  return onSnapshot(
    customersQuery,
    (snapshot) => {
      recordCloudSyncSuccess();
      const pending: ErpCustomerItem[] = [];
      const committed: ErpCustomerItem[] = [];
      for (const docSnap of snapshot.docs) {
        const mapped = mapFirestoreCustomerDoc(
          docSnap.id,
          docSnap.data() as Record<string, unknown>
        );
        if (docSnap.metadata.hasPendingWrites) {
          pending.push(mapped);
        } else {
          committed.push(mapped);
        }
      }
      const combined = [...pending, ...committed];
      reportModuleSyncState('customers', {
        phase: combined.length > 0 ? 'ready' : 'empty',
        count: combined.length,
      });
      onData(combined);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('customers', error);
      if (onError) {
        onError(error);
      } else {
        handleFirestoreError(error, OperationType.LIST, CUSTOMERS_COLLECTION);
      }
    }
  );
}
