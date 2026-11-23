import { BRAND } from '../assets/brand';

export interface RemoteVersionManifest {
  version: string;
  baseVersion?: string;
  buildId: string;
  builtAt?: string;
  commitSha?: string | null;
}

export interface AutoUpdateDetectedInfo {
  currentVersion: string;
  currentBuildId: string;
  nextVersion: string;
  nextBuildId: string;
  builtAt?: string;
}

const POLL_INTERVAL_MS = 60_000;
const INITIAL_DELAY_MS = 4_000;
const MIN_CHECK_GAP_MS = 15_000;
const RELOAD_COOLDOWN_MS = 30_000;
const RELOAD_GUARD_KEY = 'mun_auto_update_guard';

let lastCheckedAtMs = 0;
let pendingReloadTimer: ReturnType<typeof setTimeout> | null = null;
let updateDetected = false;

function isUserTypingInField(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  return Boolean(el.isContentEditable);
}

function canAttemptReloadForBuild(targetBuildId: string): boolean {
  if (typeof window === 'undefined' || !window.sessionStorage) return true;
  try {
    const raw = window.sessionStorage.getItem(RELOAD_GUARD_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw) as { buildId?: string; ts?: number };
    if (
      parsed.buildId === targetBuildId &&
      typeof parsed.ts === 'number' &&
      Date.now() - parsed.ts < RELOAD_COOLDOWN_MS
    ) {
      return false;
    }
  } catch {
    // Ignore storage errors
  }
  return true;
}

function markReloadAttempt(targetBuildId: string): void {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    window.sessionStorage.setItem(
      RELOAD_GUARD_KEY,
      JSON.stringify({ buildId: targetBuildId, ts: Date.now() })
    );
  } catch {
    // Ignore storage errors
  }
}

export async function applyAppUpdateNow(targetBuildId = 'latest'): Promise<void> {
  if (typeof window === 'undefined') return;
  if (!canAttemptReloadForBuild(targetBuildId)) return;
  markReloadAttempt(targetBuildId);

  try {
    if ('caches' in window && window.caches) {
      const keys = await window.caches.keys();
      await Promise.all(keys.map((key) => window.caches.delete(key)));
    }
  } catch {
    // Ignore CacheStorage cleanup errors
  }

  window.location.reload();
}

async function fetchManifestUrl(url: string): Promise<RemoteVersionManifest | null> {
  try {
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
      },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return null;

    const payload = (await res.json()) as
      | RemoteVersionManifest
      | { success?: boolean; data?: RemoteVersionManifest };

    const manifest =
      payload && typeof payload === 'object' && 'data' in payload && payload.data
        ? payload.data
        : (payload as RemoteVersionManifest);

    if (!manifest || typeof manifest.buildId !== 'string' || typeof manifest.version !== 'string') {
      return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

export async function fetchRemoteVersionManifest(): Promise<RemoteVersionManifest | null> {
  const fromStatic = await fetchManifestUrl('/version.json');
  if (fromStatic) return fromStatic;
  return fetchManifestUrl('/api/version');
}

export async function checkForAppUpdate(force = false): Promise<AutoUpdateDetectedInfo | null> {
  if (typeof window === 'undefined') return null;
  const now = Date.now();
  if (!force && now - lastCheckedAtMs < MIN_CHECK_GAP_MS) {
    return null;
  }
  lastCheckedAtMs = now;

  const remote = await fetchRemoteVersionManifest();
  if (!remote) return null;

  const currentBuildId = BRAND.buildId;
  if (
    !currentBuildId ||
    currentBuildId === 'dev' ||
    !remote.buildId ||
    remote.buildId === 'dev'
  ) {
    return null;
  }

  if (remote.buildId === currentBuildId) {
    return null;
  }

  return {
    currentVersion: BRAND.version,
    currentBuildId,
    nextVersion: remote.version,
    nextBuildId: remote.buildId,
    builtAt: remote.builtAt,
  };
}

function scheduleAutoReload(targetBuildId: string): void {
  if (pendingReloadTimer || !canAttemptReloadForBuild(targetBuildId)) return;

  const runReload = () => {
    pendingReloadTimer = null;
    if (isUserTypingInField()) {
      const onBlur = () => {
        window.removeEventListener('blur', onBlur, true);
        void applyAppUpdateNow(targetBuildId);
      };
      window.addEventListener('blur', onBlur, true);
      pendingReloadTimer = setTimeout(() => {
        window.removeEventListener('blur', onBlur, true);
        void applyAppUpdateNow(targetBuildId);
      }, 15_000);
      return;
    }
    void applyAppUpdateNow(targetBuildId);
  };

  pendingReloadTimer = setTimeout(runReload, 1_500);
}

export function startAutoUpdater(
  onUpdateDetected?: (info: AutoUpdateDetectedInfo) => void
): () => void {
  if (typeof window === 'undefined') return () => {};

  let active = true;

  const runCheck = async (force = false) => {
    if (!active || updateDetected) return;
    const info = await checkForAppUpdate(force);
    if (!active || !info || updateDetected) return;
    if (!canAttemptReloadForBuild(info.nextBuildId)) return;

    updateDetected = true;
    onUpdateDetected?.(info);
    scheduleAutoReload(info.nextBuildId);
  };

  const initialTimer = setTimeout(() => {
    void runCheck(true);
  }, INITIAL_DELAY_MS);

  const pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      void runCheck(false);
    }
  }, POLL_INTERVAL_MS);

  const handleVisibility = () => {
    if (document.visibilityState === 'visible') {
      void runCheck(false);
    }
  };
  const handleFocus = () => {
    void runCheck(false);
  };
  const handleOnline = () => {
    void runCheck(true);
  };
  const handleChunkError = (event: Event) => {
    const message =
      event instanceof ErrorEvent
        ? event.message
        : event instanceof PromiseRejectionEvent
          ? String(event.reason || '')
          : '';
    if (
      event.type === 'vite:preloadError' ||
      /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk/i.test(
        message
      )
    ) {
      void applyAppUpdateNow('chunk-recovery');
    }
  };

  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('focus', handleFocus);
  window.addEventListener('online', handleOnline);
  window.addEventListener('vite:preloadError', handleChunkError);
  window.addEventListener('unhandledrejection', handleChunkError);

  return () => {
    active = false;
    clearTimeout(initialTimer);
    clearInterval(pollTimer);
    if (pendingReloadTimer) {
      clearTimeout(pendingReloadTimer);
      pendingReloadTimer = null;
    }
    document.removeEventListener('visibilitychange', handleVisibility);
    window.removeEventListener('focus', handleFocus);
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('vite:preloadError', handleChunkError);
    window.removeEventListener('unhandledrejection', handleChunkError);
  };
}
