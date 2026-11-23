import { ErpCustomerItem } from '../modules/types';
import { normalizeCustomerRecord } from './customerCrmHelpers';

const CUSTOMERS_CACHE_KEY = 'mun_erp_customers_cache_v1';
const CUSTOMER_TOMBSTONES_CACHE_KEY = 'mun_erp_customer_tombstones_v1';
const MAX_CACHED_CUSTOMERS = 2000;
const MAX_CACHED_TOMBSTONES = 2000;

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
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

export function loadCachedCustomerTombstones(): string[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(CUSTOMER_TOMBSTONES_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return Array.from(
      new Set(
        parsed
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
          .map((id) => id.trim())
      )
    );
  } catch {
    return [];
  }
}

function saveTombstones(ids: Iterable<string>): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    const clean = Array.from(
      new Set(
        Array.from(ids)
          .filter((id) => typeof id === 'string' && id.trim().length > 0)
          .map((id) => id.trim())
      )
    ).slice(-MAX_CACHED_TOMBSTONES);
    storage.setItem(CUSTOMER_TOMBSTONES_CACHE_KEY, JSON.stringify(clean));
  } catch {
    // Ignore localStorage quota/private mode errors
  }
}

function mergeTwoCustomerRecords(
  existing: ErpCustomerItem,
  incoming: ErpCustomerItem
): ErpCustomerItem {
  const prevNorm = normalizeCustomerRecord(existing);
  const nextNorm = normalizeCustomerRecord(incoming);
  const prevUpdated = Date.parse(prevNorm.updatedAt || prevNorm.createdAt || '') || 0;
  const nextUpdated = Date.parse(nextNorm.updatedAt || nextNorm.createdAt || '') || 0;
  const primary = nextUpdated >= prevUpdated ? nextNorm : prevNorm;
  const secondary = nextUpdated >= prevUpdated ? prevNorm : nextNorm;

  return normalizeCustomerRecord({
    ...secondary,
    ...primary,
    referenceNo:
      primary.referenceNo ||
      secondary.referenceNo ||
      `MCR-${primary.customerId.replace(/^MCC-/, '')}`,
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
    stats: nextNorm.stats ?? prevNorm.stats,
  });
}

function writeCachedCustomers(list: ErpCustomerItem[]): void {
  const storage = getStorage();
  if (!storage) return;
  const trimmed = list.slice(0, MAX_CACHED_CUSTOMERS);
  try {
    storage.setItem(CUSTOMERS_CACHE_KEY, JSON.stringify(trimmed));
  } catch {
    // Retry with compact copy if quota exceeded
    try {
      const compact = trimmed.slice(0, 500).map((c) => ({
        ...c,
        consentHistory: (c.consentHistory || []).slice(-10),
        contactHistory: (c.contactHistory || []).slice(-10),
        notesAndFollowUps: (c.notesAndFollowUps || []).slice(0, 20),
      }));
      storage.setItem(CUSTOMERS_CACHE_KEY, JSON.stringify(compact));
    } catch {
      // Ignore storage failures
    }
  }
}

export function loadCachedCustomers(): ErpCustomerItem[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(CUSTOMERS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const tombstones = new Set(loadCachedCustomerTombstones());
    const byId = new Map<string, ErpCustomerItem>();
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const cid = String((item as ErpCustomerItem).customerId || '').trim();
      if (!cid || tombstones.has(cid)) continue;
      byId.set(cid, normalizeCustomerRecord(item as ErpCustomerItem));
    }
    return Array.from(byId.values()).sort((a, b) => {
      const aTime = Date.parse(a.createdAt || '') || 0;
      const bTime = Date.parse(b.createdAt || '') || 0;
      if (bTime !== aTime) return bTime - aTime;
      return (b.id || 0) - (a.id || 0);
    });
  } catch {
    return [];
  }
}

export function findCachedCustomer(customerId: string): ErpCustomerItem | null {
  const target = String(customerId || '').trim();
  if (!target) return null;
  return loadCachedCustomers().find((c) => c.customerId === target) ?? null;
}

export function getMaxCachedCustomerSequence(fy = getCurrentFinancialYearString()): number {
  const prefix = `MCC-${fy}-`;
  let maxSeq = 0;
  for (const c of loadCachedCustomers()) {
    const cid = String(c.customerId || '').trim();
    if (cid.startsWith(prefix)) {
      const suffix = cid.slice(prefix.length);
      if (/^\d+$/.test(suffix)) {
        maxSeq = Math.max(maxSeq, Number(suffix));
      }
    }
  }
  return maxSeq;
}

export function upsertCachedCustomer(
  customer: ErpCustomerItem,
  options?: { allowUntombstone?: boolean }
): ErpCustomerItem {
  const normalized = normalizeCustomerRecord(customer);
  if (!normalized.customerId) return normalized;

  const tombstones = new Set(loadCachedCustomerTombstones());
  if (options?.allowUntombstone) {
    tombstones.delete(normalized.customerId);
    saveTombstones(tombstones);
  } else if (tombstones.has(normalized.customerId)) {
    return normalized;
  }

  const existingList = loadCachedCustomers();
  const byId = new Map<string, ErpCustomerItem>();
  for (const item of existingList) {
    byId.set(item.customerId, item);
  }
  const existing = byId.get(normalized.customerId);
  const merged = existing ? mergeTwoCustomerRecords(existing, normalized) : normalized;
  byId.set(merged.customerId, merged);

  const next = Array.from(byId.values()).sort((a, b) => {
    const aTime = Date.parse(a.createdAt || '') || 0;
    const bTime = Date.parse(b.createdAt || '') || 0;
    if (bTime !== aTime) return bTime - aTime;
    return (b.id || 0) - (a.id || 0);
  });
  writeCachedCustomers(next);
  return merged;
}

export function upsertCachedCustomers(
  customers: ErpCustomerItem[],
  options?: { deletedIds?: string[] }
): ErpCustomerItem[] {
  const tombstones = new Set(loadCachedCustomerTombstones());
  for (const delId of options?.deletedIds ?? []) {
    if (typeof delId === 'string' && delId.trim()) {
      tombstones.add(delId.trim());
    }
  }
  if (options?.deletedIds?.length) {
    saveTombstones(tombstones);
  }

  const byId = new Map<string, ErpCustomerItem>();
  for (const existing of loadCachedCustomers()) {
    if (!tombstones.has(existing.customerId)) {
      byId.set(existing.customerId, existing);
    }
  }

  for (const raw of customers) {
    if (!raw?.customerId || tombstones.has(raw.customerId)) continue;
    const norm = normalizeCustomerRecord(raw);
    const prev = byId.get(norm.customerId);
    byId.set(norm.customerId, prev ? mergeTwoCustomerRecords(prev, norm) : norm);
  }

  const sorted = Array.from(byId.values()).sort((a, b) => {
    const aTime = Date.parse(a.createdAt || '') || 0;
    const bTime = Date.parse(b.createdAt || '') || 0;
    if (bTime !== aTime) return bTime - aTime;
    return (b.id || 0) - (a.id || 0);
  });
  writeCachedCustomers(sorted);
  return sorted;
}

export function markCustomerTombstoned(customerId: string): void {
  const cleanId = String(customerId || '').trim();
  if (!cleanId) return;
  const tombstones = new Set(loadCachedCustomerTombstones());
  tombstones.add(cleanId);
  saveTombstones(tombstones);

  const remaining = loadCachedCustomers().filter((c) => c.customerId !== cleanId);
  writeCachedCustomers(remaining);
}

export function reconcileTombstonesFromServer(serverDeletedIds: string[]): string[] {
  const tombstones = new Set(loadCachedCustomerTombstones());
  let changed = false;
  for (const id of serverDeletedIds) {
    const clean = String(id || '').trim();
    if (clean && !tombstones.has(clean)) {
      tombstones.add(clean);
      changed = true;
    }
  }
  if (changed) {
    saveTombstones(tombstones);
    const remaining = loadCachedCustomers().filter((c) => !tombstones.has(c.customerId));
    writeCachedCustomers(remaining);
  }
  return Array.from(tombstones);
}
