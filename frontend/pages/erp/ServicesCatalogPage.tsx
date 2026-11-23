import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Database,
  Edit3,
  FileText,
  Filter,
  FolderTree,
  History,
  Layers,
  Plus,
  Power,
  Search,
  Settings2,
  Trash2,
  Zap,
} from 'lucide-react';
import {
  DynamicFieldType,
  DynamicFormFieldDef,
  ErpApplicationStatus,
  ErpServiceItem,
  ServiceAutomationRule,
  ServiceCategoryItem,
  ServiceRequiredDocumentDef,
  ServiceSlaConfig,
  ServiceSubcategoryItem,
  UserProfile,
} from '../../modules/types';
import { erpApi, ErpTombstonesPayload } from '../../services/erpApi';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { MobileNumberInput } from '../../components/MobileNumberInput';
import { formatCurrency } from '../../services/apiClient';
import {
  extractFriendlyErrorMessage,
  isFirebaseConfigured,
} from '../../services/firebase';
import { saveNewCustomerToFirestore } from '../../services/customerFirestore';
import { saveApplicationToFirestore } from '../../services/erpFirestore';
import {
  getMaxCachedCustomerSequence,
  upsertCachedCustomer,
} from '../../services/customerLocalCache';
import { useCloudSync } from '../../services/cloudSync';
import {
  CatalogSeedMeta,
  computeContinuousServiceSerials,
  deleteServiceCategoryFromFirestore,
  deleteServiceFromFirestore,
  deleteServiceSubcategoryFromFirestore,
  resequenceServicesDisplayOrderInFirestore,
  saveServiceCategoryToFirestore,
  saveServiceSubcategoryToFirestore,
  saveServiceToFirestore,
  syncMissingCatalogToFirestore,
  writeServiceAuditLogToFirestore,
} from '../../services/servicesFirestore';
import { subscribeServicesModuleRealtime } from '../../services/servicesRealtime';

interface ServicesCatalogPageProps {
  currentUser: UserProfile;
  onStartApplicationForService: (serviceId: string) => void;
  onShowToast: (type: 'success' | 'error' | 'info', title: string, description?: string) => void;
}

const ALL_FIELD_TYPES: Array<{ value: DynamicFieldType; label: string }> = [
  { value: 'short_text', label: 'Short Text' },
  { value: 'long_text', label: 'Long Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'mobile', label: 'Mobile Number' },
  { value: 'email', label: 'Email' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'radio', label: 'Radio Selection' },
  { value: 'yes_no', label: 'Yes / No' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'multi_select', label: 'Multi-Select' },
  { value: 'file_upload', label: 'File / Document Upload' },
  { value: 'aadhaar', label: 'Aadhaar Number (Masked)' },
  { value: 'pan', label: 'PAN Card Number' },
  { value: 'address', label: 'Postal Address' },
];

const DOC_FORMATS: Array<'PDF' | 'JPG' | 'JPEG' | 'PNG'> = ['PDF', 'JPG', 'JPEG', 'PNG'];

const PAUSE_STATUS_OPTIONS: ErpApplicationStatus[] = [
  'Pending Customer',
  'Pending Office',
  'On Hold',
];

const AUTOMATION_TRIGGERS: Array<{ value: ServiceAutomationRule['trigger']; label: string }> = [
  { value: 'APPLICATION_CREATED', label: 'Application Created' },
  { value: 'APPLICATION_SUBMITTED', label: 'Application Submitted' },
  { value: 'STATUS_CHANGED', label: 'Status Changed' },
  { value: 'DOCUMENT_UPLOADED', label: 'Document Uploaded' },
  { value: 'DOCUMENT_VERIFIED', label: 'Document Verified' },
  { value: 'DOCUMENT_REJECTED', label: 'Document Rejected' },
  { value: 'PAYMENT_RECEIVED', label: 'Payment Received' },
  { value: 'PAYMENT_PENDING', label: 'Payment Pending' },
  { value: 'FOLLOWUP_DUE', label: 'Follow-up Due' },
  { value: 'SLA_WARNING', label: 'SLA Warning' },
  { value: 'SLA_BREACH', label: 'SLA Breach' },
  { value: 'APPLICATION_COMPLETED', label: 'Application Completed' },
  { value: 'DELIVERY_READY', label: 'Delivery Ready' },
  { value: 'REFUND_PROCESSED', label: 'Refund Processed' },
];

const AUTOMATION_ACTIONS: Array<{ value: ServiceAutomationRule['actionType']; label: string }> = [
  { value: 'GENERATE_REF_NO', label: 'Generate Reference No' },
  { value: 'GENERATE_NOTIFICATION', label: 'Generate Notification' },
  { value: 'CREATE_FOLLOWUP', label: 'Create Follow-up' },
  { value: 'CREATE_REMINDER', label: 'Create Reminder' },
  { value: 'ASSIGN_COUNTER', label: 'Assign Counter' },
  { value: 'ASSIGN_STAFF', label: 'Assign Staff' },
  { value: 'ESCALATE_INTERNAL', label: 'Escalate Internal' },
];

const DEFAULT_CREATE_FIELDS: DynamicFormFieldDef[] = [
  {
    fieldKey: 'applicant_name',
    label: 'Applicant Full Name',
    fieldType: 'short_text',
    required: true,
    displayOrder: 1,
    enabled: true,
  },
  {
    fieldKey: 'applicant_mobile',
    label: 'Mobile Number',
    fieldType: 'mobile',
    required: true,
    displayOrder: 2,
    enabled: true,
  },
  {
    fieldKey: 'applicant_notes',
    label: 'Applicant Details / Request Notes',
    fieldType: 'long_text',
    required: false,
    displayOrder: 3,
    enabled: true,
  },
];

const DEFAULT_CREATE_SLA: ServiceSlaConfig = {
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
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const slugifyKey = (val: string, fallback: string): string => {
  const cleaned = val
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
};

export const ServicesCatalogPage: React.FC<ServicesCatalogPageProps> = ({
  currentUser,
  onStartApplicationForService,
  onShowToast,
}) => {
  // Backend RBAC: ADMIN owns master service/category/subcategory configuration; MANAGER can view & sync baseline
  const canManageServices =
    currentUser.role === 'ADMIN' || Boolean(currentUser.isMasterAdmin);
  const canSyncCatalog = canManageServices || currentUser.role === 'MANAGER';

  // Cloud / Firebase Auth & Realtime Mirror state
  const cloudSync = useCloudSync();
  const firebaseUser = cloudSync.user;

  const [apiServices, setApiServices] = useState<ErpServiceItem[]>([]);
  const [apiCategories, setApiCategories] = useState<ServiceCategoryItem[]>([]);
  const [apiSubcategories, setApiSubcategories] = useState<ServiceSubcategoryItem[]>([]);

  const [fsServices, setFsServices] = useState<ErpServiceItem[]>([]);
  const [fsCategories, setFsCategories] = useState<ServiceCategoryItem[]>([]);
  const [fsSubcategories, setFsSubcategories] = useState<ServiceSubcategoryItem[]>([]);
  const [fsCatalogMeta, setFsCatalogMeta] = useState<CatalogSeedMeta | null>(null);
  const [fsLoaded, setFsLoaded] = useState(false);

  const [backendTombstones, setBackendTombstones] = useState<ErpTombstonesPayload | null>(null);
  const [localDeletedServiceIds, setLocalDeletedServiceIds] = useState<string[]>([]);
  const [localDeletedServiceCodes, setLocalDeletedServiceCodes] = useState<string[]>([]);
  const [localDeletedCategoryCodes, setLocalDeletedCategoryCodes] = useState<string[]>([]);
  const [localDeletedSubcategoryCodes, setLocalDeletedSubcategoryCodes] = useState<string[]>([]);

  const [loading, setLoading] = useState(true);
  const [syncingCatalog, setSyncingCatalog] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const autoSyncAttemptedRef = useRef(false);

  const tombstones = useMemo(() => {
    const deletedCategoryCodes = new Set<string>([
      ...(backendTombstones?.deletedCategoryCodes ?? []),
      ...(fsCatalogMeta?.deletedCategoryCodes ?? []),
      ...localDeletedCategoryCodes,
    ]);
    const deletedSubcategoryCodes = new Set<string>([
      ...(backendTombstones?.deletedSubcategoryCodes ?? []),
      ...(fsCatalogMeta?.deletedSubcategoryCodes ?? []),
      ...localDeletedSubcategoryCodes,
    ]);
    const deletedServiceIds = new Set<string>([
      ...(backendTombstones?.deletedServiceIds ?? []),
      ...(fsCatalogMeta?.deletedServiceIds ?? []),
      ...localDeletedServiceIds,
    ]);
    const deletedServiceCodes = new Set<string>([
      ...(backendTombstones?.deletedServiceCodes ?? []),
      ...(fsCatalogMeta?.deletedServiceCodes ?? []),
      ...localDeletedServiceCodes,
    ]);
    return {
      deletedCategoryCodes,
      deletedSubcategoryCodes,
      deletedServiceIds,
      deletedServiceCodes,
      hasAny:
        deletedCategoryCodes.size > 0 ||
        deletedSubcategoryCodes.size > 0 ||
        deletedServiceIds.size > 0 ||
        deletedServiceCodes.size > 0,
    };
  }, [
    backendTombstones,
    fsCatalogMeta,
    localDeletedCategoryCodes,
    localDeletedSubcategoryCodes,
    localDeletedServiceIds,
    localDeletedServiceCodes,
  ]);

  const firestoreAuthoritative = Boolean(
    firebaseUser &&
      isFirebaseConfigured() &&
      (fsCatalogMeta?.seeded || (fsLoaded && (fsServices.length > 0 || fsCategories.length > 0)))
  );

  // Merge API & Firestore strictly by newest timestamp while honoring all tombstones
  // (Never let older Firestore docs hide or revert newer backend API edits/creations/deletions on refresh)
  const categories = useMemo(() => {
    const filterCat = (c: ServiceCategoryItem) => !tombstones.deletedCategoryCodes.has(c.code);
    const map = new Map<string, ServiceCategoryItem>();
    for (const c of apiCategories) {
      if (filterCat(c)) map.set(c.code, c);
    }
    if (firebaseUser && (firestoreAuthoritative || fsCategories.length > 0)) {
      for (const fc of fsCategories) {
        if (!filterCat(fc)) continue;
        const existing = map.get(fc.code);
        if (!existing) {
          map.set(fc.code, fc);
          continue;
        }
        const fsTs = Date.parse((fc as ServiceCategoryItem & { updatedAt?: string }).updatedAt || '') || 0;
        const apiTs = Date.parse((existing as ServiceCategoryItem & { updatedAt?: string }).updatedAt || '') || 0;
        if (fsTs > apiTs) {
          map.set(fc.code, fc);
        }
      }
    }
    return Array.from(map.values()).sort(
      (a, b) => (a.displayOrder ?? a.id) - (b.displayOrder ?? b.id) || a.id - b.id
    );
  }, [apiCategories, fsCategories, firebaseUser, firestoreAuthoritative, tombstones.deletedCategoryCodes]);

  const subcategories = useMemo(() => {
    const activeCatIds = new Set(categories.map((c) => c.id));
    const filterSub = (sc: ServiceSubcategoryItem) =>
      !tombstones.deletedSubcategoryCodes.has(sc.code) &&
      (activeCatIds.size === 0 || activeCatIds.has(sc.categoryId));

    const map = new Map<string, ServiceSubcategoryItem>();
    for (const sc of apiSubcategories) {
      if (filterSub(sc)) map.set(sc.code, sc);
    }
    if (firebaseUser && (firestoreAuthoritative || fsSubcategories.length > 0)) {
      for (const fsc of fsSubcategories) {
        if (!filterSub(fsc)) continue;
        const existing = map.get(fsc.code);
        if (!existing) {
          map.set(fsc.code, fsc);
          continue;
        }
        const fsTs = Date.parse((fsc as ServiceSubcategoryItem & { updatedAt?: string }).updatedAt || '') || 0;
        const apiTs = Date.parse((existing as ServiceSubcategoryItem & { updatedAt?: string }).updatedAt || '') || 0;
        if (fsTs > apiTs) {
          map.set(fsc.code, fsc);
        }
      }
    }
    return Array.from(map.values()).sort(
      (a, b) => a.categoryId - b.categoryId || a.displayOrder - b.displayOrder || a.id - b.id
    );
  }, [
    apiSubcategories,
    fsSubcategories,
    categories,
    firebaseUser,
    firestoreAuthoritative,
    tombstones.deletedSubcategoryCodes,
  ]);

  const services = useMemo(() => {
    const filterSvc = (s: ErpServiceItem) =>
      !s.deletedAt &&
      !tombstones.deletedServiceIds.has(s.serviceId) &&
      !tombstones.deletedServiceCodes.has(s.serviceCode);

    const map = new Map<string, ErpServiceItem>();
    for (const s of apiServices) {
      if (filterSvc(s)) map.set(s.serviceId, s);
    }
    if (firebaseUser && (firestoreAuthoritative || fsServices.length > 0)) {
      for (const fs of fsServices) {
        if (!filterSvc(fs)) continue;
        const existing = map.get(fs.serviceId);
        if (!existing) {
          map.set(fs.serviceId, fs);
          continue;
        }
        const fsTs = Date.parse(fs.updatedAt || fs.createdAt || '') || 0;
        const apiTs = Date.parse(existing.updatedAt || existing.createdAt || '') || 0;
        if (fsTs > apiTs) {
          map.set(fs.serviceId, fs);
        }
      }
    }
    return computeContinuousServiceSerials(Array.from(map.values()));
  }, [
    apiServices,
    fsServices,
    firebaseUser,
    firestoreAuthoritative,
    tombstones.deletedServiceIds,
    tombstones.deletedServiceCodes,
  ]);

  // Filtering & Pagination state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<string>('ALL');
  const [selectedSubcategoryFilter, setSelectedSubcategoryFilter] = useState<string>('ALL');
  const [rateFilter, setRateFilter] = useState<'ALL' | 'CONFIGURED' | 'BLANK'>('ALL');
  const [statusFilter, setStatusFilter] = useState<
    'ALL' | 'Active' | 'Inactive' | 'Temporarily Suspended' | 'Archived'
  >('ALL');
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 15;

  // Selected Service for Configuration & Builder
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const selectedService = useMemo(
    () => services.find((s) => s.serviceId === selectedServiceId) ?? services[0] ?? null,
    [services, selectedServiceId]
  );

  const [activeSubTab, setActiveSubTab] = useState<
    'form' | 'docs' | 'sla' | 'automation' | 'pricing'
  >('form');

  // Modals & Form Submit States
  const [newServiceOpen, setNewServiceOpen] = useState(false);
  const [createTab, setCreateTab] = useState<
    'details' | 'pricing' | 'form' | 'docs' | 'sla' | 'automation'
  >('details');
  const [newCatOpen, setNewCatOpen] = useState(false);
  const [editingCat, setEditingCat] = useState<ServiceCategoryItem | null>(null);
  const [newSubOpen, setNewSubOpen] = useState(false);
  const [editingSub, setEditingSub] = useState<ServiceSubcategoryItem | null>(null);

  const [applyModalOpen, setApplyModalOpen] = useState(false);
  const [applyingService, setApplyingService] = useState<ErpServiceItem | null>(null);

  const [savingCat, setSavingCat] = useState(false);
  const [savingSub, setSavingSub] = useState(false);
  const [savingSrv, setSavingSrv] = useState(false);
  const [savingPricing, setSavingPricing] = useState(false);
  const [savingSla, setSavingSla] = useState(false);
  const [savingDocs, setSavingDocs] = useState(false);
  const [savingAutomation, setSavingAutomation] = useState(false);
  const [publishingForm, setPublishingForm] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState(false);

  const [catError, setCatError] = useState<string | null>(null);
  const [subError, setSubError] = useState<string | null>(null);
  const [srvError, setSrvError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Apply Service form state
  const [applyCustName, setApplyCustName] = useState('');
  const [applyCustMobile, setApplyCustMobile] = useState('');
  const [applyVillage, setApplyVillage] = useState('');
  const [applyFormData, setApplyFormData] = useState<Record<string, string>>({});
  const [submittingApp, setSubmittingApp] = useState(false);

  // Category & Subcategory Forms
  const [catForm, setCatForm] = useState({ name: '', description: '' });
  const [subForm, setSubForm] = useState({ categoryId: 1, name: '', description: '' });

  // Create Master Service Full Configuration State (covers all 9 areas)
  const [srvForm, setSrvForm] = useState({
    name: '',
    categoryId: 1,
    subcategoryId: '' as string | number,
    serviceCharge: 0,
    govtFee: 0,
    additionalCharges: 0,
    serviceCost: 0,
    description: '',
    serviceInstructions: '',
    status: 'Active' as ErpServiceItem['status'],
    availability: 'Available' as ErpServiceItem['availability'],
  });
  const [createFields, setCreateFields] = useState<DynamicFormFieldDef[]>(DEFAULT_CREATE_FIELDS);
  const [createFieldInput, setCreateFieldInput] = useState({
    label: '',
    fieldKey: '',
    fieldType: 'short_text' as DynamicFieldType,
    required: true,
    optionsCsv: '',
  });
  const [createDocs, setCreateDocs] = useState<ServiceRequiredDocumentDef[]>([]);
  const [createDocInput, setCreateDocInput] = useState({
    label: '',
    category: 'Identity Proof',
    required: true,
    maxSizeMb: 5,
    instructions: 'Upload clear readable scan.',
  });
  const [createSla, setCreateSla] = useState<ServiceSlaConfig>(DEFAULT_CREATE_SLA);
  const [createRules, setCreateRules] = useState<ServiceAutomationRule[]>([]);
  const [createRuleInput, setCreateRuleInput] = useState<{
    name: string;
    trigger: ServiceAutomationRule['trigger'];
    actionType: ServiceAutomationRule['actionType'];
    actionParam: string;
  }>({
    name: '',
    trigger: 'APPLICATION_SUBMITTED',
    actionType: 'GENERATE_NOTIFICATION',
    actionParam: 'SMS_STATUS_ALERT',
  });

  // Selected Service Edit Buffers
  // 1) Dynamic Form Builder
  const [draftFields, setDraftFields] = useState<DynamicFormFieldDef[]>([]);
  const [newField, setNewField] = useState<{
    label: string;
    fieldKey: string;
    fieldType: DynamicFieldType;
    required: boolean;
    optionsCsv: string;
  }>({
    label: '',
    fieldKey: '',
    fieldType: 'short_text',
    required: true,
    optionsCsv: '',
  });
  const [editingFieldIdx, setEditingFieldIdx] = useState<number | null>(null);

  // 2) Required Documents
  const [draftDocs, setDraftDocs] = useState<ServiceRequiredDocumentDef[]>([]);
  const [newDocForm, setNewDocForm] = useState({
    label: '',
    category: 'Identity / Support',
    required: true,
    allowMultiple: false,
    allowedFormats: ['PDF', 'JPG', 'JPEG', 'PNG'] as Array<'PDF' | 'JPG' | 'JPEG' | 'PNG'>,
    maxSizeMb: 10,
    instructions: 'Upload valid clear copy.',
  });
  const [editingDocIdx, setEditingDocIdx] = useState<number | null>(null);

  // 3) SLA & Processing Time
  const [editSlaMode, setEditSlaMode] = useState<'FIXED' | 'RANGE'>('FIXED');
  const [editSlaExpected, setEditSlaExpected] = useState(3);
  const [editSlaMin, setEditSlaMin] = useState(1);
  const [editSlaMax, setEditSlaMax] = useState(5);
  const [editSlaDayType, setEditSlaDayType] = useState<'CALENDAR' | 'WORKING'>('WORKING');
  const [editSlaExcludeHolidays, setEditSlaExcludeHolidays] = useState(true);
  const [editSlaStartEvent, setEditSlaStartEvent] = useState<'ON_SUBMIT' | 'ON_ASSIGN'>('ON_SUBMIT');
  const [editSlaPauseStatuses, setEditSlaPauseStatuses] = useState<ErpApplicationStatus[]>([
    'Pending Customer',
    'Pending Office',
    'On Hold',
  ]);
  const [editSlaWarningPct, setEditSlaWarningPct] = useState(75);
  const [editSlaBreachHours, setEditSlaBreachHours] = useState(72);
  const [editSlaEscWarning, setEditSlaEscWarning] = useState(true);
  const [editSlaEscBreach, setEditSlaEscBreach] = useState(true);

  // 4) Automation Rules
  const [draftRules, setDraftRules] = useState<ServiceAutomationRule[]>([]);
  const [newRuleForm, setNewRuleForm] = useState<{
    name: string;
    trigger: ServiceAutomationRule['trigger'];
    conditionStatus: ErpApplicationStatus | 'ANY';
    actionType: ServiceAutomationRule['actionType'];
    actionParam: string;
    enabled: boolean;
  }>({
    name: '',
    trigger: 'APPLICATION_SUBMITTED',
    conditionStatus: 'ANY',
    actionType: 'GENERATE_NOTIFICATION',
    actionParam: '',
    enabled: true,
  });

  // 5) Service Details, Pricing & Status
  const [editName, setEditName] = useState('');
  const [editCategoryId, setEditCategoryId] = useState(1);
  const [editSubcategoryId, setEditSubcategoryId] = useState<string | number>('');
  const [editDescription, setEditDescription] = useState('');
  const [editInstructions, setEditInstructions] = useState('');
  const [editServiceCharge, setEditServiceCharge] = useState(0);
  const [editGovtFee, setEditGovtFee] = useState(0);
  const [editAdditionalCharges, setEditAdditionalCharges] = useState(0);
  const [editCost, setEditCost] = useState(0);
  const [editStatus, setEditStatus] = useState<ErpServiceItem['status']>('Active');
  const [editAvailability, setEditAvailability] =
    useState<ErpServiceItem['availability']>('Available');

  // Delete Service State & Modal
  const [deleteServiceModalOpen, setDeleteServiceModalOpen] = useState(false);
  const [serviceToDelete, setServiceToDelete] = useState<ErpServiceItem | null>(null);
  const [deletingService, setDeletingService] = useState(false);

  // Delete Category / Subcategory Confirmation Modal
  const [deleteTaxonTarget, setDeleteTaxonTarget] = useState<{
    type: 'category' | 'subcategory';
    id: number;
    code: string;
    name: string;
  } | null>(null);
  const [deletingTaxon, setDeletingTaxon] = useState(false);

  const populateDetailBuffers = useCallback((svc: ErpServiceItem) => {
    const activeVer =
      svc.formVersions.find((v) => v.versionNo === svc.currentFormVersion) ??
      svc.formVersions[svc.formVersions.length - 1];
    setDraftFields(activeVer ? activeVer.fields.map((f) => ({ ...f })) : []);
    setEditingFieldIdx(null);

    setDraftDocs(
      Array.isArray(svc.requiredDocuments)
        ? svc.requiredDocuments.map((d) => ({
            ...d,
            allowedFormats: Array.isArray(d.allowedFormats)
              ? [...d.allowedFormats]
              : ['PDF', 'JPG', 'JPEG', 'PNG'],
          }))
        : []
    );
    setEditingDocIdx(null);

    setDraftRules(
      Array.isArray(svc.automationRules) ? svc.automationRules.map((r) => ({ ...r })) : []
    );

    setEditName(svc.name);
    setEditCategoryId(svc.categoryId);
    setEditSubcategoryId(svc.subcategoryId ?? '');
    setEditDescription(svc.description || '');
    setEditInstructions(svc.serviceInstructions || svc.termsAndConditions || '');
    setEditServiceCharge(svc.serviceCharge ?? svc.customerCharge ?? 0);
    setEditGovtFee(svc.govtFee ?? 0);
    setEditAdditionalCharges(svc.additionalCharges ?? 0);
    setEditCost(svc.serviceCost ?? 0);
    setEditStatus(svc.status);
    setEditAvailability(svc.availability);

    setEditSlaMode(svc.sla?.processingMode || 'FIXED');
    setEditSlaExpected(svc.sla?.expectedDays ?? 3);
    setEditSlaMin(svc.sla?.minDays ?? 1);
    setEditSlaMax(svc.sla?.maxDays ?? 5);
    setEditSlaDayType(svc.sla?.dayType || 'WORKING');
    setEditSlaExcludeHolidays(svc.sla?.excludeHolidays !== false);
    setEditSlaStartEvent(svc.sla?.startEvent || 'ON_SUBMIT');
    setEditSlaPauseStatuses(
      Array.isArray(svc.sla?.pauseOnStatuses) && svc.sla.pauseOnStatuses.length > 0
        ? [...svc.sla.pauseOnStatuses]
        : ['Pending Customer', 'Pending Office', 'On Hold']
    );
    setEditSlaWarningPct(svc.sla?.warningThresholdPct ?? 75);
    setEditSlaBreachHours(svc.sla?.breachThresholdHours ?? 72);
    setEditSlaEscWarning(svc.sla?.escalateToManagerAtWarning !== false);
    setEditSlaEscBreach(svc.sla?.escalateToAdminAtBreach !== false);
  }, []);

  const lastBufferedServiceSignatureRef = useRef<string>('');
  useEffect(() => {
    if (!selectedService) {
      setDraftFields([]);
      setDraftDocs([]);
      setDraftRules([]);
      lastBufferedServiceSignatureRef.current = '';
      return;
    }
    const sig = `${selectedService.serviceId}:${selectedService.updatedAt}:${selectedService.currentFormVersion}`;
    if (lastBufferedServiceSignatureRef.current !== sig) {
      lastBufferedServiceSignatureRef.current = sig;
      populateDetailBuffers(selectedService);
    }
  }, [selectedService, populateDetailBuffers]);

  const selectService = useCallback(
    (svc: ErpServiceItem | null) => {
      setSelectedServiceId(svc?.serviceId ?? null);
      if (svc) {
        lastBufferedServiceSignatureRef.current = `${svc.serviceId}:${svc.updatedAt}:${svc.currentFormVersion}`;
        populateDetailBuffers(svc);
      }
    },
    [populateDetailBuffers]
  );

  // Firestore real-time catalog subscription when connected
  useEffect(() => {
    if (!cloudSync.userUid || !isFirebaseConfigured()) {
      setFsCategories([]);
      setFsSubcategories([]);
      setFsServices([]);
      setFsCatalogMeta(null);
      setFsLoaded(false);
      return;
    }
    const unsub = subscribeServicesModuleRealtime({
      onCategories: (items) => setFsCategories(items),
      onSubcategories: (items) => setFsSubcategories(items),
      onServices: (items) => {
        setFsServices(items);
        setFsLoaded(true);
      },
      onCatalogSeedMeta: (meta) => setFsCatalogMeta(meta),
      onError: (err) => {
        onShowToast('error', 'Cloud Services Sync Error', extractFriendlyErrorMessage(err));
      },
    });
    return () => unsub();
  }, [cloudSync.userUid, onShowToast]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setSyncError(null);
    try {
      let [sRes, cRes, subRes, tombRes] = await Promise.all([
        erpApi.listServices(),
        erpApi.listServiceCategories(),
        erpApi.listServiceSubcategories(),
        erpApi.getTombstones().catch(() => null),
      ]);

      const fetchedTombstones = tombRes?.data ?? null;
      if (fetchedTombstones) {
        setBackendTombstones(fetchedTombstones);
      }
      const hasBackendTombstones = Boolean(
        fetchedTombstones &&
          (fetchedTombstones.deletedServiceIds.length > 0 ||
            fetchedTombstones.deletedServiceCodes.length > 0 ||
            fetchedTombstones.deletedCategoryCodes.length > 0 ||
            fetchedTombstones.deletedSubcategoryCodes.length > 0)
      );

      if (
        sRes.data.length === 0 &&
        canSyncCatalog &&
        !autoSyncAttemptedRef.current &&
        !hasBackendTombstones &&
        !fsCatalogMeta?.seeded
      ) {
        autoSyncAttemptedRef.current = true;
        setSyncingCatalog(true);
        try {
          const syncRes = await erpApi.syncCatalog675(false);
          const d = syncRes.data;
          [sRes, cRes, subRes] = await Promise.all([
            erpApi.listServices(),
            erpApi.listServiceCategories(),
            erpApi.listServiceSubcategories(),
          ]);
          onShowToast(
            'success',
            '675 Services Synced',
            `${d.categoriesCount} Categories · ${d.subcategoriesCount} Subcategories · ${d.servicesCount} Services`
          );
        } catch (syncErr) {
          const msg = extractFriendlyErrorMessage(syncErr, 'Unable to sync 675 Services Catalog.');
          setSyncError(msg);
          onShowToast('error', 'Services Catalog Sync Failed', msg);
        } finally {
          setSyncingCatalog(false);
        }
      }

      setApiServices(sRes.data);
      setApiCategories(cRes.data);
      setApiSubcategories(subRes.data);
    } catch (err) {
      const msg = extractFriendlyErrorMessage(err);
      setSyncError(msg);
      onShowToast('error', 'Failed to load Services', msg);
    } finally {
      setLoading(false);
    }
  }, [canSyncCatalog, fsCatalogMeta?.seeded, onShowToast]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const syncServiceWriteToCloud = async (
    svc: ErpServiceItem,
    auditType: string,
    auditSummary: string
  ) => {
    await saveServiceToFirestore(svc);
    await writeServiceAuditLogToFirestore({
      actorUserId: currentUser.userId,
      eventType: auditType,
      summary: auditSummary,
    });
  };

  const handleSyncCatalog675 = async (restoreDeleted = false) => {
    setSyncingCatalog(true);
    setSyncError(null);
    try {
      const res = await erpApi.syncCatalog675(restoreDeleted);
      const d = res.data;
      if (restoreDeleted) {
        setLocalDeletedServiceIds([]);
        setLocalDeletedServiceCodes([]);
        setLocalDeletedCategoryCodes([]);
        setLocalDeletedSubcategoryCodes([]);
      }
      const [sRes, cRes, subRes, tombRes] = await Promise.all([
        erpApi.listServices(),
        erpApi.listServiceCategories(),
        erpApi.listServiceSubcategories(),
        erpApi.getTombstones().catch(() => null),
      ]);
      if (tombRes?.data) {
        setBackendTombstones(tombRes.data);
      }
      setApiServices(sRes.data);
      setApiCategories(cRes.data);
      setApiSubcategories(subRes.data);

      let cloudNote = '';
      if (firebaseUser && isFirebaseConfigured()) {
        const fsRes = await syncMissingCatalogToFirestore({
          categories: cRes.data,
          subcategories: subRes.data,
          services: sRes.data,
          restoreDeleted,
        });
        await writeServiceAuditLogToFirestore({
          actorUserId: currentUser.userId,
          eventType: 'SERVICE_CATALOG_SYNCED',
          summary: `${restoreDeleted ? 'Restored & synced' : 'Synced'} master catalog (${d.servicesCount} services). Firestore created ${fsRes.createdServices} missing doc(s), deleted/customized docs respected.`,
        });
        cloudNote = ` · Cloud seeded ${fsRes.createdServices} missing doc(s)`;
      }

      onShowToast(
        'success',
        restoreDeleted ? 'Catalog Restored & Synced' : 'Services Catalog Synced',
        `${d.categoriesCount} Categories · ${d.subcategoriesCount} Subcategories · ${d.servicesCount} Services (${d.codeRange})${cloudNote}`
      );
    } catch (err) {
      const msg = extractFriendlyErrorMessage(err);
      setSyncError(msg);
      onShowToast('error', 'Catalog Sync Failed', msg);
    } finally {
      setSyncingCatalog(false);
    }
  };

  // ======================== DELETE SERVICE & CONTINUOUS RE-INDEX ========================
  const promptDeleteService = (svc: ErpServiceItem) => {
    setServiceToDelete(svc);
    setDeleteServiceModalOpen(true);
  };

  const handleExecuteDeleteService = async () => {
    if (!serviceToDelete) return;
    setDeletingService(true);
    const target = serviceToDelete;
    try {
      await erpApi.deleteService(target.serviceId);

      // Record tombstones optimistically and prune both API and Firestore local lists immediately
      setLocalDeletedServiceIds((prev) => Array.from(new Set([...prev, target.serviceId])));
      if (target.serviceCode) {
        setLocalDeletedServiceCodes((prev) => Array.from(new Set([...prev, target.serviceCode])));
      }

      const remainingOrdered = computeContinuousServiceSerials(
        services.filter((s) => s.serviceId !== target.serviceId)
      );

      setApiServices((prev) =>
        computeContinuousServiceSerials(prev.filter((s) => s.serviceId !== target.serviceId))
      );
      setFsServices((prev) =>
        computeContinuousServiceSerials(prev.filter((s) => s.serviceId !== target.serviceId))
      );

      await deleteServiceFromFirestore(target.serviceId, target.serviceCode);
      await resequenceServicesDisplayOrderInFirestore(remainingOrdered);
      await writeServiceAuditLogToFirestore({
        actorUserId: currentUser.userId,
        eventType: 'SERVICE_DELETED',
        summary: `Deleted ${target.serviceCode} (${target.serviceId}) and re-sequenced remaining ${remainingOrdered.length} services.`,
      });

      if (selectedService?.serviceId === target.serviceId) {
        selectService(remainingOrdered[0] ?? null);
      }

      onShowToast(
        'success',
        'Service Permanently Deleted',
        `${target.serviceCode || target.serviceId} removed; remaining display serial numbers re-sequenced cleanly.`
      );
      setDeleteServiceModalOpen(false);
      setServiceToDelete(null);
      await loadAll();
    } catch (err) {
      onShowToast('error', 'Delete Failed', extractFriendlyErrorMessage(err, 'Unable to delete service.'));
    } finally {
      setDeletingService(false);
    }
  };

  const handleToggleServiceStatus = async (svc: ErpServiceItem) => {
    const nextStatus = svc.status === 'Active' ? 'Inactive' : 'Active';
    setTogglingStatus(true);
    try {
      const res = await erpApi.toggleServiceStatus(svc.serviceId, nextStatus);
      const updated = res.data;
      setApiServices((prev) =>
        prev.map((s) => (s.serviceId === updated.serviceId ? updated : s))
      );
      await syncServiceWriteToCloud(
        updated,
        'SERVICE_UPDATED',
        `Toggled ${updated.serviceCode} (${updated.name}) status to ${updated.status}`
      );
      onShowToast(
        'success',
        `Service ${nextStatus}`,
        `${updated.serviceCode} marked ${updated.status}.`
      );
    } catch (err) {
      onShowToast('error', 'Status Update Failed', extractFriendlyErrorMessage(err));
    } finally {
      setTogglingStatus(false);
    }
  };

  // ======================== DYNAMIC FORM BUILDER ========================
  const handleAddOrUpdateDraftField = () => {
    if (!newField.label.trim()) {
      onShowToast('error', 'Field Label Required', 'Enter a label for the dynamic form field.');
      return;
    }
    const key = slugifyKey(
      newField.fieldKey.trim() || newField.label.trim(),
      `field_${draftFields.length + 1}`
    );
    const options = ['dropdown', 'radio', 'multi_select'].includes(newField.fieldType)
      ? newField.optionsCsv
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    if (editingFieldIdx !== null) {
      setDraftFields((prev) =>
        prev.map((f, i) =>
          i === editingFieldIdx
            ? {
                ...f,
                fieldKey: key,
                label: newField.label.trim(),
                fieldType: newField.fieldType,
                required: newField.required,
                options,
              }
            : f
        )
      );
      setEditingFieldIdx(null);
    } else {
      setDraftFields((prev) => [
        ...prev,
        {
          fieldKey: key,
          label: newField.label.trim(),
          fieldType: newField.fieldType,
          required: newField.required,
          displayOrder: prev.length + 1,
          options,
          enabled: true,
        },
      ]);
    }
    setNewField({
      label: '',
      fieldKey: '',
      fieldType: 'short_text',
      required: true,
      optionsCsv: '',
    });
  };

  const handleMoveDraftField = (idx: number, dir: -1 | 1) => {
    setDraftFields((prev) => {
      const targetIdx = idx + dir;
      if (targetIdx < 0 || targetIdx >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(idx, 1);
      next.splice(targetIdx, 0, item);
      return next.map((f, i) => ({ ...f, displayOrder: i + 1 }));
    });
  };

  const handlePublishFormVersion = async () => {
    if (!selectedService) return;
    if (draftFields.length === 0) {
      onShowToast('error', 'Empty Form', 'Add at least one form field before publishing a new version.');
      return;
    }
    setPublishingForm(true);
    try {
      const res = await erpApi.publishFormVersion(
        selectedService.serviceId,
        draftFields.map((f, i) => ({ ...f, displayOrder: i + 1 }))
      );
      const updated = res.data;
      setApiServices((prev) =>
        prev.map((s) => (s.serviceId === updated.serviceId ? updated : s))
      );
      await syncServiceWriteToCloud(
        updated,
        'SERVICE_FORM_PUBLISHED',
        `Published Dynamic Form v${updated.currentFormVersion} for ${updated.serviceCode} (${updated.name})`
      );
      onShowToast(
        'success',
        'Form Version Published',
        `${updated.serviceCode} v${updated.currentFormVersion} active (historical applications unaffected)`
      );
    } catch (err) {
      onShowToast('error', 'Publish Failed', extractFriendlyErrorMessage(err));
    } finally {
      setPublishingForm(false);
    }
  };

  // ======================== REQUIRED DOCUMENTS BUILDER ========================
  const handleAddOrUpdateDraftDoc = () => {
    if (!newDocForm.label.trim()) {
      onShowToast('error', 'Document Label Required', 'Enter a document name.');
      return;
    }
    const nextItem: ServiceRequiredDocumentDef = {
      docKey: slugifyKey(newDocForm.label, `doc_${draftDocs.length + 1}`),
      label: newDocForm.label.trim(),
      category: newDocForm.category.trim() || 'Identity / Support',
      required: newDocForm.required,
      allowMultiple: newDocForm.allowMultiple,
      allowedFormats:
        newDocForm.allowedFormats.length > 0 ? [...newDocForm.allowedFormats] : ['PDF', 'JPG'],
      maxSizeMb: Math.max(1, Math.min(25, Number(newDocForm.maxSizeMb) || 10)),
      instructions: newDocForm.instructions.trim() || 'Upload clear readable copy.',
      enabled: true,
    };

    if (editingDocIdx !== null) {
      setDraftDocs((prev) =>
        prev.map((d, i) => (i === editingDocIdx ? { ...nextItem, enabled: d.enabled } : d))
      );
      setEditingDocIdx(null);
    } else {
      setDraftDocs((prev) => [...prev, nextItem]);
    }
    setNewDocForm({
      label: '',
      category: 'Identity / Support',
      required: true,
      allowMultiple: false,
      allowedFormats: ['PDF', 'JPG', 'JPEG', 'PNG'],
      maxSizeMb: 10,
      instructions: 'Upload valid clear copy.',
    });
  };

  const handleSaveRequiredDocuments = async () => {
    if (!selectedService) return;
    setSavingDocs(true);
    try {
      const res = await erpApi.updateService(selectedService.serviceId, {
        requiredDocuments: draftDocs,
      });
      const updated = res.data;
      setApiServices((prev) =>
        prev.map((s) => (s.serviceId === updated.serviceId ? updated : s))
      );
      await syncServiceWriteToCloud(
        updated,
        'SERVICE_UPDATED',
        `Updated Required Documents (${draftDocs.length}) for ${updated.serviceCode}`
      );
      onShowToast(
        'success',
        'Required Documents Saved',
        `${updated.serviceCode} now has ${updated.requiredDocuments.length} document requirement(s).`
      );
    } catch (err) {
      onShowToast('error', 'Save Failed', extractFriendlyErrorMessage(err));
    } finally {
      setSavingDocs(false);
    }
  };

  // ======================== SLA & PROCESSING TIME ========================
  const handleSaveSla = async () => {
    if (!selectedService) return;
    setSavingSla(true);
    try {
      const res = await erpApi.updateService(selectedService.serviceId, {
        sla: {
          processingMode: editSlaMode,
          expectedDays: Math.max(1, Number(editSlaExpected || 1)),
          minDays: Math.max(1, Number(editSlaMin || 1)),
          maxDays: Math.max(Number(editSlaMin || 1), Number(editSlaMax || 1)),
          dayType: editSlaDayType,
          excludeHolidays: editSlaExcludeHolidays,
          startEvent: editSlaStartEvent,
          pauseOnStatuses:
            editSlaPauseStatuses.length > 0 ? editSlaPauseStatuses : ['Pending Customer'],
          warningThresholdPct: Math.min(99, Math.max(10, Number(editSlaWarningPct || 75))),
          breachThresholdHours: Math.max(1, Number(editSlaBreachHours || 72)),
          escalateToManagerAtWarning: editSlaEscWarning,
          escalateToAdminAtBreach: editSlaEscBreach,
        },
      });
      const updated = res.data;
      setApiServices((prev) =>
        prev.map((s) => (s.serviceId === updated.serviceId ? updated : s))
      );
      await syncServiceWriteToCloud(
        updated,
        'SERVICE_UPDATED',
        `Updated SLA (${updated.sla.processingMode} ${updated.sla.expectedDays}d ${updated.sla.dayType}) for ${updated.serviceCode}`
      );
      onShowToast(
        'success',
        'SLA Configuration Saved',
        `${updated.serviceCode} SLA set to ${updated.sla.expectedDays}d (${updated.sla.dayType}).`
      );
    } catch (err) {
      onShowToast('error', 'SLA Update Failed', extractFriendlyErrorMessage(err));
    } finally {
      setSavingSla(false);
    }
  };

  // ======================== AUTOMATION RULES ========================
  const handleAddDraftRule = () => {
    if (!newRuleForm.name.trim()) {
      onShowToast('error', 'Rule Name Required', 'Enter a descriptive automation rule name.');
      return;
    }
    const rule: ServiceAutomationRule = {
      id: `AUTO-${Date.now().toString(36).toUpperCase()}`,
      name: newRuleForm.name.trim(),
      trigger: newRuleForm.trigger,
      conditionStatus: newRuleForm.conditionStatus,
      actionType: newRuleForm.actionType,
      actionParam: newRuleForm.actionParam.trim() || 'DEFAULT',
      enabled: newRuleForm.enabled,
      versionNo: 1,
      executionCount: 0,
      lastRunAt: null,
      lastError: null,
    };
    setDraftRules((prev) => [...prev, rule]);
    setNewRuleForm({
      name: '',
      trigger: 'APPLICATION_SUBMITTED',
      conditionStatus: 'ANY',
      actionType: 'GENERATE_NOTIFICATION',
      actionParam: '',
      enabled: true,
    });
  };

  const handleSaveAutomationRules = async () => {
    if (!selectedService) return;
    setSavingAutomation(true);
    try {
      const res = await erpApi.updateService(selectedService.serviceId, {
        automationRules: draftRules,
      });
      const updated = res.data;
      setApiServices((prev) =>
        prev.map((s) => (s.serviceId === updated.serviceId ? updated : s))
      );
      await syncServiceWriteToCloud(
        updated,
        'SERVICE_UPDATED',
        `Updated ${draftRules.length} automation rule(s) for ${updated.serviceCode}`
      );
      onShowToast(
        'success',
        'Automation Rules Saved',
        `${updated.serviceCode} updated with ${updated.automationRules.length} rule(s).`
      );
    } catch (err) {
      onShowToast('error', 'Save Failed', extractFriendlyErrorMessage(err));
    } finally {
      setSavingAutomation(false);
    }
  };

  // ======================== DETAILS, PRICING & STATUS ========================
  const calculatedEditTotalCharge = useMemo(
    () =>
      round2(
        (Number(editServiceCharge) || 0) +
          (Number(editGovtFee) || 0) +
          (Number(editAdditionalCharges) || 0)
      ),
    [editServiceCharge, editGovtFee, editAdditionalCharges]
  );

  const calculatedEditProfit = useMemo(
    () =>
      round2(
        (Number(editServiceCharge) || 0) +
          (Number(editAdditionalCharges) || 0) -
          (Number(editCost) || 0)
      ),
    [editServiceCharge, editAdditionalCharges, editCost]
  );

  const handleSaveDetailsPricingAndStatus = async () => {
    if (!selectedService) return;
    if (!editName.trim() || editName.trim().length < 2) {
      onShowToast('error', 'Validation Failed', 'Service name must be at least 2 characters.');
      return;
    }
    setSavingPricing(true);
    try {
      const res = await erpApi.updateService(selectedService.serviceId, {
        name: editName.trim(),
        categoryId: Number(editCategoryId),
        subcategoryId: editSubcategoryId ? Number(editSubcategoryId) : null,
        description: editDescription.trim(),
        serviceInstructions: editInstructions.trim(),
        serviceCharge: Number(editServiceCharge || 0),
        govtFee: Number(editGovtFee || 0),
        additionalCharges: Number(editAdditionalCharges || 0),
        serviceCost: Number(editCost || 0),
        status: editStatus,
        availability: editAvailability,
      });
      const updated = res.data;
      setApiServices((prev) =>
        prev.map((s) => (s.serviceId === updated.serviceId ? updated : s))
      );
      await syncServiceWriteToCloud(
        updated,
        'SERVICE_UPDATED',
        `Updated details/pricing/status for ${updated.serviceCode} (Charge ₹${updated.totalCustomerCharge}, Status ${updated.status})`
      );
      onShowToast(
        'success',
        'Service Updated',
        `${updated.serviceCode} · Total Charge: ${formatCurrency(updated.totalCustomerCharge)} · Profit: ${formatCurrency(updated.profitAmount)}`
      );
    } catch (err) {
      onShowToast('error', 'Update Failed', extractFriendlyErrorMessage(err));
    } finally {
      setSavingPricing(false);
    }
  };

  // ======================== CREATE MASTER SERVICE (ALL 9 AREAS) ========================
  const handleOpenCreateServiceModal = () => {
    setSrvError(null);
    const initCatId =
      selectedCategoryFilter !== 'ALL'
        ? Number(selectedCategoryFilter)
        : categories[0]?.id ?? 1;
    const firstSub = subcategories.find((sc) => sc.categoryId === initCatId);
    setSrvForm({
      name: '',
      categoryId: initCatId,
      subcategoryId:
        selectedSubcategoryFilter !== 'ALL'
          ? Number(selectedSubcategoryFilter)
          : firstSub?.id ?? '',
      serviceCharge: 0,
      govtFee: 0,
      additionalCharges: 0,
      serviceCost: 0,
      description: '',
      serviceInstructions: '',
      status: 'Active',
      availability: 'Available',
    });
    setCreateFields(DEFAULT_CREATE_FIELDS.map((f) => ({ ...f })));
    setCreateDocs([]);
    setCreateSla({ ...DEFAULT_CREATE_SLA });
    setCreateRules([]);
    setCreateTab('details');
    setNewServiceOpen(true);
  };

  const handleCreateService = async (e: React.FormEvent) => {
    e.preventDefault();
    setSrvError(null);
    if (!srvForm.name.trim() || srvForm.name.trim().length < 2) {
      setSrvError('Service name must be at least 2 characters.');
      setCreateTab('details');
      return;
    }
    setSavingSrv(true);
    try {
      const res = await erpApi.createService({
        name: srvForm.name.trim(),
        categoryId: Number(srvForm.categoryId) || categories[0]?.id || 1,
        subcategoryId: srvForm.subcategoryId ? Number(srvForm.subcategoryId) : undefined,
        serviceCharge: Number(srvForm.serviceCharge || 0),
        govtFee: Number(srvForm.govtFee || 0),
        additionalCharges: Number(srvForm.additionalCharges || 0),
        serviceCost: Number(srvForm.serviceCost || 0),
        description: srvForm.description.trim(),
        serviceInstructions: srvForm.serviceInstructions.trim(),
        status: srvForm.status,
        availability: srvForm.availability,
        fields: createFields.map((f, idx) => ({ ...f, displayOrder: idx + 1 })),
        requiredDocuments: createDocs,
        sla: createSla,
        automationRules: createRules,
      });
      const created = res.data;
      setApiServices((prev) => computeContinuousServiceSerials([...prev, created]));

      await saveServiceToFirestore(created);
      await writeServiceAuditLogToFirestore({
        actorUserId: currentUser.userId,
        eventType: 'SERVICE_CREATED',
        summary: `Created Service ${created.serviceCode} (${created.serviceId}) — ${created.name}`,
      });

      setNewServiceOpen(false);
      onShowToast(
        'success',
        'Service Created & Saved to Cloud',
        `S.No ${created.serialNumber || ''} · ${created.serviceCode} (${created.serviceId}) — ${created.name}`
      );
      selectService(created);
      await loadAll();
    } catch (err) {
      const msg = extractFriendlyErrorMessage(err, 'Unable to create service.');
      setSrvError(msg);
      onShowToast('error', 'Creation Failed', msg);
    } finally {
      setSavingSrv(false);
    }
  };

  // ======================== CATEGORY & SUBCATEGORY CRUD ========================
  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    setCatError(null);
    if (!catForm.name.trim() || catForm.name.trim().length < 2) {
      setCatError('Category name must be at least 2 characters.');
      return;
    }
    setSavingCat(true);
    try {
      if (editingCat) {
        const res = await erpApi.updateServiceCategory(editingCat.id, {
          name: catForm.name.trim(),
          description: catForm.description.trim(),
        });
        await saveServiceCategoryToFirestore(res.data);
        await writeServiceAuditLogToFirestore({
          actorUserId: currentUser.userId,
          eventType: 'SERVICE_CATEGORY_CHANGED',
          summary: `Updated Category ${res.data.code} (${res.data.name})`,
        });
        onShowToast('success', 'Category Updated in Cloud', `Updated "${res.data.name}" (${res.data.code})`);
      } else {
        const res = await erpApi.createServiceCategory({
          name: catForm.name.trim(),
          description: catForm.description.trim(),
        });
        await saveServiceCategoryToFirestore(res.data);
        await writeServiceAuditLogToFirestore({
          actorUserId: currentUser.userId,
          eventType: 'SERVICE_CATEGORY_CHANGED',
          summary: `Created Category ${res.data.code} (${res.data.name})`,
        });
        onShowToast('success', 'Category Created in Cloud', `Created "${res.data.name}" (${res.data.code})`);
      }
      setNewCatOpen(false);
      setEditingCat(null);
      setCatForm({ name: '', description: '' });
      await loadAll();
    } catch (err) {
      const msg = extractFriendlyErrorMessage(err, 'Unable to save category.');
      setCatError(msg);
      onShowToast('error', 'Category Error', msg);
    } finally {
      setSavingCat(false);
    }
  };

  const handleSaveSubcategory = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubError(null);
    if (!subForm.name.trim() || subForm.name.trim().length < 2) {
      setSubError('Subcategory name must be at least 2 characters.');
      return;
    }
    setSavingSub(true);
    try {
      if (editingSub) {
        const res = await erpApi.updateServiceSubcategory(editingSub.id, {
          categoryId: Number(subForm.categoryId),
          name: subForm.name.trim(),
          description: subForm.description.trim(),
        });
        await saveServiceSubcategoryToFirestore(res.data);
        await writeServiceAuditLogToFirestore({
          actorUserId: currentUser.userId,
          eventType: 'SERVICE_CATEGORY_CHANGED',
          summary: `Updated Subcategory ${res.data.code} (${res.data.name})`,
        });
        onShowToast('success', 'Subcategory Updated in Cloud', `${res.data.code} — ${res.data.name}`);
      } else {
        const res = await erpApi.createServiceSubcategory({
          categoryId: Number(subForm.categoryId),
          name: subForm.name.trim(),
          description: subForm.description.trim(),
        });
        await saveServiceSubcategoryToFirestore(res.data);
        await writeServiceAuditLogToFirestore({
          actorUserId: currentUser.userId,
          eventType: 'SERVICE_CATEGORY_CHANGED',
          summary: `Created Subcategory ${res.data.code} (${res.data.name})`,
        });
        onShowToast('success', 'Subcategory Created in Cloud', `${res.data.code} — ${res.data.name}`);
      }
      setNewSubOpen(false);
      setEditingSub(null);
      setSubForm({ categoryId: categories[0]?.id ?? 1, name: '', description: '' });
      await loadAll();
    } catch (err) {
      const msg = extractFriendlyErrorMessage(err, 'Unable to save subcategory.');
      setSubError(msg);
      onShowToast('error', 'Subcategory Error', msg);
    } finally {
      setSavingSub(false);
    }
  };

  const handleExecuteDeleteTaxon = async () => {
    if (!deleteTaxonTarget) return;
    setDeletingTaxon(true);
    try {
      if (deleteTaxonTarget.type === 'category') {
        await erpApi.deleteServiceCategory(deleteTaxonTarget.id);
        setLocalDeletedCategoryCodes((prev) =>
          Array.from(new Set([...prev, deleteTaxonTarget.code]))
        );
        setApiCategories((prev) => prev.filter((c) => c.code !== deleteTaxonTarget.code));
        setFsCategories((prev) => prev.filter((c) => c.code !== deleteTaxonTarget.code));
        await deleteServiceCategoryFromFirestore(deleteTaxonTarget.code);
        await writeServiceAuditLogToFirestore({
          actorUserId: currentUser.userId,
          eventType: 'SERVICE_CATEGORY_CHANGED',
          summary: `Deleted Category ${deleteTaxonTarget.code} (${deleteTaxonTarget.name})`,
        });
        if (selectedCategoryFilter === String(deleteTaxonTarget.id)) {
          setSelectedCategoryFilter('ALL');
          setSelectedSubcategoryFilter('ALL');
        }
        onShowToast('success', 'Category Deleted', `"${deleteTaxonTarget.name}" removed.`);
      } else {
        await erpApi.deleteServiceSubcategory(deleteTaxonTarget.id);
        setLocalDeletedSubcategoryCodes((prev) =>
          Array.from(new Set([...prev, deleteTaxonTarget.code]))
        );
        setApiSubcategories((prev) => prev.filter((sc) => sc.code !== deleteTaxonTarget.code));
        setFsSubcategories((prev) => prev.filter((sc) => sc.code !== deleteTaxonTarget.code));
        await deleteServiceSubcategoryFromFirestore(deleteTaxonTarget.code);
        await writeServiceAuditLogToFirestore({
          actorUserId: currentUser.userId,
          eventType: 'SERVICE_CATEGORY_CHANGED',
          summary: `Deleted Subcategory ${deleteTaxonTarget.code} (${deleteTaxonTarget.name})`,
        });
        if (selectedSubcategoryFilter === String(deleteTaxonTarget.id)) {
          setSelectedSubcategoryFilter('ALL');
        }
        onShowToast('success', 'Subcategory Deleted', `"${deleteTaxonTarget.name}" removed.`);
      }
      setDeleteTaxonTarget(null);
      await loadAll();
    } catch (err) {
      onShowToast('error', 'Delete Blocked', extractFriendlyErrorMessage(err));
    } finally {
      setDeletingTaxon(false);
    }
  };

  // ======================== COMPUTED FILTERS & COUNTS ========================
  const activeFilterSubcategories = useMemo(() => {
    if (selectedCategoryFilter === 'ALL') return [];
    return subcategories.filter((sc) => String(sc.categoryId) === String(selectedCategoryFilter));
  }, [subcategories, selectedCategoryFilter]);

  const createFormSubcategories = useMemo(
    () => subcategories.filter((sc) => Number(sc.categoryId) === Number(srvForm.categoryId)),
    [subcategories, srvForm.categoryId]
  );

  const editFormSubcategories = useMemo(
    () => subcategories.filter((sc) => Number(sc.categoryId) === Number(editCategoryId)),
    [subcategories, editCategoryId]
  );

  const categoryCountMap = useMemo(() => {
    const counts = new Map<number, number>();
    for (const s of services) {
      counts.set(s.categoryId, (counts.get(s.categoryId) || 0) + 1);
    }
    return counts;
  }, [services]);

  const subcategoryCountMap = useMemo(() => {
    const counts = new Map<number, number>();
    for (const s of services) {
      if (s.subcategoryId) {
        counts.set(s.subcategoryId, (counts.get(s.subcategoryId) || 0) + 1);
      }
    }
    return counts;
  }, [services]);

  const filteredServices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return services.filter((s) => {
      if (
        selectedCategoryFilter !== 'ALL' &&
        String(s.categoryId) !== String(selectedCategoryFilter)
      ) {
        return false;
      }
      if (
        selectedSubcategoryFilter !== 'ALL' &&
        String(s.subcategoryId ?? '') !== String(selectedSubcategoryFilter)
      ) {
        return false;
      }
      if (statusFilter !== 'ALL' && s.status !== statusFilter) return false;
      if (rateFilter === 'CONFIGURED' && (s.totalCustomerCharge ?? s.customerCharge) <= 0)
        return false;
      if (rateFilter === 'BLANK' && (s.totalCustomerCharge ?? s.customerCharge) > 0)
        return false;
      if (q) {
        const match =
          (s.serialNumber || '').toLowerCase().includes(q) ||
          s.serviceId.toLowerCase().includes(q) ||
          s.serviceCode.toLowerCase().includes(q) ||
          s.name.toLowerCase().includes(q) ||
          s.categoryName.toLowerCase().includes(q) ||
          (s.subcategoryName || '').toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    });
  }, [
    services,
    selectedCategoryFilter,
    selectedSubcategoryFilter,
    statusFilter,
    rateFilter,
    searchQuery,
  ]);

  const totalPages = Math.max(1, Math.ceil(filteredServices.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedServices = filteredServices.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize
  );

  // ======================== APPLY SERVICE WORKFLOW ========================
  const handleOpenApplyWorkflow = (svc: ErpServiceItem) => {
    setApplyingService(svc);
    setApplyCustName('');
    setApplyCustMobile('');
    setApplyVillage('');
    setApplyFormData({});
    setApplyError(null);
    setApplyModalOpen(true);
  };

  const handleExecuteApplyService = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!applyingService) return;
    setApplyError(null);
    if (!applyCustName.trim() || applyCustMobile.trim().length < 10) {
      const msg = 'Customer Name and valid 10-digit mobile number are required.';
      setApplyError(msg);
      onShowToast('error', 'Validation Failed', msg);
      return;
    }

    setSubmittingApp(true);
    try {
      const custRes = await erpApi.createCustomer({
        fullName: applyCustName.trim(),
        mobile: applyCustMobile.trim(),
        village: applyVillage.trim() || 'Local Area',
        district: 'Murshidabad',
        minSequence: getMaxCachedCustomerSequence(),
      });
      const firestoreCustomer = await saveNewCustomerToFirestore(custRes.data);
      const savedCustomer = upsertCachedCustomer(firestoreCustomer, { allowUntombstone: true });
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('mun:customer-created', { detail: savedCustomer }));
      }
      const customerId = savedCustomer.customerId;

      const appRes = await erpApi.createApplication({
        customerId: custRes.data.customerId,
        serviceId: applyingService.serviceId,
        formData: applyFormData,
        adminRemarks: `Applied via centralized Services Catalog workflow for ${applyingService.name}`,
      });

      const savedApp = await saveApplicationToFirestore(
        { ...appRes.data, customerId },
        {
          customerFallback: savedCustomer,
          serviceFallback: applyingService,
          isExplicitCreate: true,
        }
      );

      onShowToast(
        'success',
        'Application Saved to Cloud!',
        `Reference No: ${savedApp.applicationNo} linked to customer ${customerId}.`
      );
      setApplyModalOpen(false);
      onStartApplicationForService(applyingService.serviceId);
    } catch (err) {
      const msg = extractFriendlyErrorMessage(err, 'Application submission failed.');
      setApplyError(msg);
      onShowToast('error', 'Application Submission Failed', msg);
    } finally {
      setSubmittingApp(false);
    }
  };

  const selectedCategoryObj =
    selectedCategoryFilter !== 'ALL'
      ? categories.find((c) => String(c.id) === String(selectedCategoryFilter)) ?? null
      : null;

  const selectedSubcategoryObj =
    selectedSubcategoryFilter !== 'ALL'
      ? subcategories.find((sc) => String(sc.id) === String(selectedSubcategoryFilter)) ?? null
      : null;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-neutral-950 dark:text-white">
            Services, Dynamic Forms &amp; SLA Management
          </h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            {categories.length} Categories · {subcategories.length} Subcategories · {services.length}{' '}
            Services (Continuous S.No &amp; Immutable Service IDs)
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canSyncCatalog && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={syncingCatalog}
              onClick={() => void handleSyncCatalog675(false)}
              icon={<Database className="h-3.5 w-3.5" />}
            >
              {syncingCatalog ? 'Syncing Catalog...' : 'Sync Catalog (Keep Deletions)'}
            </Button>
          )}
          {canManageServices && tombstones.hasAny && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={syncingCatalog}
              onClick={() => void handleSyncCatalog675(true)}
              icon={<Database className="h-3.5 w-3.5" />}
            >
              Restore Deleted Defaults
            </Button>
          )}
          {canManageServices && (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditingCat(null);
                  setCatError(null);
                  setCatForm({ name: '', description: '' });
                  setNewCatOpen(true);
                }}
                icon={<Layers className="h-3.5 w-3.5" />}
              >
                Add Category
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditingSub(null);
                  setSubError(null);
                  const fallbackCatId =
                    selectedCategoryFilter !== 'ALL'
                      ? Number(selectedCategoryFilter)
                      : categories[0]?.id ?? 1;
                  setSubForm({ categoryId: fallbackCatId, name: '', description: '' });
                  setNewSubOpen(true);
                }}
                icon={<FolderTree className="h-3.5 w-3.5" />}
              >
                Add Subcategory
              </Button>
              <Button
                type="button"
                size="sm"
                variant="primary"
                onClick={handleOpenCreateServiceModal}
                icon={<Plus className="h-3.5 w-3.5" />}
              >
                Add Service
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Actionable Sync Status / Error Banner */}
      {(syncError || (!loading && !syncingCatalog && services.length === 0)) && (
        <div
          role="alert"
          className={`rounded-lg border px-4 py-3 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
            syncError
              ? 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200'
              : 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200'
          }`}
        >
          <div className="space-y-0.5">
            <div className="font-semibold">
              {syncError ? 'Services Catalog Sync / Load Issue' : 'Services Catalog is Empty'}
            </div>
            <div>
              {syncError ||
                (canSyncCatalog
                  ? 'Click "Sync / Seed 675 Services" to populate all 21 categories, 77 subcategories, and 675 services.'
                  : 'No services have been synced yet. Sign in as Admin/Manager to run the initial 675-service catalog sync.')}
            </div>
          </div>
          {canSyncCatalog && (
            <Button
              type="button"
              size="sm"
              variant="primary"
              loading={syncingCatalog}
              onClick={() => void handleSyncCatalog675(tombstones.hasAny)}
              icon={<Database className="h-3.5 w-3.5" />}
            >
              {syncingCatalog
                ? 'Syncing 675 Services...'
                : tombstones.hasAny
                ? 'Restore & Sync 675 Services'
                : 'Sync / Retry 675 Services'}
            </Button>
          )}
        </div>
      )}

      {/* Category & Subcategory Navigation Bar */}
      <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">
            Category Navigation ({categories.length} Categories)
          </span>
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            {selectedCategoryObj && canManageServices && (
              <span className="inline-flex items-center gap-1 bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 rounded">
                <span className="font-mono text-[11px]">{selectedCategoryObj.code}</span>
                <button
                  type="button"
                  onClick={() => {
                    setEditingCat(selectedCategoryObj);
                    setCatError(null);
                    setCatForm({
                      name: selectedCategoryObj.name,
                      description: selectedCategoryObj.description,
                    });
                    setNewCatOpen(true);
                  }}
                  className="p-0.5 text-neutral-600 hover:text-neutral-950 dark:text-neutral-300 dark:hover:text-white cursor-pointer"
                  title={`Edit category ${selectedCategoryObj.name}`}
                >
                  <Edit3 className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setDeleteTaxonTarget({
                      type: 'category',
                      id: selectedCategoryObj.id,
                      code: selectedCategoryObj.code,
                      name: selectedCategoryObj.name,
                    })
                  }
                  className="p-0.5 text-neutral-500 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                  title={`Delete category ${selectedCategoryObj.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            )}
            <span>
              Showing {filteredServices.length} of {services.length} Service(s)
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <button
            type="button"
            onClick={() => {
              setSelectedCategoryFilter('ALL');
              setSelectedSubcategoryFilter('ALL');
              setCurrentPage(1);
            }}
            className={`px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer ${
              selectedCategoryFilter === 'ALL'
                ? 'bg-neutral-950 text-white dark:bg-white dark:text-neutral-950'
                : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200'
            }`}
          >
            All Categories ({services.length})
          </button>
          {categories.map((cat) => {
            const count = categoryCountMap.get(cat.id) || 0;
            const isSelected = String(selectedCategoryFilter) === String(cat.id);
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => {
                  setSelectedCategoryFilter(String(cat.id));
                  setSelectedSubcategoryFilter('ALL');
                  setCurrentPage(1);
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer ${
                  isSelected
                    ? 'bg-neutral-950 text-white dark:bg-white dark:text-neutral-950'
                    : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200'
                }`}
              >
                <span>{cat.name}</span>
                <span className="text-[10px] opacity-75 font-mono">({count})</span>
              </button>
            );
          })}
        </div>

        {/* Subcategory Filter Row when a Category is selected */}
        {activeFilterSubcategories.length > 0 && (
          <div className="pt-2 border-t border-neutral-100 dark:border-neutral-800">
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[11px] font-medium text-neutral-500">
                Subcategories ({activeFilterSubcategories.length})
              </div>
              {selectedSubcategoryObj && canManageServices && (
                <span className="inline-flex items-center gap-1 bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 rounded text-xs">
                  <span className="font-mono text-[11px]">{selectedSubcategoryObj.code}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingSub(selectedSubcategoryObj);
                      setSubError(null);
                      setSubForm({
                        categoryId: selectedSubcategoryObj.categoryId,
                        name: selectedSubcategoryObj.name,
                        description: selectedSubcategoryObj.description,
                      });
                      setNewSubOpen(true);
                    }}
                    className="p-0.5 text-neutral-600 hover:text-neutral-950 dark:text-neutral-300 dark:hover:text-white cursor-pointer"
                    title={`Edit subcategory ${selectedSubcategoryObj.name}`}
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setDeleteTaxonTarget({
                        type: 'subcategory',
                        id: selectedSubcategoryObj.id,
                        code: selectedSubcategoryObj.code,
                        name: selectedSubcategoryObj.name,
                      })
                    }
                    className="p-0.5 text-neutral-500 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                    title={`Delete subcategory ${selectedSubcategoryObj.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <button
                type="button"
                onClick={() => {
                  setSelectedSubcategoryFilter('ALL');
                  setCurrentPage(1);
                }}
                className={`px-2.5 py-1 rounded-md font-medium transition-colors cursor-pointer ${
                  selectedSubcategoryFilter === 'ALL'
                    ? 'bg-neutral-800 text-white dark:bg-neutral-200 dark:text-neutral-950'
                    : 'bg-neutral-100 dark:bg-neutral-800/70 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200'
                }`}
              >
                All Subcategories
              </button>
              {activeFilterSubcategories.map((sub) => {
                const subCount = subcategoryCountMap.get(sub.id) || 0;
                const isSubSel = String(selectedSubcategoryFilter) === String(sub.id);
                return (
                  <button
                    key={sub.id}
                    type="button"
                    onClick={() => {
                      setSelectedSubcategoryFilter(String(sub.id));
                      setCurrentPage(1);
                    }}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md font-medium transition-colors cursor-pointer ${
                      isSubSel
                        ? 'bg-neutral-800 text-white dark:bg-neutral-200 dark:text-neutral-950'
                        : 'bg-neutral-100 dark:bg-neutral-800/70 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200'
                    }`}
                  >
                    <span>{sub.name}</span>
                    <span className="text-[10px] opacity-75 font-mono">({subCount})</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Search & Filters Bar */}
      <div className="flex flex-col md:flex-row items-center justify-between gap-3 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-3">
        <div className="relative w-full md:w-96">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-neutral-400" />
          <input
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setCurrentPage(1);
            }}
            placeholder="Search S.No, service name, MC2627SRV code, MCS ID, category..."
            className="w-full h-9 pl-9 pr-3 text-xs bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-md focus:outline-none focus:ring-1 focus:ring-neutral-950"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
          <div className="flex items-center gap-1.5 text-xs text-neutral-500">
            <Filter className="h-3.5 w-3.5" />
            <span>Filters:</span>
          </div>
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as typeof statusFilter);
              setCurrentPage(1);
            }}
            className="h-9 px-3 text-xs bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-md"
          >
            <option value="ALL">All Statuses</option>
            <option value="Active">Active Only</option>
            <option value="Inactive">Inactive Only</option>
            <option value="Temporarily Suspended">Temporarily Suspended</option>
            <option value="Archived">Archived Only</option>
          </select>
          <select
            value={rateFilter}
            onChange={(e) => {
              setRateFilter(e.target.value as 'ALL' | 'CONFIGURED' | 'BLANK');
              setCurrentPage(1);
            }}
            className="h-9 px-3 text-xs bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-md"
          >
            <option value="ALL">All Rates</option>
            <option value="CONFIGURED">Configured (Charge &gt; 0)</option>
            <option value="BLANK">Blank / Unconfigured (₹0)</option>
          </select>
        </div>
      </div>

      {/* Main Grid: Service List (Left) & Configuration / Form Builder (Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Service List (5 Cols) */}
        <div className="lg:col-span-5 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
            <span className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">
              Services Catalog ({filteredServices.length})
            </span>
            <span className="text-[11px] font-mono text-neutral-500">
              Page {safePage} of {totalPages}
            </span>
          </div>

          <div className="divide-y divide-neutral-100 dark:divide-neutral-800 max-h-[680px] overflow-y-auto">
            {loading ? (
              <div className="p-6 text-xs text-neutral-500 text-center">
                Loading 675 services catalog...
              </div>
            ) : paginatedServices.length === 0 ? (
              <div className="p-6 text-xs text-neutral-500 text-center space-y-3">
                <p>No services found matching filters.</p>
                {services.length === 0 && canSyncCatalog && (
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    loading={syncingCatalog}
                    onClick={() => void handleSyncCatalog675(tombstones.hasAny)}
                    icon={<Database className="h-3.5 w-3.5" />}
                  >
                    {tombstones.hasAny ? 'Restore Deleted & Seed Catalog' : 'Sync / Seed 675 Services'}
                  </Button>
                )}
              </div>
            ) : (
              paginatedServices.map((svc) => {
                const isSelected = selectedService?.serviceId === svc.serviceId;
                const totalFee = svc.totalCustomerCharge ?? svc.customerCharge ?? 0;
                return (
                  <div
                    key={svc.serviceId}
                    onClick={() => selectService(svc)}
                    className={`p-4 cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-neutral-50 dark:bg-neutral-800/60 border-l-2 border-neutral-950 dark:border-white'
                        : 'hover:bg-neutral-50/70 dark:hover:bg-neutral-800/30'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-neutral-500">
                          <span className="px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200 font-semibold">
                            #{svc.serialNumber || String(svc.displayOrder ?? svc.id).padStart(3, '0')}
                          </span>
                          <span className="truncate">
                            {svc.serviceCode} · {svc.categoryName}
                            {svc.subcategoryName ? ` › ${svc.subcategoryName}` : ''}
                          </span>
                        </div>
                        <div className="font-semibold text-sm text-neutral-950 dark:text-white mt-1">
                          {svc.name}
                        </div>
                      </div>
                      <div className="text-right shrink-0 flex items-center gap-1.5">
                        <div>
                          <div className="font-mono text-xs font-semibold text-neutral-950 dark:text-white">
                            {formatCurrency(totalFee)}
                          </div>
                          <div className="font-mono text-[10px] text-emerald-700 dark:text-emerald-400">
                            Prof: {formatCurrency(svc.profitAmount)}
                          </div>
                        </div>
                        {canManageServices && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              promptDeleteService(svc);
                            }}
                            className="p-1.5 text-neutral-400 hover:text-red-600 dark:hover:text-red-400 rounded transition-colors cursor-pointer"
                            title={`Delete service ${svc.serviceCode || svc.serviceId}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-500">
                      <span>
                        <span
                          className={`inline-block mr-1.5 font-mono px-1.5 py-0.5 rounded text-[10px] ${
                            svc.status === 'Active'
                              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                              : 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300'
                          }`}
                        >
                          {svc.status}
                        </span>
                        Form v{svc.currentFormVersion} · {svc.requiredDocuments.length} docs · SLA{' '}
                        {svc.sla?.expectedDays ?? 3}d
                      </span>
                      {svc.status === 'Active' && svc.availability === 'Available' && (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenApplyWorkflow(svc);
                          }}
                        >
                          Apply Service
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Pagination Footer */}
          {totalPages > 1 && (
            <div className="px-4 py-3 border-t border-neutral-200 dark:border-neutral-800 flex items-center justify-between text-xs">
              <Button
                size="sm"
                variant="outline"
                disabled={safePage === 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <span className="font-mono text-neutral-500">
                {safePage} / {totalPages}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={safePage === totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          )}
        </div>

        {/* Selected Service Configuration & Form Builder (7 Cols) */}
        <div className="lg:col-span-7 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-5 space-y-4">
          {!selectedService ? (
            <div className="text-xs text-neutral-500 text-center py-12">
              Select a service from the left catalog to inspect or configure its dynamic form,
              required documents, SLA, automation rules, details, and pricing.
            </div>
          ) : (
            <>
              {/* Header summary */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 dark:border-neutral-800 pb-3">
                <div>
                  <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs text-neutral-500">
                    <span className="px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-semibold">
                      S.No {selectedService.serialNumber || String(selectedService.displayOrder ?? selectedService.id).padStart(3, '0')}
                    </span>
                    <span>
                      {selectedService.serviceCode} · {selectedService.serviceId} ·{' '}
                      {selectedService.categoryName}
                      {selectedService.subcategoryName
                        ? ` › ${selectedService.subcategoryName}`
                        : ''}
                    </span>
                  </div>
                  <h3 className="text-base font-bold text-neutral-950 dark:text-white mt-1">
                    {selectedService.name}
                  </h3>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {canManageServices && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        loading={togglingStatus}
                        onClick={() => handleToggleServiceStatus(selectedService)}
                        icon={<Power className="h-3.5 w-3.5" />}
                      >
                        {selectedService.status === 'Active' ? 'Deactivate' : 'Activate'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => promptDeleteService(selectedService)}
                        className="text-red-600 border-red-200 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950/40"
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => handleOpenApplyWorkflow(selectedService)}
                  >
                    Apply Service Workflow
                  </Button>
                </div>
              </div>

              {/* Sub-tabs */}
              <div className="flex flex-wrap gap-1.5 text-xs">
                {(
                  [
                    ['form', 'Dynamic Form Builder', FileText],
                    ['docs', 'Required Documents', Layers],
                    ['sla', 'SLA & Processing', Settings2],
                    ['automation', 'Automation Rules', Zap],
                    ['pricing', 'Details, Pricing & Status', Edit3],
                  ] as const
                ).map(([key, label, IconComp]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setActiveSubTab(key)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border cursor-pointer ${
                      activeSubTab === key
                        ? 'bg-neutral-950 text-white border-neutral-950 dark:bg-white dark:text-neutral-950 font-medium'
                        : 'border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800'
                    }`}
                  >
                    <IconComp className="h-3.5 w-3.5" />
                    <span>{label}</span>
                  </button>
                ))}
              </div>

              {/* Tab 1: Dynamic Form Builder & Form Fields */}
              {activeSubTab === 'form' && (
                <div className="space-y-4 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2 bg-neutral-50 dark:bg-neutral-950 p-3 rounded border border-neutral-200 dark:border-neutral-800">
                    <div>
                      <span className="font-semibold">
                        Published Version: v{selectedService.currentFormVersion}
                      </span>
                      <p className="text-neutral-500 text-[11px] mt-0.5">
                        {draftFields.length} field(s) in draft. Publishing creates v
                        {selectedService.currentFormVersion + 1} while preserving existing
                        applications.
                      </p>
                    </div>
                    {canManageServices && (
                      <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        loading={publishingForm}
                        onClick={handlePublishFormVersion}
                        icon={<Check className="h-3.5 w-3.5" />}
                      >
                        Publish Form v{selectedService.currentFormVersion + 1}
                      </Button>
                    )}
                  </div>

                  <div className="divide-y divide-neutral-100 dark:divide-neutral-800 border border-neutral-200 dark:border-neutral-800 rounded overflow-hidden">
                    {draftFields.length === 0 ? (
                      <div className="p-4 text-neutral-500 text-center">
                        No dynamic form fields configured yet.
                      </div>
                    ) : (
                      draftFields.map((f, idx) => (
                        <div
                          key={`${f.fieldKey}-${idx}`}
                          className="p-3 flex items-center justify-between gap-2 bg-white dark:bg-neutral-900"
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-neutral-400">#{idx + 1}</span>
                              <span
                                className={`font-semibold ${
                                  f.enabled === false
                                    ? 'line-through text-neutral-400'
                                    : 'text-neutral-950 dark:text-white'
                                }`}
                              >
                                {f.label}
                              </span>
                              {f.required && (
                                <span className="text-[10px] bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200 px-1.5 py-0.5 rounded font-mono">
                                  Required
                                </span>
                              )}
                              {f.enabled === false && (
                                <span className="text-[10px] bg-neutral-200 text-neutral-600 px-1.5 py-0.5 rounded font-mono">
                                  Disabled
                                </span>
                              )}
                            </div>
                            <div className="font-mono text-[11px] text-neutral-500 mt-0.5">
                              Key: {f.fieldKey} · Type: {f.fieldType}
                            </div>
                            {f.options && f.options.length > 0 && (
                              <div className="text-[11px] text-neutral-500 mt-1">
                                Options: {f.options.join(', ')}
                              </div>
                            )}
                          </div>
                          {canManageServices && (
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() =>
                                  setDraftFields((prev) =>
                                    prev.map((item, i) =>
                                      i === idx ? { ...item, required: !item.required } : item
                                    )
                                  )
                                }
                                className="px-2 py-1 text-[10px] border rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
                                title="Toggle Mandatory"
                              >
                                {f.required ? 'Req' : 'Opt'}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleMoveDraftField(idx, -1)}
                                disabled={idx === 0}
                                className="p-1 text-neutral-500 hover:text-neutral-900 disabled:opacity-30 cursor-pointer"
                                title="Move Up"
                              >
                                <ArrowUp className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleMoveDraftField(idx, 1)}
                                disabled={idx === draftFields.length - 1}
                                className="p-1 text-neutral-500 hover:text-neutral-900 disabled:opacity-30 cursor-pointer"
                                title="Move Down"
                              >
                                <ArrowDown className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingFieldIdx(idx);
                                  setNewField({
                                    label: f.label,
                                    fieldKey: f.fieldKey,
                                    fieldType: f.fieldType,
                                    required: f.required,
                                    optionsCsv: f.options?.join(', ') || '',
                                  });
                                }}
                                className="p-1 text-neutral-500 hover:text-neutral-900 cursor-pointer"
                                title="Edit Field"
                              >
                                <Edit3 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setDraftFields((prev) => prev.filter((_, i) => i !== idx))
                                }
                                className="text-red-600 hover:text-red-800 p-1 cursor-pointer"
                                title="Remove Field"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>

                  {canManageServices && (
                    <div className="bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded p-3 space-y-3">
                      <div className="font-semibold text-neutral-950 dark:text-white">
                        {editingFieldIdx !== null
                          ? `Edit Dynamic Form Field #${editingFieldIdx + 1}`
                          : 'Add Dynamic Form Field'}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                        <input
                          value={newField.label}
                          onChange={(e) => setNewField({ ...newField, label: e.target.value })}
                          placeholder="Field Label *"
                          className="h-8 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                        />
                        <input
                          value={newField.fieldKey}
                          onChange={(e) => setNewField({ ...newField, fieldKey: e.target.value })}
                          placeholder="field_key (auto)"
                          className="h-8 px-2 border rounded font-mono bg-white dark:bg-neutral-900 text-xs"
                        />
                        <select
                          value={newField.fieldType}
                          onChange={(e) =>
                            setNewField({
                              ...newField,
                              fieldType: e.target.value as DynamicFieldType,
                            })
                          }
                          className="h-8 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                        >
                          {ALL_FIELD_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                        <label className="flex items-center gap-1.5 px-1">
                          <input
                            type="checkbox"
                            checked={newField.required}
                            onChange={(e) =>
                              setNewField({ ...newField, required: e.target.checked })
                            }
                          />
                          Mandatory / Required
                        </label>
                      </div>
                      {['dropdown', 'radio', 'multi_select'].includes(newField.fieldType) && (
                        <input
                          value={newField.optionsCsv}
                          onChange={(e) =>
                            setNewField({ ...newField, optionsCsv: e.target.value })
                          }
                          placeholder="Comma-separated options (e.g., Option A, Option B, Option C)"
                          className="w-full h-8 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                        />
                      )}
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={handleAddOrUpdateDraftField}
                          icon={<Plus className="h-3 w-3" />}
                        >
                          {editingFieldIdx !== null ? 'Update Field in Draft' : 'Append Field to Draft'}
                        </Button>
                        {editingFieldIdx !== null && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setEditingFieldIdx(null);
                              setNewField({
                                label: '',
                                fieldKey: '',
                                fieldType: 'short_text',
                                required: true,
                                optionsCsv: '',
                              });
                            }}
                          >
                            Cancel Edit
                          </Button>
                        )}
                      </div>
                    </div>
                  )}

                  {selectedService.formVersions.length > 0 && (
                    <div className="border border-neutral-200 dark:border-neutral-800 rounded p-3 space-y-2">
                      <div className="flex items-center gap-1.5 font-semibold text-neutral-700 dark:text-neutral-300">
                        <History className="h-3.5 w-3.5" />
                        <span>Form Version History ({selectedService.formVersions.length})</span>
                      </div>
                      <div className="space-y-1 text-[11px] text-neutral-500">
                        {[...selectedService.formVersions].reverse().map((v) => (
                          <div
                            key={v.versionNo}
                            className="flex items-center justify-between py-1 border-b last:border-b-0 border-neutral-100 dark:border-neutral-800"
                          >
                            <span className="font-mono">
                              v{v.versionNo} ({v.fields.length} fields)
                            </span>
                            <span>
                              Published by {v.publishedBy} · {v.publishedAt.slice(0, 10)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Tab 2: Required Documents (Full CRUD + Save) */}
              {activeSubTab === 'docs' && (
                <div className="space-y-4 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2 bg-neutral-50 dark:bg-neutral-950 p-3 rounded border border-neutral-200 dark:border-neutral-800">
                    <div>
                      <span className="font-semibold">
                        Required &amp; Optional Documents Checklist ({draftDocs.length})
                      </span>
                      <p className="text-[11px] text-neutral-500 mt-0.5">
                        Configure mandatory document checklists, allowed MIME formats, and max file
                        size per service.
                      </p>
                    </div>
                    {canManageServices && (
                      <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        loading={savingDocs}
                        onClick={handleSaveRequiredDocuments}
                        icon={<Check className="h-3.5 w-3.5" />}
                      >
                        Save Required Documents
                      </Button>
                    )}
                  </div>

                  <div className="divide-y divide-neutral-100 dark:divide-neutral-800 border border-neutral-200 dark:border-neutral-800 rounded overflow-hidden">
                    {draftDocs.length === 0 ? (
                      <div className="p-4 text-neutral-500 text-center">
                        No required documents configured.
                      </div>
                    ) : (
                      draftDocs.map((d, i) => (
                        <div
                          key={`${d.docKey}-${i}`}
                          className="p-3 flex items-center justify-between gap-2 bg-white dark:bg-neutral-900"
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className={`font-semibold ${
                                  d.enabled === false
                                    ? 'line-through text-neutral-400'
                                    : 'text-neutral-950 dark:text-white'
                                }`}
                              >
                                {d.label}
                              </span>
                              <span
                                className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${
                                  d.required
                                    ? 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200'
                                    : 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300'
                                }`}
                              >
                                {d.required ? 'Mandatory' : 'Optional'}
                              </span>
                            </div>
                            <div className="text-neutral-500 text-[11px] mt-0.5">
                              {d.category || 'Identity / Support'} · Formats:{' '}
                              {(d.allowedFormats || ['PDF', 'JPG']).join(', ')} · Max{' '}
                              {d.maxSizeMb ?? 10} MB
                            </div>
                            {d.instructions && (
                              <div className="text-[11px] text-neutral-400 mt-0.5 truncate">
                                {d.instructions}
                              </div>
                            )}
                          </div>
                          {canManageServices && (
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={() =>
                                  setDraftDocs((prev) =>
                                    prev.map((item, idx) =>
                                      idx === i ? { ...item, required: !item.required } : item
                                    )
                                  )
                                }
                                className="px-2 py-1 text-[10px] border rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
                              >
                                {d.required ? 'Req' : 'Opt'}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingDocIdx(i);
                                  setNewDocForm({
                                    label: d.label,
                                    category: d.category || 'Identity / Support',
                                    required: d.required,
                                    allowMultiple: Boolean(d.allowMultiple),
                                    allowedFormats:
                                      d.allowedFormats?.length > 0
                                        ? [...d.allowedFormats]
                                        : ['PDF', 'JPG'],
                                    maxSizeMb: d.maxSizeMb || 10,
                                    instructions: d.instructions || '',
                                  });
                                }}
                                className="p-1 text-neutral-500 hover:text-neutral-900 cursor-pointer"
                                title="Edit Document Requirement"
                              >
                                <Edit3 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setDraftDocs((prev) => prev.filter((_, idx) => idx !== i))
                                }
                                className="p-1 text-red-600 hover:text-red-800 cursor-pointer"
                                title="Remove Document Requirement"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>

                  {canManageServices && (
                    <div className="bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded p-3 space-y-3">
                      <div className="font-semibold text-neutral-950 dark:text-white">
                        {editingDocIdx !== null
                          ? `Edit Required Document #${editingDocIdx + 1}`
                          : 'Add Required Document'}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <input
                          value={newDocForm.label}
                          onChange={(e) =>
                            setNewDocForm({ ...newDocForm, label: e.target.value })
                          }
                          placeholder="Document Name (e.g. Aadhaar Card) *"
                          className="h-8 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                        />
                        <input
                          value={newDocForm.category}
                          onChange={(e) =>
                            setNewDocForm({ ...newDocForm, category: e.target.value })
                          }
                          placeholder="Category (e.g. Identity Proof)"
                          className="h-8 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                        />
                        <div className="flex items-center gap-2">
                          <label className="text-[11px] text-neutral-500 shrink-0">Max MB:</label>
                          <input
                            type="number"
                            min={1}
                            max={25}
                            value={newDocForm.maxSizeMb}
                            onChange={(e) =>
                              setNewDocForm({
                                ...newDocForm,
                                maxSizeMb: Number(e.target.value),
                              })
                            }
                            className="h-8 w-16 px-2 border rounded font-mono bg-white dark:bg-neutral-900 text-xs"
                          />
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-4">
                        <label className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={newDocForm.required}
                            onChange={(e) =>
                              setNewDocForm({ ...newDocForm, required: e.target.checked })
                            }
                          />
                          Mandatory Document
                        </label>
                        <label className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={newDocForm.allowMultiple}
                            onChange={(e) =>
                              setNewDocForm({ ...newDocForm, allowMultiple: e.target.checked })
                            }
                          />
                          Allow Multiple Files
                        </label>
                        <div className="flex items-center gap-2">
                          <span className="text-neutral-500">Formats:</span>
                          {DOC_FORMATS.map((fmt) => (
                            <label key={fmt} className="flex items-center gap-1 font-mono text-[11px]">
                              <input
                                type="checkbox"
                                checked={newDocForm.allowedFormats.includes(fmt)}
                                onChange={(e) => {
                                  const next = e.target.checked
                                    ? [...newDocForm.allowedFormats, fmt]
                                    : newDocForm.allowedFormats.filter((x) => x !== fmt);
                                  setNewDocForm({ ...newDocForm, allowedFormats: next });
                                }}
                              />
                              {fmt}
                            </label>
                          ))}
                        </div>
                      </div>
                      <input
                        value={newDocForm.instructions}
                        onChange={(e) =>
                          setNewDocForm({ ...newDocForm, instructions: e.target.value })
                        }
                        placeholder="Document upload instructions..."
                        className="w-full h-8 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={handleAddOrUpdateDraftDoc}
                          icon={<Plus className="h-3 w-3" />}
                        >
                          {editingDocIdx !== null ? 'Update Document' : 'Add Document Requirement'}
                        </Button>
                        {editingDocIdx !== null && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setEditingDocIdx(null);
                              setNewDocForm({
                                label: '',
                                category: 'Identity / Support',
                                required: true,
                                allowMultiple: false,
                                allowedFormats: ['PDF', 'JPG', 'JPEG', 'PNG'],
                                maxSizeMb: 10,
                                instructions: 'Upload valid clear copy.',
                              });
                            }}
                          >
                            Cancel
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Tab 3: SLA Timeline & Processing Time */}
              {activeSubTab === 'sla' && (
                <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 text-xs space-y-4 bg-neutral-50 dark:bg-neutral-950">
                  <div className="font-semibold text-neutral-950 dark:text-white">
                    SLA Timeline &amp; Processing Time Configuration
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div>
                      <label className="block font-medium mb-1">Processing Mode</label>
                      <select
                        disabled={!canManageServices}
                        value={editSlaMode}
                        onChange={(e) => setEditSlaMode(e.target.value as 'FIXED' | 'RANGE')}
                        className="w-full h-9 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                      >
                        <option value="FIXED">FIXED</option>
                        <option value="RANGE">RANGE</option>
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium mb-1">Expected Days</label>
                      <input
                        disabled={!canManageServices}
                        type="number"
                        min={1}
                        value={editSlaExpected}
                        onChange={(e) => setEditSlaExpected(Number(e.target.value))}
                        className="w-full h-9 px-2 border rounded font-mono bg-white dark:bg-neutral-900 text-xs"
                      />
                    </div>
                    <div>
                      <label className="block font-medium mb-1">Min / Max Days</label>
                      <div className="flex gap-1">
                        <input
                          disabled={!canManageServices}
                          type="number"
                          min={1}
                          value={editSlaMin}
                          onChange={(e) => setEditSlaMin(Number(e.target.value))}
                          className="w-1/2 h-9 px-2 border rounded font-mono bg-white dark:bg-neutral-900 text-xs"
                        />
                        <input
                          disabled={!canManageServices}
                          type="number"
                          min={1}
                          value={editSlaMax}
                          onChange={(e) => setEditSlaMax(Number(e.target.value))}
                          className="w-1/2 h-9 px-2 border rounded font-mono bg-white dark:bg-neutral-900 text-xs"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block font-medium mb-1">Day Type</label>
                      <select
                        disabled={!canManageServices}
                        value={editSlaDayType}
                        onChange={(e) => setEditSlaDayType(e.target.value as 'WORKING' | 'CALENDAR')}
                        className="w-full h-9 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                      >
                        <option value="WORKING">WORKING</option>
                        <option value="CALENDAR">CALENDAR</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block font-medium mb-1">SLA Start Event</label>
                      <select
                        disabled={!canManageServices}
                        value={editSlaStartEvent}
                        onChange={(e) =>
                          setEditSlaStartEvent(e.target.value as 'ON_SUBMIT' | 'ON_ASSIGN')
                        }
                        className="w-full h-9 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                      >
                        <option value="ON_SUBMIT">ON_SUBMIT</option>
                        <option value="ON_ASSIGN">ON_ASSIGN</option>
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium mb-1">Warning Threshold (%)</label>
                      <input
                        disabled={!canManageServices}
                        type="number"
                        min={10}
                        max={99}
                        value={editSlaWarningPct}
                        onChange={(e) => setEditSlaWarningPct(Number(e.target.value))}
                        className="w-full h-9 px-2 border rounded font-mono bg-white dark:bg-neutral-900 text-xs"
                      />
                    </div>
                    <div>
                      <label className="block font-medium mb-1">Breach Threshold (Hours)</label>
                      <input
                        disabled={!canManageServices}
                        type="number"
                        min={1}
                        value={editSlaBreachHours}
                        onChange={(e) => setEditSlaBreachHours(Number(e.target.value))}
                        className="w-full h-9 px-2 border rounded font-mono bg-white dark:bg-neutral-900 text-xs"
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-4">
                    <label className="flex items-center gap-1.5">
                      <input
                        disabled={!canManageServices}
                        type="checkbox"
                        checked={editSlaExcludeHolidays}
                        onChange={(e) => setEditSlaExcludeHolidays(e.target.checked)}
                      />
                      Exclude Official Holidays
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input
                        disabled={!canManageServices}
                        type="checkbox"
                        checked={editSlaEscWarning}
                        onChange={(e) => setEditSlaEscWarning(e.target.checked)}
                      />
                      Escalate to Manager on Warning
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input
                        disabled={!canManageServices}
                        type="checkbox"
                        checked={editSlaEscBreach}
                        onChange={(e) => setEditSlaEscBreach(e.target.checked)}
                      />
                      Escalate to Admin on Breach
                    </label>
                  </div>

                  <div>
                    <span className="block font-medium mb-1.5">Auto-Pause SLA On Statuses:</span>
                    <div className="flex flex-wrap gap-3">
                      {PAUSE_STATUS_OPTIONS.map((st) => (
                        <label key={st} className="flex items-center gap-1.5">
                          <input
                            disabled={!canManageServices}
                            type="checkbox"
                            checked={editSlaPauseStatuses.includes(st)}
                            onChange={(e) => {
                              setEditSlaPauseStatuses((prev) =>
                                e.target.checked ? [...prev, st] : prev.filter((x) => x !== st)
                              );
                            }}
                          />
                          <span>{st}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {canManageServices && (
                    <Button
                      type="button"
                      size="sm"
                      variant="primary"
                      loading={savingSla}
                      onClick={handleSaveSla}
                    >
                      Save SLA Configuration
                    </Button>
                  )}

                  {selectedService.processingTimeHistory &&
                    selectedService.processingTimeHistory.length > 0 && (
                      <div className="border-t border-neutral-200 dark:border-neutral-800 pt-3 space-y-1.5">
                        <div className="font-semibold text-neutral-700 dark:text-neutral-300">
                          Processing Time Change Log ({selectedService.processingTimeHistory.length})
                        </div>
                        <div className="space-y-1 text-[11px] text-neutral-500 max-h-32 overflow-y-auto">
                          {selectedService.processingTimeHistory.map((h, i) => (
                            <div key={i} className="font-mono">
                              {h.previousSummary} → {h.newSummary} ({h.changedBy} ·{' '}
                              {h.changedAt.slice(0, 10)})
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                </div>
              )}

              {/* Tab 4: Automation Rules (Full CRUD + Save) */}
              {activeSubTab === 'automation' && (
                <div className="space-y-4 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2 bg-neutral-50 dark:bg-neutral-950 p-3 rounded border border-neutral-200 dark:border-neutral-800">
                    <div>
                      <span className="font-semibold">
                        Service Automation Rules ({draftRules.length})
                      </span>
                      <p className="text-[11px] text-neutral-500 mt-0.5">
                        Configure event-driven triggers, status conditions, and counter/follow-up
                        actions.
                      </p>
                    </div>
                    {canManageServices && (
                      <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        loading={savingAutomation}
                        onClick={handleSaveAutomationRules}
                        icon={<Check className="h-3.5 w-3.5" />}
                      >
                        Save Automation Rules
                      </Button>
                    )}
                  </div>

                  {draftRules.length === 0 ? (
                    <p className="text-neutral-500 p-4 border rounded border-dashed text-center">
                      No service automation rules configured.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {draftRules.map((r, idx) => (
                        <div
                          key={r.id}
                          className="border border-neutral-200 dark:border-neutral-800 rounded p-3 flex flex-wrap items-center justify-between gap-2 bg-white dark:bg-neutral-900"
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span
                                className={`font-semibold ${
                                  r.enabled ? '' : 'line-through text-neutral-400'
                                }`}
                              >
                                {r.name}
                              </span>
                              <span
                                className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${
                                  r.enabled
                                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                                    : 'bg-neutral-200 text-neutral-600'
                                }`}
                              >
                                {r.enabled ? 'Enabled' : 'Disabled'}
                              </span>
                            </div>
                            <div className="text-neutral-500 font-mono text-[11px] mt-0.5">
                              Trigger: {r.trigger} (If: {r.conditionStatus || 'ANY'}) → Action:{' '}
                              {r.actionType} ({r.actionParam})
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[11px] text-neutral-500">
                              Runs: {r.executionCount}
                            </span>
                            {canManageServices && (
                              <>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setDraftRules((prev) =>
                                      prev.map((item, i) =>
                                        i === idx ? { ...item, enabled: !item.enabled } : item
                                      )
                                    )
                                  }
                                  className="px-2 py-1 text-[10px] border rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
                                >
                                  {r.enabled ? 'Disable' : 'Enable'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setDraftRules((prev) => prev.filter((_, i) => i !== idx))
                                  }
                                  className="p-1 text-red-600 hover:text-red-800 cursor-pointer"
                                  title="Delete Rule"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {canManageServices && (
                    <div className="bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded p-3 space-y-3">
                      <div className="font-semibold text-neutral-950 dark:text-white">
                        Add Automation Rule
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <input
                          value={newRuleForm.name}
                          onChange={(e) =>
                            setNewRuleForm({ ...newRuleForm, name: e.target.value })
                          }
                          placeholder="Rule Name (e.g. Auto Follow-up After 2 Days) *"
                          className="h-8 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                        />
                        <input
                          value={newRuleForm.actionParam}
                          onChange={(e) =>
                            setNewRuleForm({ ...newRuleForm, actionParam: e.target.value })
                          }
                          placeholder="Action Parameter (e.g. CTR-01 or days: 2)"
                          className="h-8 px-2 border rounded font-mono bg-white dark:bg-neutral-900 text-xs"
                        />
                        <select
                          value={newRuleForm.trigger}
                          onChange={(e) =>
                            setNewRuleForm({
                              ...newRuleForm,
                              trigger: e.target.value as ServiceAutomationRule['trigger'],
                            })
                          }
                          className="h-8 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                        >
                          {AUTOMATION_TRIGGERS.map((tr) => (
                            <option key={tr.value} value={tr.value}>
                              Trigger: {tr.label}
                            </option>
                          ))}
                        </select>
                        <select
                          value={newRuleForm.actionType}
                          onChange={(e) =>
                            setNewRuleForm({
                              ...newRuleForm,
                              actionType: e.target.value as ServiceAutomationRule['actionType'],
                            })
                          }
                          className="h-8 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                        >
                          {AUTOMATION_ACTIONS.map((ac) => (
                            <option key={ac.value} value={ac.value}>
                              Action: {ac.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={handleAddDraftRule}
                        icon={<Plus className="h-3 w-3" />}
                      >
                        Append Automation Rule
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* Tab 5: Service Details, Pricing & Status (Inspectable by all, editable by Admin) */}
              {activeSubTab === 'pricing' && (
                <div className="space-y-4 text-xs border border-neutral-200 dark:border-neutral-800 rounded p-4 bg-neutral-50 dark:bg-neutral-950">
                  <div className="font-semibold text-neutral-950 dark:text-white">
                    Service Details, Rate Schedule, Profit Engine &amp; Status
                  </div>

                  {/* Read-only System Codes + Editable Service Name */}
                  <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                    <div>
                      <label className="block font-medium mb-1">Display S.No</label>
                      <input
                        readOnly
                        disabled
                        value={
                          selectedService.serialNumber ||
                          String(selectedService.displayOrder ?? selectedService.id).padStart(
                            3,
                            '0'
                          )
                        }
                        className="w-full h-9 px-3 border rounded font-mono bg-neutral-100 dark:bg-neutral-900 text-neutral-500 text-xs"
                      />
                    </div>
                    <div>
                      <label className="block font-medium mb-1">Service Code (Locked)</label>
                      <input
                        readOnly
                        disabled
                        value={selectedService.serviceCode}
                        className="w-full h-9 px-3 border rounded font-mono bg-neutral-100 dark:bg-neutral-900 text-neutral-500 text-xs"
                      />
                    </div>
                    <div>
                      <label className="block font-medium mb-1">System ID (Locked)</label>
                      <input
                        readOnly
                        disabled
                        value={selectedService.serviceId}
                        className="w-full h-9 px-3 border rounded font-mono bg-neutral-100 dark:bg-neutral-900 text-neutral-500 text-xs"
                      />
                    </div>
                    <div>
                      <label className="block font-medium mb-1">Service Name *</label>
                      <input
                        disabled={!canManageServices}
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-900 text-xs"
                      />
                    </div>
                  </div>

                  {/* Category & Subcategory Assignment */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block font-medium mb-1">Category</label>
                      <select
                        disabled={!canManageServices}
                        value={editCategoryId}
                        onChange={(e) => {
                          const nextCat = Number(e.target.value);
                          setEditCategoryId(nextCat);
                          const firstSub = subcategories.find((sc) => sc.categoryId === nextCat);
                          setEditSubcategoryId(firstSub?.id ?? '');
                        }}
                        className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-900 text-xs"
                      >
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium mb-1">Subcategory</label>
                      <select
                        disabled={!canManageServices}
                        value={editSubcategoryId}
                        onChange={(e) =>
                          setEditSubcategoryId(e.target.value ? Number(e.target.value) : '')
                        }
                        className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-900 text-xs"
                      >
                        <option value="">None / General</option>
                        {editFormSubcategories.map((sc) => (
                          <option key={sc.id} value={sc.id}>
                            {sc.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Full 4-component Fee & Profit Engine */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block font-medium mb-1">Service Charge (₹)</label>
                      <input
                        disabled={!canManageServices}
                        type="number"
                        min={0}
                        value={editServiceCharge}
                        onChange={(e) => setEditServiceCharge(Number(e.target.value))}
                        className="w-full h-9 px-3 border rounded font-mono bg-white dark:bg-neutral-900 text-xs"
                      />
                    </div>
                    <div>
                      <label className="block font-medium mb-1">Govt / Portal Fee (₹)</label>
                      <input
                        disabled={!canManageServices}
                        type="number"
                        min={0}
                        value={editGovtFee}
                        onChange={(e) => setEditGovtFee(Number(e.target.value))}
                        className="w-full h-9 px-3 border rounded font-mono bg-white dark:bg-neutral-900 text-xs"
                      />
                    </div>
                    <div>
                      <label className="block font-medium mb-1">Additional Charges (₹)</label>
                      <input
                        disabled={!canManageServices}
                        type="number"
                        min={0}
                        value={editAdditionalCharges}
                        onChange={(e) => setEditAdditionalCharges(Number(e.target.value))}
                        className="w-full h-9 px-3 border rounded font-mono bg-white dark:bg-neutral-900 text-xs"
                      />
                    </div>
                    <div>
                      <label className="block font-medium mb-1">Service Cost (₹)</label>
                      <input
                        disabled={!canManageServices}
                        type="number"
                        min={0}
                        value={editCost}
                        onChange={(e) => setEditCost(Number(e.target.value))}
                        className="w-full h-9 px-3 border rounded font-mono bg-white dark:bg-neutral-900 text-xs"
                      />
                    </div>
                    <div>
                      <label className="block font-medium mb-1">Total Customer Charge (₹)</label>
                      <div className="h-9 px-3 border rounded flex items-center font-mono font-bold bg-white dark:bg-neutral-900 text-neutral-950 dark:text-white">
                        {formatCurrency(calculatedEditTotalCharge)}
                      </div>
                    </div>
                    <div>
                      <label className="block font-medium mb-1">Calculated Net Profit (₹)</label>
                      <div className="h-9 px-3 border rounded flex items-center font-mono font-bold bg-emerald-50 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300">
                        {formatCurrency(calculatedEditProfit)}
                      </div>
                    </div>
                  </div>

                  {/* Description & Service Instructions */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block font-medium mb-1">Description</label>
                      <textarea
                        disabled={!canManageServices}
                        rows={2}
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        className="w-full p-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                      />
                    </div>
                    <div>
                      <label className="block font-medium mb-1">
                        Service Instructions / Terms
                      </label>
                      <textarea
                        disabled={!canManageServices}
                        rows={2}
                        value={editInstructions}
                        onChange={(e) => setEditInstructions(e.target.value)}
                        className="w-full p-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                      />
                    </div>
                  </div>

                  {/* Status & Availability */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block font-medium mb-1">Service Status</label>
                      <select
                        disabled={!canManageServices}
                        value={editStatus}
                        onChange={(e) =>
                          setEditStatus(e.target.value as ErpServiceItem['status'])
                        }
                        className="h-9 px-3 border rounded bg-white dark:bg-neutral-900 text-xs w-full"
                      >
                        <option value="Active">Active</option>
                        <option value="Inactive">Inactive</option>
                        <option value="Temporarily Suspended">Temporarily Suspended</option>
                        <option value="Archived">Archived</option>
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium mb-1">Counter Availability</label>
                      <select
                        disabled={!canManageServices}
                        value={editAvailability}
                        onChange={(e) =>
                          setEditAvailability(e.target.value as ErpServiceItem['availability'])
                        }
                        className="h-9 px-3 border rounded bg-white dark:bg-neutral-900 text-xs w-full"
                      >
                        <option value="Available">Available</option>
                        <option value="Unavailable">Unavailable</option>
                      </select>
                    </div>
                  </div>

                  {canManageServices && (
                    <Button
                      type="button"
                      size="sm"
                      variant="primary"
                      loading={savingPricing}
                      onClick={handleSaveDetailsPricingAndStatus}
                    >
                      Save Service Details, Pricing &amp; Status
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Apply Service Workflow Modal */}
      <Modal
        isOpen={applyModalOpen}
        onClose={() => setApplyModalOpen(false)}
        title={`Apply Service: ${applyingService?.name ?? ''}`}
      >
        <form onSubmit={handleExecuteApplyService} className="space-y-4 text-xs" noValidate>
          {applyError && (
            <div
              role="alert"
              className="px-3 py-2 rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300"
            >
              {applyError}
            </div>
          )}
          <div className="bg-neutral-50 dark:bg-neutral-950 p-3 rounded border border-neutral-200 dark:border-neutral-800">
            <div className="font-semibold text-neutral-950 dark:text-white">
              Customer Information
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
              <div>
                <label className="block font-medium mb-1">Customer Full Name *</label>
                <input
                  required
                  value={applyCustName}
                  onChange={(e) => setApplyCustName(e.target.value)}
                  placeholder="Enter customer full name..."
                  className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-900 text-xs"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Mobile Number (10 digits) *</label>
                <MobileNumberInput
                  required
                  value={applyCustMobile}
                  onChange={setApplyCustMobile}
                  aria-label="Customer mobile number"
                />
              </div>
            </div>
            <div className="mt-2">
              <label className="block font-medium mb-1">Village / Locality</label>
              <input
                value={applyVillage}
                onChange={(e) => setApplyVillage(e.target.value)}
                placeholder="Mamudpur"
                className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-900 text-xs"
              />
            </div>
          </div>

          {applyingService && (
            <div className="space-y-3">
              <div className="font-semibold text-neutral-950 dark:text-white">
                Dynamic Form Inputs &amp; Required Checklist
              </div>
              <div className="p-3 border border-neutral-200 dark:border-neutral-800 rounded bg-white dark:bg-neutral-900 space-y-3">
                {(
                  applyingService.formVersions.find(
                    (v) => v.versionNo === applyingService.currentFormVersion
                  )?.fields ?? []
                )
                  .filter((f) => f.enabled !== false)
                  .map((field) => (
                    <div key={field.fieldKey}>
                      <label className="block font-medium mb-1">
                        {field.label} {field.required && <span className="text-red-500">*</span>}
                      </label>
                      {field.fieldType === 'yes_no' ? (
                        <select
                          required={field.required}
                          value={applyFormData[field.fieldKey] ?? ''}
                          onChange={(e) =>
                            setApplyFormData({ ...applyFormData, [field.fieldKey]: e.target.value })
                          }
                          className="w-full h-9 px-3 border rounded bg-neutral-50 dark:bg-neutral-950 text-xs"
                        >
                          <option value="">Select Yes / No</option>
                          <option value="Yes">Yes</option>
                          <option value="No">No</option>
                        </select>
                      ) : field.fieldType === 'dropdown' && field.options?.length ? (
                        <select
                          required={field.required}
                          value={applyFormData[field.fieldKey] ?? ''}
                          onChange={(e) =>
                            setApplyFormData({ ...applyFormData, [field.fieldKey]: e.target.value })
                          }
                          className="w-full h-9 px-3 border rounded bg-neutral-50 dark:bg-neutral-950 text-xs"
                        >
                          <option value="">Select {field.label}...</option>
                          {field.options.map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}
                            </option>
                          ))}
                        </select>
                      ) : field.fieldType === 'long_text' ? (
                        <textarea
                          rows={2}
                          required={field.required}
                          value={applyFormData[field.fieldKey] ?? ''}
                          onChange={(e) =>
                            setApplyFormData({ ...applyFormData, [field.fieldKey]: e.target.value })
                          }
                          placeholder={`Enter ${field.label}...`}
                          className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-950 text-xs"
                        />
                      ) : (
                        <input
                          required={field.required}
                          type={field.fieldType === 'date' ? 'date' : field.fieldType === 'number' ? 'number' : 'text'}
                          value={applyFormData[field.fieldKey] ?? ''}
                          onChange={(e) =>
                            setApplyFormData({ ...applyFormData, [field.fieldKey]: e.target.value })
                          }
                          placeholder={`Enter ${field.label}...`}
                          className="w-full h-9 px-3 border rounded bg-neutral-50 dark:bg-neutral-950 text-xs"
                        />
                      )}
                    </div>
                  ))}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-neutral-200 dark:border-neutral-800">
            <Button type="button" size="sm" variant="outline" onClick={() => setApplyModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="primary" disabled={submittingApp}>
              {submittingApp ? 'Submitting Application...' : 'Submit & Generate Application No'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Add Master Service Modal (Complete 9-Area Configuration) */}
      <Modal
        isOpen={newServiceOpen}
        onClose={() => {
          setSrvError(null);
          setNewServiceOpen(false);
        }}
        title="Create Master Service & Full Configuration"
        maxWidthClass="max-w-3xl"
      >
        <form onSubmit={handleCreateService} className="space-y-4 text-xs" noValidate>
          {srvError && (
            <div
              role="alert"
              className="px-3 py-2 rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300"
            >
              {srvError}
            </div>
          )}

          {/* Create Modal Tabs */}
          <div className="flex flex-wrap gap-1.5 border-b border-neutral-200 dark:border-neutral-800 pb-2">
            {(
              [
                ['details', '1. Details & Status'],
                ['pricing', '2. Pricing'],
                ['form', `3. Form Fields (${createFields.length})`],
                ['docs', `4. Required Docs (${createDocs.length})`],
                ['sla', '5. SLA & Processing'],
                ['automation', `6. Automation (${createRules.length})`],
              ] as const
            ).map(([k, lbl]) => (
              <button
                key={k}
                type="button"
                onClick={() => setCreateTab(k)}
                className={`px-2.5 py-1 rounded text-[11px] font-medium cursor-pointer ${
                  createTab === k
                    ? 'bg-neutral-950 text-white dark:bg-white dark:text-neutral-950'
                    : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300'
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>

          {createTab === 'details' && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block font-medium mb-1">Service Name *</label>
                  <input
                    required
                    value={srvForm.name}
                    onChange={(e) => {
                      setSrvError(null);
                      setSrvForm({ ...srvForm, name: e.target.value });
                    }}
                    placeholder="e.g. Income Certificate Renewal"
                    className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-900 text-xs"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Service Code (System-Generated)</label>
                  <input
                    readOnly
                    disabled
                    value="Auto-generated (MC2627SRV-XXX)"
                    className="w-full h-9 px-3 border rounded font-mono bg-neutral-100 dark:bg-neutral-950 text-neutral-500 text-xs"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block font-medium mb-1">Category *</label>
                  <select
                    value={srvForm.categoryId}
                    onChange={(e) => {
                      const nextCatId = Number(e.target.value);
                      const firstSub = subcategories.find((sc) => sc.categoryId === nextCatId);
                      setSrvForm({
                        ...srvForm,
                        categoryId: nextCatId,
                        subcategoryId: firstSub?.id ?? '',
                      });
                    }}
                    className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-900 text-xs"
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium mb-1">Subcategory</label>
                  <select
                    value={srvForm.subcategoryId}
                    onChange={(e) =>
                      setSrvForm({
                        ...srvForm,
                        subcategoryId: e.target.value ? Number(e.target.value) : '',
                      })
                    }
                    className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-900 text-xs"
                  >
                    <option value="">Default / General</option>
                    {createFormSubcategories.map((sc) => (
                      <option key={sc.id} value={sc.id}>
                        {sc.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block font-medium mb-1">Service Status</label>
                  <select
                    value={srvForm.status}
                    onChange={(e) =>
                      setSrvForm({ ...srvForm, status: e.target.value as ErpServiceItem['status'] })
                    }
                    className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-900 text-xs"
                  >
                    <option value="Active">Active</option>
                    <option value="Inactive">Inactive</option>
                    <option value="Temporarily Suspended">Temporarily Suspended</option>
                    <option value="Archived">Archived</option>
                  </select>
                </div>
                <div>
                  <label className="block font-medium mb-1">Counter Availability</label>
                  <select
                    value={srvForm.availability}
                    onChange={(e) =>
                      setSrvForm({
                        ...srvForm,
                        availability: e.target.value as ErpServiceItem['availability'],
                      })
                    }
                    className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-900 text-xs"
                  >
                    <option value="Available">Available</option>
                    <option value="Unavailable">Unavailable</option>
                  </select>
                </div>
              </div>
              <textarea
                rows={2}
                value={srvForm.description}
                onChange={(e) => setSrvForm({ ...srvForm, description: e.target.value })}
                placeholder="Service description..."
                className="w-full p-2 border rounded bg-white dark:bg-neutral-900 text-xs"
              />
              <textarea
                rows={2}
                value={srvForm.serviceInstructions}
                onChange={(e) =>
                  setSrvForm({ ...srvForm, serviceInstructions: e.target.value })
                }
                placeholder="Service instructions / operator terms..."
                className="w-full p-2 border rounded bg-white dark:bg-neutral-900 text-xs"
              />
            </div>
          )}

          {createTab === 'pricing' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div>
                  <label className="block font-medium mb-1">Service Charge (₹)</label>
                  <input
                    type="number"
                    min={0}
                    value={srvForm.serviceCharge}
                    onChange={(e) =>
                      setSrvForm({ ...srvForm, serviceCharge: Number(e.target.value) })
                    }
                    className="w-full h-9 px-2 border rounded font-mono bg-white dark:bg-neutral-900 text-xs"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Govt Fee (₹)</label>
                  <input
                    type="number"
                    min={0}
                    value={srvForm.govtFee}
                    onChange={(e) => setSrvForm({ ...srvForm, govtFee: Number(e.target.value) })}
                    className="w-full h-9 px-2 border rounded font-mono bg-white dark:bg-neutral-900 text-xs"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Additional (₹)</label>
                  <input
                    type="number"
                    min={0}
                    value={srvForm.additionalCharges}
                    onChange={(e) =>
                      setSrvForm({ ...srvForm, additionalCharges: Number(e.target.value) })
                    }
                    className="w-full h-9 px-2 border rounded font-mono bg-white dark:bg-neutral-900 text-xs"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Cost (₹)</label>
                  <input
                    type="number"
                    min={0}
                    value={srvForm.serviceCost}
                    onChange={(e) =>
                      setSrvForm({ ...srvForm, serviceCost: Number(e.target.value) })
                    }
                    className="w-full h-9 px-2 border rounded font-mono bg-white dark:bg-neutral-900 text-xs"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 bg-neutral-50 dark:bg-neutral-950 p-3 rounded border border-neutral-200 dark:border-neutral-800 font-mono">
                <div>
                  Total Customer Charge:{' '}
                  {formatCurrency(
                    round2(srvForm.serviceCharge + srvForm.govtFee + srvForm.additionalCharges)
                  )}
                </div>
                <div className="text-emerald-700 dark:text-emerald-400">
                  Net Profit:{' '}
                  {formatCurrency(
                    round2(srvForm.serviceCharge + srvForm.additionalCharges - srvForm.serviceCost)
                  )}
                </div>
              </div>
            </div>
          )}

          {createTab === 'form' && (
            <div className="space-y-3">
              <div className="divide-y border rounded max-h-44 overflow-y-auto">
                {createFields.map((f, idx) => (
                  <div key={`${f.fieldKey}-${idx}`} className="p-2 flex items-center justify-between">
                    <span>
                      <span className="font-mono text-neutral-400 mr-1.5">#{idx + 1}</span>
                      <span className="font-semibold">{f.label}</span>{' '}
                      <span className="font-mono text-[11px] text-neutral-500">
                        ({f.fieldType} {f.required ? '· Required' : '· Optional'})
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setCreateFields((prev) => prev.filter((_, i) => i !== idx))
                      }
                      className="text-red-600 p-1 cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input
                  value={createFieldInput.label}
                  onChange={(e) =>
                    setCreateFieldInput({ ...createFieldInput, label: e.target.value })
                  }
                  placeholder="Field Label..."
                  className="h-8 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                />
                <select
                  value={createFieldInput.fieldType}
                  onChange={(e) =>
                    setCreateFieldInput({
                      ...createFieldInput,
                      fieldType: e.target.value as DynamicFieldType,
                    })
                  }
                  className="h-8 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                >
                  {ALL_FIELD_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={createFieldInput.required}
                    onChange={(e) =>
                      setCreateFieldInput({ ...createFieldInput, required: e.target.checked })
                    }
                  />
                  Required Field
                </label>
              </div>
              {['dropdown', 'radio', 'multi_select'].includes(createFieldInput.fieldType) && (
                <input
                  value={createFieldInput.optionsCsv}
                  onChange={(e) =>
                    setCreateFieldInput({ ...createFieldInput, optionsCsv: e.target.value })
                  }
                  placeholder="Comma-separated choices..."
                  className="w-full h-8 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                />
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  if (!createFieldInput.label.trim()) return;
                  const opts = ['dropdown', 'radio', 'multi_select'].includes(
                    createFieldInput.fieldType
                  )
                    ? createFieldInput.optionsCsv
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean)
                    : undefined;
                  setCreateFields((prev) => [
                    ...prev,
                    {
                      fieldKey: slugifyKey(
                        createFieldInput.fieldKey || createFieldInput.label,
                        `field_${prev.length + 1}`
                      ),
                      label: createFieldInput.label.trim(),
                      fieldType: createFieldInput.fieldType,
                      required: createFieldInput.required,
                      displayOrder: prev.length + 1,
                      options: opts,
                      enabled: true,
                    },
                  ]);
                  setCreateFieldInput({
                    label: '',
                    fieldKey: '',
                    fieldType: 'short_text',
                    required: true,
                    optionsCsv: '',
                  });
                }}
                icon={<Plus className="h-3 w-3" />}
              >
                Add Field
              </Button>
            </div>
          )}

          {createTab === 'docs' && (
            <div className="space-y-3">
              <div className="divide-y border rounded max-h-40 overflow-y-auto">
                {createDocs.length === 0 ? (
                  <div className="p-3 text-neutral-500 text-center">
                    No required documents added yet.
                  </div>
                ) : (
                  createDocs.map((d, i) => (
                    <div key={`${d.docKey}-${i}`} className="p-2 flex items-center justify-between">
                      <span>
                        <span className="font-semibold">{d.label}</span> ({d.category} ·{' '}
                        {d.required ? 'Mandatory' : 'Optional'} · {d.maxSizeMb}MB)
                      </span>
                      <button
                        type="button"
                        onClick={() => setCreateDocs((prev) => prev.filter((_, idx) => idx !== i))}
                        className="text-red-600 p-1 cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input
                  value={createDocInput.label}
                  onChange={(e) =>
                    setCreateDocInput({ ...createDocInput, label: e.target.value })
                  }
                  placeholder="Document Label..."
                  className="h-8 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                />
                <input
                  value={createDocInput.category}
                  onChange={(e) =>
                    setCreateDocInput({ ...createDocInput, category: e.target.value })
                  }
                  placeholder="Document Category"
                  className="h-8 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                />
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={createDocInput.required}
                    onChange={(e) =>
                      setCreateDocInput({ ...createDocInput, required: e.target.checked })
                    }
                  />
                  Mandatory Document
                </label>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  if (!createDocInput.label.trim()) return;
                  setCreateDocs((prev) => [
                    ...prev,
                    {
                      docKey: slugifyKey(createDocInput.label, `doc_${prev.length + 1}`),
                      label: createDocInput.label.trim(),
                      category: createDocInput.category.trim() || 'Identity Proof',
                      required: createDocInput.required,
                      allowMultiple: false,
                      allowedFormats: ['PDF', 'JPG', 'JPEG', 'PNG'],
                      maxSizeMb: createDocInput.maxSizeMb || 5,
                      instructions: createDocInput.instructions,
                      enabled: true,
                    },
                  ]);
                  setCreateDocInput({
                    label: '',
                    category: 'Identity Proof',
                    required: true,
                    maxSizeMb: 5,
                    instructions: 'Upload clear readable scan.',
                  });
                }}
                icon={<Plus className="h-3 w-3" />}
              >
                Add Document Requirement
              </Button>
            </div>
          )}

          {createTab === 'sla' && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div>
                <label className="block font-medium mb-1">Mode</label>
                <select
                  value={createSla.processingMode}
                  onChange={(e) =>
                    setCreateSla({
                      ...createSla,
                      processingMode: e.target.value as 'FIXED' | 'RANGE',
                    })
                  }
                  className="w-full h-8 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                >
                  <option value="FIXED">FIXED</option>
                  <option value="RANGE">RANGE</option>
                </select>
              </div>
              <div>
                <label className="block font-medium mb-1">Expected Days</label>
                <input
                  type="number"
                  min={1}
                  value={createSla.expectedDays}
                  onChange={(e) =>
                    setCreateSla({ ...createSla, expectedDays: Number(e.target.value) })
                  }
                  className="w-full h-8 px-2 border rounded font-mono bg-white dark:bg-neutral-900 text-xs"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Day Type</label>
                <select
                  value={createSla.dayType}
                  onChange={(e) =>
                    setCreateSla({
                      ...createSla,
                      dayType: e.target.value as 'WORKING' | 'CALENDAR',
                    })
                  }
                  className="w-full h-8 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                >
                  <option value="WORKING">WORKING</option>
                  <option value="CALENDAR">CALENDAR</option>
                </select>
              </div>
              <div>
                <label className="block font-medium mb-1">Min Days</label>
                <input
                  type="number"
                  min={1}
                  value={createSla.minDays}
                  onChange={(e) => setCreateSla({ ...createSla, minDays: Number(e.target.value) })}
                  className="w-full h-8 px-2 border rounded font-mono bg-white dark:bg-neutral-900 text-xs"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Max Days</label>
                <input
                  type="number"
                  min={1}
                  value={createSla.maxDays}
                  onChange={(e) => setCreateSla({ ...createSla, maxDays: Number(e.target.value) })}
                  className="w-full h-8 px-2 border rounded font-mono bg-white dark:bg-neutral-900 text-xs"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">SLA Start Event</label>
                <select
                  value={createSla.startEvent}
                  onChange={(e) =>
                    setCreateSla({
                      ...createSla,
                      startEvent: e.target.value as 'ON_SUBMIT' | 'ON_ASSIGN',
                    })
                  }
                  className="w-full h-8 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                >
                  <option value="ON_SUBMIT">ON_SUBMIT</option>
                  <option value="ON_ASSIGN">ON_ASSIGN</option>
                </select>
              </div>
            </div>
          )}

          {createTab === 'automation' && (
            <div className="space-y-3">
              <div className="divide-y border rounded max-h-40 overflow-y-auto">
                {createRules.length === 0 ? (
                  <div className="p-3 text-neutral-500 text-center">No automation rules added.</div>
                ) : (
                  createRules.map((r, i) => (
                    <div key={r.id} className="p-2 flex items-center justify-between">
                      <span>
                        <span className="font-semibold">{r.name}</span>{' '}
                        <span className="font-mono text-[11px] text-neutral-500">
                          ({r.trigger} → {r.actionType})
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setCreateRules((prev) => prev.filter((_, idx) => idx !== i))}
                        className="text-red-600 p-1 cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  value={createRuleInput.name}
                  onChange={(e) =>
                    setCreateRuleInput({ ...createRuleInput, name: e.target.value })
                  }
                  placeholder="Rule Name..."
                  className="h-8 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                />
                <input
                  value={createRuleInput.actionParam}
                  onChange={(e) =>
                    setCreateRuleInput({ ...createRuleInput, actionParam: e.target.value })
                  }
                  placeholder="Action Param (e.g. CTR-01)"
                  className="h-8 px-2 border rounded font-mono bg-white dark:bg-neutral-900 text-xs"
                />
                <select
                  value={createRuleInput.trigger}
                  onChange={(e) =>
                    setCreateRuleInput({
                      ...createRuleInput,
                      trigger: e.target.value as ServiceAutomationRule['trigger'],
                    })
                  }
                  className="h-8 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                >
                  {AUTOMATION_TRIGGERS.map((tr) => (
                    <option key={tr.value} value={tr.value}>
                      {tr.label}
                    </option>
                  ))}
                </select>
                <select
                  value={createRuleInput.actionType}
                  onChange={(e) =>
                    setCreateRuleInput({
                      ...createRuleInput,
                      actionType: e.target.value as ServiceAutomationRule['actionType'],
                    })
                  }
                  className="h-8 px-2 border rounded bg-white dark:bg-neutral-900 text-xs"
                >
                  {AUTOMATION_ACTIONS.map((ac) => (
                    <option key={ac.value} value={ac.value}>
                      {ac.label}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  if (!createRuleInput.name.trim()) return;
                  setCreateRules((prev) => [
                    ...prev,
                    {
                      id: `AUTO-${Date.now().toString(36).toUpperCase()}`,
                      name: createRuleInput.name.trim(),
                      trigger: createRuleInput.trigger,
                      conditionStatus: 'ANY',
                      actionType: createRuleInput.actionType,
                      actionParam: createRuleInput.actionParam.trim() || 'DEFAULT',
                      enabled: true,
                      versionNo: 1,
                      executionCount: 0,
                      lastRunAt: null,
                      lastError: null,
                    },
                  ]);
                  setCreateRuleInput({
                    name: '',
                    trigger: 'APPLICATION_SUBMITTED',
                    actionType: 'GENERATE_NOTIFICATION',
                    actionParam: 'SMS_STATUS_ALERT',
                  });
                }}
                icon={<Plus className="h-3 w-3" />}
              >
                Add Rule
              </Button>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-neutral-200 dark:border-neutral-800">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setSrvError(null);
                setNewServiceOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="primary" loading={savingSrv}>
              Create Service
            </Button>
          </div>
        </form>
      </Modal>

      {/* Add / Edit Category Modal */}
      <Modal
        isOpen={newCatOpen}
        onClose={() => {
          setCatError(null);
          setEditingCat(null);
          setNewCatOpen(false);
        }}
        title={editingCat ? `Edit Category (${editingCat.code})` : 'Add Service Category'}
      >
        <form onSubmit={handleSaveCategory} className="space-y-3 text-xs" noValidate>
          {catError && (
            <div
              role="alert"
              className="px-3 py-2 rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300"
            >
              {catError}
            </div>
          )}
          <div>
            <label className="block font-medium mb-1">Category Name *</label>
            <input
              required
              value={catForm.name}
              onChange={(e) => {
                setCatError(null);
                setCatForm({ ...catForm, name: e.target.value });
              }}
              placeholder="e.g. Citizen & KYC Services"
              className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-900 text-xs"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">Description</label>
            <input
              value={catForm.description}
              onChange={(e) => setCatForm({ ...catForm, description: e.target.value })}
              placeholder="Category scope description..."
              className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-900 text-xs"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setCatError(null);
                setEditingCat(null);
                setNewCatOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="primary" loading={savingCat}>
              {editingCat ? 'Save Category' : 'Create Category'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Add / Edit Subcategory Modal */}
      <Modal
        isOpen={newSubOpen}
        onClose={() => {
          setSubError(null);
          setEditingSub(null);
          setNewSubOpen(false);
        }}
        title={
          editingSub ? `Edit Subcategory (${editingSub.code})` : 'Add Service Subcategory'
        }
      >
        <form onSubmit={handleSaveSubcategory} className="space-y-3 text-xs" noValidate>
          {subError && (
            <div
              role="alert"
              className="px-3 py-2 rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300"
            >
              {subError}
            </div>
          )}
          <div>
            <label className="block font-medium mb-1">Parent Category *</label>
            <select
              value={subForm.categoryId}
              onChange={(e) => setSubForm({ ...subForm, categoryId: Number(e.target.value) })}
              className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-900 text-xs"
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block font-medium mb-1">Subcategory Name *</label>
            <input
              required
              value={subForm.name}
              onChange={(e) => {
                setSubError(null);
                setSubForm({ ...subForm, name: e.target.value });
              }}
              placeholder="e.g. Digital Identity Updates"
              className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-900 text-xs"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">Description</label>
            <input
              value={subForm.description}
              onChange={(e) => setSubForm({ ...subForm, description: e.target.value })}
              placeholder="Subcategory scope description..."
              className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-900 text-xs"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setSubError(null);
                setEditingSub(null);
                setNewSubOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="primary" loading={savingSub}>
              {editingSub ? 'Save Subcategory' : 'Create Subcategory'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete Category / Subcategory Confirmation Modal */}
      <Modal
        isOpen={Boolean(deleteTaxonTarget)}
        onClose={() => setDeleteTaxonTarget(null)}
        title={`Confirm Delete ${deleteTaxonTarget?.type === 'category' ? 'Category' : 'Subcategory'}`}
      >
        <div className="space-y-4 text-xs">
          <p className="text-neutral-700 dark:text-neutral-300 leading-relaxed">
            Permanently delete{' '}
            <span className="font-semibold">{deleteTaxonTarget?.name}</span> (
            <span className="font-mono">{deleteTaxonTarget?.code}</span>)? Deletion is blocked if any
            subcategories or services remain linked.
          </p>
          <div className="flex justify-end gap-2 pt-3 border-t border-neutral-200 dark:border-neutral-800">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setDeleteTaxonTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="primary"
              loading={deletingTaxon}
              onClick={handleExecuteDeleteTaxon}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              Confirm Delete
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete Service Confirmation Modal */}
      <Modal
        isOpen={deleteServiceModalOpen}
        onClose={() => setDeleteServiceModalOpen(false)}
        title={`Confirm Service Deletion: ${serviceToDelete?.serviceCode || serviceToDelete?.serviceId || ''}`}
      >
        <div className="space-y-4 text-xs">
          <p className="text-neutral-700 dark:text-neutral-300 leading-relaxed">
            Are you sure you want to permanently delete service{' '}
            <span className="font-semibold">{serviceToDelete?.name}</span> (
            {serviceToDelete?.serviceCode} / {serviceToDelete?.serviceId})? Remaining services will
            automatically re-sequence continuous display serial numbers while keeping their
            permanent Service IDs and Codes unchanged.
          </p>
          <div className="flex justify-end gap-2 pt-3 border-t border-neutral-200 dark:border-neutral-800">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setDeleteServiceModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="primary"
              loading={deletingService}
              onClick={handleExecuteDeleteService}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              Confirm &amp; Delete Service
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
