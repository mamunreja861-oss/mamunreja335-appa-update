import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { User } from 'firebase/auth';
import {
  ErpServiceItem,
  ServiceCategoryItem,
  ServiceSubcategoryItem,
} from '../modules/types';
import {
  auth,
  db,
  handleFirestoreError,
  OperationType,
  timestampToIso,
  withStandardCloudFields,
} from './firebase';
import { runStrictCloudWriteWithRetry } from './cloudSync';

export const SERVICE_CATEGORIES_COLLECTION = 'serviceCategories';
export const SERVICE_SUBCATEGORIES_COLLECTION = 'serviceSubcategories';
export const SERVICES_COLLECTION = 'services';
export const SECURITY_LOGS_COLLECTION = 'securityLogs';
export const SETTINGS_COLLECTION = 'settings';
export const CATALOG_SEED_DOC_ID = 'catalogSeed';

export interface CatalogSeedMeta {
  seeded: boolean;
  deletedServiceIds: string[];
  deletedServiceCodes: string[];
  deletedCategoryCodes: string[];
  deletedSubcategoryCodes: string[];
  updatedAtIso?: string;
}

export function parseCatalogSeedMeta(raw: unknown): CatalogSeedMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const meta = (obj.catalogSeedMeta && typeof obj.catalogSeedMeta === 'object'
    ? obj.catalogSeedMeta
    : obj) as Record<string, unknown>;
  return {
    seeded: Boolean(meta.seeded),
    deletedServiceIds: Array.isArray(meta.deletedServiceIds)
      ? meta.deletedServiceIds.map((v) => String(v))
      : [],
    deletedServiceCodes: Array.isArray(meta.deletedServiceCodes)
      ? meta.deletedServiceCodes.map((v) => String(v))
      : [],
    deletedCategoryCodes: Array.isArray(meta.deletedCategoryCodes)
      ? meta.deletedCategoryCodes.map((v) => String(v))
      : [],
    deletedSubcategoryCodes: Array.isArray(meta.deletedSubcategoryCodes)
      ? meta.deletedSubcategoryCodes.map((v) => String(v))
      : [],
    updatedAtIso: typeof meta.updatedAtIso === 'string' ? meta.updatedAtIso : undefined,
  };
}

function boundStr(value: unknown, maxLen: number): string {
  return String(value ?? '').trim().slice(0, maxLen);
}

function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = stripUndefinedDeep(v);
      }
    }
    return out as T;
  }
  return value;
}

function sanitizeArrayOfMaps<T extends object>(arr: unknown, maxItems: number): T[] {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, maxItems).map((item) => stripUndefinedDeep(item && typeof item === 'object' ? item : {}) as T);
}

function hashIdToPositiveInt(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.max(1, Math.abs(hash));
}

export function computeContinuousServiceSerials(
  list: ErpServiceItem[]
): ErpServiceItem[] {
  const sorted = [...list].sort(
    (a, b) => (a.displayOrder ?? a.id) - (b.displayOrder ?? b.id) || a.id - b.id
  );
  let activeCounter = 0;
  return sorted.map((svc) => {
    if (svc.deletedAt) {
      return { ...svc, serialNumber: 'ARCHIVED' };
    }
    activeCounter += 1;
    return {
      ...svc,
      displayOrder: activeCounter,
      serialNumber: String(activeCounter).padStart(3, '0'),
    };
  });
}

export function mapFirestoreCategoryDoc(
  docId: string,
  data: Record<string, unknown>
): ServiceCategoryItem {
  const code = String(data.code || docId);
  const numMatch = code.match(/(\d+)$/);
  const fallbackId = numMatch ? Number(numMatch[1]) : hashIdToPositiveInt(docId);
  return {
    id: typeof data.id === 'number' && Number.isFinite(data.id) ? data.id : fallbackId,
    code,
    name: String(data.name || ''),
    description: String(data.description || ''),
    displayOrder:
      typeof data.displayOrder === 'number' && Number.isFinite(data.displayOrder)
        ? data.displayOrder
        : fallbackId,
    status: (data.status as ServiceCategoryItem['status']) || 'active',
    proposedBy: String(data.proposedBy || 'SYSTEM'),
    approvedBy: data.approvedBy ? String(data.approvedBy) : null,
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

export function mapFirestoreSubcategoryDoc(
  docId: string,
  data: Record<string, unknown>
): ServiceSubcategoryItem {
  const code = String(data.code || docId);
  const fallbackId = hashIdToPositiveInt(docId);
  return {
    id: typeof data.id === 'number' && Number.isFinite(data.id) ? data.id : fallbackId,
    code,
    categoryId: typeof data.categoryId === 'number' ? data.categoryId : 1,
    categoryName: String(data.categoryName || ''),
    name: String(data.name || ''),
    description: String(data.description || ''),
    displayOrder:
      typeof data.displayOrder === 'number' && Number.isFinite(data.displayOrder)
        ? data.displayOrder
        : 1,
    status: (data.status as ServiceSubcategoryItem['status']) || 'active',
    createdBy: String(data.createdBy || 'SYSTEM'),
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

export function mapFirestoreServiceDoc(
  docId: string,
  data: Record<string, unknown>
): ErpServiceItem {
  const serviceId = String(data.serviceId || docId);
  const serviceCharge = Number(data.serviceCharge ?? data.customerCharge ?? 0);
  const govtFee = Number(data.govtFee ?? 0);
  const additionalCharges = Number(data.additionalCharges ?? 0);
  const serviceCost = Number(data.serviceCost ?? 0);
  const totalCustomerCharge = Number(
    data.totalCustomerCharge ?? data.customerCharge ?? serviceCharge + govtFee + additionalCharges
  );
  const profitAmount = Number(
    data.profitAmount ?? serviceCharge + additionalCharges - serviceCost
  );

  return {
    id:
      typeof data.id === 'number' && Number.isFinite(data.id)
        ? data.id
        : hashIdToPositiveInt(serviceId),
    serviceId,
    serviceCode: String(data.serviceCode || serviceId),
    name: String(data.name || ''),
    categoryId: typeof data.categoryId === 'number' ? data.categoryId : 1,
    categoryName: String(data.categoryName || 'General'),
    subcategoryId:
      typeof data.subcategoryId === 'number' ? data.subcategoryId : undefined,
    subcategoryName:
      typeof data.subcategoryName === 'string' && data.subcategoryName
        ? data.subcategoryName
        : undefined,
    description: String(data.description || ''),
    serviceCharge,
    serviceCost,
    govtFee,
    additionalCharges,
    totalCustomerCharge,
    customerCharge: totalCustomerCharge,
    profitAmount,
    status: (data.status as ErpServiceItem['status']) || 'Active',
    availability: (data.availability as ErpServiceItem['availability']) || 'Available',
    serviceInstructions: String(data.serviceInstructions || data.termsAndConditions || ''),
    termsAndConditions: String(data.termsAndConditions || data.serviceInstructions || ''),
    displayOrder:
      typeof data.displayOrder === 'number' && Number.isFinite(data.displayOrder)
        ? data.displayOrder
        : undefined,
    sla: (data.sla as ErpServiceItem['sla']) || {
      processingMode: 'FIXED',
      expectedDays: 3,
      minDays: 1,
      maxDays: 5,
      dayType: 'WORKING',
      excludeHolidays: true,
      startEvent: 'ON_SUBMIT',
      pauseOnStatuses: ['Pending Customer', 'Pending Office', 'On Hold'],
      warningThresholdPct: 75,
      breachThresholdHours: 72,
      escalateToManagerAtWarning: true,
      escalateToAdminAtBreach: true,
    },
    requiredDocuments: Array.isArray(data.requiredDocuments)
      ? (data.requiredDocuments as ErpServiceItem['requiredDocuments'])
      : [],
    currentFormVersion:
      typeof data.currentFormVersion === 'number' ? data.currentFormVersion : 1,
    formVersions: Array.isArray(data.formVersions)
      ? (data.formVersions as ErpServiceItem['formVersions'])
      : [],
    automationRules: Array.isArray(data.automationRules)
      ? (data.automationRules as ErpServiceItem['automationRules'])
      : [],
    processingTimeHistory: Array.isArray(data.processingTimeHistory)
      ? (data.processingTimeHistory as ErpServiceItem['processingTimeHistory'])
      : [],
    deletedAt: typeof data.deletedAt === 'string' && data.deletedAt ? data.deletedAt : null,
    createdBy: String(data.createdBy || 'SYSTEM'),
    updatedBy: data.updatedBy ? String(data.updatedBy) : undefined,
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

function buildCategoryFirestorePayload(
  cat: ServiceCategoryItem,
  authUser: User,
  isCreate: boolean,
  existingData?: Record<string, unknown>
): Record<string, unknown> {
  const validStatus =
    cat.status === 'active' || cat.status === 'pending_approval' || cat.status === 'archived'
      ? cat.status
      : 'active';
  const cleanName = boundStr(cat.name, 120);
  const payload: Record<string, unknown> = {
    code: boundStr(existingData?.code || cat.code, 64),
    name: cleanName.length >= 2 ? cleanName : `${cleanName} Category`,
    description: boundStr(cat.description, 400),
    displayOrder: Number.isFinite(Number(cat.displayOrder)) ? Number(cat.displayOrder) : cat.id,
    status: validStatus,
    proposedBy: boundStr(cat.proposedBy || authUser.email || authUser.uid, 64),
    approvedBy: cat.approvedBy ? boundStr(cat.approvedBy, 64) : null,
    updatedBy: boundStr(authUser.email || authUser.uid, 64),
    updatedAt: serverTimestamp(),
  };

  if (typeof cat.id === 'number' && Number.isFinite(cat.id)) {
    payload.id = cat.id;
  }

  const hasValidExistingUid =
    typeof existingData?.createdByUid === 'string' && existingData.createdByUid.length > 0;
  if (isCreate || !hasValidExistingUid) {
    payload.createdByUid = authUser.uid;
  }
  const hasValidExistingCreatedAt = Boolean(existingData?.createdAt);
  if (isCreate || !hasValidExistingCreatedAt) {
    payload.createdAt = serverTimestamp();
    payload.createdBy = boundStr(cat.proposedBy || authUser.email || authUser.uid, 64) || 'SYSTEM';
  }

  const code = boundStr(existingData?.code || cat.code, 64);
  return withStandardCloudFields(stripUndefinedDeep(payload), {
    recordId: code,
    authUserUid: authUser.uid,
    status: validStatus,
    existingData,
  });
}

function buildSubcategoryFirestorePayload(
  sub: ServiceSubcategoryItem,
  authUser: User,
  isCreate: boolean,
  existingData?: Record<string, unknown>
): Record<string, unknown> {
  const validStatus = sub.status === 'archived' ? 'archived' : 'active';
  const cleanName = boundStr(sub.name, 120);
  const payload: Record<string, unknown> = {
    code: boundStr(existingData?.code || sub.code, 64),
    categoryId: Number(sub.categoryId) || 1,
    categoryName: boundStr(sub.categoryName, 120),
    name: cleanName.length >= 2 ? cleanName : `${cleanName} Subcategory`,
    description: boundStr(sub.description, 400),
    displayOrder: Number.isFinite(Number(sub.displayOrder)) ? Number(sub.displayOrder) : 1,
    status: validStatus,
    updatedBy: boundStr(authUser.email || authUser.uid, 64),
    updatedAt: serverTimestamp(),
  };

  if (typeof sub.id === 'number' && Number.isFinite(sub.id)) {
    payload.id = sub.id;
  }

  const hasValidExistingUid =
    typeof existingData?.createdByUid === 'string' && existingData.createdByUid.length > 0;
  if (isCreate || !hasValidExistingUid) {
    payload.createdByUid = authUser.uid;
  }
  if (isCreate || !existingData?.createdAt) {
    payload.createdAt = serverTimestamp();
    payload.createdBy = boundStr(sub.createdBy || authUser.email || authUser.uid, 64) || 'SYSTEM';
  }

  const code = boundStr(existingData?.code || sub.code, 64);
  return withStandardCloudFields(stripUndefinedDeep(payload), {
    recordId: code,
    authUserUid: authUser.uid,
    status: validStatus,
    existingData,
  });
}

function buildServiceFirestorePayload(
  svc: ErpServiceItem,
  authUser: User,
  isCreate: boolean,
  existingData?: Record<string, unknown>
): Record<string, unknown> {
  const cleanName = boundStr(svc.name, 160);
  const serviceCharge = Math.max(0, Number(svc.serviceCharge ?? svc.customerCharge ?? 0));
  const govtFee = Math.max(0, Number(svc.govtFee ?? 0));
  const additionalCharges = Math.max(0, Number(svc.additionalCharges ?? 0));
  const serviceCost = Math.max(0, Number(svc.serviceCost ?? 0));
  const totalCustomerCharge =
    Math.round((serviceCharge + govtFee + additionalCharges) * 100) / 100;
  const profitAmount =
    Math.round((serviceCharge + additionalCharges - serviceCost) * 100) / 100;

  const validStatus =
    svc.status === 'Active' ||
    svc.status === 'Inactive' ||
    svc.status === 'Temporarily Suspended' ||
    svc.status === 'Archived'
      ? svc.status
      : 'Active';
  const validAvailability = svc.availability === 'Unavailable' ? 'Unavailable' : 'Available';

  const cleanInstructions = boundStr(svc.serviceInstructions || svc.termsAndConditions, 2000);
  const cleanSla = stripUndefinedDeep({
    processingMode: svc.sla?.processingMode === 'RANGE' ? 'RANGE' : 'FIXED',
    expectedDays: Math.max(1, Number(svc.sla?.expectedDays ?? 3)),
    minDays: Math.max(1, Number(svc.sla?.minDays ?? 1)),
    maxDays: Math.max(1, Number(svc.sla?.maxDays ?? 5)),
    dayType: svc.sla?.dayType === 'CALENDAR' ? 'CALENDAR' : 'WORKING',
    excludeHolidays: svc.sla?.excludeHolidays !== false,
    startEvent: svc.sla?.startEvent === 'ON_ASSIGN' ? 'ON_ASSIGN' : 'ON_SUBMIT',
    pauseOnStatuses: Array.isArray(svc.sla?.pauseOnStatuses)
      ? svc.sla.pauseOnStatuses.slice(0, 10)
      : ['Pending Customer', 'Pending Office', 'On Hold'],
    warningThresholdPct: Number(svc.sla?.warningThresholdPct ?? 75),
    breachThresholdHours: Number(svc.sla?.breachThresholdHours ?? 72),
    escalateToManagerAtWarning: svc.sla?.escalateToManagerAtWarning !== false,
    escalateToAdminAtBreach: svc.sla?.escalateToAdminAtBreach !== false,
  });

  // Preserve newest up to 20 formVersions within firestore.rules limit
  const trimmedFormVersions =
    Array.isArray(svc.formVersions) && svc.formVersions.length > 20
      ? svc.formVersions.slice(-20)
      : svc.formVersions;

  const payload: Record<string, unknown> = {
    serviceId: boundStr(existingData?.serviceId || svc.serviceId, 128),
    serviceCode: boundStr(existingData?.serviceCode || svc.serviceCode, 64),
    name: cleanName.length >= 2 ? cleanName : `${cleanName} Service`,
    categoryId: Number(svc.categoryId) || 1,
    categoryName: boundStr(svc.categoryName, 120),
    subcategoryId:
      typeof svc.subcategoryId === 'number' && Number.isFinite(svc.subcategoryId)
        ? svc.subcategoryId
        : null,
    subcategoryName: svc.subcategoryName ? boundStr(svc.subcategoryName, 120) : null,
    description: boundStr(svc.description, 600),
    serviceCharge,
    serviceCost,
    govtFee,
    additionalCharges,
    totalCustomerCharge,
    customerCharge: totalCustomerCharge,
    profitAmount,
    status: validStatus,
    availability: validAvailability,
    serviceInstructions: cleanInstructions,
    termsAndConditions: cleanInstructions,
    displayOrder: Number.isFinite(Number(svc.displayOrder)) ? Number(svc.displayOrder) : svc.id,
    sla: cleanSla,
    requiredDocuments: sanitizeArrayOfMaps(svc.requiredDocuments, 30),
    currentFormVersion: Number(svc.currentFormVersion ?? 1),
    formVersions: sanitizeArrayOfMaps(trimmedFormVersions, 20),
    automationRules: sanitizeArrayOfMaps(svc.automationRules, 20),
    processingTimeHistory: sanitizeArrayOfMaps(svc.processingTimeHistory, 50),
    deletedAt: svc.deletedAt ? boundStr(svc.deletedAt, 64) : null,
    updatedBy: boundStr(svc.updatedBy || authUser.email || authUser.uid, 64),
    updatedAt: serverTimestamp(),
  };

  if (typeof svc.id === 'number' && Number.isFinite(svc.id)) {
    payload.id = svc.id;
  }

  const hasValidExistingUid =
    typeof existingData?.createdByUid === 'string' && existingData.createdByUid.length > 0;
  if (isCreate || !hasValidExistingUid) {
    payload.createdByUid = authUser.uid;
  }
  if (isCreate || !existingData?.createdAt) {
    payload.createdAt = serverTimestamp();
    payload.createdBy = boundStr(svc.createdBy || authUser.email || authUser.uid, 64) || 'SYSTEM';
  }

  const resolvedServiceId = boundStr(existingData?.serviceId || svc.serviceId, 128);
  return withStandardCloudFields(stripUndefinedDeep(payload), {
    recordId: resolvedServiceId,
    authUserUid: authUser.uid,
    status: validStatus,
    existingData,
  });
}

export async function saveServiceCategoryToFirestore(
  cat: ServiceCategoryItem
): Promise<boolean> {
  return runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const path = `${SERVICE_CATEGORIES_COLLECTION}/${cat.code}`;
    const ref = doc(db, SERVICE_CATEGORIES_COLLECTION, cat.code);
    try {
      const existing = await getDocFromServer(ref);
      if (existing.exists()) {
        const payload = buildCategoryFirestorePayload(
          cat,
          authUser,
          false,
          existing.data() as Record<string, unknown>
        );
        await updateDoc(ref, payload);
      } else {
        const payload = buildCategoryFirestorePayload(cat, authUser, true);
        await setDoc(ref, payload);
      }
      const verified = await getDocFromServer(ref);
      if (!verified.exists()) {
        throw new Error(`[unavailable] Service category (${cat.code}) could not be verified on Firestore server.`);
      }
      return true;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  }, { fallbackIfNoClientAuth: () => true });
}

export async function getCatalogSeedMetaFromFirestore(): Promise<CatalogSeedMeta | null> {
  if (!db || !auth?.currentUser) return null;
  const path = `${SETTINGS_COLLECTION}/${CATALOG_SEED_DOC_ID}`;
  try {
    const snap = await getDoc(doc(db, SETTINGS_COLLECTION, CATALOG_SEED_DOC_ID));
    if (!snap.exists()) return null;
    return parseCatalogSeedMeta(snap.data());
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function saveCatalogSeedMetaInFirestore(
  meta: CatalogSeedMeta
): Promise<boolean> {
  if (!db || !auth?.currentUser) return false;
  const path = `${SETTINGS_COLLECTION}/${CATALOG_SEED_DOC_ID}`;
  const ref = doc(db, SETTINGS_COLLECTION, CATALOG_SEED_DOC_ID);
  const cleanMeta: CatalogSeedMeta = {
    seeded: Boolean(meta.seeded),
    deletedServiceIds: Array.from(new Set(meta.deletedServiceIds)).slice(0, 2000),
    deletedServiceCodes: Array.from(new Set(meta.deletedServiceCodes)).slice(0, 2000),
    deletedCategoryCodes: Array.from(new Set(meta.deletedCategoryCodes)).slice(0, 500),
    deletedSubcategoryCodes: Array.from(new Set(meta.deletedSubcategoryCodes)).slice(0, 1000),
    updatedAtIso: new Date().toISOString(),
  };
  try {
    const existing = await getDoc(ref);
    if (existing.exists()) {
      const existingData = existing.data() as Record<string, unknown>;
      const updatePayload: Record<string, unknown> = {
        catalogSeedMeta: cleanMeta,
        updatedByUid: auth.currentUser.uid,
        updatedAt: serverTimestamp(),
      };
      if (typeof existingData.settingKey !== 'string') {
        updatePayload.settingKey = CATALOG_SEED_DOC_ID;
      }
      if (!existingData.createdAt) {
        updatePayload.createdAt = serverTimestamp();
      }
      await updateDoc(ref, updatePayload);
    } else {
      await setDoc(ref, {
        settingKey: CATALOG_SEED_DOC_ID,
        catalogSeedMeta: cleanMeta,
        updatedByUid: auth.currentUser.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function recordCatalogTombstoneInFirestore(delta: {
  deletedServiceIds?: string[];
  deletedServiceCodes?: string[];
  deletedCategoryCodes?: string[];
  deletedSubcategoryCodes?: string[];
  seeded?: boolean;
}): Promise<boolean> {
  if (!db || !auth?.currentUser) return false;
  const existing = (await getCatalogSeedMetaFromFirestore()) ?? {
    seeded: true,
    deletedServiceIds: [],
    deletedServiceCodes: [],
    deletedCategoryCodes: [],
    deletedSubcategoryCodes: [],
  };
  const next: CatalogSeedMeta = {
    seeded: delta.seeded !== undefined ? delta.seeded : existing.seeded,
    deletedServiceIds: Array.from(
      new Set([...existing.deletedServiceIds, ...(delta.deletedServiceIds ?? [])])
    ),
    deletedServiceCodes: Array.from(
      new Set([...existing.deletedServiceCodes, ...(delta.deletedServiceCodes ?? [])])
    ),
    deletedCategoryCodes: Array.from(
      new Set([...existing.deletedCategoryCodes, ...(delta.deletedCategoryCodes ?? [])])
    ),
    deletedSubcategoryCodes: Array.from(
      new Set([...existing.deletedSubcategoryCodes, ...(delta.deletedSubcategoryCodes ?? [])])
    ),
  };
  return saveCatalogSeedMetaInFirestore(next);
}

export async function deleteServiceCategoryFromFirestore(code: string): Promise<boolean> {
  return runStrictCloudWriteWithRetry(async () => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const path = `${SERVICE_CATEGORIES_COLLECTION}/${code}`;
    try {
      await deleteDoc(doc(db, SERVICE_CATEGORIES_COLLECTION, code));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
    await recordCatalogTombstoneInFirestore({ deletedCategoryCodes: [code], seeded: true });
    return true;
  }, { fallbackIfNoClientAuth: () => true });
}

export async function saveServiceSubcategoryToFirestore(
  sub: ServiceSubcategoryItem
): Promise<boolean> {
  return runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const path = `${SERVICE_SUBCATEGORIES_COLLECTION}/${sub.code}`;
    const ref = doc(db, SERVICE_SUBCATEGORIES_COLLECTION, sub.code);
    try {
      const existing = await getDocFromServer(ref);
      if (existing.exists()) {
        const payload = buildSubcategoryFirestorePayload(
          sub,
          authUser,
          false,
          existing.data() as Record<string, unknown>
        );
        await updateDoc(ref, payload);
      } else {
        const payload = buildSubcategoryFirestorePayload(sub, authUser, true);
        await setDoc(ref, payload);
      }
      const verified = await getDocFromServer(ref);
      if (!verified.exists()) {
        throw new Error(`[unavailable] Service subcategory (${sub.code}) could not be verified on Firestore server.`);
      }
      return true;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  }, { fallbackIfNoClientAuth: () => true });
}

export async function deleteServiceSubcategoryFromFirestore(code: string): Promise<boolean> {
  return runStrictCloudWriteWithRetry(async () => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const path = `${SERVICE_SUBCATEGORIES_COLLECTION}/${code}`;
    try {
      await deleteDoc(doc(db, SERVICE_SUBCATEGORIES_COLLECTION, code));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
    await recordCatalogTombstoneInFirestore({ deletedSubcategoryCodes: [code], seeded: true });
    return true;
  }, { fallbackIfNoClientAuth: () => true });
}

export async function saveServiceToFirestore(svc: ErpServiceItem): Promise<boolean> {
  return runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const path = `${SERVICES_COLLECTION}/${svc.serviceId}`;
    const ref = doc(db, SERVICES_COLLECTION, svc.serviceId);
    try {
      const existing = await getDocFromServer(ref);
      if (existing.exists()) {
        const payload = buildServiceFirestorePayload(
          svc,
          authUser,
          false,
          existing.data() as Record<string, unknown>
        );
        await updateDoc(ref, payload);
      } else {
        const payload = buildServiceFirestorePayload(svc, authUser, true);
        await setDoc(ref, payload);
      }
      const verified = await getDocFromServer(ref);
      if (!verified.exists()) {
        throw new Error(`[unavailable] Service (${svc.serviceId}) could not be verified on Firestore server.`);
      }
      return true;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  }, { fallbackIfNoClientAuth: () => true });
}

export async function deleteServiceFromFirestore(
  serviceId: string,
  serviceCode?: string
): Promise<boolean> {
  return runStrictCloudWriteWithRetry(async () => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const path = `${SERVICES_COLLECTION}/${serviceId}`;
    try {
      await deleteDoc(doc(db, SERVICES_COLLECTION, serviceId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
    await recordCatalogTombstoneInFirestore({
      deletedServiceIds: [serviceId],
      deletedServiceCodes: serviceCode ? [serviceCode] : [],
      seeded: true,
    });
    return true;
  }, { fallbackIfNoClientAuth: () => true });
}

/**
 * After deleting or adding a service, persists updated displayOrder for existing Firestore service docs
 * whose position shifted, without touching createdByUid/createdAt/serviceId/serviceCode.
 */
export async function resequenceServicesDisplayOrderInFirestore(
  orderedServices: ErpServiceItem[]
): Promise<number> {
  if (!db || !auth?.currentUser) return 0;
  try {
    const snap = await getDocs(collection(db, SERVICES_COLLECTION));
    const existingMap = new Map<string, Record<string, unknown>>();
    for (const d of snap.docs) {
      existingMap.set(d.id, d.data() as Record<string, unknown>);
    }

    const toUpdate: Array<{ serviceId: string; nextOrder: number; existing: Record<string, unknown> }> = [];
    orderedServices.forEach((svc, idx) => {
      const nextOrder = idx + 1;
      const existing = existingMap.get(svc.serviceId);
      if (existing && existing.displayOrder !== nextOrder) {
        toUpdate.push({ serviceId: svc.serviceId, nextOrder, existing });
      }
    });

    if (toUpdate.length === 0) return 0;

    const BATCH_LIMIT = 350;
    for (let i = 0; i < toUpdate.length; i += BATCH_LIMIT) {
      const chunk = toUpdate.slice(i, i + BATCH_LIMIT);
      const batch = writeBatch(db);
      for (const item of chunk) {
        const ref = doc(db, SERVICES_COLLECTION, item.serviceId);
        const updateData: Record<string, unknown> = {
          displayOrder: item.nextOrder,
          updatedBy: boundStr(auth.currentUser.email || auth.currentUser.uid, 64),
          updatedAt: serverTimestamp(),
        };
        if (!item.existing.createdByUid) {
          updateData.createdByUid = auth.currentUser.uid;
        }
        if (!item.existing.createdAt) {
          updateData.createdAt = serverTimestamp();
        }
        batch.update(ref, updateData);
      }
      await batch.commit();
    }
    return toUpdate.length;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, SERVICES_COLLECTION);
  }
}

/**
 * Safely seeds missing master catalog documents (Categories, Subcategories, Services) into Firestore.
 * Existing Firestore documents are NEVER overwritten or duplicated so customized rates, forms, SLA and docs stay intact.
 * Deleted items tracked in settings/catalogSeed tombstones stay deleted unless restoreDeleted=true.
 */
export async function syncMissingCatalogToFirestore(params: {
  categories: ServiceCategoryItem[];
  subcategories: ServiceSubcategoryItem[];
  services: ErpServiceItem[];
  restoreDeleted?: boolean;
}): Promise<{ createdCategories: number; createdSubcategories: number; createdServices: number }> {
  if (!db || !auth?.currentUser) {
    return { createdCategories: 0, createdSubcategories: 0, createdServices: 0 };
  }
  const authUser = auth.currentUser;
  const currentMeta = await getCatalogSeedMetaFromFirestore();
  const deletedCatCodes = new Set(params.restoreDeleted ? [] : currentMeta?.deletedCategoryCodes ?? []);
  const deletedSubCodes = new Set(params.restoreDeleted ? [] : currentMeta?.deletedSubcategoryCodes ?? []);
  const deletedSvcIds = new Set(params.restoreDeleted ? [] : currentMeta?.deletedServiceIds ?? []);
  const deletedSvcCodes = new Set(params.restoreDeleted ? [] : currentMeta?.deletedServiceCodes ?? []);

  let existingCatIds: Set<string>;
  let existingSubIds: Set<string>;
  let existingSvcIds: Set<string>;
  try {
    const [catSnap, subSnap, svcSnap] = await Promise.all([
      getDocs(collection(db, SERVICE_CATEGORIES_COLLECTION)),
      getDocs(collection(db, SERVICE_SUBCATEGORIES_COLLECTION)),
      getDocs(collection(db, SERVICES_COLLECTION)),
    ]);
    existingCatIds = new Set(catSnap.docs.map((d) => d.id));
    existingSubIds = new Set(subSnap.docs.map((d) => d.id));
    existingSvcIds = new Set(svcSnap.docs.map((d) => d.id));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, SERVICES_COLLECTION);
  }

  const deletedCatIdNumbers = new Set(
    params.categories.filter((c) => deletedCatCodes.has(c.code)).map((c) => c.id)
  );
  const deletedSubIdNumbers = new Set(
    params.subcategories
      .filter((sc) => deletedSubCodes.has(sc.code) || deletedCatIdNumbers.has(sc.categoryId))
      .map((sc) => sc.id)
  );

  const missingCats = params.categories.filter(
    (c) => !existingCatIds.has(c.code) && !deletedCatCodes.has(c.code)
  );
  const missingSubs = params.subcategories.filter(
    (sc) =>
      !existingSubIds.has(sc.code) &&
      !deletedSubCodes.has(sc.code) &&
      !deletedCatIdNumbers.has(sc.categoryId)
  );
  const missingSvcs = params.services.filter(
    (s) =>
      !existingSvcIds.has(s.serviceId) &&
      !deletedSvcIds.has(s.serviceId) &&
      !deletedSvcCodes.has(s.serviceCode) &&
      !deletedCatIdNumbers.has(s.categoryId) &&
      !(s.subcategoryId !== undefined && deletedSubIdNumbers.has(s.subcategoryId))
  );

  const ops: Array<{ col: string; id: string; data: Record<string, unknown> }> = [
    ...missingCats.map((c) => ({
      col: SERVICE_CATEGORIES_COLLECTION,
      id: c.code,
      data: buildCategoryFirestorePayload(c, authUser, true),
    })),
    ...missingSubs.map((sc) => ({
      col: SERVICE_SUBCATEGORIES_COLLECTION,
      id: sc.code,
      data: buildSubcategoryFirestorePayload(sc, authUser, true),
    })),
    ...missingSvcs.map((s) => ({
      col: SERVICES_COLLECTION,
      id: s.serviceId,
      data: buildServiceFirestorePayload(s, authUser, true),
    })),
  ];

  if (ops.length > 0) {
    const BATCH_LIMIT = 300;
    try {
      for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
        const chunk = ops.slice(i, i + BATCH_LIMIT);
        const batch = writeBatch(db);
        for (const op of chunk) {
          batch.set(doc(db, op.col, op.id), op.data);
        }
        await batch.commit();
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, SERVICES_COLLECTION);
    }
  }

  await saveCatalogSeedMetaInFirestore({
    seeded: true,
    deletedServiceIds: Array.from(deletedSvcIds),
    deletedServiceCodes: Array.from(deletedSvcCodes),
    deletedCategoryCodes: Array.from(deletedCatCodes),
    deletedSubcategoryCodes: Array.from(deletedSubCodes),
  });

  return {
    createdCategories: missingCats.length,
    createdSubcategories: missingSubs.length,
    createdServices: missingSvcs.length,
  };
}

export async function writeServiceAuditLogToFirestore(params: {
  actorUserId: string;
  eventType: string;
  summary: string;
  result?: 'SUCCESS' | 'FAILURE' | 'BLOCKED';
}): Promise<boolean> {
  if (!db || !auth?.currentUser) return false;
  const logId = `LOG_SRV_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const path = `${SECURITY_LOGS_COLLECTION}/${logId}`;
  try {
    await setDoc(doc(db, SECURITY_LOGS_COLLECTION, logId), {
      eventType: boundStr(params.eventType || 'SERVICE_UPDATED', 64),
      actorUserId: boundStr(params.actorUserId || auth.currentUser.uid, 64) || 'SYSTEM',
      result: params.result || 'SUCCESS',
      deviceInfo: 'MUN COMPUTER Web Console',
      summary: boundStr(params.summary || 'Service catalog updated', 400),
      createdByUid: auth.currentUser.uid,
      createdAt: serverTimestamp(),
    });
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}
