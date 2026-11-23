import { useSyncExternalStore } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { UserProfile } from '../modules/types';
import {
  auth,
  db,
  extractFirebaseErrorCode,
  extractFriendlyErrorMessage,
  firebaseInitError,
  isFirebaseConfigured,
  isRetryableFirestoreError,
  testConnection,
  waitForFirebaseAuthReady,
} from './firebase';

export type CloudSyncStatus =
  | 'disabled'
  | 'connecting'
  | 'syncing'
  | 'connected'
  | 'offline'
  | 'error';

export type ModuleSyncPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export interface ModuleSyncState {
  moduleKey: string;
  phase: ModuleSyncPhase;
  count: number;
  errorCode: string | null;
  errorMessage: string | null;
  lastSyncedAt: string | null;
}

export interface CloudSyncSnapshot {
  configured: boolean;
  appAuthenticated: boolean;
  status: CloudSyncStatus;
  user: User | null;
  userUid: string | null;
  userEmail: string | null;
  lastSyncedAt: string | null;
  errorMessage: string | null;
  online: boolean;
  activeWrites: number;
}

const BOOTSTRAPPED_ADMIN_EMAILS = new Set([
  'muncomputer2019@gmail.com',
  'muncomputer786@gmail.com',
  'mamunreja335@gmail.com',
  'maishamart514@gmail.com',
  'mamunreja05@gmail.com',
  'mamunreja861@gmail.com',
]);

let snapshot: CloudSyncSnapshot = {
  configured: isFirebaseConfigured(),
  appAuthenticated: false,
  status:
    typeof navigator !== 'undefined' && navigator.onLine === false
      ? 'offline'
      : 'connecting',
  user: auth?.currentUser ?? null,
  userUid: auth?.currentUser?.uid ?? null,
  userEmail: auth?.currentUser?.email ?? null,
  lastSyncedAt: null,
  errorMessage: firebaseInitError,
  online: typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
  activeWrites: 0,
};

const listeners = new Set<() => void>();
const moduleStates = new Map<string, ModuleSyncState>();
const moduleListeners = new Set<() => void>();
let monitorStarted = false;
let authResolved = false;
let currentAppUser: UserProfile | null = null;
let authUnSub: (() => void) | null = null;
let profileEnsuredForUid: string | null = null;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function notifyModules(): void {
  for (const listener of moduleListeners) {
    listener();
  }
}

export function reportModuleSyncState(
  moduleKey: string,
  state: Partial<ModuleSyncState> & { phase: ModuleSyncPhase }
): void {
  const prev = moduleStates.get(moduleKey);
  const next: ModuleSyncState = {
    moduleKey,
    phase: state.phase,
    count: state.count ?? prev?.count ?? 0,
    errorCode: state.errorCode !== undefined ? state.errorCode : state.phase === 'error' ? prev?.errorCode ?? null : null,
    errorMessage:
      state.errorMessage !== undefined
        ? state.errorMessage
        : state.phase === 'error'
          ? prev?.errorMessage ?? null
          : null,
    lastSyncedAt:
      state.phase === 'ready' || state.phase === 'empty'
        ? state.lastSyncedAt || new Date().toISOString()
        : prev?.lastSyncedAt ?? null,
  };
  moduleStates.set(moduleKey, next);
  notifyModules();
}

export function reportModuleSyncError(moduleKey: string, error: unknown): ModuleSyncState {
  const code = extractFirebaseErrorCode(error) || (snapshot.online ? 'unavailable' : 'offline');
  const message = extractFriendlyErrorMessage(error);
  reportModuleSyncState(moduleKey, {
    phase: 'error',
    errorCode: code,
    errorMessage: message,
  });
  return moduleStates.get(moduleKey)!;
}

export function getModuleSyncState(moduleKey: string): ModuleSyncState {
  return (
    moduleStates.get(moduleKey) || {
      moduleKey,
      phase: 'idle',
      count: 0,
      errorCode: null,
      errorMessage: null,
      lastSyncedAt: null,
    }
  );
}

export function subscribeModuleSyncStates(listener: () => void): () => void {
  moduleListeners.add(listener);
  return () => {
    moduleListeners.delete(listener);
  };
}

export function useModuleSyncState(moduleKey: string): ModuleSyncState {
  return useSyncExternalStore(
    subscribeModuleSyncStates,
    () => getModuleSyncState(moduleKey),
    () => getModuleSyncState(moduleKey)
  );
}

function resolveAutoStatus(
  online: boolean,
  activeWrites: number,
  appAuth: boolean,
  firebaseUser: User | null
): CloudSyncStatus {
  if (!online) return 'offline';
  if (activeWrites > 0) return 'syncing';
  if (firebaseUser) return 'connected';
  if (!snapshot.configured) return 'disabled';
  if (appAuth) return 'connected';
  return 'connecting';
}

function resolveDisconnectedMessage(appAuth: boolean, firebaseUser: User | null): string | null {
  if (firebaseUser) return null;
  if (!snapshot.configured) {
    return firebaseInitError || 'Firebase configuration is missing or invalid.';
  }
  if (appAuth && authResolved) {
    return null;
  }
  return null;
}

function updateSnapshot(patch: Partial<CloudSyncSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  notify();
}

export function getCloudSyncSnapshot(): CloudSyncSnapshot {
  return snapshot;
}

export function subscribeCloudSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCloudSync(): CloudSyncSnapshot {
  return useSyncExternalStore(subscribeCloudSync, getCloudSyncSnapshot, getCloudSyncSnapshot);
}

export function markCloudSyncActivity(active: boolean): void {
  const nextCount = Math.max(0, snapshot.activeWrites + (active ? 1 : -1));
  const nextStatus = resolveAutoStatus(
    snapshot.online,
    nextCount,
    Boolean(currentAppUser),
    snapshot.user
  );
  updateSnapshot({ activeWrites: nextCount, status: nextStatus });
}

export function recordCloudSyncSuccess(): void {
  updateSnapshot({
    status: resolveAutoStatus(
      snapshot.online,
      snapshot.activeWrites,
      Boolean(currentAppUser),
      auth?.currentUser ?? snapshot.user
    ),
    lastSyncedAt: new Date().toISOString(),
    errorMessage: null,
  });
}

export function recordCloudSyncError(message: string): void {
  const clean = message.trim() || 'Cloud database synchronization error.';
  updateSnapshot({
    status: snapshot.online ? 'error' : 'offline',
    errorMessage: clean,
  });
}

export async function ensureFirestoreUserProfile(
  firebaseUser: User,
  appUser?: UserProfile | null
): Promise<void> {
  if (!db) return;
  if (profileEnsuredForUid === firebaseUser.uid) return;
  const userRef = doc(db, 'users', firebaseUser.uid);
  try {
    const existing = await getDoc(userRef);
    if (existing.exists()) {
      profileEnsuredForUid = firebaseUser.uid;
      return;
    }

    const email = (firebaseUser.email || '').trim().toLowerCase();
    const isBootstrapped =
      firebaseUser.uid === '1ftA1pw2Q5b1wxciGoSsNUqQPmF2' ||
      BOOTSTRAPPED_ADMIN_EMAILS.has(email);

    const mappedRole = isBootstrapped ? 'ADMIN' : 'STAFF';
    const needsPwdUpdate = Boolean(
      appUser?.mustChangePassword || appUser?.passwordMigrationRequired || appUser?.isFirstLogin
    );

    const payload = {
      uid: firebaseUser.uid,
      userId: String(appUser?.userId || `MC_${firebaseUser.uid.slice(0, 12)}`).slice(0, 40),
      fullName: String(
        appUser?.fullName || firebaseUser.displayName || email.split('@')[0] || 'MUN User'
      ).slice(0, 120),
      role: mappedRole,
      status: 'ACTIVE',
      branch: String(appUser?.branch || 'Main Branch').slice(0, 120),
      designation: String(appUser?.designation || (isBootstrapped ? 'Master Administrator' : 'Operator')).slice(0, 120),
      isMasterAdmin: isBootstrapped,
      isFirstLogin: typeof appUser?.isFirstLogin === 'boolean' ? appUser.isFirstLogin : needsPwdUpdate,
      passwordChanged:
        typeof appUser?.passwordChanged === 'boolean' ? appUser.passwordChanged : !needsPwdUpdate,
      mustChangePassword: Boolean(appUser?.mustChangePassword || appUser?.passwordMigrationRequired),
      passwordChangedAt: String(appUser?.passwordChangedAt || '').slice(0, 64),
      mobileVerified: Boolean(appUser?.mobileVerified),
      emailVerified: Boolean(firebaseUser.emailVerified),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    await setDoc(userRef, payload);
    profileEnsuredForUid = firebaseUser.uid;
  } catch (err) {
    console.warn('User profile sync skipped:', extractFriendlyErrorMessage(err));
  }
}

export async function markPasswordChangedInFirestore(
  firebaseUser: User | null | undefined,
  appUser?: UserProfile | null
): Promise<void> {
  if (!db || !firebaseUser) return;
  const userRef = doc(db, 'users', firebaseUser.uid);
  const nowIso = new Date().toISOString();
  const existing = await getDoc(userRef);

  if (!existing.exists()) {
    const email = (firebaseUser.email || '').trim().toLowerCase();
    const isBootstrapped =
      firebaseUser.uid === '1ftA1pw2Q5b1wxciGoSsNUqQPmF2' ||
      BOOTSTRAPPED_ADMIN_EMAILS.has(email);
    await setDoc(userRef, {
      uid: firebaseUser.uid,
      userId: String(appUser?.userId || `MC_${firebaseUser.uid.slice(0, 12)}`).slice(0, 40),
      fullName: String(
        appUser?.fullName || firebaseUser.displayName || email.split('@')[0] || 'MUN User'
      ).slice(0, 120),
      role: isBootstrapped ? 'ADMIN' : 'STAFF',
      status: 'ACTIVE',
      branch: String(appUser?.branch || 'Main Branch').slice(0, 120),
      designation: String(appUser?.designation || (isBootstrapped ? 'Master Administrator' : 'Operator')).slice(0, 120),
      isMasterAdmin: isBootstrapped,
      isFirstLogin: false,
      passwordChanged: true,
      mustChangePassword: false,
      passwordChangedAt: nowIso,
      mobileVerified: Boolean(appUser?.mobileVerified),
      emailVerified: Boolean(firebaseUser.emailVerified),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    profileEnsuredForUid = firebaseUser.uid;
    return;
  }

  await updateDoc(userRef, {
    isFirstLogin: false,
    passwordChanged: true,
    mustChangePassword: false,
    passwordChangedAt: nowIso,
    updatedAt: serverTimestamp(),
  });
  profileEnsuredForUid = firebaseUser.uid;
}

export function initCloudSyncMonitor(appUser?: UserProfile | null): () => void {
  if (appUser !== undefined) {
    currentAppUser = appUser;
    const activeFbUser = auth?.currentUser ?? snapshot.user;
    if (appUser) {
      updateSnapshot({
        appAuthenticated: true,
        status: resolveAutoStatus(snapshot.online, snapshot.activeWrites, true, activeFbUser),
        lastSyncedAt: activeFbUser ? snapshot.lastSyncedAt || new Date().toISOString() : snapshot.lastSyncedAt,
        errorMessage: resolveDisconnectedMessage(true, activeFbUser),
      });
      if (activeFbUser) {
        void ensureFirestoreUserProfile(activeFbUser, appUser);
      }
    } else {
      updateSnapshot({
        appAuthenticated: false,
        status: resolveAutoStatus(snapshot.online, snapshot.activeWrites, false, activeFbUser),
        errorMessage: null,
      });
    }
  }

  if (monitorStarted) {
    return () => {};
  }
  monitorStarted = true;

  if (!isFirebaseConfigured() || !auth) {
    authResolved = true;
    updateSnapshot({
      configured: false,
      status: 'disabled',
      errorMessage: firebaseInitError || 'Firebase client SDK is not configured.',
    });
    return () => {};
  }

  const handleOnline = () => {
    updateSnapshot({
      online: true,
      status: resolveAutoStatus(true, snapshot.activeWrites, Boolean(currentAppUser), snapshot.user),
      errorMessage: resolveDisconnectedMessage(Boolean(currentAppUser), snapshot.user),
    });
    if (auth?.currentUser) {
      void testConnection().then((res) => {
        if (!res.ok) {
          updateSnapshot({
            status: 'error',
            errorMessage: res.error || 'Unable to reach cloud database.',
          });
        } else {
          updateSnapshot({
            status: 'connected',
            lastSyncedAt: snapshot.lastSyncedAt || new Date().toISOString(),
            errorMessage: null,
          });
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('mun:cloud-reconnected'));
          }
        }
      });
    }
  };

  const handleOffline = () => {
    updateSnapshot({
      online: false,
      status: 'offline',
      errorMessage: 'Internet connection offline. Reconnect to sync changes.',
    });
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
  }

  authUnSub = onAuthStateChanged(auth, async (user) => {
    authResolved = true;
    if (!user) {
      profileEnsuredForUid = null;
      moduleStates.clear();
      notifyModules();
      updateSnapshot({
        user: null,
        userUid: null,
        userEmail: null,
        status: resolveAutoStatus(snapshot.online, snapshot.activeWrites, Boolean(currentAppUser), null),
        errorMessage: resolveDisconnectedMessage(Boolean(currentAppUser), null),
      });
      return;
    }

    updateSnapshot({
      user,
      userUid: user.uid,
      userEmail: user.email ?? null,
      status: snapshot.online ? 'connecting' : 'offline',
      errorMessage: null,
    });

    await ensureFirestoreUserProfile(user, currentAppUser);
    const conn = await testConnection();
    if (!conn.ok) {
      updateSnapshot({
        status: snapshot.online ? 'error' : 'offline',
        errorMessage: conn.error || 'Failed to connect to cloud database.',
      });
      return;
    }

    updateSnapshot({
      status: snapshot.online ? 'connected' : 'offline',
      lastSyncedAt: new Date().toISOString(),
      errorMessage: null,
    });
  });

  return () => {
    if (authUnSub) {
      authUnSub();
      authUnSub = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    }
    monitorStarted = false;
  };
}

/**
 * Passive Firebase client SDK status resolver.
 * Never triggers Google Sign-In popups or external OAuth flows.
 */
export async function connectCloudDatabaseInteractive(
  appUser?: UserProfile | null,
  _options?: { interactive?: boolean }
): Promise<User | null> {
  if (appUser !== undefined) currentAppUser = appUser;
  if (!isFirebaseConfigured()) {
    throw new Error(
      `[failed-precondition] Firebase client SDK is not configured: ${firebaseInitError || 'Missing project config.'}`
    );
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    updateSnapshot({ online: false, status: 'offline' });
    throw new Error('[unavailable] Internet connection is offline. Reconnect and try again.');
  }

  const readyUser = auth?.currentUser ?? (await waitForFirebaseAuthReady());
  if (readyUser) {
    await ensureFirestoreUserProfile(readyUser, currentAppUser);
    updateSnapshot({
      user: readyUser,
      userUid: readyUser.uid,
      userEmail: readyUser.email ?? null,
      status: 'connected',
      lastSyncedAt: new Date().toISOString(),
      errorMessage: null,
    });
    return readyUser;
  }

  authResolved = true;
  updateSnapshot({
    user: null,
    userUid: null,
    userEmail: null,
    status: resolveAutoStatus(snapshot.online, snapshot.activeWrites, Boolean(currentAppUser), null),
    errorMessage: null,
  });
  return null;
}

export async function ensureCloudAuthForSave(
  appUser?: UserProfile | null,
  options?: { interactive?: boolean }
): Promise<User | null> {
  return connectCloudDatabaseInteractive(appUser, options);
}

/**
 * Background-only mirror helper for non-critical UI preferences.
 */
export async function runCloudWrite<T>(
  operation: (user: User) => Promise<T>,
  fallback?: T
): Promise<T> {
  const user = auth?.currentUser ?? (await waitForFirebaseAuthReady());
  if (!user || !db) {
    return fallback as T;
  }

  markCloudSyncActivity(true);
  try {
    const result = await operation(user);
    recordCloudSyncSuccess();
    return result;
  } catch (err) {
    const msg = extractFriendlyErrorMessage(err, 'Client Firestore mirror skipped.');
    if (fallback !== undefined) {
      console.warn('[Background Firestore mirror warning]:', msg);
      return fallback;
    }
    recordCloudSyncError(msg);
    throw err;
  } finally {
    markCloudSyncActivity(false);
  }
}

/**
 * Client Firestore write helper:
 * Executes direct client Firestore write when Firebase client auth is active;
 * when operating under custom ERP authentication without Google OAuth, invokes
 * `fallbackIfNoClientAuth` cleanly so server-persisted ERP operations complete seamlessly.
 */
export async function runStrictCloudWrite<T>(
  operation: (user: User) => Promise<T>,
  opts?: { fallbackIfNoClientAuth?: () => Promise<T> | T }
): Promise<T> {
  const user = auth?.currentUser ?? (await waitForFirebaseAuthReady());
  if (!user) {
    if (opts?.fallbackIfNoClientAuth) {
      return await opts.fallbackIfNoClientAuth();
    }
    if (!db || !isFirebaseConfigured()) {
      const msg = `[failed-precondition] Cloud database (Firestore) is not initialized: ${
        firebaseInitError || 'Verify Firebase configuration.'
      }`;
      recordCloudSyncError(msg);
      throw new Error(msg);
    }
    recordCloudSyncSuccess();
    return undefined as unknown as T;
  }

  if (!db || !isFirebaseConfigured()) {
    const msg = `[failed-precondition] Cloud database (Firestore) is not initialized: ${
      firebaseInitError || 'Verify Firebase configuration.'
    }`;
    recordCloudSyncError(msg);
    throw new Error(msg);
  }

  markCloudSyncActivity(true);
  try {
    const result = await operation(user);
    recordCloudSyncSuccess();
    return result;
  } catch (err) {
    const msg = extractFriendlyErrorMessage(err, 'Cloud Firestore write failed.');
    recordCloudSyncError(msg);
    throw err;
  } finally {
    markCloudSyncActivity(false);
  }
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Firestore write with bounded exponential backoff on transient failures.
 */
export async function runStrictCloudWriteWithRetry<T>(
  operation: (user: User) => Promise<T>,
  opts?: {
    maxRetries?: number;
    baseDelayMs?: number;
    fallbackIfNoClientAuth?: () => Promise<T> | T;
  }
): Promise<T> {
  const maxRetries = Math.max(0, opts?.maxRetries ?? 2);
  const baseDelayMs = Math.max(50, opts?.baseDelayMs ?? 250);
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await runStrictCloudWrite(operation, {
        fallbackIfNoClientAuth: opts?.fallbackIfNoClientAuth,
      });
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries || !isRetryableFirestoreError(err)) {
        throw err;
      }
      await waitMs(baseDelayMs * Math.pow(2, attempt));
    }
  }
  throw lastError;
}

if (typeof window !== 'undefined') {
  initCloudSyncMonitor();
}
