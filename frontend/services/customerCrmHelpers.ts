import { CustomerSegment } from '../modules/types';
import { ErpCustomerItem } from './erpApi';
import { isSafeRemotePhotoUrl, maskAadhaarValue } from '../utils/customerValidation';

const VALID_SEGMENTS: CustomerSegment[] = [
  'Regular',
  'General',
  'VIP',
  'Individual',
  'Corporate',
  'Government',
];

export function normalizeCustomerSegment(value: unknown): CustomerSegment {
  const raw = String(value ?? '').trim();
  const matched = VALID_SEGMENTS.find((seg) => seg.toLowerCase() === raw.toLowerCase());
  return matched ?? 'Regular';
}

export function isCustomerArchived(customer: Partial<ErpCustomerItem>): boolean {
  if (customer.isArchived === true) return true;
  if (typeof customer.deletedAt === 'string' && customer.deletedAt.trim().length > 0) {
    return true;
  }
  return false;
}

export function normalizeCustomerRecord(c: ErpCustomerItem): ErpCustomerItem {
  const fullName = String(c.fullName || c.name || '').trim();
  const panNumber = c.panNumber || c.pan ? String(c.panNumber || c.pan).trim().toUpperCase() : undefined;
  const rawAadhaar = c.aadhaarMasked || c.aadhaar ? String(c.aadhaarMasked || c.aadhaar).trim() : '';
  const aadhaarMasked = rawAadhaar ? maskAadhaarValue(rawAadhaar) || undefined : undefined;
  const totalBusiness = Number(c.stats?.totalPaid ?? c.totalBusiness ?? 0) || 0;
  const archived = isCustomerArchived(c);
  const status =
    c.status === 'Inactive' || c.status === 'Blocked' || c.status === 'Active'
      ? c.status
      : 'Active';
  const rawPhotoUrl = String(c.photoDownloadURL || c.photoUrl || '').trim();
  const safePhotoUrl = isSafeRemotePhotoUrl(rawPhotoUrl) ? rawPhotoUrl : undefined;
  const photoStoragePath =
    typeof c.photoStoragePath === 'string' && c.photoStoragePath.trim().length > 0
      ? c.photoStoragePath.trim()
      : undefined;

  return {
    ...c,
    referenceNo:
      c.referenceNo ||
      (c.customerId ? `MCR-${c.customerId.replace(/^MCC-/, '')}` : undefined),
    fullName,
    name: fullName,
    panNumber,
    pan: panNumber,
    aadhaarMasked,
    aadhaar: aadhaarMasked,
    photoStoragePath,
    photoDownloadURL: safePhotoUrl,
    photoUrl: safePhotoUrl,
    totalBusiness,
    isArchived: archived,
    deletedAt: archived ? c.deletedAt ?? new Date().toISOString() : null,
    status,
    segment: normalizeCustomerSegment(c.segment),
    createdAt: c.createdAt || new Date().toISOString(),
  };
}

export function mergeCustomerLists(params: {
  firestoreCustomers: ErpCustomerItem[];
  apiCustomers: ErpCustomerItem[];
  cachedCustomers?: ErpCustomerItem[];
  optimisticCustomers?: ErpCustomerItem[];
  deletedCustomerIds?: string[];
}): ErpCustomerItem[] {
  const deletedSet = new Set(params.deletedCustomerIds ?? []);
  const byId = new Map<string, ErpCustomerItem>();

  const upsertRichRecord = (raw: ErpCustomerItem, preferIncomingOnTie: boolean) => {
    if (!raw?.customerId || deletedSet.has(raw.customerId)) return;
    const incoming = normalizeCustomerRecord(raw);
    const existing = byId.get(incoming.customerId);
    if (!existing) {
      byId.set(incoming.customerId, incoming);
      return;
    }

    const existingUpdated = Date.parse(existing.updatedAt || existing.createdAt || '') || 0;
    const incomingUpdated = Date.parse(incoming.updatedAt || incoming.createdAt || '') || 0;
    const preferIncoming =
      (preferIncomingOnTie ? incomingUpdated >= existingUpdated : incomingUpdated > existingUpdated) ||
      Boolean(incoming.deletedAt && !existing.deletedAt && incomingUpdated >= existingUpdated);

    const primary = preferIncoming ? incoming : existing;
    const secondary = preferIncoming ? existing : incoming;

    byId.set(
      incoming.customerId,
      normalizeCustomerRecord({
        ...secondary,
        ...primary,
        referenceNo:
          primary.referenceNo ||
          secondary.referenceNo ||
          `MCR-${incoming.customerId.replace(/^MCC-/, '')}`,
        photoStoragePath: primary.photoStoragePath || secondary.photoStoragePath,
        photoDownloadURL:
          primary.photoDownloadURL ||
          primary.photoUrl ||
          secondary.photoDownloadURL ||
          secondary.photoUrl,
        photoUrl:
          primary.photoDownloadURL ||
          primary.photoUrl ||
          secondary.photoDownloadURL ||
          secondary.photoUrl,
        aadhaarMasked: primary.aadhaarMasked || secondary.aadhaarMasked,
        panNumber: primary.panNumber || secondary.panNumber,
        consents:
          Array.isArray(primary.consents) && primary.consents.length > 0
            ? primary.consents
            : secondary.consents,
        consentHistory:
          Array.isArray(primary.consentHistory) && primary.consentHistory.length > 0
            ? primary.consentHistory
            : secondary.consentHistory,
        contactHistory:
          Array.isArray(primary.contactHistory) && primary.contactHistory.length > 0
            ? primary.contactHistory
            : secondary.contactHistory,
        notesAndFollowUps:
          Array.isArray(primary.notesAndFollowUps) && primary.notesAndFollowUps.length > 0
            ? primary.notesAndFollowUps
            : secondary.notesAndFollowUps,
        stats: incoming.stats ?? existing.stats,
        totalBusiness:
          Number(
            incoming.stats?.totalPaid ??
              existing.stats?.totalPaid ??
              primary.totalBusiness ??
              secondary.totalBusiness ??
              0
          ) || 0,
      })
    );
  };

  for (const raw of params.cachedCustomers ?? []) {
    upsertRichRecord(raw, false);
  }

  for (const raw of params.firestoreCustomers) {
    upsertRichRecord(raw, true);
  }

  for (const raw of params.apiCustomers) {
    upsertRichRecord(raw, false);
  }

  for (const raw of params.optimisticCustomers ?? []) {
    upsertRichRecord(raw, true);
  }

  return Array.from(byId.values()).sort((a, b) => {
    const aTime = Date.parse(a.createdAt || '') || 0;
    const bTime = Date.parse(b.createdAt || '') || 0;
    if (bTime !== aTime) return bTime - aTime;
    return (b.id || 0) - (a.id || 0);
  });
}

export interface CustomerFilterCriteria {
  query: string;
  segment: string;
  status: string;
  showArchived: boolean;
}

export function filterCustomers(
  customers: ErpCustomerItem[],
  filters: CustomerFilterCriteria
): ErpCustomerItem[] {
  const q = filters.query.trim().toLowerCase();
  const seg = filters.segment.trim();
  const stat = filters.status.trim();

  return customers.filter((raw) => {
    const c = normalizeCustomerRecord(raw);
    if (!filters.showArchived && isCustomerArchived(c)) return false;

    if (stat && stat !== 'All' && (c.status || 'Active').toLowerCase() !== stat.toLowerCase()) {
      return false;
    }

    if (seg && seg !== 'All' && (c.segment || 'Regular').toLowerCase() !== seg.toLowerCase()) {
      return false;
    }

    if (q) {
      const searchableFields = [
        c.name,
        c.fullName,
        c.mobile,
        c.whatsapp,
        c.customerId,
        c.village,
        c.district,
        c.pan,
        c.panNumber,
      ];
      const matched = searchableFields.some((val) =>
        String(val ?? '').toLowerCase().includes(q)
      );
      if (!matched) return false;
    }

    return true;
  });
}

export interface CustomerSummaryMetrics {
  totalCustomers: number;
  activeCustomers: number;
  vipCustomers: number;
  totalBusiness: number;
}

export function computeCustomerSummaryMetrics(
  customers: ErpCustomerItem[]
): CustomerSummaryMetrics {
  const nonArchived = customers.filter((c) => !isCustomerArchived(c));
  const totalCustomers = nonArchived.length;
  const activeCustomers = nonArchived.filter(
    (c) => String(c.status || 'Active').trim().toLowerCase() === 'active'
  ).length;
  const vipCustomers = nonArchived.filter(
    (c) =>
      String(c.segment || '').trim().toLowerCase() === 'vip' ||
      String(c.crmTag || '').trim().toLowerCase() === 'vip'
  ).length;
  const totalBusiness = nonArchived.reduce(
    (sum, c) => sum + (Number(c.stats?.totalPaid ?? c.totalBusiness ?? 0) || 0),
    0
  );

  return {
    totalCustomers,
    activeCustomers,
    vipCustomers,
    totalBusiness,
  };
}
