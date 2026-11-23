import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Copy,
  CreditCard,
  Edit3,
  FolderPlus,
  FolderTree,
  History,
  IndianRupee,
  Landmark,
  ListTree,
  Lock,
  MessageSquareWarning,
  Plus,
  RefreshCw,
  Search,
  ShoppingCart,
} from 'lucide-react';
import {
  ALL_UNIT_TYPES,
  CscCategory,
  CscRateHistoryEntry,
  CscService,
  UnitType,
} from '../../../shared/cscTypes';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { Pagination } from '../../components/Pagination';
import { useLanguage } from '../../i18n/translations';
import { PageKey, UserProfile } from '../../modules/types';
import { paginateArray } from '../../services/apiClient';
import { cscApi } from '../../services/cscApi';
import {
  saveCscCategoryToFirestore,
  saveCscServiceOverrideToFirestore,
  subscribeCscOverridesFromFirestore,
  subscribeCscRateHistoryFromFirestore,
} from '../../services/cscFirestore';
import { useCloudSync } from '../../services/cloudSync';
import { formatDateIST, formatDateTimeIST, formatINR } from '../../services/formatters';
import { extractFriendlyErrorMessage } from '../../services/firebase';

interface CscServicesAndRatesPageProps {
  currentUser: UserProfile;
  viewMode?: 'categories' | 'sub-services';
  selectedCategoryId?: string;
  onSelectCategoryId?: (categoryId: string) => void;
  onNavigate?: (page: PageKey) => void;
  onStartOrderForService?: (serviceId: string) => void;
  onShowToast: (type: 'success' | 'error' | 'info', title: string, description?: string) => void;
}

function getWorkflowLinkForService(svc: CscService): {
  page: PageKey;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
} | null {
  const lowerName = svc.name.toLowerCase();
  if (svc.moduleTag === 'PVC' || svc.categoryId === 'CAT-09') {
    return { page: 'csc-pvc', label: 'PVC Desk', Icon: CreditCard };
  }
  if (svc.moduleTag === 'GRIEVANCE' || svc.moduleTag === 'RTI' || svc.categoryId === 'CAT-05') {
    return { page: 'csc-grievances', label: 'Grievance / RTI', Icon: MessageSquareWarning };
  }
  if (
    svc.moduleTag === 'PMJAY' ||
    svc.moduleTag === 'MMSBY' ||
    svc.moduleTag === 'NPCI' ||
    svc.moduleTag === 'CYBER_CRIME' ||
    lowerName.includes('ayushman bharat') ||
    lowerName.includes('swasthya sathi')
  ) {
    return { page: 'csc-schemes', label: 'Schemes Hub', Icon: Landmark };
  }
  return null;
}

function getWorkflowLinkForCategory(cat: CscCategory): {
  page: PageKey;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
} | null {
  if (cat.moduleTag === 'PVC' || cat.id === 'CAT-09') {
    return { page: 'csc-pvc', label: 'PVC Desk', Icon: CreditCard };
  }
  if (cat.moduleTag === 'GRIEVANCE' || cat.moduleTag === 'RTI' || cat.id === 'CAT-05') {
    return { page: 'csc-grievances', label: 'Grievance / RTI', Icon: MessageSquareWarning };
  }
  if (
    cat.moduleTag === 'PMJAY' ||
    cat.moduleTag === 'MMSBY' ||
    cat.moduleTag === 'NPCI' ||
    cat.moduleTag === 'CYBER_CRIME'
  ) {
    return { page: 'csc-schemes', label: 'Schemes Hub', Icon: Landmark };
  }
  return null;
}

export const CscServicesAndRatesPage: React.FC<CscServicesAndRatesPageProps> = ({
  currentUser,
  viewMode = 'sub-services',
  selectedCategoryId,
  onSelectCategoryId,
  onNavigate,
  onStartOrderForService,
  onShowToast,
}) => {
  const { t } = useLanguage();
  const cloudSync = useCloudSync();
  const [baseCategories, setBaseCategories] = useState<CscCategory[]>([]);
  const [cloudCategories, setCloudCategories] = useState<CscCategory[]>([]);
  const [baseServices, setBaseServices] = useState<CscService[]>([]);
  const [cloudServiceOverrides, setCloudServiceOverrides] = useState<CscService[]>([]);
  const [baseRateHistory, setBaseRateHistory] = useState<CscRateHistoryEntry[]>([]);
  const [cloudRateHistory, setCloudRateHistory] = useState<CscRateHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const categories = useMemo(() => {
    const map = new Map<string, CscCategory>();
    for (const c of baseCategories) map.set(c.id, c);
    for (const c of cloudCategories) {
      const prev = map.get(c.id);
      map.set(c.id, prev ? { ...prev, ...c } : c);
    }
    return Array.from(map.values()).sort((a, b) => (a.displayOrder ?? 999) - (b.displayOrder ?? 999));
  }, [baseCategories, cloudCategories]);

  const services = useMemo(() => {
    const map = new Map<string, CscService>();
    for (const s of baseServices) map.set(s.id, s);
    for (const ov of cloudServiceOverrides) {
      const prev = map.get(ov.id);
      map.set(ov.id, prev ? { ...prev, ...ov } : ov);
    }
    return Array.from(map.values());
  }, [baseServices, cloudServiceOverrides]);

  const rateHistory = useMemo(() => {
    const map = new Map<string, CscRateHistoryEntry>();
    for (const h of baseRateHistory) map.set(h.id, h);
    for (const h of cloudRateHistory) map.set(h.id, h);
    return Array.from(map.values()).sort((a, b) =>
      String(b.changedAt || '').localeCompare(String(a.changedAt || ''))
    );
  }, [baseRateHistory, cloudRateHistory]);

  const [internalCatId, setInternalCatId] = useState<string>(selectedCategoryId || 'ALL');
  const selectedCatId = selectedCategoryId !== undefined ? selectedCategoryId : internalCatId;
  const updateSelectedCatId = (nextCatId: string) => {
    setInternalCatId(nextCatId);
    onSelectCategoryId?.(nextCatId);
  };

  const [categorySearch, setCategorySearch] = useState('');
  const [search, setSearch] = useState('');
  const [rateFilter, setRateFilter] = useState<'ALL' | 'CONFIGURED' | 'BLANK'>('ALL');
  const [activeTab, setActiveTab] = useState<'catalog' | 'rate-history'>('catalog');
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
    if (viewMode === 'sub-services') {
      setActiveTab('catalog');
    }
  }, [viewMode, selectedCatId]);

  const isAdmin = currentUser.role === 'ADMIN';
  const canEditRates = isAdmin || Boolean(currentUser.permissions?.['csc.rateEdit']);

  // Modals
  const [rateModalService, setRateModalService] = useState<CscService | null>(null);
  const [rateServiceCharge, setRateServiceCharge] = useState('');
  const [rateGovtFee, setRateGovtFee] = useState('');
  const [rateUnitType, setRateUnitType] = useState<UnitType>('Per Application');
  const [rateEffectiveDate, setRateEffectiveDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [rateReason, setRateReason] = useState('');
  const [savingRate, setSavingRate] = useState(false);
  const [rateError, setRateError] = useState<string | null>(null);

  const [catModalOpen, setCatModalOpen] = useState(false);
  const [editingCat, setEditingCat] = useState<CscCategory | null>(null);
  const [catName, setCatName] = useState('');
  const [catCode, setCatCode] = useState('');
  const [catDesc, setCatDesc] = useState('');
  const [savingCat, setSavingCat] = useState(false);
  const [catError, setCatError] = useState<string | null>(null);

  const [svcModalOpen, setSvcModalOpen] = useState(false);
  const [editingSvc, setEditingSvc] = useState<CscService | null>(null);
  const [svcCatId, setSvcCatId] = useState('');
  const [svcName, setSvcName] = useState('');
  const [svcSubGroup, setSvcSubGroup] = useState('');
  const [svcDesc, setSvcDesc] = useState('');
  const [svcDocs, setSvcDocs] = useState('Aadhaar Card (Masked), Applicant Photo, Mobile Number');
  const [svcAvailability, setSvcAvailability] = useState<'Available' | 'Unavailable'>('Available');
  const [savingSvc, setSavingSvc] = useState(false);
  const [svcError, setSvcError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [catRes, svcRes, histRes] = await Promise.all([
        cscApi.getCategories(),
        cscApi.getServices(),
        cscApi.getRateHistory().catch(() => ({ data: [] as CscRateHistoryEntry[] })),
      ]);
      setBaseCategories(catRes.data);
      setBaseServices(svcRes.data);
      setBaseRateHistory(histRes.data);
    } catch (err) {
      if (!cloudSync.userUid) {
        onShowToast('error', 'Failed to load CSC Catalog', extractFriendlyErrorMessage(err));
      }
    } finally {
      setLoading(false);
    }
  }, [cloudSync.userUid, onShowToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!cloudSync.userUid) return;
    const unsubCatalog = subscribeCscOverridesFromFirestore(
      (cats) => setCloudCategories(cats),
      (svcs) => setCloudServiceOverrides(svcs)
    );
    const unsubHistory = subscribeCscRateHistoryFromFirestore((hist) =>
      setCloudRateHistory(hist)
    );
    return () => {
      unsubCatalog();
      unsubHistory();
    };
  }, [cloudSync.userUid]);

  const filteredCategories = useMemo(() => {
    const q = categorySearch.trim().toLowerCase();
    return categories.filter(
      (cat) =>
        !q ||
        cat.name.toLowerCase().includes(q) ||
        cat.code.toLowerCase().includes(q) ||
        cat.description.toLowerCase().includes(q)
    );
  }, [categories, categorySearch]);

  const filteredServices = useMemo(() => {
    const q = search.trim().toLowerCase();
    return services.filter((s) => {
      if (selectedCatId !== 'ALL' && s.categoryId !== selectedCatId) return false;
      if (rateFilter === 'CONFIGURED' && !s.rateConfigured) return false;
      if (rateFilter === 'BLANK' && s.rateConfigured) return false;
      if (
        q &&
        !s.name.toLowerCase().includes(q) &&
        !s.code.toLowerCase().includes(q) &&
        !s.categoryName.toLowerCase().includes(q) &&
        !(s.subGroup || '').toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [services, selectedCatId, rateFilter, search]);

  const paginated = useMemo(() => paginateArray(filteredServices, page, 15), [filteredServices, page]);

  const blankCount = useMemo(() => services.filter((s) => !s.rateConfigured).length, [services]);
  const configuredCount = services.length - blankCount;

  const openRateModal = (svc: CscService) => {
    setRateError(null);
    setRateModalService(svc);
    setRateServiceCharge(svc.serviceCharge !== null ? String(svc.serviceCharge) : '');
    setRateGovtFee(svc.govtFee !== null ? String(svc.govtFee) : '0');
    setRateUnitType(svc.unitType || 'Per Application');
    setRateEffectiveDate(svc.effectiveDate || new Date().toISOString().slice(0, 10));
    setRateReason('');
  };

  const handleSaveRate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rateModalService) return;
    setRateError(null);
    const sc = Number(rateServiceCharge);
    const gf = Number(rateGovtFee || 0);
    if (!Number.isFinite(sc) || sc < 0 || !Number.isFinite(gf) || gf < 0) {
      const msg = 'Service Charge and Government Fee must be 0 or greater.';
      setRateError(msg);
      onShowToast('error', 'Invalid Rate', msg);
      return;
    }
    setSavingRate(true);
    try {
      const reason = rateReason.trim() || 'Admin Rate Configuration';
      let updatedSvc: CscService;
      let historyEntry: CscRateHistoryEntry;
      try {
        const res = await cscApi.updateServiceRate(rateModalService.id, {
          serviceCharge: sc,
          govtFee: gf,
          unitType: rateUnitType,
          effectiveDate: rateEffectiveDate,
          changeReason: reason,
        });
        updatedSvc = res.data.service;
        historyEntry = res.data.historyEntry;
      } catch (apiErr) {
        const apiMsg = apiErr instanceof Error ? apiErr.message.toLowerCase() : '';
        if (!apiMsg.includes('not found') && !apiMsg.includes('404')) {
          throw apiErr;
        }
        const nowIso = new Date().toISOString();
        updatedSvc = {
          ...rateModalService,
          serviceCharge: sc,
          govtFee: gf,
          totalAmount: sc + gf,
          unitType: rateUnitType,
          rateConfigured: true,
          effectiveDate: rateEffectiveDate,
          updatedBy: currentUser.userId,
          updatedAt: nowIso,
        };
        historyEntry = {
          id: `RATE-${Date.now()}`,
          serviceId: rateModalService.id,
          serviceCode: rateModalService.code,
          serviceName: rateModalService.name,
          categoryName: rateModalService.categoryName,
          adminId: currentUser.userId,
          oldServiceCharge: rateModalService.serviceCharge,
          newServiceCharge: sc,
          oldGovtFee: rateModalService.govtFee,
          newGovtFee: gf,
          oldTotalAmount: rateModalService.totalAmount,
          newTotalAmount: sc + gf,
          oldUnitType: rateModalService.unitType,
          newUnitType: rateUnitType,
          effectiveDate: rateEffectiveDate,
          changeReason: reason,
          changedAt: nowIso,
        };
      }

      await saveCscServiceOverrideToFirestore(updatedSvc, historyEntry);
      setCloudServiceOverrides((prev) => {
        const next = prev.filter((s) => s.id !== updatedSvc.id);
        return [...next, updatedSvc];
      });
      setCloudRateHistory((prev) => [historyEntry, ...prev.filter((h) => h.id !== historyEntry.id)]);
      onShowToast(
        'success',
        'Service Rate Saved',
        `${updatedSvc.name} set to ${formatINR(sc + gf)} (${rateUnitType}). Synced to cloud.`
      );
      setRateModalService(null);
      void loadData();
    } catch (err) {
      const msg = extractFriendlyErrorMessage(err, 'Unable to update service rate.');
      setRateError(msg);
      onShowToast('error', 'Rate Update Blocked', msg);
    } finally {
      setSavingRate(false);
    }
  };

  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    setCatError(null);
    if (!catName.trim() || catName.trim().length < 2) {
      setCatError('Category name must be at least 2 characters.');
      return;
    }
    setSavingCat(true);
    try {
      let savedCat: CscCategory;
      if (editingCat) {
        try {
          const res = await cscApi.updateCategory(editingCat.id, {
            name: catName.trim(),
            code: catCode.trim(),
            description: catDesc.trim(),
          });
          savedCat = res.data;
        } catch (apiErr) {
          const apiMsg = apiErr instanceof Error ? apiErr.message.toLowerCase() : '';
          if (!apiMsg.includes('not found') && !apiMsg.includes('404')) throw apiErr;
          savedCat = {
            ...editingCat,
            name: catName.trim(),
            code: catCode.trim() || editingCat.code,
            description: catDesc.trim(),
          };
        }
      } else {
        const res = await cscApi.createCategory({
          name: catName.trim(),
          code: catCode.trim() || undefined,
          description: catDesc.trim(),
        });
        savedCat = res.data;
      }

      const cloudSaved = await saveCscCategoryToFirestore(savedCat);
      setCloudCategories((prev) => [...prev.filter((c) => c.id !== cloudSaved.id), cloudSaved]);
      onShowToast('success', editingCat ? 'Category Updated' : 'Category Created');
      setCatModalOpen(false);
      void loadData();
    } catch (err) {
      const msg = extractFriendlyErrorMessage(err, 'Unable to save category.');
      setCatError(msg);
      onShowToast('error', 'Category Error', msg);
    } finally {
      setSavingCat(false);
    }
  };

  const handleSaveService = async (e: React.FormEvent) => {
    e.preventDefault();
    setSvcError(null);
    if (!svcName.trim() || svcName.trim().length < 2) {
      setSvcError('Service name must be at least 2 characters.');
      return;
    }
    const requiredDocuments = svcDocs
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    setSavingSvc(true);
    try {
      let savedSvc: CscService;
      if (editingSvc) {
        try {
          const res = await cscApi.updateService(editingSvc.id, {
            name: svcName.trim(),
            subGroup: svcSubGroup.trim(),
            description: svcDesc.trim(),
            requiredDocuments,
            availability: svcAvailability,
          });
          savedSvc = res.data;
        } catch (apiErr) {
          const apiMsg = apiErr instanceof Error ? apiErr.message.toLowerCase() : '';
          if (!apiMsg.includes('not found') && !apiMsg.includes('404')) throw apiErr;
          savedSvc = {
            ...editingSvc,
            name: svcName.trim(),
            subGroup: svcSubGroup.trim(),
            description: svcDesc.trim(),
            requiredDocuments,
            availability: svcAvailability,
            updatedBy: currentUser.userId,
            updatedAt: new Date().toISOString(),
          };
        }
      } else {
        const targetCatId = svcCatId || categories[0]?.id || 'CAT-01';
        try {
          const res = await cscApi.createService({
            categoryId: targetCatId,
            name: svcName.trim(),
            subGroup: svcSubGroup.trim(),
            description: svcDesc.trim(),
            requiredDocuments,
          });
          savedSvc = res.data;
        } catch (apiErr) {
          const apiMsg = apiErr instanceof Error ? apiErr.message.toLowerCase() : '';
          if (!apiMsg.includes('not found') && !apiMsg.includes('404')) throw apiErr;
          const catObj = categories.find((c) => c.id === targetCatId);
          const nowIso = new Date().toISOString();
          const newId = `CSVC-${Date.now().toString(36).toUpperCase()}`;
          savedSvc = {
            id: newId,
            code: newId,
            categoryId: targetCatId,
            categoryName: catObj?.name || 'General Services',
            subGroup: svcSubGroup.trim(),
            name: svcName.trim(),
            description: svcDesc.trim(),
            serviceCharge: null,
            govtFee: null,
            totalAmount: null,
            unitType: null,
            rateConfigured: false,
            effectiveDate: null,
            requiredDocuments,
            availability: 'Available',
            active: true,
            moduleTag: catObj?.moduleTag || 'GENERAL',
            updatedBy: currentUser.userId,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
        }
      }

      const cloudSaved = await saveCscServiceOverrideToFirestore(savedSvc);
      setCloudServiceOverrides((prev) => [...prev.filter((s) => s.id !== cloudSaved.id), cloudSaved]);
      onShowToast(
        'success',
        editingSvc ? 'Service Updated' : 'Service Created (Rate Blank)',
        editingSvc
          ? `${cloudSaved.name} saved permanently.`
          : 'New service created with blank rates until Admin configures pricing.'
      );
      setSvcModalOpen(false);
      void loadData();
    } catch (err) {
      const msg = extractFriendlyErrorMessage(err, 'Unable to save service.');
      setSvcError(msg);
      onShowToast('error', 'Service Error', msg);
    } finally {
      setSavingSvc(false);
    }
  };

  const handleDuplicate = async (svc: CscService) => {
    try {
      let duplicatedSvc: CscService;
      try {
        const res = await cscApi.duplicateService(svc.id);
        duplicatedSvc = res.data;
      } catch (apiErr) {
        const apiMsg = apiErr instanceof Error ? apiErr.message.toLowerCase() : '';
        if (!apiMsg.includes('not found') && !apiMsg.includes('404')) throw apiErr;
        const nowIso = new Date().toISOString();
        const newId = `CSVC-${Date.now().toString(36).toUpperCase()}`;
        duplicatedSvc = {
          ...svc,
          id: newId,
          code: newId,
          name: `${svc.name} (Copy)`,
          serviceCharge: null,
          govtFee: null,
          totalAmount: null,
          unitType: null,
          rateConfigured: false,
          effectiveDate: null,
          updatedBy: currentUser.userId,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
      }
      const cloudSaved = await saveCscServiceOverrideToFirestore(duplicatedSvc);
      setCloudServiceOverrides((prev) => [...prev.filter((s) => s.id !== cloudSaved.id), cloudSaved]);
      onShowToast('success', 'Service Duplicated', `${cloudSaved.name} created with blank rate.`);
      void loadData();
    } catch (err) {
      onShowToast('error', 'Duplicate Failed', extractFriendlyErrorMessage(err));
    }
  };

  const selectedCategoryObj = categories.find((c) => c.id === selectedCatId);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-neutral-950 dark:text-white">
            {viewMode === 'categories'
              ? t.navLabels['csc-service-categories'] ?? 'Service Categories'
              : t.navLabels['csc-services'] ?? `Sub-Services (${services.length})`}
          </h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            {categories.length} Categories · {services.length} Sub-Services ({configuredCount} Rate Set ·{' '}
            {blankCount} Blank/Unconfigured) · All rates start blank until explicitly set by Admin.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {onNavigate && (
            <div className="inline-flex rounded-md border border-neutral-200 dark:border-neutral-700 overflow-hidden bg-neutral-50 dark:bg-neutral-900">
              <button
                type="button"
                onClick={() => onNavigate('csc-service-categories')}
                className={`px-3 h-8 text-xs font-medium cursor-pointer whitespace-nowrap inline-flex items-center gap-1.5 ${
                  viewMode === 'categories'
                    ? 'bg-neutral-950 text-white dark:bg-white dark:text-neutral-950'
                    : 'text-neutral-600 dark:text-neutral-300 hover:text-neutral-950 dark:hover:text-white'
                }`}
              >
                <FolderTree className="h-3.5 w-3.5" />
                {t.navLabels['csc-service-categories'] ?? 'Service Categories'} ({categories.length})
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveTab('catalog');
                  onNavigate('csc-services');
                }}
                className={`px-3 h-8 text-xs font-medium cursor-pointer whitespace-nowrap inline-flex items-center gap-1.5 ${
                  viewMode === 'sub-services' && activeTab === 'catalog'
                    ? 'bg-neutral-950 text-white dark:bg-white dark:text-neutral-950'
                    : 'text-neutral-600 dark:text-neutral-300 hover:text-neutral-950 dark:hover:text-white'
                }`}
              >
                <ListTree className="h-3.5 w-3.5" />
                {t.navLabels['csc-services'] ?? `Sub-Services (${services.length})`}
              </button>
              {viewMode === 'sub-services' && (
                <button
                  type="button"
                  onClick={() => setActiveTab('rate-history')}
                  className={`px-3 h-8 text-xs font-medium cursor-pointer whitespace-nowrap inline-flex items-center gap-1.5 ${
                    activeTab === 'rate-history'
                      ? 'bg-neutral-950 text-white dark:bg-white dark:text-neutral-950'
                      : 'text-neutral-600 dark:text-neutral-300 hover:text-neutral-950 dark:hover:text-white'
                  }`}
                >
                  <History className="h-3.5 w-3.5" />
                  Rate History ({rateHistory.length})
                </button>
              )}
            </div>
          )}

          {!onNavigate && (
            <div className="inline-flex rounded-md border border-neutral-200 dark:border-neutral-700 overflow-hidden bg-neutral-50 dark:bg-neutral-900">
              <button
                type="button"
                onClick={() => setActiveTab('catalog')}
                className={`px-3 h-8 text-xs font-medium cursor-pointer whitespace-nowrap ${
                  activeTab === 'catalog'
                    ? 'bg-neutral-950 text-white dark:bg-white dark:text-neutral-950'
                    : 'text-neutral-600 dark:text-neutral-300'
                }`}
              >
                Sub-Services ({services.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('rate-history')}
                className={`px-3 h-8 text-xs font-medium cursor-pointer whitespace-nowrap flex items-center gap-1.5 ${
                  activeTab === 'rate-history'
                    ? 'bg-neutral-950 text-white dark:bg-white dark:text-neutral-950'
                    : 'text-neutral-600 dark:text-neutral-300'
                }`}
              >
                <History className="h-3.5 w-3.5" />
                Rate History ({rateHistory.length})
              </button>
            </div>
          )}

          {isAdmin && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                icon={<FolderPlus className="h-3.5 w-3.5" />}
                onClick={() => {
                  setCatError(null);
                  setEditingCat(null);
                  setCatName('');
                  setCatCode('');
                  setCatDesc('');
                  setCatModalOpen(true);
                }}
              >
                Add Category
              </Button>
              {viewMode === 'sub-services' && (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  icon={<Plus className="h-3.5 w-3.5" />}
                  onClick={() => {
                    setSvcError(null);
                    setEditingSvc(null);
                    setSvcCatId(selectedCatId !== 'ALL' ? selectedCatId : categories[0]?.id || 'CAT-01');
                    setSvcName('');
                    setSvcSubGroup('');
                    setSvcDesc('');
                    setSvcAvailability('Available');
                    setSvcModalOpen(true);
                  }}
                >
                  Add Service
                </Button>
              )}
            </>
          )}
          <Button variant="outline" size="sm" onClick={loadData} loading={loading} icon={<RefreshCw className="h-3.5 w-3.5" />}>
            Refresh
          </Button>
        </div>
      </div>

      {!canEditRates && (
        <div className="px-4 py-2.5 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
          <Lock className="h-4 w-4 text-amber-600 shrink-0" />
          <span>
            Operator Read-Only Rate View: Only ADMIN (or an operator explicitly granted{' '}
            <code className="font-mono">csc.rateEdit</code>) can configure or update service fees.
          </span>
        </div>
      )}

      {viewMode === 'categories' ? (
        <div className="space-y-4">
          {/* Summary Strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4">
              <div className="text-xs text-neutral-500 dark:text-neutral-400">Service Categories</div>
              <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-neutral-950 dark:text-white">
                {categories.length}
              </div>
            </div>
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4">
              <div className="text-xs text-neutral-500 dark:text-neutral-400">Total Sub-Services</div>
              <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-neutral-950 dark:text-white">
                {services.length}
              </div>
            </div>
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4">
              <div className="text-xs text-neutral-500 dark:text-neutral-400">Rates Configured</div>
              <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                {configuredCount}
              </div>
            </div>
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4">
              <div className="text-xs text-neutral-500 dark:text-neutral-400">Pending / Blank Rate</div>
              <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-amber-700 dark:text-amber-400">
                {blankCount}
              </div>
            </div>
          </div>

          {/* Category Search */}
          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-3.5 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <div className="relative flex-1">
              <Search className="h-3.5 w-3.5 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="search"
                value={categorySearch}
                onChange={(e) => setCategorySearch(e.target.value)}
                placeholder="Search service categories by name, code, or description..."
                className="w-full h-9 pl-8 pr-3 text-xs bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
              />
            </div>
            {onNavigate && (
              <Button
                variant="primary"
                size="sm"
                icon={<ArrowRight className="h-3.5 w-3.5" />}
                onClick={() => {
                  updateSelectedCatId('ALL');
                  onNavigate('csc-services');
                }}
              >
                Browse All {services.length} Sub-Services
              </Button>
            )}
          </div>

          {/* Categories Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredCategories.map((cat) => {
              const catServices = services.filter((s) => s.categoryId === cat.id);
              const catConfigured = catServices.filter((s) => s.rateConfigured).length;
              const workflowLink = getWorkflowLinkForCategory(cat);
              return (
                <div
                  key={cat.id}
                  className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 flex flex-col justify-between gap-3 hover:border-neutral-400 dark:hover:border-neutral-600 transition-colors"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                          {cat.code} · #{cat.displayOrder}
                        </div>
                        <h3 className="mt-0.5 text-sm font-semibold text-neutral-950 dark:text-white">
                          {cat.name}
                        </h3>
                      </div>
                      {isAdmin && (
                        <button
                          type="button"
                          title="Edit Category"
                          onClick={() => {
                            setCatError(null);
                            setEditingCat(cat);
                            setCatName(cat.name);
                            setCatCode(cat.code);
                            setCatDesc(cat.description);
                            setCatModalOpen(true);
                          }}
                          className="p-1.5 rounded border border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:text-neutral-950 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer shrink-0"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400 line-clamp-2">
                      {cat.description}
                    </p>
                    {cat.noticeText && (
                      <div className="mt-2 px-2.5 py-1.5 rounded bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-[11px] text-amber-900 dark:text-amber-200">
                        {cat.noticeText}
                      </div>
                    )}
                  </div>

                  <div className="pt-3 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-between gap-2">
                    <div className="text-xs font-mono tabular-nums text-neutral-600 dark:text-neutral-300">
                      <span className="font-semibold text-neutral-950 dark:text-white">
                        {catServices.length}
                      </span>{' '}
                      sub-services ·{' '}
                      <span className="text-emerald-700 dark:text-emerald-400">
                        {catConfigured} rated
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {workflowLink && onNavigate && (
                        <Button
                          variant="outline"
                          size="sm"
                          icon={<workflowLink.Icon className="h-3 w-3" />}
                          onClick={() => onNavigate(workflowLink.page)}
                        >
                          {workflowLink.label}
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<ArrowRight className="h-3 w-3" />}
                        onClick={() => {
                          updateSelectedCatId(cat.id);
                          setActiveTab('catalog');
                          onNavigate?.('csc-services');
                        }}
                      >
                        Sub-Services
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
            {filteredCategories.length === 0 && (
              <div className="md:col-span-2 xl:col-span-3 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-4 py-10 text-center text-xs text-neutral-500">
                No matching service categories found.
              </div>
            )}
          </div>
        </div>
      ) : activeTab === 'catalog' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* 21 Categories Left Rail */}
          <aside className="lg:col-span-4 xl:col-span-3 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-3 space-y-1 max-h-[760px] overflow-y-auto">
            <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
              Categories ({categories.length})
            </div>
            <button
              type="button"
              onClick={() => {
                updateSelectedCatId('ALL');
                setPage(1);
              }}
              className={`w-full px-2.5 py-2 rounded-md text-left text-xs flex items-center justify-between cursor-pointer ${
                selectedCatId === 'ALL'
                  ? 'bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 font-semibold'
                  : 'hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-300'
              }`}
            >
              <span>All Categories</span>
              <span className="font-mono tabular-nums text-[11px]">{services.length}</span>
            </button>
            {categories.map((cat) => {
              const count = services.filter((s) => s.categoryId === cat.id).length;
              const active = selectedCatId === cat.id;
              return (
                <div key={cat.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      updateSelectedCatId(cat.id);
                      setPage(1);
                    }}
                    className={`flex-1 min-w-0 px-2.5 py-2 rounded-md text-left text-xs flex items-center justify-between gap-2 cursor-pointer ${
                      active
                        ? 'bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 font-semibold'
                        : 'hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-300'
                    }`}
                  >
                    <span className="truncate">{cat.name}</span>
                    <span className="font-mono tabular-nums text-[11px] shrink-0">{count}</span>
                  </button>
                  {isAdmin && (
                    <button
                      type="button"
                      title="Edit Category"
                      onClick={() => {
                        setCatError(null);
                        setEditingCat(cat);
                        setCatName(cat.name);
                        setCatCode(cat.code);
                        setCatDesc(cat.description);
                        setCatModalOpen(true);
                      }}
                      className="p-1.5 rounded text-neutral-400 hover:text-neutral-950 dark:hover:text-white cursor-pointer shrink-0"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </aside>

          {/* Services Table */}
          <section className="lg:col-span-8 xl:col-span-9 space-y-3">
            {selectedCategoryObj?.noticeText && (
              <div className="px-4 py-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-lg text-xs text-amber-900 dark:text-amber-200 font-medium">
                Compliance Notice ({selectedCategoryObj.name}): {selectedCategoryObj.noticeText}
              </div>
            )}

            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-3.5 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
              <div className="relative flex-1">
                <Search className="h-3.5 w-3.5 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Search 550+ services by name, code, sub-group..."
                  className="w-full h-9 pl-8 pr-3 text-xs bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
                />
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {(['ALL', 'CONFIGURED', 'BLANK'] as const).map((rf) => (
                  <button
                    key={rf}
                    type="button"
                    onClick={() => {
                      setRateFilter(rf);
                      setPage(1);
                    }}
                    className={`px-2.5 h-8 rounded text-xs font-medium cursor-pointer whitespace-nowrap ${
                      rateFilter === rf
                        ? 'bg-neutral-950 text-white dark:bg-white dark:text-neutral-950'
                        : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300'
                    }`}
                  >
                    {rf === 'ALL' ? 'All Rates' : rf === 'CONFIGURED' ? 'Rate Set' : 'Blank Rate'}
                  </button>
                ))}
              </div>
            </div>

            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead className="bg-neutral-50 dark:bg-neutral-950 border-b border-neutral-200 dark:border-neutral-800 text-neutral-500">
                    <tr>
                      <th className="px-3.5 py-2.5 font-semibold">Code / Service</th>
                      <th className="px-3.5 py-2.5 font-semibold">Category</th>
                      <th className="px-3.5 py-2.5 font-semibold text-right">Service Charge</th>
                      <th className="px-3.5 py-2.5 font-semibold text-right">Govt Fee</th>
                      <th className="px-3.5 py-2.5 font-semibold text-right">Total</th>
                      <th className="px-3.5 py-2.5 font-semibold">Unit Type</th>
                      <th className="px-3.5 py-2.5 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                    {paginated.items.map((svc) => (
                      <tr key={svc.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800/40">
                        <td className="px-3.5 py-2.5 max-w-xs">
                          <div className="font-mono text-[11px] text-neutral-500">{svc.code}</div>
                          <div className="font-medium text-neutral-950 dark:text-white">{svc.name}</div>
                          {svc.subGroup && (
                            <div className="text-[11px] text-neutral-500">{svc.subGroup}</div>
                          )}
                        </td>
                        <td className="px-3.5 py-2.5 text-neutral-600 dark:text-neutral-300">
                          <div>{svc.categoryName}</div>
                          <div className="text-[11px] text-neutral-400">
                            {svc.availability} · {svc.active ? 'Active' : 'Inactive'}
                          </div>
                        </td>
                        <td className="px-3.5 py-2.5 text-right font-mono tabular-nums">
                          {svc.serviceCharge !== null ? formatINR(svc.serviceCharge) : <span className="text-neutral-400">— Blank</span>}
                        </td>
                        <td className="px-3.5 py-2.5 text-right font-mono tabular-nums">
                          {svc.govtFee !== null ? formatINR(svc.govtFee) : <span className="text-neutral-400">— Blank</span>}
                        </td>
                        <td className="px-3.5 py-2.5 text-right font-mono tabular-nums font-semibold">
                          {svc.rateConfigured && svc.totalAmount !== null ? (
                            <span className="text-emerald-700 dark:text-emerald-400">{formatINR(svc.totalAmount)}</span>
                          ) : (
                            <span className="text-amber-700 dark:text-amber-400 font-normal">Rate Not Set</span>
                          )}
                        </td>
                        <td className="px-3.5 py-2.5 text-neutral-600 dark:text-neutral-300 whitespace-nowrap">
                          {svc.unitType || '—'}
                        </td>
                        <td className="px-3.5 py-2.5 text-right">
                          <div className="inline-flex items-center justify-end gap-1.5 flex-wrap">
                            {canEditRates && (
                              <Button
                                variant={svc.rateConfigured ? 'outline' : 'primary'}
                                size="sm"
                                onClick={() => openRateModal(svc)}
                                icon={<IndianRupee className="h-3 w-3" />}
                              >
                                {svc.rateConfigured ? 'Edit Rate' : 'Set Rate'}
                              </Button>
                            )}
                            {isAdmin && (
                              <>
                                <button
                                  type="button"
                                  title="Edit Service Details"
                                  onClick={() => {
                                    setSvcError(null);
                                    setEditingSvc(svc);
                                    setSvcCatId(svc.categoryId);
                                    setSvcName(svc.name);
                                    setSvcSubGroup(svc.subGroup || '');
                                    setSvcDesc(svc.description);
                                    setSvcDocs(svc.requiredDocuments.join(', '));
                                    setSvcAvailability(svc.availability);
                                    setSvcModalOpen(true);
                                  }}
                                  className="p-1.5 rounded border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
                                >
                                  <Edit3 className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  title="Duplicate Service (Starts with Blank Rate)"
                                  onClick={() => handleDuplicate(svc)}
                                  className="p-1.5 rounded border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                </button>
                              </>
                            )}
                            {(() => {
                              const wf = getWorkflowLinkForService(svc);
                              if (!wf || !onNavigate) return null;
                              const WfIcon = wf.Icon;
                              return (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => onNavigate(wf.page)}
                                  icon={<WfIcon className="h-3 w-3" />}
                                >
                                  {wf.label}
                                </Button>
                              );
                            })()}
                            {onStartOrderForService && svc.rateConfigured && (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => onStartOrderForService(svc.id)}
                                icon={<ShoppingCart className="h-3 w-3" />}
                              >
                                Order
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {paginated.items.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-4 py-10 text-center text-neutral-500">
                          No matching CSC services found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-3 border-t border-neutral-100 dark:border-neutral-800">
                <Pagination
                  pagination={paginated.pagination}
                  onPageChange={setPage}
                />
              </div>
            </div>
          </section>
        </div>
      ) : (
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-neutral-950 dark:text-white">
              Immutable Rate Change Audit Log
            </h3>
            <span className="text-xs text-neutral-500">
              Historical orders retain original snapshots automatically
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="bg-neutral-50 dark:bg-neutral-950 border-b border-neutral-200 dark:border-neutral-800 text-neutral-500">
                <tr>
                  <th className="px-3.5 py-2.5">Date</th>
                  <th className="px-3.5 py-2.5">Service</th>
                  <th className="px-3.5 py-2.5 text-right">Old Total</th>
                  <th className="px-3.5 py-2.5 text-right">New Total</th>
                  <th className="px-3.5 py-2.5">Unit Type</th>
                  <th className="px-3.5 py-2.5">Admin</th>
                  <th className="px-3.5 py-2.5">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {rateHistory.map((h) => (
                  <tr key={h.id}>
                    <td className="px-3.5 py-2.5 font-mono text-neutral-500 whitespace-nowrap">
                      {formatDateTimeIST(h.changedAt)}
                    </td>
                    <td className="px-3.5 py-2.5">
                      <div className="font-medium text-neutral-950 dark:text-white">{h.serviceName}</div>
                      <div className="text-[11px] font-mono text-neutral-500">
                        {h.serviceCode} · {h.categoryName}
                      </div>
                    </td>
                    <td className="px-3.5 py-2.5 text-right font-mono tabular-nums text-neutral-500">
                      {h.oldTotalAmount !== null ? formatINR(h.oldTotalAmount) : 'Blank'}
                    </td>
                    <td className="px-3.5 py-2.5 text-right font-mono tabular-nums font-semibold text-emerald-700 dark:text-emerald-400">
                      {formatINR(h.newTotalAmount)}
                    </td>
                    <td className="px-3.5 py-2.5 whitespace-nowrap">{h.newUnitType}</td>
                    <td className="px-3.5 py-2.5 font-mono">{h.adminId}</td>
                    <td className="px-3.5 py-2.5 text-neutral-600 dark:text-neutral-300">
                      {h.changeReason} (Eff. {formatDateIST(h.effectiveDate)})
                    </td>
                  </tr>
                ))}
                {rateHistory.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-neutral-500">
                      No rate updates recorded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Dynamic Rate Configuration Modal */}
      <Modal
        isOpen={Boolean(rateModalService)}
        onClose={() => {
          setRateError(null);
          setRateModalService(null);
        }}
        title={`Configure Rate — ${rateModalService?.name || ''}`}
      >
        <form onSubmit={handleSaveRate} className="space-y-4 text-xs" noValidate>
          {rateError && (
            <div role="alert" className="px-3 py-2 rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300">
              {rateError}
            </div>
          )}
          <div className="p-3 rounded bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800">
            <div className="font-mono text-[11px] text-neutral-500">
              {rateModalService?.code} · {rateModalService?.categoryName}
            </div>
            <div className="mt-1 text-neutral-700 dark:text-neutral-300">
              Total Amount = Service Charge + Government Fee. Updating rate applies only to future orders.
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-medium mb-1">Service Charge (INR ₹) *</label>
              <input
                type="number"
                step="0.01"
                min="0"
                required
                value={rateServiceCharge}
                onChange={(e) => setRateServiceCharge(e.target.value)}
                placeholder="e.g. 50"
                className="w-full h-9 px-3 font-mono bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Government Fee (INR ₹) *</label>
              <input
                type="number"
                step="0.01"
                min="0"
                required
                value={rateGovtFee}
                onChange={(e) => setRateGovtFee(e.target.value)}
                placeholder="0"
                className="w-full h-9 px-3 font-mono bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded"
              />
            </div>
          </div>

          <div className="p-3 rounded bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 flex items-center justify-between">
            <span className="font-medium text-emerald-900 dark:text-emerald-200">
              Computed Total Amount
            </span>
            <span className="text-base font-bold font-mono tabular-nums text-emerald-700 dark:text-emerald-300">
              {formatINR((Number(rateServiceCharge) || 0) + (Number(rateGovtFee) || 0))}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-medium mb-1">Unit Type *</label>
              <select
                value={rateUnitType}
                onChange={(e) => setRateUnitType(e.target.value as UnitType)}
                className="w-full h-9 px-2.5 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded"
              >
                {ALL_UNIT_TYPES.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium mb-1">Effective Date *</label>
              <input
                type="date"
                required
                value={rateEffectiveDate}
                onChange={(e) => setRateEffectiveDate(e.target.value)}
                className="w-full h-9 px-2.5 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded"
              />
            </div>
          </div>

          <div>
            <label className="block font-medium mb-1">Change Reason</label>
            <input
              type="text"
              value={rateReason}
              onChange={(e) => setRateReason(e.target.value)}
              placeholder="e.g. Standard center tariff effective Nov 2026"
              className="w-full h-9 px-3 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setRateModalService(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={savingRate}>
              Save Dynamic Rate
            </Button>
          </div>
        </form>
      </Modal>

      {/* Category Modal */}
      <Modal
        isOpen={catModalOpen}
        onClose={() => {
          setCatError(null);
          setCatModalOpen(false);
        }}
        title={editingCat ? 'Edit Category' : 'Add Service Category'}
      >
        <form onSubmit={handleSaveCategory} className="space-y-3 text-xs" noValidate>
          {catError && (
            <div role="alert" className="px-3 py-2 rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300">
              {catError}
            </div>
          )}
          <div>
            <label className="block font-medium mb-1">Category Name *</label>
            <input
              type="text"
              required
              value={catName}
              onChange={(e) => {
                setCatError(null);
                setCatName(e.target.value);
              }}
              className="w-full h-9 px-3 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">Category Code</label>
            <input
              type="text"
              value={catCode}
              onChange={(e) => setCatCode(e.target.value)}
              placeholder="Optional auto-generated"
              className="w-full h-9 px-3 font-mono bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">Description</label>
            <textarea
              rows={3}
              value={catDesc}
              onChange={(e) => setCatDesc(e.target.value)}
              className="w-full p-2.5 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setCatError(null);
                setCatModalOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={savingCat}>
              Save Category
            </Button>
          </div>
        </form>
      </Modal>

      {/* Service Modal */}
      <Modal
        isOpen={svcModalOpen}
        onClose={() => {
          setSvcError(null);
          setSvcModalOpen(false);
        }}
        title={editingSvc ? 'Edit CSC Service' : 'Create CSC Service (Starts with Blank Rate)'}
      >
        <form onSubmit={handleSaveService} className="space-y-3 text-xs" noValidate>
          {svcError && (
            <div role="alert" className="px-3 py-2 rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300">
              {svcError}
            </div>
          )}
          {!editingSvc && (
            <div>
              <label className="block font-medium mb-1">Category *</label>
              <select
                value={svcCatId}
                onChange={(e) => setSvcCatId(e.target.value)}
                className="w-full h-9 px-2.5 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded"
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="block font-medium mb-1">Service Name *</label>
            <input
              type="text"
              required
              value={svcName}
              onChange={(e) => {
                setSvcError(null);
                setSvcName(e.target.value);
              }}
              className="w-full h-9 px-3 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">Sub-Group (Optional)</label>
            <input
              type="text"
              value={svcSubGroup}
              onChange={(e) => setSvcSubGroup(e.target.value)}
              className="w-full h-9 px-3 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">Required Documents (comma-separated)</label>
            <input
              type="text"
              value={svcDocs}
              onChange={(e) => setSvcDocs(e.target.value)}
              className="w-full h-9 px-3 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded"
            />
          </div>
          {editingSvc && (
            <div>
              <label className="block font-medium mb-1">Availability</label>
              <select
                value={svcAvailability}
                onChange={(e) => setSvcAvailability(e.target.value as 'Available' | 'Unavailable')}
                className="w-full h-9 px-2.5 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded"
              >
                <option value="Available">Available</option>
                <option value="Unavailable">Unavailable</option>
              </select>
            </div>
          )}
          <div>
            <label className="block font-medium mb-1">Description</label>
            <textarea
              rows={2}
              value={svcDesc}
              onChange={(e) => setSvcDesc(e.target.value)}
              className="w-full p-2.5 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setSvcError(null);
                setSvcModalOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={savingSvc}>
              {editingSvc ? 'Update Service' : 'Create (Rate Blank)'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
