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
  CscCategory,
  CscDocumentRecord,
  CscOrderRecord,
  CscRateHistoryEntry,
  CscService,
  GrievanceRecord,
  PvcOrder,
  PvcRateSlab,
  WholesaleShop,
} from '../../shared/cscTypes';
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

function boundStr(val: unknown, maxLen: number): string {
  return String(val ?? '').trim().slice(0, maxLen);
}

function sanitizeValidId(val: unknown, prefix = 'CSC'): string {
  const cleaned = String(val ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 128);
  return cleaned.length >= 1 ? cleaned : `${prefix}_${Date.now()}`;
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

function sanitizeArrayOfMaps<T extends object>(arr: unknown, maxItems: number): T[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .slice(0, maxItems)
    .map((item) => stripUndefinedDeep(item && typeof item === 'object' ? item : {}) as T);
}

// ============================================================================
// CSC Categories, Service Overrides & Rate History
// ============================================================================
const VALID_MODULE_TAGS = new Set([
  'GENERAL',
  'PMJAY',
  'MMSBY',
  'NPCI',
  'CYBER_CRIME',
  'PVC',
  'GRIEVANCE',
  'RTI',
]);

export async function saveCscCategoryToFirestore(cat: CscCategory): Promise<CscCategory> {
  return runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const id = sanitizeValidId(cat.id, 'CAT');
    const ref = doc(db, 'cscCustomCategories', id);
    try {
      const existing = await getDocFromServer(ref);
      const existingData = existing.exists()
        ? (existing.data() as Record<string, unknown>)
        : undefined;
      const cleanName = boundStr(cat.name, 160);
      const cleanCode = boundStr(cat.code || id, 40);
      const status = cat.active !== false ? 'Active' : 'Inactive';
      const payload = withStandardCloudFields(
        stripUndefinedDeep({
          id,
          code: cleanCode.length >= 2 ? cleanCode : `${cleanCode}C`,
          name: cleanName.length >= 2 ? cleanName : `${cleanName} Category`,
          icon: boundStr(cat.icon || 'FolderOpen', 64),
          description: boundStr(cat.description, 500),
          displayOrder: Number(cat.displayOrder ?? 1),
          active: cat.active !== false,
          noticeText: boundStr(cat.noticeText, 600),
          moduleTag: VALID_MODULE_TAGS.has(cat.moduleTag) ? cat.moduleTag : 'GENERAL',
          createdAt: existingData?.createdAt ?? serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
        {
          recordId: id,
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
        throw new Error(`[unavailable] CSC Category (${id}) could not be verified on Firestore server.`);
      }
      return { ...cat, id };
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `cscCustomCategories/${id}`);
    }
  }, { fallbackIfNoClientAuth: () => cat });
}

export async function saveCscServiceOverrideToFirestore(
  svc: CscService,
  rateHistoryEntry?: CscRateHistoryEntry
): Promise<CscService> {
  return runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const serviceId = sanitizeValidId(svc.id, 'CSVC');
    const ref = doc(db, 'cscServiceOverrides', serviceId);
    try {
      const existing = await getDocFromServer(ref);
      const existingData = existing.exists()
        ? (existing.data() as Record<string, unknown>)
        : undefined;
      const cleanName = boundStr(svc.name, 200);
      const status = svc.active !== false ? 'Active' : 'Inactive';
      const payload = withStandardCloudFields(
        stripUndefinedDeep({
          serviceId,
          code: boundStr(svc.code || serviceId, 40),
          categoryId: boundStr(svc.categoryId, 64),
          categoryName: boundStr(svc.categoryName, 160),
          subGroup: boundStr(svc.subGroup, 120),
          name: cleanName.length >= 2 ? cleanName : `${cleanName} Service`,
          description: boundStr(svc.description, 500),
          serviceCharge: svc.serviceCharge === null ? null : Math.max(0, Number(svc.serviceCharge ?? 0)),
          govtFee: svc.govtFee === null ? null : Math.max(0, Number(svc.govtFee ?? 0)),
          totalAmount: svc.totalAmount === null ? null : Math.max(0, Number(svc.totalAmount ?? 0)),
          unitType: svc.unitType ? boundStr(svc.unitType, 40) : null,
          rateConfigured: Boolean(svc.rateConfigured),
          effectiveDate: svc.effectiveDate ?? null,
          requiredDocuments: Array.isArray(svc.requiredDocuments)
            ? svc.requiredDocuments.slice(0, 30).map((d) => boundStr(d, 160)).filter(Boolean)
            : [],
          availability: svc.availability === 'Unavailable' ? 'Unavailable' : 'Available',
          active: svc.active !== false,
          moduleTag: VALID_MODULE_TAGS.has(svc.moduleTag) ? svc.moduleTag : 'GENERAL',
          updatedBy: boundStr(svc.updatedBy || authUser.email || authUser.uid, 64),
          updatedByUid: authUser.uid,
          createdAt: existingData?.createdAt ?? serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
        {
          recordId: serviceId,
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
        throw new Error(
          `[unavailable] CSC service override (${serviceId}) could not be verified on Firestore server.`
        );
      }

      if (rateHistoryEntry) {
        const histId = sanitizeValidId(rateHistoryEntry.id, 'RATE');
        await setDoc(
          doc(db, 'cscRateHistory', histId),
          withStandardCloudFields(
            stripUndefinedDeep({
              id: histId,
              serviceId,
              serviceCode: boundStr(rateHistoryEntry.serviceCode, 40),
              serviceName: boundStr(rateHistoryEntry.serviceName, 200),
              categoryName: boundStr(rateHistoryEntry.categoryName, 160),
              adminId: boundStr(rateHistoryEntry.adminId || authUser.email || authUser.uid, 64),
              oldServiceCharge: rateHistoryEntry.oldServiceCharge,
              newServiceCharge: Math.max(0, Number(rateHistoryEntry.newServiceCharge ?? 0)),
              oldGovtFee: rateHistoryEntry.oldGovtFee,
              newGovtFee: Math.max(0, Number(rateHistoryEntry.newGovtFee ?? 0)),
              oldTotalAmount: rateHistoryEntry.oldTotalAmount,
              newTotalAmount: Math.max(0, Number(rateHistoryEntry.newTotalAmount ?? 0)),
              oldUnitType: rateHistoryEntry.oldUnitType,
              newUnitType: boundStr(rateHistoryEntry.newUnitType || 'Per Application', 40),
              effectiveDate: boundStr(rateHistoryEntry.effectiveDate, 32),
              changeReason: boundStr(rateHistoryEntry.changeReason, 300),
              changedAt: rateHistoryEntry.changedAt || new Date().toISOString(),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            }),
            {
              recordId: histId,
              authUserUid: authUser.uid,
              status: 'Recorded',
            }
          )
        );
      }

      return { ...svc, id: serviceId };
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `cscServiceOverrides/${serviceId}`);
    }
  }, { fallbackIfNoClientAuth: () => svc });
}

export async function deleteCscServiceOverrideFromFirestore(serviceId: string): Promise<void> {
  await runStrictCloudWriteWithRetry(async () => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const cleanId = sanitizeValidId(serviceId, 'CSVC');
    try {
      await deleteDoc(doc(db, 'cscServiceOverrides', cleanId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `cscServiceOverrides/${cleanId}`);
    }
  }, { fallbackIfNoClientAuth: () => undefined });
}

// ============================================================================
// PVC Rate Slabs & Wholesale Shops
// ============================================================================
export async function savePvcSlabToFirestore(slab: PvcRateSlab): Promise<PvcRateSlab> {
  return runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const id = sanitizeValidId(slab.id, 'SLAB');
    const ref = doc(db, 'pvcSlabs', id);
    try {
      const existing = await getDocFromServer(ref);
      const existingData = existing.exists()
        ? (existing.data() as Record<string, unknown>)
        : undefined;
      const minQty = Math.max(1, Number(slab.minQty ?? 1));
      const maxQty = Math.max(minQty, Number(slab.maxQty ?? minQty));
      const status = slab.active !== false ? 'Active' : 'Inactive';
      const payload = withStandardCloudFields(
        stripUndefinedDeep({
          id,
          mode: slab.mode === 'WHOLESALE' ? 'WHOLESALE' : 'INDIVIDUAL',
          minQty,
          maxQty,
          ratePerCard: Math.max(0, Number(slab.ratePerCard ?? 0)),
          active: slab.active !== false,
          updatedBy: boundStr(slab.updatedBy || authUser.email || authUser.uid, 64),
          createdAt: existingData?.createdAt ?? serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
        {
          recordId: id,
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
        throw new Error(`[unavailable] PVC slab (${id}) could not be verified on Firestore server.`);
      }
      return { ...slab, id };
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `pvcSlabs/${id}`);
    }
  }, { fallbackIfNoClientAuth: () => slab });
}

export async function deletePvcSlabFromFirestore(slabId: string): Promise<void> {
  await runStrictCloudWriteWithRetry(async () => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const id = sanitizeValidId(slabId, 'SLAB');
    try {
      await deleteDoc(doc(db, 'pvcSlabs', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `pvcSlabs/${id}`);
    }
  }, { fallbackIfNoClientAuth: () => undefined });
}

export async function saveWholesaleShopToFirestore(
  shop: WholesaleShop
): Promise<WholesaleShop> {
  return runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const id = sanitizeValidId(shop.id, 'SHOP');
    const ref = doc(db, 'wholesaleShops', id);
    try {
      const existing = await getDocFromServer(ref);
      const existingData = existing.exists()
        ? (existing.data() as Record<string, unknown>)
        : undefined;
      const mobile = boundStr(shop.mobile, 24);
      const shopName = boundStr(shop.shopName, 160);
      const ownerName = boundStr(shop.ownerName, 120);
      const status = shop.active !== false ? 'Active' : 'Inactive';
      const payload = withStandardCloudFields(
        stripUndefinedDeep({
          id,
          shopCode: boundStr(shop.shopCode || id, 40),
          shopName: shopName.length >= 2 ? shopName : `${shopName} Shop`,
          ownerName: ownerName.length >= 2 ? ownerName : `${ownerName} Owner`,
          mobile: mobile.length >= 8 ? mobile : mobile.padEnd(10, '0'),
          altMobile: boundStr(shop.altMobile, 24),
          address: boundStr(shop.address, 300),
          registrationDate: boundStr(shop.registrationDate, 32),
          remarks: boundStr(shop.remarks, 300),
          active: shop.active !== false,
          createdAt: existingData?.createdAt ?? serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
        {
          recordId: id,
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
        throw new Error(`[unavailable] Wholesale shop (${id}) could not be verified on Firestore server.`);
      }
      return { ...shop, id };
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `wholesaleShops/${id}`);
    }
  }, { fallbackIfNoClientAuth: () => shop });
}

// ============================================================================
// CSC Orders (cscOrders/{orderId})
// ============================================================================
export function mapFirestoreCscOrderDoc(
  docId: string,
  data: Record<string, unknown>
): CscOrderRecord {
  const orderId = String(data.orderId || docId);
  return {
    ...(data as unknown as CscOrderRecord),
    id: String(data.id || orderId),
    orderId,
    items: Array.isArray(data.items) ? (data.items as CscOrderRecord['items']) : [],
    documents: Array.isArray(data.documents) ? (data.documents as CscOrderRecord['documents']) : [],
    payments: Array.isArray(data.payments) ? (data.payments as CscOrderRecord['payments']) : [],
    statusHistory: Array.isArray(data.statusHistory)
      ? (data.statusHistory as CscOrderRecord['statusHistory'])
      : [],
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

export async function saveCscOrderToFirestore(order: CscOrderRecord): Promise<CscOrderRecord> {
  return runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const orderId = sanitizeValidId(order.orderId || order.id, 'CSCO');
    const ref = doc(db, 'cscOrders', orderId);
    try {
      const existing = await getDocFromServer(ref);
      const existingData = existing.exists()
        ? (existing.data() as Record<string, unknown>)
        : undefined;
      const customerName = boundStr(order.customerName, 160);
      const mobile = boundStr(order.mobile, 24);
      const cleanDocs = sanitizeArrayOfMaps(
        Array.isArray(order.documents)
          ? order.documents.map((docItem) => {
              if (!docItem || typeof docItem !== 'object') return {};
              const copy = { ...(docItem as unknown as Record<string, unknown>) };
              if (copy.storagePath || copy.storageUrl) {
                delete copy.contentBase64;
                delete copy.docBase64;
              }
              return copy;
            })
          : [],
        30
      );
      const appStatus = order.applicationStatus || 'Pending';
      const payload = withStandardCloudFields(
        stripUndefinedDeep({
          id: orderId,
          orderId,
          customerId: boundStr(order.customerId || 'WALKIN', 64),
          customerUid: '',
          customerName: customerName.length >= 2 ? customerName : `${customerName} Customer`,
          mobile: mobile.length >= 8 ? mobile : mobile.padEnd(10, '0'),
          selectedCategoryId: boundStr(order.selectedCategoryId, 64),
          selectedCategoryName: boundStr(order.selectedCategoryName, 160),
          selectedServiceId: boundStr(order.selectedServiceId, 64),
          selectedServiceName: boundStr(order.selectedServiceName, 200),
          items: sanitizeArrayOfMaps(order.items, 30),
          applicationDetails: stripUndefinedDeep(order.applicationDetails ?? {}),
          documents: cleanDocs,
          serviceCharge: Math.max(0, Number(order.serviceCharge ?? 0)),
          govtFee: Math.max(0, Number(order.govtFee ?? 0)),
          totalAmount: Math.max(0, Number(order.totalAmount ?? 0)),
          advancePayment: Math.max(0, Number(order.advancePayment ?? 0)),
          additionalPayments: Math.max(0, Number(order.additionalPayments ?? 0)),
          refundedAmount: Math.max(0, Number(order.refundedAmount ?? 0)),
          totalPaid: Math.max(0, Number(order.totalPaid ?? 0)),
          remainingDue: Math.max(0, Number(order.remainingDue ?? 0)),
          orderDate: boundStr(order.orderDate, 32),
          applicationStatus: appStatus,
          paymentStatus: order.paymentStatus || 'Unpaid',
          operatorId: boundStr(order.operatorId || authUser.uid, 64),
          operatorName: boundStr(order.operatorName || authUser.email || 'Operator', 120),
          adminRemarks: boundStr(order.adminRemarks, 400),
          moduleTag: VALID_MODULE_TAGS.has(order.moduleTag) ? order.moduleTag : 'GENERAL',
          ekycMethod: order.ekycMethod ?? 'Not Applicable',
          ekycStatus: order.ekycStatus ?? 'Not Applicable',
          externalAckNo: boundStr(order.externalAckNo, 80),
          pmjayDetails: order.pmjayDetails ? stripUndefinedDeep(order.pmjayDetails) : null,
          mmsbyDetails: order.mmsbyDetails ? stripUndefinedDeep(order.mmsbyDetails) : null,
          npciDetails: order.npciDetails ? stripUndefinedDeep(order.npciDetails) : null,
          cyberCrimeDetails: order.cyberCrimeDetails
            ? stripUndefinedDeep(order.cyberCrimeDetails)
            : null,
          payments: sanitizeArrayOfMaps(order.payments, 50),
          statusHistory: sanitizeArrayOfMaps(order.statusHistory, 50),
          createdAt: existingData?.createdAt ?? serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
        {
          recordId: orderId,
          authUserUid: authUser.uid,
          status: appStatus,
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
        throw new Error(`[unavailable] CSC Order (${orderId}) could not be verified on Firestore server.`);
      }
      return mapFirestoreCscOrderDoc(verified.id, verified.data() as Record<string, unknown>);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `cscOrders/${orderId}`);
    }
  }, { fallbackIfNoClientAuth: () => order });
}

// ============================================================================
// PVC Orders (pvcOrders/{orderId})
// ============================================================================
export function mapFirestorePvcOrderDoc(
  docId: string,
  data: Record<string, unknown>
): PvcOrder {
  const orderId = String(data.orderId || docId);
  return {
    ...(data as unknown as PvcOrder),
    id: String(data.id || orderId),
    orderId,
    items: Array.isArray(data.items) ? (data.items as PvcOrder['items']) : [],
    payments: Array.isArray(data.payments) ? (data.payments as PvcOrder['payments']) : [],
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

export async function savePvcOrderToFirestore(order: PvcOrder): Promise<PvcOrder> {
  return runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const orderId = sanitizeValidId(order.orderId || order.id, 'PVC');
    const ref = doc(db, 'pvcOrders', orderId);
    try {
      const existing = await getDocFromServer(ref);
      const existingData = existing.exists()
        ? (existing.data() as Record<string, unknown>)
        : undefined;
      const customerName = boundStr(order.customerName, 160);
      const mobile = boundStr(order.mobile, 24);
      const deliveryStatus = order.deliveryStatus || 'Pending';
      const payload = withStandardCloudFields(
        stripUndefinedDeep({
          id: orderId,
          orderId,
          orderMode: order.orderMode === 'WHOLESALE' ? 'WHOLESALE' : 'INDIVIDUAL',
          customerId: boundStr(order.customerId, 64),
          customerUid: '',
          customerName: customerName.length >= 2 ? customerName : `${customerName} Customer`,
          mobile: mobile.length >= 8 ? mobile : mobile.padEnd(10, '0'),
          shopId: boundStr(order.shopId, 64),
          shopName: boundStr(order.shopName, 160),
          shopOwnerName: boundStr(order.shopOwnerName, 120),
          address: boundStr(order.address, 300),
          items: sanitizeArrayOfMaps(order.items, 30),
          totalCards: Math.max(1, Number(order.totalCards ?? 1)),
          grandTotal: Math.max(0, Number(order.grandTotal ?? 0)),
          advancePayment: Math.max(0, Number(order.advancePayment ?? 0)),
          additionalPayments: Math.max(0, Number(order.additionalPayments ?? 0)),
          totalPaid: Math.max(0, Number(order.totalPaid ?? 0)),
          remainingDue: Math.max(0, Number(order.remainingDue ?? 0)),
          paymentStatus: order.paymentStatus || 'Unpaid',
          deliveryStatus,
          orderDate: boundStr(order.orderDate, 32),
          operatorId: boundStr(order.operatorId || authUser.uid, 64),
          operatorName: boundStr(order.operatorName || authUser.email || 'Operator', 120),
          remarks: boundStr(order.remarks, 400),
          payments: sanitizeArrayOfMaps(order.payments, 50),
          createdAt: existingData?.createdAt ?? serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
        {
          recordId: orderId,
          authUserUid: authUser.uid,
          status: deliveryStatus,
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
        throw new Error(`[unavailable] PVC Order (${orderId}) could not be verified on Firestore server.`);
      }
      return mapFirestorePvcOrderDoc(verified.id, verified.data() as Record<string, unknown>);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `pvcOrders/${orderId}`);
    }
  }, { fallbackIfNoClientAuth: () => order });
}

// ============================================================================
// Grievances & RTI (cscGrievances/{trackingId})
// ============================================================================
export function mapFirestoreGrievanceDoc(
  docId: string,
  data: Record<string, unknown>
): GrievanceRecord {
  const internalTrackingId = String(data.internalTrackingId || docId);
  return {
    ...(data as unknown as GrievanceRecord),
    id: String(data.id || internalTrackingId),
    internalTrackingId,
    uploadedDocuments: Array.isArray(data.uploadedDocuments)
      ? (data.uploadedDocuments as CscDocumentRecord[])
      : [],
    followUps: Array.isArray(data.followUps)
      ? (data.followUps as GrievanceRecord['followUps'])
      : [],
    statusHistory: Array.isArray(data.statusHistory)
      ? (data.statusHistory as GrievanceRecord['statusHistory'])
      : [],
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

export async function saveCscGrievanceToFirestore(
  grievance: GrievanceRecord
): Promise<GrievanceRecord> {
  return runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const trackingId = sanitizeValidId(
      grievance.internalTrackingId || grievance.id,
      'GRV'
    );
    const ref = doc(db, 'cscGrievances', trackingId);
    try {
      const existing = await getDocFromServer(ref);
      const existingData = existing.exists()
        ? (existing.data() as Record<string, unknown>)
        : undefined;
      const customerName = boundStr(grievance.customerName, 160);
      const subject = boundStr(grievance.complaintSubject, 240);
      const complaintStatus = grievance.complaintStatus || 'Draft';
      const payload = withStandardCloudFields(
        stripUndefinedDeep({
          id: trackingId,
          internalTrackingId: trackingId,
          externalAckNo: boundStr(grievance.externalAckNo, 80),
          customerId: boundStr(grievance.customerId, 64),
          customerUid: '',
          customerName: customerName.length >= 2 ? customerName : `${customerName} Citizen`,
          mobile: boundStr(grievance.mobile, 24),
          address: boundStr(grievance.address, 300),
          district: boundStr(grievance.district, 120),
          blockOrMunicipality: boundStr(grievance.blockOrMunicipality, 120),
          complaintCategory: boundStr(grievance.complaintCategory || 'Public Grievance', 120),
          serviceType: grievance.serviceType || 'Online Grievance Filing Assistance',
          department: boundStr(grievance.department, 160),
          authority: boundStr(grievance.authority, 160),
          complaintSubject: subject.length >= 3 ? subject : `${subject} Subject`,
          complaintDetails: boundStr(grievance.complaintDetails, 2000),
          uploadedDocuments: sanitizeArrayOfMaps(grievance.uploadedDocuments, 30),
          serviceCharge: Math.max(0, Number(grievance.serviceCharge ?? 0)),
          govtFee: Math.max(0, Number(grievance.govtFee ?? 0)),
          totalAmount: Math.max(0, Number(grievance.totalAmount ?? 0)),
          paidAmount: Math.max(0, Number(grievance.paidAmount ?? 0)),
          remainingDue: Math.max(0, Number(grievance.remainingDue ?? 0)),
          paymentStatus: grievance.paymentStatus || 'Unpaid',
          submissionDate: boundStr(grievance.submissionDate, 32),
          followUpDate: boundStr(grievance.followUpDate, 32),
          complaintStatus,
          isRti: Boolean(grievance.isRti),
          rtiType: grievance.rtiType ?? null,
          pioName: boundStr(grievance.pioName, 120),
          faaName: boundStr(grievance.faaName, 120),
          replySummary: boundStr(grievance.replySummary, 1000),
          adminRemarks: boundStr(grievance.adminRemarks, 400),
          operatorId: boundStr(grievance.operatorId || authUser.uid, 64),
          operatorName: boundStr(grievance.operatorName || authUser.email || 'Operator', 120),
          followUps: sanitizeArrayOfMaps(grievance.followUps, 50),
          statusHistory: sanitizeArrayOfMaps(grievance.statusHistory, 50),
          createdAt: existingData?.createdAt ?? serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
        {
          recordId: trackingId,
          authUserUid: authUser.uid,
          status: complaintStatus,
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
        throw new Error(
          `[unavailable] CSC Grievance (${trackingId}) could not be verified on Firestore server.`
        );
      }
      return mapFirestoreGrievanceDoc(verified.id, verified.data() as Record<string, unknown>);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `cscGrievances/${trackingId}`);
    }
  }, { fallbackIfNoClientAuth: () => grievance });
}

// ============================================================================
// Live Subscriptions
// ============================================================================
export function subscribeCscOrdersFromFirestore(
  onData: (orders: CscOrderRecord[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  reportModuleSyncState('cscOrders', { phase: 'loading' });
  return onSnapshot(
    collection(db, 'cscOrders'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => mapFirestoreCscOrderDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      reportModuleSyncState('cscOrders', {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('cscOrders', error);
      if (onError) onError(error);
    }
  );
}

export function subscribePvcOrdersFromFirestore(
  onData: (orders: PvcOrder[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  reportModuleSyncState('pvcOrders', { phase: 'loading' });
  return onSnapshot(
    collection(db, 'pvcOrders'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => mapFirestorePvcOrderDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      reportModuleSyncState('pvcOrders', {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('pvcOrders', error);
      if (onError) onError(error);
    }
  );
}

export function subscribePvcSlabsFromFirestore(
  onData: (slabs: PvcRateSlab[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  reportModuleSyncState('pvcSlabs', { phase: 'loading' });
  return onSnapshot(
    collection(db, 'pvcSlabs'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs.map((d) => ({
        ...(d.data() as PvcRateSlab),
        id: d.id,
        createdAt: timestampToIso(d.data().createdAt),
        updatedAt: timestampToIso(d.data().updatedAt),
      }));
      reportModuleSyncState('pvcSlabs', {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('pvcSlabs', error);
      if (onError) onError(error);
    }
  );
}

export function subscribeWholesaleShopsFromFirestore(
  onData: (shops: WholesaleShop[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  reportModuleSyncState('wholesaleShops', { phase: 'loading' });
  return onSnapshot(
    collection(db, 'wholesaleShops'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs.map((d) => ({
        ...(d.data() as WholesaleShop),
        id: d.id,
        createdAt: timestampToIso(d.data().createdAt),
        updatedAt: timestampToIso(d.data().updatedAt),
      }));
      reportModuleSyncState('wholesaleShops', {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('wholesaleShops', error);
      if (onError) onError(error);
    }
  );
}

export function subscribeCscGrievancesFromFirestore(
  onData: (grievances: GrievanceRecord[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  reportModuleSyncState('cscGrievances', { phase: 'loading' });
  return onSnapshot(
    collection(db, 'cscGrievances'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => mapFirestoreGrievanceDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      reportModuleSyncState('cscGrievances', {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('cscGrievances', error);
      if (onError) onError(error);
    }
  );
}

export function subscribeCscOverridesFromFirestore(
  onCategories: (cats: CscCategory[]) => void,
  onOverrides: (svcs: CscService[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  reportModuleSyncState('cscServices', { phase: 'loading' });
  const unsubCats = onSnapshot(
    collection(db, 'cscCustomCategories'),
    (snap) => {
      recordCloudSyncSuccess();
      onCategories(
        snap.docs.map((d) => ({
          ...(d.data() as CscCategory),
          id: d.id,
          createdAt: timestampToIso(d.data().createdAt),
          updatedAt: timestampToIso(d.data().updatedAt),
        }))
      );
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('cscServices', error);
      if (onError) onError(error);
    }
  );
  const unsubSvcs = onSnapshot(
    collection(db, 'cscServiceOverrides'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs.map((d) => ({
        ...(d.data() as CscService),
        id: String(d.data().serviceId || d.id),
        createdAt: timestampToIso(d.data().createdAt),
        updatedAt: timestampToIso(d.data().updatedAt),
      }));
      reportModuleSyncState('cscServices', {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onOverrides(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('cscServices', error);
      if (onError) onError(error);
    }
  );
  return () => {
    unsubCats();
    unsubSvcs();
  };
}

export function subscribeCscRateHistoryFromFirestore(
  onData: (history: CscRateHistoryEntry[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  return onSnapshot(
    collection(db, 'cscRateHistory'),
    (snap) => {
      recordCloudSyncSuccess();
      const entries = snap.docs
        .map((d) => {
          const data = d.data() as Record<string, unknown>;
          return {
            ...(data as unknown as CscRateHistoryEntry),
            id: String(data.id || d.id),
            changedAt: String(data.changedAt || timestampToIso(data.createdAt)),
          };
        })
        .sort((a, b) => String(b.changedAt || '').localeCompare(String(a.changedAt || '')));
      onData(entries);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      if (onError) onError(error);
    }
  );
}

// ============================================================================
// CSC Private Document Vault (cscDocuments/{docId})
// ============================================================================
export async function saveCscDocumentToFirestore(
  docRecord: CscDocumentRecord
): Promise<CscDocumentRecord> {
  return runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const docId = sanitizeValidId(docRecord.docId, 'DOC');
    const ref = doc(db, 'cscDocuments', docId);
    try {
      const existing = await getDocFromServer(ref);
      const existingData = existing.exists()
        ? (existing.data() as Record<string, unknown>)
        : undefined;
      const cleanName = boundStr(docRecord.docName || 'Document', 200);
      const safeDocName = cleanName.length >= 2 ? cleanName : 'Document';
      const safeCustomerId = sanitizeValidId(docRecord.customerId, 'CUST').slice(0, 64);
      const verificationStatus =
        docRecord.verificationStatus &&
        ['Pending', 'Verified', 'Rejected', 'Re-upload Requested'].includes(
          docRecord.verificationStatus
        )
          ? docRecord.verificationStatus
          : 'Pending';

      const payload = withStandardCloudFields(
        stripUndefinedDeep({
          docId,
          customerId: safeCustomerId.length >= 2 ? safeCustomerId : 'CUST_01',
          customerUid: docRecord.customerUid
            ? boundStr(docRecord.customerUid, 128)
            : (existingData?.customerUid as string | undefined) ?? undefined,
          orderId: docRecord.orderId ? boundStr(docRecord.orderId, 64) : undefined,
          grievanceId: docRecord.grievanceId ? boundStr(docRecord.grievanceId, 64) : undefined,
          category: boundStr(docRecord.category || 'Supporting Proof', 120),
          docName: safeDocName,
          mimeType: boundStr(docRecord.mimeType || 'application/pdf', 120),
          fileSizeBytes: Number(docRecord.fileSizeBytes ?? 0),
          storageUrl: docRecord.storageUrl ? boundStr(docRecord.storageUrl, 1000) : undefined,
          storagePath: docRecord.storagePath ? boundStr(docRecord.storagePath, 300) : undefined,
          verificationStatus,
          rejectionReason: docRecord.rejectionReason
            ? boundStr(docRecord.rejectionReason, 300)
            : undefined,
          uploadedBy: boundStr(docRecord.uploadedBy || authUser.email || authUser.uid, 64),
          verifiedBy: docRecord.verifiedBy ? boundStr(docRecord.verifiedBy, 64) : undefined,
          uploadedAt: boundStr(docRecord.uploadedAt || new Date().toISOString(), 64),
          verifiedAt: docRecord.verifiedAt ? boundStr(docRecord.verifiedAt, 64) : undefined,
          auditTrail: sanitizeArrayOfMaps(docRecord.auditTrail, 50),
          createdAt: existingData?.createdAt ?? serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
        {
          recordId: docId,
          authUserUid: authUser.uid,
          status: verificationStatus,
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
        throw new Error(
          `[unavailable] CSC Document (${docId}) could not be verified on Firestore server.`
        );
      }

      return {
        ...docRecord,
        docId,
        contentBase64: undefined,
      };
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `cscDocuments/${docId}`);
    }
  }, {
    fallbackIfNoClientAuth: () => ({
      ...docRecord,
      contentBase64: undefined,
    }),
  });
}

export function subscribeCscDocumentsFromFirestore(
  onData: (docs: CscDocumentRecord[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  reportModuleSyncState('cscDocuments', { phase: 'loading' });
  return onSnapshot(
    collection(db, 'cscDocuments'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => {
          const data = d.data() as Record<string, unknown>;
          return {
            ...(data as unknown as CscDocumentRecord),
            docId: String(data.docId || d.id),
            uploadedAt: String(data.uploadedAt || timestampToIso(data.createdAt)),
          };
        })
        .sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')));
      reportModuleSyncState('cscDocuments', {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('cscDocuments', error);
      if (onError) onError(error);
    }
  );
}
