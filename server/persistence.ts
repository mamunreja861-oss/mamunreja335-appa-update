import fs from 'node:fs';
import path from 'node:path';
import type { CscStore } from './cscStore.js';
import type { ErpSnapshot, ErpStore } from './erpStore.js';
import type { FinanceStore } from './finance/financeStore.js';
import type { Phase03Store } from './phase03Store.js';
import type { Phase08Store } from './phase08/phase08Store.js';
import type { QaStore } from './phase09/qaStore.js';
import type { ReportStore } from './reports/reportStore.js';
import type { SecurityStore } from './securityStore.js';

export interface RuntimeExtraStores {
  filePath?: string;
  cscStore?: CscStore;
  financeStore?: FinanceStore;
  reportStore?: ReportStore;
  phase08Store?: Phase08Store;
  qaStore?: QaStore;
  hydratePhase03?: boolean;
}

export interface PersistedRuntimeState {
  version: 1;
  savedAt: string;
  erp: ErpSnapshot;
  docSequence?: {
    counters: Record<string, number>;
    issued: string[];
  };
  phase03?: ReturnType<Phase03Store['exportSnapshot']>;
  csc?: ReturnType<CscStore['exportSnapshot']>;
  finance?: ReturnType<FinanceStore['exportSnapshot']>;
  reports?: ReturnType<ReportStore['exportSnapshot']>;
  phase08?: ReturnType<Phase08Store['exportSnapshot']>;
  qa?: ReturnType<QaStore['exportSnapshot']>;
}

export interface PersistedSecurityState {
  version: 1;
  savedAt: string;
  security: ReturnType<SecurityStore['exportAuthSnapshot']>;
  passwordHistory?: Record<string, string[]>;
  integrations?: ReturnType<Phase03Store['exportIntegrationsSnapshot']>;
}

export function isDiskPersistenceEnabled(): boolean {
  if (process.env.MUN_PERSISTENCE_PATH || process.env.MUN_SECURITY_PERSISTENCE_PATH) return true;
  if (process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT)) {
    return false;
  }
  return true;
}

export function resolvePersistenceFilePath(): string {
  if (process.env.MUN_PERSISTENCE_PATH) {
    return path.resolve(process.env.MUN_PERSISTENCE_PATH);
  }
  const preferredDir = path.resolve(process.cwd(), 'storage');
  try {
    fs.mkdirSync(preferredDir, { recursive: true });
    fs.accessSync(preferredDir, fs.constants.W_OK);
    return path.join(preferredDir, 'erp-state.json');
  } catch {
    return '/tmp/mun-erp-state.json';
  }
}

export function resolveSecurityPersistenceFilePath(): string {
  if (process.env.MUN_SECURITY_PERSISTENCE_PATH) {
    return path.resolve(process.env.MUN_SECURITY_PERSISTENCE_PATH);
  }
  if (process.env.MUN_PERSISTENCE_PATH) {
    const resolvedErp = path.resolve(process.env.MUN_PERSISTENCE_PATH);
    return path.join(path.dirname(resolvedErp), 'security-state.json');
  }
  const preferredDir = path.resolve(process.cwd(), 'storage');
  try {
    fs.mkdirSync(preferredDir, { recursive: true });
    fs.accessSync(preferredDir, fs.constants.W_OK);
    return path.join(preferredDir, 'security-state.json');
  } catch {
    return '/tmp/mun-security-state.json';
  }
}

export function hydrateSecurityStoreFromDisk(
  securityStore: SecurityStore,
  filePath = resolveSecurityPersistenceFilePath()
): PersistedSecurityState | null {
  if (!isDiskPersistenceEnabled()) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as PersistedSecurityState;
    if (!parsed || typeof parsed !== 'object' || !parsed.security) return null;
    securityStore.hydrateAuthSnapshot(parsed.security);
    return parsed;
  } catch (err) {
    console.warn('[Security Persistence Hydrate Warning]', err instanceof Error ? err.message : err);
    return null;
  }
}

export function hydratePasswordHistoryIntoPhase08Store(
  phase08Store: Phase08Store,
  persisted: PersistedSecurityState | null
): void {
  if (!persisted?.passwordHistory || typeof persisted.passwordHistory !== 'object') return;
  for (const [userId, hashes] of Object.entries(persisted.passwordHistory)) {
    if (!Array.isArray(hashes)) continue;
    const validHashes = hashes.filter((h): h is string => typeof h === 'string' && h.length > 0);
    if (validHashes.length > 0) {
      phase08Store.passwordHistory.set(
        userId,
        validHashes.slice(0, phase08Store.settings.passwordHistoryCount)
      );
    }
  }
}

export function hydratePhase03IntegrationsFromDisk(
  phase03Store: Phase03Store,
  persisted: PersistedSecurityState | null
): void {
  if (!persisted?.integrations) return;
  phase03Store.hydrateIntegrationsSnapshot(persisted.integrations);
}

export function saveSecurityStoreToDisk(
  securityStore: SecurityStore,
  phase08Store?: Phase08Store,
  phase03Store?: Phase03Store,
  filePath = resolveSecurityPersistenceFilePath()
): boolean {
  if (!isDiskPersistenceEnabled()) return false;
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const passwordHistory: Record<string, string[]> = {};
    if (phase08Store) {
      for (const [userId, hashes] of phase08Store.passwordHistory.entries()) {
        passwordHistory[userId] = [...hashes];
      }
    }
    const payload: PersistedSecurityState = {
      version: 1,
      savedAt: new Date().toISOString(),
      security: securityStore.exportAuthSnapshot(),
      passwordHistory,
      ...(phase03Store ? { integrations: phase03Store.exportIntegrationsSnapshot() } : {}),
    };
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    console.warn('[Security Persistence Save Warning]', err instanceof Error ? err.message : err);
    return false;
  }
}

export function hydrateRuntimeStoresFromDisk(
  erpStore: ErpStore | null,
  phase03Store: Phase03Store,
  filePathOrExtra: string | RuntimeExtraStores = resolvePersistenceFilePath()
): boolean {
  if (!isDiskPersistenceEnabled()) return false;
  const opts: RuntimeExtraStores =
    typeof filePathOrExtra === 'string' ? { filePath: filePathOrExtra } : filePathOrExtra;
  const filePath = opts.filePath || resolvePersistenceFilePath();
  try {
    if (!fs.existsSync(filePath)) return false;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return false;
    const parsed = JSON.parse(raw) as PersistedRuntimeState;
    if (!parsed || typeof parsed !== 'object') return false;
    if (parsed.docSequence) {
      phase03Store.docSequence.hydrateState(parsed.docSequence);
    }
    if (opts.hydratePhase03 !== false && parsed.phase03) {
      phase03Store.hydrateSnapshot(parsed.phase03);
    }
    if (erpStore && parsed.erp) {
      erpStore.hydrateSnapshot(parsed.erp);
    }
    if (opts.cscStore && parsed.csc) {
      opts.cscStore.hydrateSnapshot(parsed.csc);
    }
    if (opts.financeStore && parsed.finance) {
      opts.financeStore.hydrateSnapshot(parsed.finance);
    }
    if (opts.reportStore && parsed.reports) {
      opts.reportStore.hydrateSnapshot(parsed.reports);
    }
    if (opts.phase08Store && parsed.phase08) {
      opts.phase08Store.hydrateSnapshot(parsed.phase08);
    }
    if (opts.qaStore && parsed.qa) {
      opts.qaStore.hydrateSnapshot(parsed.qa);
    }
    return true;
  } catch (err) {
    console.warn('[Persistence Hydrate Warning]', err instanceof Error ? err.message : err);
    return false;
  }
}

export function saveRuntimeStoresToDisk(
  erpStore: ErpStore,
  phase03Store: Phase03Store,
  filePathOrExtra: string | RuntimeExtraStores = resolvePersistenceFilePath()
): boolean {
  if (!isDiskPersistenceEnabled()) return false;
  const opts: RuntimeExtraStores =
    typeof filePathOrExtra === 'string' ? { filePath: filePathOrExtra } : filePathOrExtra;
  const filePath = opts.filePath || resolvePersistenceFilePath();
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload: PersistedRuntimeState = {
      version: 1,
      savedAt: new Date().toISOString(),
      erp: erpStore.exportSnapshot(),
      docSequence: phase03Store.docSequence.exportState(),
      phase03: phase03Store.exportSnapshot(),
      ...(opts.cscStore ? { csc: opts.cscStore.exportSnapshot() } : {}),
      ...(opts.financeStore ? { finance: opts.financeStore.exportSnapshot() } : {}),
      ...(opts.reportStore ? { reports: opts.reportStore.exportSnapshot() } : {}),
      ...(opts.phase08Store ? { phase08: opts.phase08Store.exportSnapshot() } : {}),
      ...(opts.qaStore ? { qa: opts.qaStore.exportSnapshot() } : {}),
    };
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    console.warn('[Persistence Save Warning]', err instanceof Error ? err.message : err);
    return false;
  }
}
