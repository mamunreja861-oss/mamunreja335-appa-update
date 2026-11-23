import {
  collection,
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

export interface InvoiceDoc {
  invoiceNo: string;
  applicationNo: string;
  customerId: string;
  customerName: string;
  serviceId: string;
  serviceName: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  paidAmount: number;
  balanceDue: number;
  issuedDate: string;
  dueDate?: string;
  status: 'Paid' | 'Partial' | 'Unpaid' | 'Cancelled';
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ReceiptDoc {
  receiptNo: string;
  transactionId: string;
  invoiceNo?: string;
  applicationNo: string;
  customerId: string;
  customerName: string;
  serviceName: string;
  paymentMethod: string;
  amount: number;
  collectedBy: string;
  issuedAt: string;
  status: 'Issued' | 'Voided';
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DeliveryRecordDoc {
  deliveryId: string;
  applicationNo: string;
  customerId: string;
  customerName?: string;
  recipientName: string;
  recipientRelation: string;
  deliveryMode: 'In-Person Counter' | 'WhatsApp Digital' | 'Email Digital' | 'Courier';
  deliveredBy: string;
  deliveredAt: string;
  remarks?: string;
  status: 'Delivered' | 'Re-issued' | 'Returned';
  createdAt?: string;
  updatedAt?: string;
}

export interface IncomeVoucherDoc {
  incomeNo: string;
  category: string;
  description: string;
  customerId?: string;
  applicationNo?: string;
  counterCode: string;
  paymentMethod: string;
  amount: number;
  incomeDate: string;
  recordedBy: string;
  status: 'Approved' | 'Pending';
  createdAt?: string;
  updatedAt?: string;
}

export interface AttendanceDoc {
  attendanceId: string;
  date: string;
  empId: string;
  employeeName: string;
  department: string;
  checkInTime: string;
  checkOutTime?: string;
  status: 'Present' | 'Absent' | 'Half-Day' | 'Leave' | 'Holiday';
  remarks?: string;
  markedBy: string;
  createdAt?: string;
  updatedAt?: string;
}

function boundStr(val: unknown, maxLen: number): string {
  return String(val ?? '').trim().slice(0, maxLen);
}

function sanitizeId(val: unknown, prefix: string): string {
  const cleaned = String(val ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 128);
  return cleaned.length >= 2 ? cleaned : `${prefix}_${Date.now()}`;
}

export function mapFirestoreInvoiceDoc(docId: string, data: Record<string, unknown>): InvoiceDoc {
  const invoiceNo = String(data.invoiceNo || docId);
  return {
    invoiceNo,
    applicationNo: String(data.applicationNo || ''),
    customerId: String(data.customerId || ''),
    customerName: String(data.customerName || ''),
    serviceId: String(data.serviceId || ''),
    serviceName: String(data.serviceName || ''),
    subtotal: Number(data.subtotal ?? 0),
    taxAmount: Number(data.taxAmount ?? 0),
    totalAmount: Number(data.totalAmount ?? 0),
    paidAmount: Number(data.paidAmount ?? 0),
    balanceDue: Number(data.balanceDue ?? 0),
    issuedDate: String(data.issuedDate || timestampToIso(data.createdAt).slice(0, 10)),
    dueDate: typeof data.dueDate === 'string' ? data.dueDate : undefined,
    status: (data.status as InvoiceDoc['status']) || 'Unpaid',
    notes: typeof data.notes === 'string' ? data.notes : undefined,
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

export async function saveInvoiceToFirestore(invoice: InvoiceDoc): Promise<InvoiceDoc> {
  return runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const invoiceNo = sanitizeId(invoice.invoiceNo, 'INV');
    const ref = doc(db, 'invoices', invoiceNo);
    try {
      const existing = await getDocFromServer(ref);
      const existingData = existing.exists() ? (existing.data() as Record<string, unknown>) : undefined;
      const validStatus: InvoiceDoc['status'] = ['Paid', 'Partial', 'Unpaid', 'Cancelled'].includes(
        invoice.status
      )
        ? invoice.status
        : 'Unpaid';
      const payload = withStandardCloudFields(
        {
          invoiceNo,
          applicationNo: sanitizeId(invoice.applicationNo, 'MCA'),
          customerId: sanitizeId(invoice.customerId, 'MCC'),
          customerName: boundStr(invoice.customerName || 'Customer', 120),
          serviceId: sanitizeId(invoice.serviceId || 'SRV', 'SRV'),
          serviceName: boundStr(invoice.serviceName || 'CSC Service', 160),
          subtotal: Math.max(0, Number(invoice.subtotal ?? 0)),
          taxAmount: Math.max(0, Number(invoice.taxAmount ?? 0)),
          totalAmount: Math.max(0, Number(invoice.totalAmount ?? 0)),
          paidAmount: Math.max(0, Number(invoice.paidAmount ?? 0)),
          balanceDue: Math.max(0, Number(invoice.balanceDue ?? 0)),
          issuedDate: boundStr(invoice.issuedDate || new Date().toISOString().slice(0, 10), 32),
          dueDate: boundStr(invoice.dueDate, 32),
          status: validStatus,
          notes: boundStr(invoice.notes, 400),
          createdAt: existingData?.createdAt ?? serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        {
          recordId: invoiceNo,
          authUserUid: authUser.uid,
          status: validStatus,
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
        throw new Error(`[unavailable] Invoice (${invoiceNo}) could not be verified on Firestore server.`);
      }
      return mapFirestoreInvoiceDoc(verified.id, verified.data() as Record<string, unknown>);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `invoices/${invoiceNo}`);
    }
  }, { fallbackIfNoClientAuth: () => invoice });
}

export function subscribeInvoicesFromFirestore(
  onData: (invoices: InvoiceDoc[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  reportModuleSyncState('invoices', { phase: 'loading' });
  return onSnapshot(
    collection(db, 'invoices'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => mapFirestoreInvoiceDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      reportModuleSyncState('invoices', {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('invoices', error);
      if (onError) onError(error);
    }
  );
}

export function mapFirestoreReceiptDoc(docId: string, data: Record<string, unknown>): ReceiptDoc {
  const receiptNo = String(data.receiptNo || docId);
  return {
    receiptNo,
    transactionId: String(data.transactionId || receiptNo),
    invoiceNo: typeof data.invoiceNo === 'string' && data.invoiceNo ? data.invoiceNo : undefined,
    applicationNo: String(data.applicationNo || ''),
    customerId: String(data.customerId || ''),
    customerName: String(data.customerName || ''),
    serviceName: String(data.serviceName || ''),
    paymentMethod: String(data.paymentMethod || 'Cash'),
    amount: Number(data.amount ?? 0),
    collectedBy: String(data.collectedBy || ''),
    issuedAt: String(data.issuedAt || timestampToIso(data.createdAt)),
    status: data.status === 'Voided' ? 'Voided' : 'Issued',
    notes: typeof data.notes === 'string' ? data.notes : undefined,
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

export async function saveReceiptToFirestore(receipt: ReceiptDoc): Promise<ReceiptDoc> {
  return runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const receiptNo = sanitizeId(receipt.receiptNo, 'RCPT');
    const ref = doc(db, 'receipts', receiptNo);
    try {
      const existing = await getDocFromServer(ref);
      const existingData = existing.exists() ? (existing.data() as Record<string, unknown>) : undefined;
      const validStatus: ReceiptDoc['status'] = receipt.status === 'Voided' ? 'Voided' : 'Issued';
      const payload = withStandardCloudFields(
        {
          receiptNo,
          transactionId: sanitizeId(receipt.transactionId || receiptNo, 'TXN'),
          invoiceNo: boundStr(receipt.invoiceNo, 64),
          applicationNo: sanitizeId(receipt.applicationNo, 'MCA'),
          customerId: sanitizeId(receipt.customerId, 'MCC'),
          customerName: boundStr(receipt.customerName || 'Customer', 120),
          serviceName: boundStr(receipt.serviceName || 'CSC Service', 160),
          paymentMethod: boundStr(receipt.paymentMethod || 'Cash', 40),
          amount: Math.max(0.01, Number(receipt.amount ?? 0.01)),
          collectedBy: boundStr(receipt.collectedBy || authUser.email || authUser.uid, 64),
          issuedAt: boundStr(receipt.issuedAt || new Date().toISOString(), 64),
          status: validStatus,
          notes: boundStr(receipt.notes, 400),
          createdAt: existingData?.createdAt ?? serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        {
          recordId: receiptNo,
          authUserUid: authUser.uid,
          status: validStatus,
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
        throw new Error(`[unavailable] Receipt (${receiptNo}) could not be verified on Firestore server.`);
      }
      return mapFirestoreReceiptDoc(verified.id, verified.data() as Record<string, unknown>);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `receipts/${receiptNo}`);
    }
  }, { fallbackIfNoClientAuth: () => receipt });
}

export function subscribeReceiptsFromFirestore(
  onData: (receipts: ReceiptDoc[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  reportModuleSyncState('receipts', { phase: 'loading' });
  return onSnapshot(
    collection(db, 'receipts'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => mapFirestoreReceiptDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => String(b.issuedAt || '').localeCompare(String(a.issuedAt || '')));
      reportModuleSyncState('receipts', {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('receipts', error);
      if (onError) onError(error);
    }
  );
}

export function mapFirestoreDeliveryDoc(
  docId: string,
  data: Record<string, unknown>
): DeliveryRecordDoc {
  const deliveryId = String(data.deliveryId || docId);
  return {
    deliveryId,
    applicationNo: String(data.applicationNo || ''),
    customerId: String(data.customerId || ''),
    customerName: typeof data.customerName === 'string' ? data.customerName : undefined,
    recipientName: String(data.recipientName || ''),
    recipientRelation: String(data.recipientRelation || 'Self'),
    deliveryMode: (data.deliveryMode as DeliveryRecordDoc['deliveryMode']) || 'In-Person Counter',
    deliveredBy: String(data.deliveredBy || ''),
    deliveredAt: String(data.deliveredAt || timestampToIso(data.createdAt)),
    remarks: typeof data.remarks === 'string' ? data.remarks : undefined,
    status: (data.status as DeliveryRecordDoc['status']) || 'Delivered',
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

export async function saveDeliveryRecordToFirestore(
  record: DeliveryRecordDoc
): Promise<DeliveryRecordDoc> {
  return runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const deliveryId = sanitizeId(record.deliveryId || `DEL_${record.applicationNo}`, 'DEL');
    const ref = doc(db, 'deliveryRecords', deliveryId);
    try {
      const existing = await getDocFromServer(ref);
      const existingData = existing.exists() ? (existing.data() as Record<string, unknown>) : undefined;
      const validStatus: DeliveryRecordDoc['status'] = ['Delivered', 'Re-issued', 'Returned'].includes(
        record.status
      )
        ? record.status
        : 'Delivered';
      const payload = withStandardCloudFields(
        {
          deliveryId,
          applicationNo: sanitizeId(record.applicationNo, 'MCA'),
          customerId: sanitizeId(record.customerId, 'MCC'),
          customerName: boundStr(record.customerName || '', 120),
          recipientName: boundStr(record.recipientName || 'Applicant', 120),
          recipientRelation: boundStr(record.recipientRelation || 'Self', 80),
          deliveryMode: boundStr(record.deliveryMode || 'In-Person Counter', 64),
          deliveredBy: boundStr(record.deliveredBy || authUser.email || authUser.uid, 64),
          deliveredAt: boundStr(record.deliveredAt || new Date().toISOString(), 64),
          remarks: boundStr(record.remarks, 400),
          status: validStatus,
          createdAt: existingData?.createdAt ?? serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        {
          recordId: deliveryId,
          authUserUid: authUser.uid,
          status: validStatus,
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
          `[unavailable] Delivery record (${deliveryId}) could not be verified on Firestore server.`
        );
      }
      return mapFirestoreDeliveryDoc(verified.id, verified.data() as Record<string, unknown>);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `deliveryRecords/${deliveryId}`);
    }
  }, { fallbackIfNoClientAuth: () => record });
}

export function subscribeDeliveryRecordsFromFirestore(
  onData: (records: DeliveryRecordDoc[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  reportModuleSyncState('deliveryRecords', { phase: 'loading' });
  return onSnapshot(
    collection(db, 'deliveryRecords'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => mapFirestoreDeliveryDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => String(b.deliveredAt || '').localeCompare(String(a.deliveredAt || '')));
      reportModuleSyncState('deliveryRecords', {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('deliveryRecords', error);
      if (onError) onError(error);
    }
  );
}

export function mapFirestoreIncomeDoc(
  docId: string,
  data: Record<string, unknown>
): IncomeVoucherDoc {
  const incomeNo = String(data.incomeNo || docId);
  return {
    incomeNo,
    category: String(data.category || 'Service Income'),
    description: String(data.description || ''),
    customerId: typeof data.customerId === 'string' && data.customerId ? data.customerId : undefined,
    applicationNo:
      typeof data.applicationNo === 'string' && data.applicationNo ? data.applicationNo : undefined,
    counterCode: String(data.counterCode || 'CTR-01'),
    paymentMethod: String(data.paymentMethod || 'Cash'),
    amount: Number(data.amount ?? 0),
    incomeDate: String(data.incomeDate || timestampToIso(data.createdAt).slice(0, 10)),
    recordedBy: String(data.recordedBy || ''),
    status: data.status === 'Pending' ? 'Pending' : 'Approved',
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

export async function saveIncomeToFirestore(income: IncomeVoucherDoc): Promise<IncomeVoucherDoc> {
  return runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const incomeNo = sanitizeId(income.incomeNo, 'INC');
    const ref = doc(db, 'income', incomeNo);
    try {
      const existing = await getDocFromServer(ref);
      const existingData = existing.exists() ? (existing.data() as Record<string, unknown>) : undefined;
      const validStatus: IncomeVoucherDoc['status'] =
        income.status === 'Pending' ? 'Pending' : 'Approved';
      const payload = withStandardCloudFields(
        {
          incomeNo,
          category: boundStr(income.category || 'Service Income', 80),
          description: boundStr(income.description || 'Counter Income', 300),
          customerId: boundStr(income.customerId, 64),
          applicationNo: boundStr(income.applicationNo, 64),
          counterCode: boundStr(income.counterCode || 'CTR-01', 40),
          paymentMethod: boundStr(income.paymentMethod || 'Cash', 40),
          amount: Math.max(0.01, Number(income.amount ?? 0.01)),
          incomeDate: boundStr(income.incomeDate || new Date().toISOString().slice(0, 10), 32),
          recordedBy: boundStr(income.recordedBy || authUser.email || authUser.uid, 64),
          status: validStatus,
          createdAt: existingData?.createdAt ?? serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        {
          recordId: incomeNo,
          authUserUid: authUser.uid,
          status: validStatus,
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
          `[unavailable] Income voucher (${incomeNo}) could not be verified on Firestore server.`
        );
      }
      return mapFirestoreIncomeDoc(verified.id, verified.data() as Record<string, unknown>);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `income/${incomeNo}`);
    }
  }, { fallbackIfNoClientAuth: () => income });
}

export function subscribeIncomeFromFirestore(
  onData: (items: IncomeVoucherDoc[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  reportModuleSyncState('income', { phase: 'loading' });
  return onSnapshot(
    collection(db, 'income'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => mapFirestoreIncomeDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      reportModuleSyncState('income', {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('income', error);
      if (onError) onError(error);
    }
  );
}

export function mapFirestoreAttendanceDoc(
  docId: string,
  data: Record<string, unknown>
): AttendanceDoc {
  const attendanceId = String(data.attendanceId || docId);
  return {
    attendanceId,
    date: String(data.date || ''),
    empId: String(data.empId || ''),
    employeeName: String(data.employeeName || ''),
    department: String(data.department || 'Operations'),
    checkInTime: String(data.checkInTime || ''),
    checkOutTime: typeof data.checkOutTime === 'string' ? data.checkOutTime : undefined,
    status: (data.status as AttendanceDoc['status']) || 'Present',
    remarks: typeof data.remarks === 'string' ? data.remarks : undefined,
    markedBy: String(data.markedBy || ''),
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

export async function saveAttendanceToFirestore(record: AttendanceDoc): Promise<AttendanceDoc> {
  return runStrictCloudWriteWithRetry(async (authUser) => {
    if (!db) throw new Error('[failed-precondition] Cloud database (Firestore) is not initialized.');
    const datePart = boundStr(record.date || new Date().toISOString().slice(0, 10), 16);
    const empId = sanitizeId(record.empId, 'EMP');
    const attendanceId = sanitizeId(record.attendanceId || `${datePart}_${empId}`, 'ATT');
    const ref = doc(db, 'attendance', attendanceId);
    try {
      const existing = await getDocFromServer(ref);
      const existingData = existing.exists() ? (existing.data() as Record<string, unknown>) : undefined;
      const validStatus: AttendanceDoc['status'] = [
        'Present',
        'Absent',
        'Half-Day',
        'Leave',
        'Holiday',
      ].includes(record.status)
        ? record.status
        : 'Present';
      const payload = withStandardCloudFields(
        {
          attendanceId,
          date: datePart,
          empId,
          employeeName: boundStr(record.employeeName || empId, 120),
          department: boundStr(record.department || 'Operations', 80),
          checkInTime: boundStr(record.checkInTime || new Date().toISOString(), 64),
          checkOutTime: boundStr(record.checkOutTime, 64),
          status: validStatus,
          remarks: boundStr(record.remarks, 300),
          markedBy: boundStr(record.markedBy || authUser.email || authUser.uid, 64),
          createdAt: existingData?.createdAt ?? serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        {
          recordId: attendanceId,
          authUserUid: authUser.uid,
          status: validStatus,
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
          `[unavailable] Attendance record (${attendanceId}) could not be verified on Firestore server.`
        );
      }
      return mapFirestoreAttendanceDoc(verified.id, verified.data() as Record<string, unknown>);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `attendance/${attendanceId}`);
    }
  }, { fallbackIfNoClientAuth: () => record });
}

export function subscribeAttendanceFromFirestore(
  onData: (records: AttendanceDoc[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  reportModuleSyncState('attendance', { phase: 'loading' });
  return onSnapshot(
    collection(db, 'attendance'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => mapFirestoreAttendanceDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      reportModuleSyncState('attendance', {
        phase: items.length > 0 ? 'ready' : 'empty',
        count: items.length,
      });
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      reportModuleSyncError('attendance', error);
      if (onError) onError(error);
    }
  );
}
