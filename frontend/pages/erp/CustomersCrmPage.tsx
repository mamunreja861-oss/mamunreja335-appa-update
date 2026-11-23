import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  FilePlus2,
  GitMerge,
  IndianRupee,
  Pencil,
  Plus,
  Printer,
  RotateCcw,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  Upload,
  User,
  UserCheck,
  Users,
} from 'lucide-react';
import { CustomerSegment, ErpApplicationItem, ErpCustomerItem, ErpPaymentItem, UserProfile } from '../../modules/types';
import { erpApi } from '../../services/erpApi';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { MobileNumberInput } from '../../components/MobileNumberInput';
import { CustomerPhotoCapture, SelectedCustomerPhoto } from '../../components/CustomerPhotoCapture';
import { DataTable, TableColumn } from '../../components/DataTable';
import { formatCurrency, paginateArray } from '../../services/apiClient';
import { formatDateIST } from '../../services/formatters';
import {
  auth,
  extractFriendlyErrorMessage,
  isFirebaseConfigured,
  waitForFirebaseAuthReady,
} from '../../services/firebase';

import {
  computeCustomerSummaryMetrics,
  filterCustomers,
  mergeCustomerLists,
  normalizeCustomerRecord,
} from '../../services/customerCrmHelpers';
import {
  findCachedCustomer,
  getMaxCachedCustomerSequence,
  loadCachedCustomers,
  loadCachedCustomerTombstones,
  markCustomerTombstoned,
  reconcileTombstonesFromServer,
  upsertCachedCustomer,
  upsertCachedCustomers,
} from '../../services/customerLocalCache';
import {
  deleteCustomerFromFirestore,
  ensureFirestoreUniqueCustomerAllocation,
  fetchCustomerFromFirestoreServer,
  getMaxFirestoreCustomerSequence,
  saveCustomerToFirestore,
  saveCustomersBatchToFirestore,
  saveNewCustomerToFirestore,
  subscribeCustomersFromFirestore,
} from '../../services/customerFirestore';
import {
  deleteCustomerPhotoFromStorage,
  uploadCustomerPhotoToStorage,
} from '../../services/customerPhotoStorage';
import {
  isSafeRemotePhotoUrl,
  sanitizeAadhaarInput,
  sanitizeMobileInput,
  sanitizePanInput,
  sanitizePinCodeInput,
  validateAadhaarNumber,
  validateCustomerPhotoFile,
  validateFullName,
  validateMobileNumber,
  validatePanNumber,
  validatePinCode,
  validateVillage,
} from '../../utils/customerValidation';
import {
  useCloudSync,
} from '../../services/cloudSync';
import { subscribeApplicationsFromFirestore, subscribePaymentsFromFirestore } from '../../services/erpFirestore';

interface CustomersCrmPageProps {
  currentUser: UserProfile;
  onStartApplicationForCustomer: (customerId: string) => void;
  onShowToast: (type: 'success' | 'error' | 'info', title: string, description?: string) => void;
}

const CONSENT_LABELS: Array<{ key: string; label: string }> = [
  { key: 'SMS_CONSENT', label: 'SMS Message Consent' },
  { key: 'WHATSAPP_CONSENT', label: 'WhatsApp Message Consent' },
  { key: 'STATUS_UPDATE_CONSENT', label: 'Application Status Update Consent' },
  { key: 'PAYMENT_REMINDER_CONSENT', label: 'Payment Reminder Consent' },
  { key: 'SERVICE_NOTIFICATION_CONSENT', label: 'Service Notification Consent' },
  { key: 'PROMOTIONAL_CONSENT', label: 'Promotional / Offer Consent' },
  { key: 'DATA_PRIVACY_CONSENT', label: 'Data Processing & Privacy Consent' },
];

const createDefaultConsentsState = (): Record<string, boolean> => ({
  SMS_CONSENT: true,
  WHATSAPP_CONSENT: true,
  STATUS_UPDATE_CONSENT: true,
  PAYMENT_REMINDER_CONSENT: true,
  SERVICE_NOTIFICATION_CONSENT: true,
  PROMOTIONAL_CONSENT: true,
  DATA_PRIVACY_CONSENT: true,
});

export const CustomersCrmPage: React.FC<CustomersCrmPageProps> = ({
  currentUser,
  onStartApplicationForCustomer,
  onShowToast,
}) => {
  const [apiCustomers, setApiCustomers] = useState<ErpCustomerItem[]>([]);
  const [firestoreCustomers, setFirestoreCustomers] = useState<ErpCustomerItem[]>([]);
  const [cachedCustomers, setCachedCustomers] = useState<ErpCustomerItem[]>(() =>
    loadCachedCustomers()
  );
  const [optimisticCustomers, setOptimisticCustomers] = useState<ErpCustomerItem[]>([]);
  const [firestoreApps, setFirestoreApps] = useState<ErpApplicationItem[]>([]);
  const [firestorePayments, setFirestorePayments] = useState<ErpPaymentItem[]>([]);
  const [deletedCustomerIds, setDeletedCustomerIds] = useState<string[]>(() =>
    loadCachedCustomerTombstones()
  );
  const cloudSync = useCloudSync();
  const activeFirebaseUid = cloudSync.userUid || auth?.currentUser?.uid || null;
  const [loading, setLoading] = useState(() => loadCachedCustomers().length === 0);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [segmentFilter, setSegmentFilter] = useState('All');
  const [showArchived, setShowArchived] = useState(false);
  const [page, setPage] = useState(1);
  const fetchSeqRef = useRef(0);
  const hasAnyLoadedRef = useRef(loadCachedCustomers().length > 0);
  const [permanentDeleteTarget, setPermanentDeleteTarget] = useState<ErpCustomerItem | null>(null);
  const [deletingPermanent, setDeletingPermanent] = useState(false);

  // Registration modal
  const [createOpen, setCreateOpen] = useState(false);
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [dupOverridePrompt, setDupOverridePrompt] = useState<string | null>(null);
  const [selectedPhoto, setSelectedPhoto] = useState<SelectedCustomerPhoto | null>(null);
  const [photoUploadProgress, setPhotoUploadProgress] = useState<number | null>(null);
  const [photoUploadStatus, setPhotoUploadStatus] = useState<string | null>(null);
  const onShowToastRef = useRef(onShowToast);
  onShowToastRef.current = onShowToast;
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [fieldNotices, setFieldNotices] = useState<Record<string, string>>({});
  const [reservedRegIds, setReservedRegIds] = useState<{ customerId: string; referenceNo: string } | null>(null);

  const [registrationSuccess, setRegistrationSuccess] = useState<{
    customer: ErpCustomerItem;
    customerId: string;
    referenceNo: string;
    photoDownloadURL?: string;
  } | null>(null);
  const [form, setForm] = useState({
    fullName: '',
    fatherOrHusbandName: '',
    dob: '',
    gender: 'Male' as 'Male' | 'Female' | 'Other',
    mobile: '',
    whatsapp: '',
    email: '',
    aadhaarNumber: '',
    panNumber: '',
    voterId: '',
    village: '',
    postOffice: '',
    policeStation: '',
    district: 'Murshidabad',
    pinCode: '',
    presentAddress: '',
    sameAsPresent: true,
    sameAsMobile: true,
    permanentAddress: '',
    segment: 'Regular' as CustomerSegment,
    overrideDuplicateReason: '',
  });
  const [newConsents, setNewConsents] = useState<Record<string, boolean>>(createDefaultConsentsState);

  // Customer 360 Profile modal
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileData, setProfileData] = useState<{
    customer: ErpCustomerItem;
    applications: ErpApplicationItem[];
    payments: ErpPaymentItem[];
  } | null>(null);
  const [profileTab, setProfileTab] = useState<'overview' | 'consents' | 'apps' | 'notes' | 'idcard'>('overview');
  const [noteInput, setNoteInput] = useState('');
  const [noteType, setNoteType] = useState<'INTERNAL_NOTE' | 'FOLLOW_UP'>('INTERNAL_NOTE');
  const [followUpDate, setFollowUpDate] = useState('');
  const [otpChallenge, setOtpChallenge] = useState<{
    challengeId: string;
    sandboxOtpPreview?: string;
    newMobile: string;
    otpInput: string;
  } | null>(null);
  const [decryptedAadhaar, setDecryptedAadhaar] = useState<string | null>(null);

  // Bulk import & Admin merge
  const [bulkOpen, setBulkOpen] = useState(false);
  const [csvInput, setCsvInput] = useState(
    'fullName,mobile,village,district\nRabiul Sk,9830100991,Mamudpur,Murshidabad\nSultana Khatun,9830100992,Juginda,Murshidabad'
  );
  const [bulkPreview, setBulkPreview] = useState<Array<{
    rowNumber: number;
    fullName: string;
    mobile: string;
    village: string;
    valid: boolean;
    errors: string[];
  }> | null>(null);

  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergePrimary, setMergePrimary] = useState('');
  const [mergeDuplicate, setMergeDuplicate] = useState('');
  const [mergeReason, setMergeReason] = useState('');
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editPinError, setEditPinError] = useState<string | null>(null);
  const [editPinNotice, setEditPinNotice] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    customerId: '',
    fullName: '',
    fatherOrHusbandName: '',
    email: '',
    village: '',
    district: 'Murshidabad',
    pinCode: '',
    presentAddress: '',
    segment: 'Regular' as CustomerSegment,
    status: 'Active' as 'Active' | 'Inactive' | 'Blocked',
  });

  const loadCustomers = useCallback(
    async (options?: { silent?: boolean }) => {
      const seq = ++fetchSeqRef.current;
      const silent = Boolean(options?.silent) || hasAnyLoadedRef.current;
      if (!silent) {
        setLoading(true);
      }
      try {
        const [res, tombRes] = await Promise.all([
          erpApi.listCustomers({ includeDeleted: true }),
          erpApi.getTombstones().catch(() => null),
        ]);
        if (seq !== fetchSeqRef.current) return;

        hasAnyLoadedRef.current = true;
        const serverTombstones = tombRes?.data?.deletedCustomerIds ?? [];
        const mergedTombstones = reconcileTombstonesFromServer(serverTombstones);
        setDeletedCustomerIds((prev) =>
          Array.from(new Set([...prev, ...mergedTombstones]))
        );
        const tombSet = new Set(mergedTombstones);

        let normalizedApi = res.data
          .map(normalizeCustomerRecord)
          .filter((c) => !tombSet.has(c.customerId));

        // Detect any locally persisted customers missing from a cold-started server instance
        const cachedBefore = loadCachedCustomers();
        const apiIdSet = new Set(normalizedApi.map((c) => c.customerId));
        const missingOnServer = cachedBefore.filter(
          (c) => !tombSet.has(c.customerId) && !apiIdSet.has(c.customerId)
        );

        let nextCached = upsertCachedCustomers(normalizedApi, {
          deletedIds: mergedTombstones,
        });

        if (missingOnServer.length > 0) {
          try {
            const syncRes = await erpApi.syncCustomers(missingOnServer);
            if (seq !== fetchSeqRef.current) return;
            const skipped = syncRes.data.skippedTombstonedIds ?? [];
            if (skipped.length > 0) {
              const afterSkipTombs = reconcileTombstonesFromServer(skipped);
              setDeletedCustomerIds((prev) =>
                Array.from(new Set([...prev, ...afterSkipTombs]))
              );
            }
            const syncedList = (syncRes.data.customers ?? []).map(normalizeCustomerRecord);
            if (syncedList.length > 0) {
              const combinedMap = new Map<string, ErpCustomerItem>();
              for (const c of normalizedApi) combinedMap.set(c.customerId, c);
              for (const c of syncedList) combinedMap.set(c.customerId, c);
              normalizedApi = Array.from(combinedMap.values());
              nextCached = upsertCachedCustomers(syncedList, {
                deletedIds: skipped,
              });
            }
          } catch {
            // Keep locally cached customers visible even if background sync fails
          }
        }

        setApiCustomers(normalizedApi);
        setCachedCustomers(nextCached);
      } catch (err) {
        const fallbackCached = loadCachedCustomers();
        if (fallbackCached.length > 0) {
          setCachedCustomers(fallbackCached);
          hasAnyLoadedRef.current = true;
        } else if (!activeFirebaseUid) {
          onShowToast('error', 'Failed to load Customers', extractFriendlyErrorMessage(err));
        }
      } finally {
        if (seq === fetchSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [activeFirebaseUid, onShowToast]
  );

  useEffect(() => {
    void loadCustomers({ silent: false });
  }, [loadCustomers]);

  useEffect(() => {
    if (!activeFirebaseUid || !isFirebaseConfigured()) {
      setFirestoreCustomers([]);
      setFirestoreApps([]);
      setFirestorePayments([]);
      return;
    }
    const unsubCust = subscribeCustomersFromFirestore(
      (docs) => {
        hasAnyLoadedRef.current = true;
        const normalizedDocs = docs.map(normalizeCustomerRecord);
        setFirestoreCustomers(normalizedDocs);
        setOptimisticCustomers((prev) =>
          prev.filter(
            (opt) => !normalizedDocs.some((fsDoc) => fsDoc.customerId === opt.customerId)
          )
        );
        setLoading(false);
      },
      (err) => {
        setLoading(false);
        onShowToastRef.current('error', 'Cloud Customer Sync Error', extractFriendlyErrorMessage(err));
      }
    );
    const unsubApps = subscribeApplicationsFromFirestore((docs) => setFirestoreApps(docs));
    const unsubPays = subscribePaymentsFromFirestore((docs) => setFirestorePayments(docs));
    return () => {
      unsubCust();
      unsubApps();
      unsubPays();
    };
  }, [activeFirebaseUid]);


  useEffect(() => {
    const handleCustomerCreated = (event: Event) => {
      const custom = event as CustomEvent<ErpCustomerItem>;
      const created = custom.detail;
      if (!created?.customerId) return;
      const normalized = upsertCachedCustomer(created, { allowUntombstone: true });
      hasAnyLoadedRef.current = true;
      setLoading(false);
      setCachedCustomers(loadCachedCustomers());
      setOptimisticCustomers((prev) => [
        normalized,
        ...prev.filter((c) => c.customerId !== normalized.customerId),
      ]);
      setApiCustomers((prev) => [
        normalized,
        ...prev.filter((c) => c.customerId !== normalized.customerId),
      ]);
      if (activeFirebaseUid) {
        setFirestoreCustomers((prev) => [
          normalized,
          ...prev.filter((c) => c.customerId !== normalized.customerId),
        ]);
      }
    };
    const handleCustomersChanged = () => {
      setCachedCustomers(loadCachedCustomers());
      void loadCustomers({ silent: true });
    };
    window.addEventListener('mun:customer-created', handleCustomerCreated);
    window.addEventListener('mun:customers-changed', handleCustomersChanged);
    return () => {
      window.removeEventListener('mun:customer-created', handleCustomerCreated);
      window.removeEventListener('mun:customers-changed', handleCustomersChanged);
    };
  }, [activeFirebaseUid, loadCustomers]);

  const mergedCustomers = useMemo(
    () =>
      mergeCustomerLists({
        firestoreCustomers,
        apiCustomers,
        cachedCustomers,
        optimisticCustomers,
        deletedCustomerIds,
      }),
    [firestoreCustomers, apiCustomers, cachedCustomers, optimisticCustomers, deletedCustomerIds]
  );

  const summaryMetrics = useMemo(
    () => computeCustomerSummaryMetrics(mergedCustomers),
    [mergedCustomers]
  );

  const customers = useMemo(
    () =>
      filterCustomers(mergedCustomers, {
        query,
        segment: segmentFilter,
        status: statusFilter,
        showArchived,
      }),
    [mergedCustomers, showArchived, statusFilter, segmentFilter, query]
  );

  const handlePermanentDeleteCustomer = async () => {
    if (!permanentDeleteTarget) return;
    setDeletingPermanent(true);
    const target = permanentDeleteTarget;
    try {
      await erpApi.deleteCustomer(target.customerId).catch((apiErr) => {
        const msg = extractFriendlyErrorMessage(apiErr).toLowerCase();
        if (!msg.includes('not found') && !msg.includes('404')) throw apiErr;
      });
      await deleteCustomerFromFirestore(target.customerId);
      markCustomerTombstoned(target.customerId);
      setDeletedCustomerIds((prev) => Array.from(new Set([...prev, target.customerId])));
      setCachedCustomers(loadCachedCustomers());
      setOptimisticCustomers((prev) => prev.filter((c) => c.customerId !== target.customerId));
      setApiCustomers((prev) => prev.filter((c) => c.customerId !== target.customerId));
      setFirestoreCustomers((prev) => prev.filter((c) => c.customerId !== target.customerId));
      if (profileData?.customer.customerId === target.customerId) {
        setProfileData(null);
      }
      setPermanentDeleteTarget(null);
      window.dispatchEvent(new CustomEvent('mun:customers-changed'));
      onShowToast('success', 'Customer Permanently Deleted', `${target.fullName} (${target.customerId}) removed permanently.`);
      await loadCustomers({ silent: true });
    } catch (err) {
      onShowToast('error', 'Permanent Delete Blocked', extractFriendlyErrorMessage(err));
    } finally {
      setDeletingPermanent(false);
    }
  };

  const openProfile = async (customerId: string) => {
    setProfileLoading(true);
    setDecryptedAadhaar(null);
    setProfileTab('overview');
    try {
      const [apiRes, serverFsCustomer] = await Promise.all([
        erpApi.getCustomerProfile(customerId).catch(() => null),
        activeFirebaseUid ? fetchCustomerFromFirestoreServer(customerId).catch(() => null) : Promise.resolve(null),
      ]);
      const localFsCustomer =
        serverFsCustomer ||
        firestoreCustomers.find((c) => c.customerId === customerId) ||
        mergedCustomers.find((c) => c.customerId === customerId) ||
        customers.find((c) => c.customerId === customerId) ||
        findCachedCustomer(customerId) ||
        null;
      const resolvedCustomer = localFsCustomer
        ? normalizeCustomerRecord({
            ...(apiRes?.data.customer ?? {}),
            ...localFsCustomer,
            photoDownloadURL:
              localFsCustomer.photoDownloadURL ||
              localFsCustomer.photoUrl ||
              apiRes?.data.customer.photoDownloadURL ||
              apiRes?.data.customer.photoUrl,
            photoUrl:
              localFsCustomer.photoDownloadURL ||
              localFsCustomer.photoUrl ||
              apiRes?.data.customer.photoDownloadURL ||
              apiRes?.data.customer.photoUrl,
            photoStoragePath:
              localFsCustomer.photoStoragePath || apiRes?.data.customer.photoStoragePath,
          })
        : apiRes?.data.customer
          ? normalizeCustomerRecord(apiRes.data.customer)
          : null;

      if (!resolvedCustomer) {
        throw new Error(`Customer ${customerId} not found in Firestore, local cache, or server memory.`);
      }

      if (!apiRes && !deletedCustomerIds.includes(resolvedCustomer.customerId)) {
        void erpApi.syncCustomers([resolvedCustomer]).catch(() => {});
      }

      setProfileData({
        customer: resolvedCustomer,
        applications:
          apiRes?.data.applications ?? firestoreApps.filter((a) => a.customerId === customerId),
        payments:
          apiRes?.data.payments ?? firestorePayments.filter((p) => p.customerId === customerId),
      });
    } catch (err) {
      onShowToast('error', 'Failed to inspect Customer', extractFriendlyErrorMessage(err));
    } finally {
      setProfileLoading(false);
    }
  };

  const resetRegistrationForm = useCallback(() => {
    setForm({
      fullName: '',
      fatherOrHusbandName: '',
      dob: '',
      gender: 'Male',
      mobile: '',
      whatsapp: '',
      email: '',
      aadhaarNumber: '',
      panNumber: '',
      voterId: '',
      village: '',
      postOffice: '',
      policeStation: '',
      district: 'Murshidabad',
      pinCode: '',
      presentAddress: '',
      sameAsPresent: true,
      sameAsMobile: true,
      permanentAddress: '',
      segment: 'Regular',
      overrideDuplicateReason: '',
    });
    setSelectedPhoto(null);
    setPhotoUploadProgress(null);
    setPhotoUploadStatus(null);
    setFieldErrors({});
    setFieldNotices({});
    setCreateError(null);
    setDupOverridePrompt(null);
    setReservedRegIds(null);
    setNewConsents(createDefaultConsentsState());
  }, []);


  const validateRegistrationForm = useCallback((): Record<string, string> => {
    const nextErrors: Record<string, string> = {};
    const nameErr = validateFullName(form.fullName);
    if (nameErr) nextErrors.fullName = nameErr;

    const mobileErr = validateMobileNumber(form.mobile, true);
    if (mobileErr) nextErrors.mobile = mobileErr;

    if (!form.sameAsMobile && form.whatsapp.trim().length > 0) {
      const waErr = validateMobileNumber(form.whatsapp, true);
      if (waErr) nextErrors.whatsapp = waErr;
    }

    const villageErr = validateVillage(form.village);
    if (villageErr) nextErrors.village = villageErr;

    const aadhaarErr = validateAadhaarNumber(form.aadhaarNumber, false);
    if (aadhaarErr) nextErrors.aadhaarNumber = aadhaarErr;

    const pinErr = validatePinCode(form.pinCode, false);
    if (pinErr) nextErrors.pinCode = pinErr;

    const panErr = validatePanNumber(form.panNumber, false);
    if (panErr) nextErrors.panNumber = panErr;

    if (selectedPhoto) {
      const photoErr = validateCustomerPhotoFile(selectedPhoto.file);
      if (photoErr) nextErrors.photo = photoErr;
    }

    return nextErrors;
  }, [form, selectedPhoto]);

  const hasFormValidationErrors = useMemo(() => {
    return Object.keys(validateRegistrationForm()).length > 0;
  }, [validateRegistrationForm]);

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    const nextErrors = validateRegistrationForm();
    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      setCreateError('Please fix the highlighted validation errors before submitting.');
      return;
    }
    setFieldErrors({});

    const cleanName = form.fullName.trim();
    const cleanMobile = form.mobile.trim();
    const cleanWhatsapp = form.sameAsMobile ? cleanMobile : form.whatsapp.trim() || cleanMobile;
    const cleanVillage = form.village.trim();
    const cleanAadhaar = form.aadhaarNumber.trim();
    const cleanPin = form.pinCode.trim();
    const cleanPan = form.panNumber.trim().toUpperCase();

    setSavingCustomer(true);
    setPhotoUploadProgress(null);
    setPhotoUploadStatus(null);
    let createdApiCustomerId: string | null = null;
    let uploadedPhotoStoragePath: string | null = null;

    try {
      await waitForFirebaseAuthReady();

      // Step 2: Reserve sequential Customer ID & Reference Number synchronized against Firestore & durable cache
      const maxFsSeq = Math.max(
        await getMaxFirestoreCustomerSequence(),
        getMaxCachedCustomerSequence()
      );
      const backendAlloc = reservedRegIds
        ? reservedRegIds
        : (
            await erpApi.reserveCustomerId({
              fullName: cleanName,
              mobile: cleanMobile,
              village: cleanVillage,
              aadhaarNumber: cleanAadhaar,
              pinCode: cleanPin,
              panNumber: cleanPan,
              minSequence: maxFsSeq,
              overrideDuplicateReason: form.overrideDuplicateReason.trim() || undefined,
            })
          ).data;

      const allocated = await ensureFirestoreUniqueCustomerAllocation({
        candidateId: backendAlloc.customerId,
        referenceNo: backendAlloc.referenceNo,
        mobile: cleanMobile,
        aadhaarNumber: cleanAadhaar,
        overrideDuplicateReason: form.overrideDuplicateReason.trim() || undefined,
      });
      setReservedRegIds({ customerId: allocated.customerId, referenceNo: allocated.referenceNo });

      // Step 3: Upload selected photograph to Firebase Storage & verify metadata before saving Firestore doc
      let photoStoragePath = '';
      let photoDownloadURL = '';

      if (selectedPhoto) {
        setPhotoUploadProgress(0);
        setPhotoUploadStatus('Uploading photograph to Firebase Storage (0%)...');

        const uploadResult = await uploadCustomerPhotoToStorage({
          customerId: allocated.customerId,
          file: selectedPhoto.file,
          fileName: selectedPhoto.fileName,
          onProgress: (pct) => {
            setPhotoUploadProgress(pct);
            setPhotoUploadStatus(
              pct >= 100
                ? 'Verifying uploaded photograph in Firebase Storage...'
                : `Uploading photograph to Firebase Storage (${pct}%)...`
            );
          },
        });

        photoStoragePath = uploadResult.photoStoragePath;
        photoDownloadURL = uploadResult.photoDownloadURL;
        uploadedPhotoStoragePath = uploadResult.photoStoragePath;
        setPhotoUploadStatus('Photograph uploaded & verified in Firebase Storage.');
      }

      // Step 4: Record customer in Express ERP backend
      const payload = {
        ...form,
        reservedCustomerId: allocated.customerId,
        referenceNo: allocated.referenceNo,
        fullName: cleanName,
        mobile: cleanMobile,
        whatsapp: cleanWhatsapp,
        village: cleanVillage,
        district: form.district.trim() || 'Murshidabad',
        pinCode: cleanPin,
        aadhaarNumber: cleanAadhaar,
        panNumber: cleanPan,
        photoStoragePath,
        photoDownloadURL,
        photoUrl: photoDownloadURL,
        segment: form.segment || 'Regular',
        consents: CONSENT_LABELS.map((c) => ({
          category: c.key,
          granted: Boolean(newConsents[c.key]),
          verificationMethod: 'Digital Signature',
        })),
      };
      const res = await erpApi.createCustomer(payload);
      createdApiCustomerId = res.data.customerId;

      const baseCustomer: ErpCustomerItem = {
        ...res.data,
        customerId: res.data.customerId || allocated.customerId,
        referenceNo: res.data.referenceNo || allocated.referenceNo,
        fullName: res.data.fullName || cleanName,
        name: res.data.fullName || cleanName,
        panNumber: res.data.panNumber || cleanPan || undefined,
        pan: res.data.panNumber || cleanPan || undefined,
        aadhaar: res.data.aadhaarMasked || undefined,
        photoStoragePath: photoStoragePath || res.data.photoStoragePath || undefined,
        photoDownloadURL: photoDownloadURL || res.data.photoDownloadURL || undefined,
        photoUrl: photoDownloadURL || res.data.photoDownloadURL || undefined,
        totalBusiness: 0,
        isArchived: false,
        deletedAt: res.data.deletedAt ?? null,
        status: res.data.status || 'Active',
        segment: res.data.segment || form.segment || 'Regular',
        createdAt: res.data.createdAt || new Date().toISOString(),
      };

      // Step 5: Write & verify Firestore (if Firebase Auth active) and persist to durable local cache
      setPhotoUploadStatus('Saving and verifying customer record...');
      const savedCustomer = upsertCachedCustomer(
        normalizeCustomerRecord(await saveNewCustomerToFirestore(baseCustomer)),
        { allowUntombstone: true }
      );
      hasAnyLoadedRef.current = true;
      setLoading(false);
      setCachedCustomers(loadCachedCustomers());

      setOptimisticCustomers((prev) => [
        savedCustomer,
        ...prev.filter((c) => c.customerId !== savedCustomer.customerId),
      ]);
      setApiCustomers((prev) => [
        savedCustomer,
        ...prev.filter((c) => c.customerId !== savedCustomer.customerId),
      ]);
      setFirestoreCustomers((prev) => [
        savedCustomer,
        ...prev.filter((c) => c.customerId !== savedCustomer.customerId),
      ]);
      setQuery('');
      setStatusFilter('All');
      setSegmentFilter('All');
      setShowArchived(false);
      setPage(1);

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('mun:customer-created', { detail: savedCustomer }));
      }

      const finalRefNo =
        savedCustomer.referenceNo ||
        allocated.referenceNo ||
        `MCR-${savedCustomer.customerId.replace(/^MCC-/, '')}`;
      onShowToastRef.current(
        'success',
        activeFirebaseUid ? 'Customer Registered & Saved to Firestore' : 'Customer Registered & Saved',
        `${savedCustomer.customerId} · Ref: ${finalRefNo}`
      );
      resetRegistrationForm();
      setRegistrationSuccess({
        customer: savedCustomer,
        customerId: savedCustomer.customerId,
        referenceNo: finalRefNo,
        photoDownloadURL: savedCustomer.photoDownloadURL || savedCustomer.photoUrl,
      });
    } catch (err) {
      if (createdApiCustomerId) {
        await erpApi.deleteCustomer(createdApiCustomerId).catch(() => {});
      }
      if (uploadedPhotoStoragePath) {
        await deleteCustomerPhotoFromStorage(uploadedPhotoStoragePath).catch(() => {});
      }
      const msg = extractFriendlyErrorMessage(err, 'Unable to save customer to Cloud Firestore.');
      if (msg.toLowerCase().includes('duplicate')) {
        setDupOverridePrompt(msg);
      } else {
        setCreateError(msg);
      }
      onShowToastRef.current('error', 'Customer Registration Failed', msg);
    } finally {
      setSavingCustomer(false);
      setPhotoUploadProgress(null);
      setPhotoUploadStatus(null);
    }
  };

  const openEditProfile = (c: ErpCustomerItem) => {
    setEditPinError(null);
    setEditPinNotice(null);
    setEditForm({
      customerId: c.customerId,
      fullName: c.fullName || c.name || '',
      fatherOrHusbandName: c.fatherOrHusbandName || '',
      email: c.email || '',
      village: c.village || '',
      district: c.district || 'Murshidabad',
      pinCode: c.pinCode || '',
      presentAddress: c.presentAddress || '',
      segment: c.segment || 'Regular',
      status: c.status || 'Active',
    });
    setEditOpen(true);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editForm.fullName.trim() || editForm.fullName.trim().length < 2) {
      onShowToast('error', 'Invalid Name', 'Full name must be at least 2 characters.');
      return;
    }
    const pinErr = validatePinCode(editForm.pinCode, false);
    if (pinErr) {
      setEditPinError(pinErr);
      onShowToast('error', 'Invalid PIN Code', pinErr);
      return;
    }
    setSavingEdit(true);
    try {
      const updatePatch = {
        fullName: editForm.fullName.trim(),
        fatherOrHusbandName: editForm.fatherOrHusbandName.trim(),
        email: editForm.email.trim(),
        village: editForm.village.trim(),
        district: editForm.district.trim(),
        pinCode: editForm.pinCode.trim(),
        presentAddress: editForm.presentAddress.trim(),
        segment: editForm.segment,
        status: editForm.status,
      };
      let updatedCustomer: ErpCustomerItem;
      try {
        const res = await erpApi.updateCustomer(editForm.customerId, updatePatch);
        updatedCustomer = res.data;
      } catch (apiErr) {
        const msg = extractFriendlyErrorMessage(apiErr).toLowerCase();
        const existingLocal =
          firestoreCustomers.find((c) => c.customerId === editForm.customerId) ||
          customers.find((c) => c.customerId === editForm.customerId);
        if ((msg.includes('not found') || msg.includes('404')) && existingLocal) {
          updatedCustomer = {
            ...existingLocal,
            ...updatePatch,
            updatedAt: new Date().toISOString(),
          };
        } else {
          throw apiErr;
        }
      }

      await saveCustomerToFirestore(updatedCustomer);
      const normalizedUpdated = upsertCachedCustomer(normalizeCustomerRecord(updatedCustomer));
      setCachedCustomers(loadCachedCustomers());
      setOptimisticCustomers((prev) => [
        normalizedUpdated,
        ...prev.filter((c) => c.customerId !== normalizedUpdated.customerId),
      ]);
      setApiCustomers((prev) =>
        prev.map((c) => (c.customerId === normalizedUpdated.customerId ? { ...c, ...normalizedUpdated } : c))
      );
      if (activeFirebaseUid) {
        setFirestoreCustomers((prev) =>
          prev.map((c) => (c.customerId === normalizedUpdated.customerId ? { ...c, ...normalizedUpdated } : c))
        );
      }
      setProfileData((prev) =>
        prev && prev.customer.customerId === normalizedUpdated.customerId
          ? { ...prev, customer: normalizedUpdated }
          : prev
      );
      setEditOpen(false);
      onShowToast('success', 'Customer Updated', `${normalizedUpdated.customerId} saved permanently.`);
    } catch (err) {
      onShowToast('error', 'Update Failed', extractFriendlyErrorMessage(err));
    } finally {
      setSavingEdit(false);
    }
  };

  const handleBulkPreviewOrCommit = async (commit: boolean) => {
    try {
      const lines = csvInput
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const start = lines[0]?.toLowerCase().includes('fullname') ? 1 : 0;
      const rows = lines.slice(start).map((line) => {
        const [fullName = '', mobile = '', village = '', district = 'Murshidabad'] = line
          .split(',')
          .map((s) => s.trim());
        return { fullName, mobile, village, district };
      });
      const res = await erpApi.bulkImportCustomers(rows, commit);
      setBulkPreview(res.data.preview);
      if (commit) {
        if (res.data.createdIds.length > 0) {
          const allCustRes = await erpApi.listCustomers({ includeDeleted: true });
          const idSet = new Set(res.data.createdIds);
          const createdRecords = allCustRes.data.filter((c) => idSet.has(c.customerId));
          if (createdRecords.length > 0) {
            const savedBatch = (await saveCustomersBatchToFirestore(createdRecords)).map(
              (c) => upsertCachedCustomer(normalizeCustomerRecord(c), { allowUntombstone: true })
            );
            setCachedCustomers(loadCachedCustomers());
            const savedIds = new Set(savedBatch.map((c) => c.customerId));
            setOptimisticCustomers((prev) => [
              ...savedBatch,
              ...prev.filter((c) => !savedIds.has(c.customerId)),
            ]);
            setApiCustomers((prev) => [
              ...savedBatch,
              ...prev.filter((c) => !savedIds.has(c.customerId)),
            ]);
            if (activeFirebaseUid) {
              setFirestoreCustomers((prev) => [
                ...savedBatch,
                ...prev.filter((c) => !savedIds.has(c.customerId)),
              ]);
            }
          }
        }
        onShowToast('success', 'Bulk Import Saved', res.message);
        setBulkOpen(false);
        setBulkPreview(null);
        await loadCustomers({ silent: true });
      }
    } catch (err) {
      onShowToast('error', 'Import Error', extractFriendlyErrorMessage(err));
    }
  };

  const handleToggleConsent = async (category: string, nextGranted: boolean) => {
    if (!profileData) return;
    try {
      let updatedCustomer: ErpCustomerItem;
      try {
        const res = await erpApi.updateCustomerConsents(profileData.customer.customerId, {
          updates: [{ category, granted: nextGranted }],
          verificationMethod: 'Digital Signature',
          notes: 'Updated via Customer 360° Profile',
        });
        updatedCustomer = res.data;
      } catch (apiErr) {
        const msg = extractFriendlyErrorMessage(apiErr).toLowerCase();
        if (!msg.includes('not found') && !msg.includes('404')) throw apiErr;
        const now = new Date().toISOString();
        updatedCustomer = {
          ...profileData.customer,
          consents: profileData.customer.consents.map((c) =>
            c.category === category ? { ...c, granted: nextGranted, recordedAt: now } : c
          ),
          updatedAt: now,
        };
      }
      await saveCustomerToFirestore(updatedCustomer);
      const cachedUpdated = upsertCachedCustomer(updatedCustomer);
      setCachedCustomers(loadCachedCustomers());
      setOptimisticCustomers((prev) => [
        cachedUpdated,
        ...prev.filter((c) => c.customerId !== cachedUpdated.customerId),
      ]);
      setProfileData((prev) => (prev ? { ...prev, customer: cachedUpdated } : prev));
      onShowToast('success', 'Consent Saved', `${category} set to ${nextGranted ? 'Granted' : 'Revoked'}`);
    } catch (err) {
      onShowToast('error', 'Failed', extractFriendlyErrorMessage(err));
    }
  };

  const handleSendCustomerOtp = async () => {
    if (!profileData) return;
    const targetMob = otpChallenge?.newMobile || profileData.customer.mobile;
    try {
      const res = await erpApi.sendMobileOtp(targetMob);
      setOtpChallenge({
        challengeId: res.data.challengeId,
        sandboxOtpPreview: res.data.sandboxOtpPreview,
        newMobile: targetMob,
        otpInput: res.data.sandboxOtpPreview || '',
      });
      onShowToast(
        'info',
        'OTP Verification Challenge Issued',
        res.data.providerConfigured ? 'Dispatched via SMS gateway.' : `Sandbox preview OTP: ${res.data.sandboxOtpPreview}`
      );
    } catch (err) {
      onShowToast('error', 'OTP Error', extractFriendlyErrorMessage(err));
    }
  };

  const handleVerifyCustomerOtp = async () => {
    if (!profileData || !otpChallenge) return;
    try {
      const v = await erpApi.verifyMobileOtp(otpChallenge.challengeId, otpChallenge.otpInput);
      let updatedCustomer: ErpCustomerItem;
      try {
        const updated = await erpApi.verifyCustomerContact(profileData.customer.customerId, {
          newMobile: otpChallenge.newMobile,
          verificationToken: v.data.verificationToken,
        });
        updatedCustomer = updated.data;
      } catch (apiErr) {
        const msg = extractFriendlyErrorMessage(apiErr).toLowerCase();
        if (!msg.includes('not found') && !msg.includes('404')) throw apiErr;
        const now = new Date().toISOString();
        updatedCustomer = {
          ...profileData.customer,
          mobile: otpChallenge.newMobile,
          verificationStatus: 'OTP Verified',
          mobileOtpVerifiedAt: now,
          updatedAt: now,
        };
      }
      await saveCustomerToFirestore(updatedCustomer);
      const cachedVerified = upsertCachedCustomer(updatedCustomer);
      setCachedCustomers(loadCachedCustomers());
      setOptimisticCustomers((prev) => [
        cachedVerified,
        ...prev.filter((c) => c.customerId !== cachedVerified.customerId),
      ]);
      setProfileData((prev) => (prev ? { ...prev, customer: cachedVerified } : prev));
      setOtpChallenge(null);
      onShowToast('success', 'Mobile OTP Verified & Saved', `${cachedVerified.customerId} marked ${cachedVerified.verificationStatus}`);
      await loadCustomers();
    } catch (err) {
      onShowToast('error', 'Verification Failed', extractFriendlyErrorMessage(err));
    }
  };

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profileData || !noteInput.trim()) return;
    try {
      let updatedCustomer: ErpCustomerItem;
      try {
        const res = await erpApi.addCustomerNote(profileData.customer.customerId, {
          type: noteType,
          text: noteInput,
          followUpDate: noteType === 'FOLLOW_UP' ? followUpDate : undefined,
        });
        updatedCustomer = res.data;
      } catch (apiErr) {
        const msg = extractFriendlyErrorMessage(apiErr).toLowerCase();
        if (!msg.includes('not found') && !msg.includes('404')) throw apiErr;
        const now = new Date().toISOString();
        updatedCustomer = {
          ...profileData.customer,
          notesAndFollowUps: [
            {
              id: Date.now(),
              type: noteType,
              text: noteInput.trim(),
              followUpDate: noteType === 'FOLLOW_UP' ? followUpDate : undefined,
              authorUserId: currentUser.userId,
              createdAt: now,
            },
            ...profileData.customer.notesAndFollowUps,
          ],
          updatedAt: now,
        };
      }
      await saveCustomerToFirestore(updatedCustomer);
      const cachedWithNote = upsertCachedCustomer(updatedCustomer);
      setCachedCustomers(loadCachedCustomers());
      setOptimisticCustomers((prev) => [
        cachedWithNote,
        ...prev.filter((c) => c.customerId !== cachedWithNote.customerId),
      ]);
      setProfileData((prev) => (prev ? { ...prev, customer: cachedWithNote } : prev));
      setNoteInput('');
      onShowToast('success', 'CRM Note Saved');
    } catch (err) {
      onShowToast('error', 'Failed', extractFriendlyErrorMessage(err));
    }
  };

  const handleMerge = async (e: React.FormEvent) => {
    e.preventDefault();
    setMergeError(null);
    setMerging(true);
    try {
      const res = await erpApi.mergeCustomers({
        primaryCustomerId: mergePrimary.trim(),
        duplicateCustomerId: mergeDuplicate.trim(),
        reason: mergeReason.trim(),
      });
      await saveCustomerToFirestore(res.data.primaryCustomer);
      upsertCachedCustomer(res.data.primaryCustomer);
      const dupRec = customers.find((c) => c.customerId === res.data.mergedDuplicateId);
      if (dupRec) {
        const archivedDup: ErpCustomerItem = {
          ...dupRec,
          status: 'Inactive',
          isArchived: true,
          deletedAt: new Date().toISOString(),
        };
        await saveCustomerToFirestore(archivedDup);
        upsertCachedCustomer(archivedDup);
      }
      setCachedCustomers(loadCachedCustomers());
      onShowToast(
        'success',
        'Customers Merged & Synced',
        `Moved ${res.data.relinkedApplicationsCount} application(s) to ${mergePrimary}`
      );
      setMergeOpen(false);
      await loadCustomers();
    } catch (err) {
      const msg = extractFriendlyErrorMessage(err, 'Unable to merge customers.');
      setMergeError(msg);
      onShowToast('error', 'Merge Failed', msg);
    } finally {
      setMerging(false);
    }
  };

  const paginated = useMemo(() => paginateArray(customers, page, 8), [customers, page]);

  const columns: TableColumn<ErpCustomerItem>[] = [
    {
      key: 'customerId',
      header: 'Customer ID',
      render: (r) => (
        <div>
          <span className="font-mono text-xs font-semibold text-neutral-950 dark:text-white">
            {r.customerId}
          </span>
          {(r.deletedAt || r.isArchived) && (
            <span className="ml-2 text-[10px] font-mono uppercase text-red-600">Archived</span>
          )}
        </div>
      ),
    },
    {
      key: 'fullName',
      header: 'Customer & Address',
      render: (r) => {
        const photoUrl = isSafeRemotePhotoUrl(r.photoDownloadURL || r.photoUrl)
          ? (r.photoDownloadURL || r.photoUrl)!
          : null;
        return (
          <div className="flex items-center gap-2.5">
            {photoUrl ? (
              <img
                src={photoUrl}
                alt={r.fullName || r.name || 'Customer'}
                className="w-9 h-9 rounded-full object-cover border border-neutral-200 dark:border-neutral-700 shrink-0"
              />
            ) : (
              <div className="w-9 h-9 rounded-full bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 flex items-center justify-center text-xs font-semibold text-neutral-600 dark:text-neutral-300 shrink-0">
                {(r.fullName || r.name || 'C').slice(0, 1).toUpperCase()}
              </div>
            )}
            <div>
              <div className="font-medium text-neutral-950 dark:text-white">
                {r.fullName || r.name || 'Unnamed Customer'}
              </div>
              <div className="text-xs text-neutral-500 dark:text-neutral-400">
                {r.village || '—'} · {r.district || 'Murshidabad'} ({r.segment || 'Regular'})
              </div>
            </div>
          </div>
        );
      },
    },
    {
      key: 'mobile',
      header: 'Mobile / Verification',
      render: (r) => (
        <div>
          <div className="font-mono text-xs text-neutral-900 dark:text-neutral-200">{r.mobile}</div>
          <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
            {r.verificationStatus || 'Consent Verified'}
          </div>
        </div>
      ),
    },
    {
      key: 'apps',
      header: 'Applications',
      render: (r) => (
        <span className="font-mono text-xs tabular-nums">
          {r.stats?.activeApplications ?? 0} active / {r.stats?.applicationCount ?? 0} total
        </span>
      ),
    },
    {
      key: 'balance',
      header: 'Paid / Due',
      align: 'right',
      render: (r) => (
        <div className="text-right font-mono text-xs tabular-nums">
          <div className="text-neutral-950 dark:text-white">
            {formatCurrency(r.stats?.totalPaid ?? r.totalBusiness ?? 0)}
          </div>
          {(r.stats?.pendingBalance ?? 0) > 0 && (
            <div className="text-amber-600 dark:text-amber-400">Due {formatCurrency(r.stats!.pendingBalance)}</div>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Action',
      align: 'right',
      render: (r) => (
        <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="outline" onClick={() => openProfile(r.customerId)}>
            360° Profile
          </Button>
          {!(r.deletedAt || r.isArchived) ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onStartApplicationForCustomer(r.customerId)}
              icon={<FilePlus2 className="h-3 w-3" />}
            >
              New App
            </Button>
          ) : (
            currentUser.role === 'ADMIN' && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      let restoredData: ErpCustomerItem;
                      try {
                        const restored = await erpApi.restoreCustomer(r.customerId);
                        restoredData = restored.data;
                      } catch (apiErr) {
                        const msg = extractFriendlyErrorMessage(apiErr).toLowerCase();
                        if (!msg.includes('not found') && !msg.includes('404')) throw apiErr;
                        restoredData = {
                          ...r,
                          deletedAt: null,
                          isArchived: false,
                          status: 'Active',
                          updatedAt: new Date().toISOString(),
                        };
                      }
                      await saveCustomerToFirestore(restoredData);
                      const cachedRestored = upsertCachedCustomer(restoredData, {
                        allowUntombstone: true,
                      });
                      setCachedCustomers(loadCachedCustomers());
                      setOptimisticCustomers((prev) => [
                        cachedRestored,
                        ...prev.filter((c) => c.customerId !== r.customerId),
                      ]);
                      setApiCustomers((prev) =>
                        prev.map((c) => (c.customerId === r.customerId ? cachedRestored : c))
                      );
                      window.dispatchEvent(new CustomEvent('mun:customers-changed'));
                      onShowToast('success', 'Customer Restored', r.customerId);
                      loadCustomers();
                    } catch (err) {
                      onShowToast('error', 'Restore Failed', extractFriendlyErrorMessage(err));
                    }
                  }}
                  icon={<RotateCcw className="h-3 w-3" />}
                >
                  Restore
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => setPermanentDeleteTarget(r)}
                  icon={<Trash2 className="h-3 w-3" />}
                >
                  Delete
                </Button>
              </>
            )
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-neutral-950 dark:text-white">
            Customer Management &amp; CRM
          </h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            MCC sequential FY IDs, duplicate Mobile/Aadhaar guards, OTP contact verification, and 7-category consent ledger
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {currentUser.role === 'ADMIN' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMergeOpen(true)}
              icon={<GitMerge className="h-3.5 w-3.5" />}
            >
              Merge Duplicates
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setBulkOpen(true)}
            icon={<Upload className="h-3.5 w-3.5" />}
          >
            Bulk CSV Import
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => {
              setRegistrationSuccess(null);
              setCreateError(null);
              setFieldErrors({});
              setFieldNotices({});
              setDupOverridePrompt(null);
              setReservedRegIds(null);
              setNewConsents(createDefaultConsentsState());
              setCreateOpen(true);
            }}
            icon={<Plus className="h-3.5 w-3.5" />}
          >
            Register Customer
          </Button>
        </div>
      </div>

      {/* Live Summary Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
            <span>Total Customers</span>
            <Users className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-neutral-950 dark:text-white">
            {summaryMetrics.totalCustomers}
          </div>
          <div className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
            Live synced directory records
          </div>
        </div>

        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
            <span>Active Customers</span>
            <UserCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-neutral-950 dark:text-white">
            {summaryMetrics.activeCustomers}
          </div>
          <div className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
            Active &amp; eligible for services
          </div>
        </div>

        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
            <span>VIP Customers</span>
            <Star className="h-4 w-4 text-amber-500 dark:text-amber-400" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-neutral-950 dark:text-white">
            {summaryMetrics.vipCustomers}
          </div>
          <div className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
            Priority &amp; high-value segment
          </div>
        </div>

        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
            <span>Total Business</span>
            <IndianRupee className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-neutral-950 dark:text-white">
            {formatCurrency(summaryMetrics.totalBusiness)}
          </div>
          <div className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
            Cumulative collected volume
          </div>
        </div>
      </div>

      {/* Filters Bar */}
      <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="h-3.5 w-3.5 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Search ID, name, mobile, village, PAN..."
            className="w-full h-9 pl-8 pr-3 text-xs bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Filter by segment"
            value={segmentFilter}
            onChange={(e) => {
              setSegmentFilter(e.target.value);
              setPage(1);
            }}
            className="h-9 px-2.5 text-xs bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
          >
            <option value="All">All Segments</option>
            <option value="Regular">Regular</option>
            <option value="VIP">VIP</option>
            <option value="Individual">Individual</option>
            <option value="Corporate">Corporate</option>
            <option value="Government">Government</option>
            <option value="General">General</option>
          </select>
          <select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="h-9 px-2.5 text-xs bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
          >
            <option value="All">All Status</option>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
            <option value="Blocked">Blocked</option>
          </select>
          <label className="inline-flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300 px-2">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => {
                setShowArchived(e.target.checked);
                setPage(1);
              }}
            />
            Show Archived
          </label>
        </div>
      </div>

      <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
        <DataTable
          columns={columns}
          data={paginated.items}
          rowKey={(r) => r.customerId}
          loading={loading}
          pagination={paginated.pagination}
          onPageChange={setPage}
          onRowClick={(r) => openProfile(r.customerId)}
          emptyActionLabel={
            query || segmentFilter !== 'All' || statusFilter !== 'All' || showArchived
              ? 'Reset Filters'
              : undefined
          }
          onEmptyAction={() => {
            setQuery('');
            setSegmentFilter('All');
            setStatusFilter('All');
            setShowArchived(false);
            setPage(1);
          }}
        />
      </div>

      {/* Register Customer Modal */}
      <Modal
        isOpen={createOpen}
        onClose={() => {
          if (savingCustomer) return;
          setCreateError(null);
          setRegistrationSuccess(null);
          setCreateOpen(false);
        }}
        title="Register New Customer (CRM)"
        description="Generates sequential Customer ID & Reference Number, uploads verified photograph to Firebase Storage, and persists to Firestore."
        maxWidthClass="max-w-3xl"
      >
        {registrationSuccess ? (
          <div className="space-y-4 text-xs">
            <div className="p-4 rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 flex flex-col sm:flex-row items-start sm:items-center gap-4">
              {isSafeRemotePhotoUrl(registrationSuccess.photoDownloadURL) ? (
                <img
                  src={registrationSuccess.photoDownloadURL}
                  alt={registrationSuccess.customer.fullName}
                  className="w-20 h-24 rounded-md object-cover border border-emerald-300 dark:border-emerald-700 shrink-0"
                />
              ) : (
                <div className="w-20 h-24 rounded-md border border-emerald-200 dark:border-emerald-800 bg-white dark:bg-neutral-900 flex items-center justify-center text-emerald-600 shrink-0">
                  <User className="h-8 w-8" />
                </div>
              )}
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-sm font-bold text-emerald-800 dark:text-emerald-300">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  Registration Successful
                </div>
                <div className="text-neutral-800 dark:text-neutral-200 font-medium text-sm">
                  {registrationSuccess.customer.fullName}
                </div>
                <div className="flex flex-wrap gap-3 font-mono text-xs pt-1">
                  <span className="px-2 py-1 rounded bg-white dark:bg-neutral-900 border border-emerald-200 dark:border-emerald-800">
                    Customer ID: <strong>{registrationSuccess.customerId}</strong>
                  </span>
                  <span className="px-2 py-1 rounded bg-white dark:bg-neutral-900 border border-emerald-200 dark:border-emerald-800">
                    Reference No: <strong>{registrationSuccess.referenceNo}</strong>
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const cid = registrationSuccess.customerId;
                  setRegistrationSuccess(null);
                  setCreateOpen(false);
                  void openProfile(cid);
                }}
              >
                Open 360° Profile
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setRegistrationSuccess(null);
                  resetRegistrationForm();
                }}
              >
                Register Another Customer
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => {
                  setRegistrationSuccess(null);
                  setCreateOpen(false);
                }}
              >
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleCreateCustomer} className="space-y-4" noValidate>
            {photoUploadStatus && savingCustomer && (
              <div className="px-3 py-2 text-xs rounded border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-200">
                {photoUploadStatus}
              </div>
            )}
            {createError && (
              <div
                role="alert"
                className="px-3 py-2 text-xs rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 flex flex-wrap items-center justify-between gap-2"
              >
                <span>{createError}</span>
                {reservedRegIds && (
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    disabled={savingCustomer}
                  >
                    Retry Save
                  </Button>
                )}
              </div>
            )}
            {dupOverridePrompt && (
              <div className="p-3 border border-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded text-xs space-y-2">
                <div className="font-semibold text-amber-800 dark:text-amber-300">{dupOverridePrompt}</div>
                {(currentUser.role === 'ADMIN' || currentUser.role === 'MANAGER') && (
                  <div>
                    <label className="block font-medium mb-1">Authorized Override Reason (Manager/Admin Only)</label>
                    <input
                      type="text"
                      value={form.overrideDuplicateReason}
                      onChange={(e) => setForm({ ...form, overrideDuplicateReason: e.target.value })}
                      placeholder="e.g., Family member sharing phone with valid consent"
                      className="w-full h-9 px-3 border border-amber-300 rounded bg-white dark:bg-neutral-950 text-xs"
                    />
                  </div>
                )}
              </div>
            )}

            <CustomerPhotoCapture
              value={selectedPhoto}
              onChange={(photo) => {
                setSelectedPhoto(photo);
                setFieldErrors((prev) => ({ ...prev, photo: '' }));
              }}
              disabled={savingCustomer}
              isModalOpen={createOpen}
              uploadProgress={photoUploadProgress}
            />
            {fieldErrors.photo && (
              <p className="text-xs text-red-600">{fieldErrors.photo}</p>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-medium mb-1">Full Name *</label>
                <input
                  required
                  value={form.fullName}
                  onChange={(e) => {
                    const nextVal = e.target.value;
                    setForm({ ...form, fullName: nextVal });
                    setFieldErrors((prev) => ({
                      ...prev,
                      fullName: nextVal.trim() ? validateFullName(nextVal) || '' : '',
                    }));
                  }}
                  onBlur={() =>
                    setFieldErrors((prev) => ({
                      ...prev,
                      fullName: validateFullName(form.fullName) || '',
                    }))
                  }
                  className={`w-full h-9 px-3 border rounded bg-white dark:bg-neutral-950 ${
                    fieldErrors.fullName
                      ? 'border-red-500 focus:outline-none'
                      : 'border-neutral-300 dark:border-neutral-700'
                  }`}
                />
                {fieldErrors.fullName && (
                  <p className="mt-1 text-[11px] text-red-600">{fieldErrors.fullName}</p>
                )}
              </div>

              <div>
                <label className="block font-medium mb-1">Father / Husband Name</label>
                <input
                  value={form.fatherOrHusbandName}
                  onChange={(e) => setForm({ ...form, fatherOrHusbandName: e.target.value })}
                  className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block font-medium">Mobile Number *</label>
                  <span
                    className={`font-mono text-[11px] ${
                      form.mobile.length === 10
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-neutral-500'
                    }`}
                  >
                    {form.mobile.length}/10
                  </span>
                </div>
                <div
                  className={`flex rounded-md border overflow-hidden bg-white dark:bg-neutral-950 ${
                    fieldErrors.mobile
                      ? 'border-red-500'
                      : 'border-neutral-300 dark:border-neutral-700'
                  }`}
                >
                  <span className="inline-flex items-center px-3 bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 text-xs font-mono font-medium border-r border-neutral-300 dark:border-neutral-700">
                    +91
                  </span>
                  <input
                    required
                    type="tel"
                    inputMode="numeric"
                    maxLength={10}
                    value={form.mobile}
                    onChange={(e) => {
                      const res = sanitizeMobileInput(e.target.value);
                      setForm({
                        ...form,
                        mobile: res.value,
                        whatsapp: form.sameAsMobile ? res.value : form.whatsapp,
                      });
                      setFieldNotices((prev) => ({ ...prev, mobile: res.notice || '' }));
                      setFieldErrors((prev) => ({
                        ...prev,
                        mobile:
                          res.value.length === 10
                            ? ''
                            : res.value.length > 0
                            ? `Mobile number must be exactly 10 digits (${res.value.length}/10).`
                            : '',
                      }));
                    }}
                    onBlur={() =>
                      setFieldErrors((prev) => ({
                        ...prev,
                        mobile: validateMobileNumber(form.mobile, true) || '',
                      }))
                    }
                    placeholder="9830000000"
                    className="w-full h-9 px-3 border-0 bg-transparent font-mono text-xs focus:outline-none"
                  />
                </div>
                {fieldErrors.mobile && (
                  <p className="mt-1 text-[11px] text-red-600">{fieldErrors.mobile}</p>
                )}
                {!fieldErrors.mobile && fieldNotices.mobile && (
                  <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{fieldNotices.mobile}</p>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <label className="block font-medium">WhatsApp</label>
                    <label className="inline-flex items-center gap-1 text-[11px] text-neutral-600 dark:text-neutral-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.sameAsMobile}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setForm({
                            ...form,
                            sameAsMobile: checked,
                            whatsapp: checked ? form.mobile : form.whatsapp,
                          });
                          if (checked) {
                            setFieldErrors((prev) => ({ ...prev, whatsapp: '' }));
                            setFieldNotices((prev) => ({ ...prev, whatsapp: '' }));
                          }
                        }}
                        className="rounded border-neutral-300"
                      />
                      <span>Same as Mobile</span>
                    </label>
                  </div>
                  <span className="font-mono text-[11px] text-neutral-500">
                    {(form.sameAsMobile ? form.mobile : form.whatsapp).length}/10
                  </span>
                </div>
                <div
                  className={`flex rounded-md border overflow-hidden bg-white dark:bg-neutral-950 ${
                    fieldErrors.whatsapp
                      ? 'border-red-500'
                      : 'border-neutral-300 dark:border-neutral-700'
                  }`}
                >
                  <span className="inline-flex items-center px-3 bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 text-xs font-mono font-medium border-r border-neutral-300 dark:border-neutral-700">
                    +91
                  </span>
                  <input
                    type="tel"
                    inputMode="numeric"
                    maxLength={10}
                    value={form.sameAsMobile ? form.mobile : form.whatsapp}
                    disabled={form.sameAsMobile}
                    onChange={(e) => {
                      const res = sanitizeMobileInput(e.target.value);
                      setForm({ ...form, whatsapp: res.value });
                      setFieldNotices((prev) => ({ ...prev, whatsapp: res.notice || '' }));
                      setFieldErrors((prev) => ({
                        ...prev,
                        whatsapp: res.value
                          ? validateMobileNumber(res.value, false) || ''
                          : '',
                      }));
                    }}
                    placeholder="9830000000"
                    className="w-full h-9 px-3 border-0 bg-transparent font-mono text-xs focus:outline-none disabled:opacity-75"
                  />
                </div>
                {fieldErrors.whatsapp && (
                  <p className="mt-1 text-[11px] text-red-600">{fieldErrors.whatsapp}</p>
                )}
                {!fieldErrors.whatsapp && fieldNotices.whatsapp && (
                  <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{fieldNotices.whatsapp}</p>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block font-medium">Aadhaar (12 digits, Encrypted &amp; Masked)</label>
                  <span
                    className={`font-mono text-[11px] ${
                      form.aadhaarNumber.length === 12
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-neutral-500'
                    }`}
                  >
                    {form.aadhaarNumber.length}/12
                  </span>
                </div>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={12}
                  value={form.aadhaarNumber}
                  onChange={(e) => {
                    const res = sanitizeAadhaarInput(e.target.value);
                    setForm({ ...form, aadhaarNumber: res.value });
                    setFieldNotices((prev) => ({ ...prev, aadhaarNumber: res.notice || '' }));
                    setFieldErrors((prev) => ({
                      ...prev,
                      aadhaarNumber:
                        res.value.length === 0 || res.value.length === 12
                          ? ''
                          : `Aadhaar number must be exactly 12 digits (${res.value.length}/12).`,
                    }));
                  }}
                  onBlur={() =>
                    setFieldErrors((prev) => ({
                      ...prev,
                      aadhaarNumber: validateAadhaarNumber(form.aadhaarNumber, false) || '',
                    }))
                  }
                  placeholder="Optional 12-digit number"
                  className={`w-full h-9 px-3 border rounded bg-white dark:bg-neutral-950 font-mono ${
                    fieldErrors.aadhaarNumber
                      ? 'border-red-500 focus:outline-none'
                      : 'border-neutral-300 dark:border-neutral-700'
                  }`}
                />
                {fieldErrors.aadhaarNumber && (
                  <p className="mt-1 text-[11px] text-red-600">{fieldErrors.aadhaarNumber}</p>
                )}
                {!fieldErrors.aadhaarNumber && fieldNotices.aadhaarNumber && (
                  <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{fieldNotices.aadhaarNumber}</p>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block font-medium">PAN Number (AAAAA9999A)</label>
                  <span
                    className={`font-mono text-[11px] ${
                      /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(form.panNumber)
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-neutral-500'
                    }`}
                  >
                    {form.panNumber.length}/10
                  </span>
                </div>
                <input
                  type="text"
                  maxLength={10}
                  value={form.panNumber}
                  onChange={(e) => {
                    const res = sanitizePanInput(e.target.value);
                    setForm({ ...form, panNumber: res.value });
                    setFieldNotices((prev) => ({ ...prev, panNumber: res.notice || '' }));
                    setFieldErrors((prev) => ({
                      ...prev,
                      panNumber:
                        res.value.length === 0 || /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(res.value)
                          ? ''
                          : 'PAN must follow AAAAA9999A (5 letters, 4 digits, 1 letter).',
                    }));
                  }}
                  onBlur={() =>
                    setFieldErrors((prev) => ({
                      ...prev,
                      panNumber: validatePanNumber(form.panNumber, false) || '',
                    }))
                  }
                  placeholder="ABCDE1234F"
                  className={`w-full h-9 px-3 border rounded bg-white dark:bg-neutral-950 font-mono uppercase ${
                    fieldErrors.panNumber
                      ? 'border-red-500 focus:outline-none'
                      : 'border-neutral-300 dark:border-neutral-700'
                  }`}
                />
                {fieldErrors.panNumber && (
                  <p className="mt-1 text-[11px] text-red-600">{fieldErrors.panNumber}</p>
                )}
                {!fieldErrors.panNumber && fieldNotices.panNumber && (
                  <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{fieldNotices.panNumber}</p>
                )}
              </div>

              <div>
                <label className="block font-medium mb-1">Village / Locality *</label>
                <input
                  required
                  value={form.village}
                  onChange={(e) => {
                    const nextVal = e.target.value;
                    setForm({ ...form, village: nextVal });
                    setFieldErrors((prev) => ({
                      ...prev,
                      village: nextVal.trim() ? validateVillage(nextVal) || '' : '',
                    }));
                  }}
                  onBlur={() =>
                    setFieldErrors((prev) => ({
                      ...prev,
                      village: validateVillage(form.village) || '',
                    }))
                  }
                  className={`w-full h-9 px-3 border rounded bg-white dark:bg-neutral-950 ${
                    fieldErrors.village
                      ? 'border-red-500 focus:outline-none'
                      : 'border-neutral-300 dark:border-neutral-700'
                  }`}
                />
                {fieldErrors.village && (
                  <p className="mt-1 text-[11px] text-red-600">{fieldErrors.village}</p>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block font-medium">District &amp; PIN Code</label>
                  <span
                    className={`font-mono text-[11px] ${
                      form.pinCode.length === 6
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-neutral-500'
                    }`}
                  >
                    PIN {form.pinCode.length}/6
                  </span>
                </div>
                <div className="flex gap-2">
                  <input
                    value={form.district}
                    onChange={(e) => setForm({ ...form, district: e.target.value })}
                    className="flex-1 h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
                  />
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={form.pinCode}
                    onChange={(e) => {
                      const res = sanitizePinCodeInput(e.target.value);
                      setForm({ ...form, pinCode: res.value });
                      setFieldNotices((prev) => ({ ...prev, pinCode: res.notice || '' }));
                      setFieldErrors((prev) => ({
                        ...prev,
                        pinCode:
                          res.value.length === 0 || res.value.length === 6
                            ? ''
                            : `PIN Code must be exactly 6 digits (${res.value.length}/6).`,
                      }));
                    }}
                    onBlur={() =>
                      setFieldErrors((prev) => ({
                        ...prev,
                        pinCode: validatePinCode(form.pinCode, false) || '',
                      }))
                    }
                    placeholder="6-digit PIN"
                    className={`w-28 h-9 px-3 border rounded bg-white dark:bg-neutral-950 font-mono ${
                      fieldErrors.pinCode
                        ? 'border-red-500 focus:outline-none'
                        : 'border-neutral-300 dark:border-neutral-700'
                    }`}
                  />
                </div>
                {fieldErrors.pinCode && (
                  <p className="mt-1 text-[11px] text-red-600">{fieldErrors.pinCode}</p>
                )}
                {!fieldErrors.pinCode && fieldNotices.pinCode && (
                  <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{fieldNotices.pinCode}</p>
                )}
              </div>

              <div>
                <label className="block font-medium mb-1">Customer Segment</label>
                <select
                  value={form.segment}
                  onChange={(e) => setForm({ ...form, segment: e.target.value as CustomerSegment })}
                  className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
                >
                  <option value="Regular">Regular</option>
                  <option value="VIP">VIP</option>
                  <option value="Individual">Individual</option>
                  <option value="Corporate">Corporate</option>
                  <option value="Government">Government</option>
                  <option value="General">General</option>
                </select>
              </div>
            </div>

            <div className="border-t border-neutral-200 dark:border-neutral-800 pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <div className="text-xs font-semibold">7-Category Customer Consents</div>
                <span className="text-[11px] text-emerald-700 dark:text-emerald-400">
                  All 7 consents auto-checked (No OTP needed · uncheck if customer opts out)
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                {CONSENT_LABELS.map((c) => (
                  <label key={c.key} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(newConsents[c.key])}
                      onChange={(e) =>
                        setNewConsents((prev) => ({ ...prev, [c.key]: e.target.checked }))
                      }
                    />
                    <span>{c.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={savingCustomer}
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={savingCustomer}
                disabled={savingCustomer || (Boolean(createError || Object.values(fieldErrors).some(Boolean)) && hasFormValidationErrors)}
              >
                Register Customer
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* Customer 360 Profile Drawer/Modal */}
      <Modal
        isOpen={Boolean(profileData) || profileLoading}
        onClose={() => setProfileData(null)}
        title={profileData ? `${profileData.customer.fullName} · ${profileData.customer.customerId}` : 'Loading Customer...'}
        description="Complete 12-section Customer CRM Profile, OTP Verification, Consent Proof, Applications & ID Card"
        maxWidthClass="max-w-5xl"
      >
        {profileData && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 dark:border-neutral-800 pb-3">
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ['overview', 'Personal & Addresses'],
                    ['consents', '7 Consents & OTP'],
                    ['apps', `Applications (${profileData.applications.length})`],
                    ['notes', 'Notes & Follow-ups'],
                    ['idcard', 'ID Card Print'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setProfileTab(id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded border cursor-pointer ${
                      profileTab === id
                        ? 'bg-neutral-950 text-white border-neutral-950 dark:bg-white dark:text-neutral-950'
                        : 'border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                {(currentUser.role === 'ADMIN' || currentUser.role === 'MANAGER') && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openEditProfile(profileData.customer)}
                    icon={<Pencil className="h-3.5 w-3.5" />}
                  >
                    Edit Profile
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    const id = profileData.customer.customerId;
                    setProfileData(null);
                    onStartApplicationForCustomer(id);
                  }}
                  icon={<FilePlus2 className="h-3.5 w-3.5" />}
                >
                  New Application (Pre-filled)
                </Button>
                {currentUser.role === 'ADMIN' && !(profileData.customer.deletedAt || profileData.customer.isArchived) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      try {
                        await erpApi.softDeleteCustomer(profileData.customer.customerId, 'Archived via CRM').catch((apiErr) => {
                          const msg = extractFriendlyErrorMessage(apiErr).toLowerCase();
                          if (!msg.includes('not found') && !msg.includes('404')) throw apiErr;
                        });
                        const archivedAt = new Date().toISOString();
                        const archivedRecord: ErpCustomerItem = {
                          ...profileData.customer,
                          deletedAt: archivedAt,
                          isArchived: true,
                          updatedAt: archivedAt,
                        };
                        await saveCustomerToFirestore(archivedRecord);
                        const cachedArchived = upsertCachedCustomer(archivedRecord);
                        setCachedCustomers(loadCachedCustomers());
                        setOptimisticCustomers((prev) => [
                          cachedArchived,
                          ...prev.filter((c) => c.customerId !== cachedArchived.customerId),
                        ]);
                        setApiCustomers((prev) =>
                          prev.map((c) =>
                            c.customerId === cachedArchived.customerId ? cachedArchived : c
                          )
                        );
                        setProfileData(null);
                        window.dispatchEvent(new CustomEvent('mun:customers-changed'));
                        loadCustomers();
                        onShowToast('info', 'Customer Archived');
                      } catch (err) {
                        onShowToast('error', 'Archive Failed', extractFriendlyErrorMessage(err));
                      }
                    }}
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                  >
                    Archive
                  </Button>
                )}
                {currentUser.role === 'ADMIN' && (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => setPermanentDeleteTarget(profileData.customer)}
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                  >
                    Delete Permanently
                  </Button>
                )}
              </div>
            </div>

            {profileTab === 'overview' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-2">
                  <div className="flex items-start gap-3 pb-2 border-b border-neutral-100 dark:border-neutral-800">
                    {isSafeRemotePhotoUrl(
                      profileData.customer.photoDownloadURL || profileData.customer.photoUrl
                    ) ? (
                      <img
                        src={profileData.customer.photoDownloadURL || profileData.customer.photoUrl}
                        alt={profileData.customer.fullName}
                        className="w-16 h-20 rounded-md object-cover border border-neutral-300 dark:border-neutral-700 shrink-0"
                      />
                    ) : (
                      <div className="w-16 h-20 rounded-md border border-neutral-200 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center text-neutral-400 shrink-0">
                        <User className="h-6 w-6" />
                      </div>
                    )}
                    <div className="space-y-1">
                      <div className="font-semibold text-sm">Identity &amp; Contact</div>
                      <div className="font-mono text-[11px] text-neutral-500">
                        ID: {profileData.customer.customerId} · Ref:{' '}
                        {profileData.customer.referenceNo ||
                          `MCR-${profileData.customer.customerId.replace(/^MCC-/, '')}`}
                      </div>
                      {profileData.customer.panNumber && (
                        <div>
                          PAN: <span className="font-mono font-medium">{profileData.customer.panNumber}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div>Father / Husband: <span className="font-medium">{profileData.customer.fatherOrHusbandName || '-'}</span></div>
                  <div>DOB / Gender: <span className="font-medium">{profileData.customer.dob || '-'} · {profileData.customer.gender}</span></div>
                  <div>Mobile: <span className="font-mono font-medium">{profileData.customer.mobile}</span> ({profileData.customer.verificationStatus})</div>
                  <div>WhatsApp: <span className="font-mono font-medium">{profileData.customer.whatsapp}</span></div>
                  <div>Email: <span className="font-medium">{profileData.customer.email || '-'}</span></div>
                  <div className="flex items-center justify-between pt-1">
                    <span>
                      Aadhaar: <span className="font-mono font-semibold">{decryptedAadhaar || profileData.customer.aadhaarMasked || 'Not Stored'}</span>
                    </span>
                    {currentUser.role === 'ADMIN' && profileData.customer.aadhaarMasked && !decryptedAadhaar && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          try {
                            const res = await erpApi.decryptCustomerAadhaar(profileData.customer.customerId);
                            setDecryptedAadhaar(res.data.aadhaarFormatted);
                          } catch (err) {
                            onShowToast('error', 'Decrypt Failed', extractFriendlyErrorMessage(err));
                          }
                        }}
                      >
                        Decrypt (Audit Logged)
                      </Button>
                    )}
                  </div>
                </div>

                <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-2">
                  <div className="font-semibold text-sm">Addresses &amp; Summary</div>
                  <div>Present Address: <span className="font-medium">{profileData.customer.presentAddress}</span></div>
                  <div>Permanent Address: <span className="font-medium">{profileData.customer.permanentAddress}</span></div>
                  <div>Village / PS / District: <span className="font-medium">{profileData.customer.village}, {profileData.customer.policeStation}, {profileData.customer.district} - {profileData.customer.pinCode}</span></div>
                  <div className="pt-2 border-t border-neutral-100 dark:border-neutral-800">
                    Payments Settled: <span className="font-mono font-bold">{formatCurrency(profileData.payments.filter((p) => p.verificationStatus === 'Confirmed').reduce((s, p) => s + p.amount, 0))}</span>
                  </div>
                </div>
              </div>
            )}

            {profileTab === 'consents' && (
              <div className="space-y-4 text-xs">
                <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="font-semibold text-sm flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-emerald-600" />
                      OTP Mobile / WhatsApp Verification
                    </div>
                    <Button size="sm" variant="outline" onClick={handleSendCustomerOtp}>
                      Send Verification OTP
                    </Button>
                  </div>
                  {otpChallenge && (
                    <div className="p-3 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded flex flex-wrap items-end gap-2">
                      <div>
                        <label className="block mb-1">Target Mobile</label>
                        <MobileNumberInput
                          value={otpChallenge.newMobile}
                          onChange={(val) => setOtpChallenge((prev) => (prev ? { ...prev, newMobile: val } : prev))}
                          heightClassName="h-8"
                          aria-label="Target OTP mobile number"
                        />
                      </div>
                      <div>
                        <label className="block mb-1">OTP Code {otpChallenge.sandboxOtpPreview ? `(Sandbox: ${otpChallenge.sandboxOtpPreview})` : ''}</label>
                        <input
                          value={otpChallenge.otpInput}
                          onChange={(e) => setOtpChallenge({ ...otpChallenge, otpInput: e.target.value })}
                          className="h-8 px-2 border rounded font-mono w-32"
                        />
                      </div>
                      <Button size="sm" variant="primary" onClick={handleVerifyCustomerOtp} icon={<UserCheck className="h-3.5 w-3.5" />}>
                        Confirm OTP
                      </Button>
                    </div>
                  )}
                </div>

                <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-2">
                  <div className="font-semibold text-sm mb-2">7 Separate Consent Categories (Privacy &amp; Notification Gate)</div>
                  <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                    {profileData.customer.consents.map((c) => (
                      <div key={c.category} className="py-2 flex items-center justify-between gap-4">
                        <div>
                          <div className="font-medium">{c.label}</div>
                          <div className="text-[11px] text-neutral-500">
                            Method: {c.verificationMethod} · {c.recordedAt ? formatDateIST(c.recordedAt.slice(0, 10)) : 'Pending'}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant={c.granted ? 'primary' : 'outline'}
                          onClick={() => handleToggleConsent(c.category, !c.granted)}
                        >
                          {c.granted ? 'Granted (Click to Revoke)' : 'Not Granted (Grant)'}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {profileTab === 'apps' && (
              <div className="space-y-2 text-xs">
                {profileData.applications.length === 0 ? (
                  <p className="text-neutral-500">No applications linked to this customer yet.</p>
                ) : (
                  profileData.applications.map((a) => (
                    <div key={a.applicationNo} className="border border-neutral-200 dark:border-neutral-800 rounded p-3 flex items-center justify-between">
                      <div>
                        <div className="font-mono font-semibold">{a.applicationNo} · {a.serviceSnapshot.name}</div>
                        <div className="text-neutral-500">Status: {a.status} · Due: {formatDateIST(a.expectedCompletionDate)}</div>
                      </div>
                      <div className="font-mono text-right">
                        <div>{formatCurrency(a.financialSummary.netCollected)} paid</div>
                        <div className="text-neutral-500">Fee {formatCurrency(a.financialSummary.serviceCharge)}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {profileTab === 'notes' && (
              <div className="space-y-3 text-xs">
                <form onSubmit={handleAddNote} className="flex flex-wrap gap-2">
                  <select
                    value={noteType}
                    onChange={(e) => setNoteType(e.target.value as 'INTERNAL_NOTE' | 'FOLLOW_UP')}
                    className="h-9 px-2 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
                  >
                    <option value="INTERNAL_NOTE">Internal Note</option>
                    <option value="FOLLOW_UP">CRM Follow-up</option>
                  </select>
                  {noteType === 'FOLLOW_UP' && (
                    <input
                      type="date"
                      value={followUpDate}
                      onChange={(e) => setFollowUpDate(e.target.value)}
                      className="h-9 px-2 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
                    />
                  )}
                  <input
                    value={noteInput}
                    onChange={(e) => setNoteInput(e.target.value)}
                    placeholder="Add CRM interaction note..."
                    className="flex-1 h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
                  />
                  <Button type="submit" size="sm" variant="primary">Save</Button>
                </form>
                <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {profileData.customer.notesAndFollowUps.map((n) => (
                    <div key={n.id} className="py-2">
                      <span className="font-mono font-semibold mr-2">[{n.type}]</span>
                      <span>{n.text}</span>
                      <span className="ml-2 text-neutral-400">by {n.authorUserId}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {profileTab === 'idcard' && (
              <div className="space-y-3">
                <div className="max-w-md mx-auto border-2 border-neutral-950 dark:border-white rounded-lg p-5 bg-white text-neutral-950 space-y-3">
                  <div className="flex items-center justify-between border-b border-neutral-300 pb-2">
                    <div>
                      <div className="font-bold text-sm tracking-tight">MUN COMPUTER</div>
                      <div className="text-[10px] text-neutral-600">CUSTOMER MEMBERSHIP &amp; SERVICE CARD</div>
                    </div>
                    <span className="font-mono text-xs font-bold">{profileData.customer.customerId}</span>
                  </div>
                  <div className="flex items-start gap-3">
                    {isSafeRemotePhotoUrl(
                      profileData.customer.photoDownloadURL || profileData.customer.photoUrl
                    ) ? (
                      <img
                        src={profileData.customer.photoDownloadURL || profileData.customer.photoUrl}
                        alt={profileData.customer.fullName}
                        className="w-16 h-20 rounded border border-neutral-400 object-cover shrink-0"
                      />
                    ) : (
                      <div className="w-16 h-20 rounded border border-neutral-300 bg-neutral-100 flex items-center justify-center text-neutral-400 shrink-0">
                        <User className="h-6 w-6" />
                      </div>
                    )}
                    <div className="text-xs space-y-1">
                      <div className="font-bold text-sm">{profileData.customer.fullName}</div>
                      <div>Mobile: <span className="font-mono">{profileData.customer.mobile}</span></div>
                      <div>Address: {profileData.customer.village}, {profileData.customer.district}</div>
                      <div>Status: {profileData.customer.verificationStatus}</div>
                    </div>
                  </div>
                  <div className="pt-2 border-t border-neutral-200 flex items-center justify-between text-[10px] font-mono text-neutral-600">
                    <span>AUTH-QR: {profileData.customer.customerId}</span>
                    <span>ISSUED BY MUN COMPUTER</span>
                  </div>
                </div>
                <div className="flex justify-center no-print">
                  <Button size="sm" variant="primary" onClick={() => window.print()} icon={<Printer className="h-3.5 w-3.5" />}>
                    Print Customer ID Card
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Bulk CSV Import Modal */}
      <Modal
        isOpen={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title="Bulk Customer CSV Import"
        description="Validate rows before committing sequential MCC Customer IDs."
        maxWidthClass="max-w-2xl"
      >
        <div className="space-y-3 text-xs">
          <textarea
            rows={6}
            value={csvInput}
            onChange={(e) => setCsvInput(e.target.value)}
            className="w-full p-3 font-mono border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
          />
          {bulkPreview && (
            <div className="border border-neutral-200 dark:border-neutral-800 rounded p-3 max-h-48 overflow-y-auto space-y-1">
              {bulkPreview.map((r) => (
                <div key={r.rowNumber} className="flex justify-between">
                  <span>Row {r.rowNumber}: {r.fullName} ({r.mobile})</span>
                  <span className={r.valid ? 'text-emerald-600 font-semibold' : 'text-red-600'}>
                    {r.valid ? 'Valid' : r.errors.join(', ')}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => handleBulkPreviewOrCommit(false)}>
              Validate Preview
            </Button>
            <Button size="sm" variant="primary" onClick={() => handleBulkPreviewOrCommit(true)}>
              Commit Valid Customers
            </Button>
          </div>
        </div>
      </Modal>

      {/* Admin Customer Merge Modal */}
      <Modal
        isOpen={mergeOpen}
        onClose={() => {
          setMergeError(null);
          setMergeOpen(false);
        }}
        title="Merge Duplicate Customers (Admin Only)"
        description="Transfers all linked applications, documents, payments, deliveries, and refunds to the primary Customer ID."
      >
        <form onSubmit={handleMerge} className="space-y-3 text-xs" noValidate>
          {mergeError && (
            <div role="alert" className="px-3 py-2 rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300">
              {mergeError}
            </div>
          )}
          <div>
            <label className="block font-medium mb-1">Primary Customer ID (Retained)</label>
            <input
              required
              value={mergePrimary}
              onChange={(e) => setMergePrimary(e.target.value)}
              placeholder="MCC-2026-27-000001"
              className="w-full h-9 px-3 border rounded font-mono bg-white dark:bg-neutral-950"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">Duplicate Customer ID (Merged &amp; Archived)</label>
            <input
              required
              value={mergeDuplicate}
              onChange={(e) => setMergeDuplicate(e.target.value)}
              placeholder="MCC-2026-27-000004"
              className="w-full h-9 px-3 border rounded font-mono bg-white dark:bg-neutral-950"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">Merge Audit Reason</label>
            <input
              required
              value={mergeReason}
              onChange={(e) => setMergeReason(e.target.value)}
              placeholder="Same citizen registered twice under alternate mobile"
              className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-950"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setMergeError(null);
                setMergeOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="primary" loading={merging}>
              Execute Merge
            </Button>
          </div>
        </form>
      </Modal>
      {/* Edit Customer Profile Modal */}
      <Modal
        isOpen={editOpen}
        onClose={() => setEditOpen(false)}
        title={`Edit Customer · ${editForm.customerId}`}
        description="Updates profile fields and synchronizes with backend and Cloud Firestore."
        maxWidthClass="max-w-2xl"
      >
        <form onSubmit={handleSaveEdit} className="space-y-3 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-medium mb-1">Full Name *</label>
              <input
                required
                value={editForm.fullName}
                onChange={(e) => setEditForm((prev) => ({ ...prev, fullName: e.target.value }))}
                className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Father / Husband Name</label>
              <input
                value={editForm.fatherOrHusbandName}
                onChange={(e) => setEditForm((prev) => ({ ...prev, fatherOrHusbandName: e.target.value }))}
                className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Email</label>
              <input
                type="email"
                value={editForm.email}
                onChange={(e) => setEditForm((prev) => ({ ...prev, email: e.target.value }))}
                className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Village / Locality</label>
              <input
                value={editForm.village}
                onChange={(e) => setEditForm((prev) => ({ ...prev, village: e.target.value }))}
                className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">District</label>
              <input
                value={editForm.district}
                onChange={(e) => setEditForm((prev) => ({ ...prev, district: e.target.value }))}
                className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block font-medium">PIN Code</label>
                <span className="font-mono text-[11px] text-neutral-500">{editForm.pinCode.length}/6</span>
              </div>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={editForm.pinCode}
                onChange={(e) => {
                  const res = sanitizePinCodeInput(e.target.value);
                  setEditForm((prev) => ({ ...prev, pinCode: res.value }));
                  setEditPinNotice(res.notice || null);
                  setEditPinError(
                    res.value.length === 0 || res.value.length === 6
                      ? null
                      : `PIN Code must be exactly 6 digits (${res.value.length}/6).`
                  );
                }}
                className={`w-full h-9 px-3 border rounded bg-white dark:bg-neutral-950 font-mono ${
                  editPinError
                    ? 'border-red-500 focus:outline-none'
                    : 'border-neutral-300 dark:border-neutral-700'
                }`}
              />
              {editPinError && <p className="mt-1 text-[11px] text-red-600">{editPinError}</p>}
              {!editPinError && editPinNotice && (
                <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{editPinNotice}</p>
              )}
            </div>
            <div>
              <label className="block font-medium mb-1">Segment</label>
              <select
                value={editForm.segment}
                onChange={(e) =>
                  setEditForm((prev) => ({
                    ...prev,
                    segment: e.target.value as CustomerSegment,
                  }))
                }
                className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              >
                <option value="Regular">Regular</option>
                <option value="VIP">VIP</option>
                <option value="Individual">Individual</option>
                <option value="Corporate">Corporate</option>
                <option value="Government">Government</option>
                <option value="General">General</option>
              </select>
            </div>
            <div>
              <label className="block font-medium mb-1">Status</label>
              <select
                value={editForm.status}
                onChange={(e) =>
                  setEditForm((prev) => ({
                    ...prev,
                    status: e.target.value as 'Active' | 'Inactive' | 'Blocked',
                  }))
                }
                className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              >
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
                <option value="Blocked">Blocked</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block font-medium mb-1">Present Address</label>
            <input
              value={editForm.presentAddress}
              onChange={(e) => setEditForm((prev) => ({ ...prev, presentAddress: e.target.value }))}
              className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="primary" loading={savingEdit}>
              Save Changes
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={Boolean(permanentDeleteTarget)}
        onClose={() => !deletingPermanent && setPermanentDeleteTarget(null)}
        title="Permanently Delete Customer?"
        description="This permanently removes the customer record from both backend storage and Firestore so it will never return."
        maxWidthClass="max-w-md"
      >
        {permanentDeleteTarget && (
          <div className="space-y-4 text-xs">
            <div className="p-3 rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200">
              <div className="font-semibold">{permanentDeleteTarget.fullName}</div>
              <div className="font-mono mt-0.5">
                {permanentDeleteTarget.customerId} · {permanentDeleteTarget.mobile}
              </div>
            </div>
            <p className="text-neutral-600 dark:text-neutral-400">
              Customers with active applications or confirmed financial payments are protected and must have those records archived/deleted first.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={deletingPermanent}
                onClick={() => setPermanentDeleteTarget(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                variant="danger"
                loading={deletingPermanent}
                onClick={handlePermanentDeleteCustomer}
                icon={<Trash2 className="h-3.5 w-3.5" />}
              >
                Permanently Delete
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};
