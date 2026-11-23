import fs from 'node:fs';
import path from 'node:path';
import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
  type App,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getDatabase, type Database } from 'firebase-admin/database';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage, type Storage } from 'firebase-admin/storage';
import { GoogleAuth } from 'google-auth-library';
import type { ErpCustomer } from './erpTypes.js';
import { AuthChallenge, SecurityLogRecord, ServerSession, ServerUser } from './types.js';

export interface ResolvedFirebaseAdminConfig {
  projectId: string;
  firestoreDatabaseId: string;
  storageBucket: string;
  authMode: 'service_account_json' | 'service_account_env' | 'application_default' | 'unconfigured';
  initialized: boolean;
  error: string | null;
}

interface AppletConfigShape {
  projectId?: string;
  firestoreDatabaseId?: string;
  storageBucket?: string;
}

function readAppletConfigFile(): AppletConfigShape {
  try {
    const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(cfgPath)) {
      return JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as AppletConfigShape;
    }
  } catch {
    // Ignore parse error; fallback to env vars
  }
  return {};
}

function resolveFirestoreDatabaseId(serviceProjectId?: string): string | undefined {
  const envDb = (process.env.FIREBASE_DATABASE_ID || '').trim();
  if (envDb) return envDb;
  const parsed = readAppletConfigFile();
  if (
    serviceProjectId &&
    parsed.projectId &&
    serviceProjectId.trim() !== parsed.projectId.trim()
  ) {
    return undefined;
  }
  if (parsed.firestoreDatabaseId && parsed.firestoreDatabaseId.trim()) {
    return parsed.firestoreDatabaseId.trim();
  }
  return undefined;
}

function resolveDefaultStorageBucket(serviceProjectId?: string): string {
  const envBucket = (process.env.FIREBASE_STORAGE_BUCKET || '').replace(/^gs:\/\//i, '').trim();
  if (envBucket) return envBucket;
  const parsed = readAppletConfigFile();
  if (
    parsed.storageBucket &&
    parsed.storageBucket.trim() &&
    (!serviceProjectId || !parsed.projectId || serviceProjectId.trim() === parsed.projectId.trim())
  ) {
    return parsed.storageBucket.replace(/^gs:\/\//i, '').trim();
  }
  const pid = (serviceProjectId || parsed.projectId || process.env.FIREBASE_PROJECT_ID || '').trim();
  return pid ? `${pid}.firebasestorage.app` : '';
}

let initialized = false;
let initAttempted = false;
let adminAppInstance: App | null = null;
let rtdbInstance: Database | null = null;
let firestoreInstance: Firestore | null = null;
let storageInstance: Storage | null = null;
let resolvedAuthMode: ResolvedFirebaseAdminConfig['authMode'] = 'unconfigured';
let resolvedProjectId = '';
let resolvedDbId = '(default)';
let resolvedStorageBucket = '';
let lastInitError: string | null = null;
let cachedServiceAccount: (ServiceAccount & {
  project_id?: string;
  client_email?: string;
  private_key?: string;
}) | null = null;

function parseServiceAccount(): (ServiceAccount & {
  project_id?: string;
  client_email?: string;
  private_key?: string;
}) | null {
  const rawJson = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as ServiceAccount & {
        project_id?: string;
        client_email?: string;
        private_key?: string;
      };
      if (parsed.private_key && typeof parsed.private_key === 'string') {
        parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
      }
      resolvedAuthMode = 'service_account_json';
      return parsed;
    } catch {
      console.warn('Invalid FIREBASE_SERVICE_ACCOUNT_JSON format; skipping Firebase Admin SDK.');
      return null;
    }
  }

  const projectId = (process.env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = (process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  if (projectId && clientEmail && privateKey) {
    resolvedAuthMode = 'service_account_env';
    return {
      projectId,
      clientEmail,
      privateKey,
    };
  }
  return null;
}

function shouldUseApplicationDefaultCredentials(): boolean {
  if (process.env.NODE_ENV === 'test') {
    return (process.env.FIREBASE_USE_ADC || '').trim().toLowerCase() === 'true';
  }
  return Boolean(
    (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim() ||
      (process.env.FIREBASE_USE_ADC || '').trim().toLowerCase() === 'true'
  );
}

export function ensureFirebaseAdminInitialized(): {
  enabled: boolean;
  app: App | null;
  rtdb: Database | null;
  firestore: Firestore | null;
  storage: Storage | null;
} {
  if (initAttempted) {
    return {
      enabled: initialized,
      app: adminAppInstance,
      rtdb: rtdbInstance,
      firestore: firestoreInstance,
      storage: storageInstance,
    };
  }
  initAttempted = true;

  const appletCfg = readAppletConfigFile();
  const serviceAccount = parseServiceAccount();
  cachedServiceAccount = serviceAccount;
  const useAdc = !serviceAccount && shouldUseApplicationDefaultCredentials();

  const candidateProjectId =
    (serviceAccount as { project_id?: string } | null)?.project_id ||
    serviceAccount?.projectId ||
    (process.env.FIREBASE_PROJECT_ID || '').trim() ||
    (process.env.GOOGLE_CLOUD_PROJECT || '').trim() ||
    (process.env.GCP_PROJECT || '').trim() ||
    (appletCfg.projectId || '').trim();

  resolvedProjectId = candidateProjectId;
  resolvedStorageBucket = resolveDefaultStorageBucket(candidateProjectId);
  const firestoreDbId = resolveFirestoreDatabaseId(candidateProjectId);
  resolvedDbId = firestoreDbId || '(default)';

  if (!serviceAccount && !useAdc) {
    resolvedAuthMode = 'unconfigured';
    return { enabled: false, app: null, rtdb: null, firestore: null, storage: null };
  }

  const databaseURL = (process.env.FIREBASE_DATABASE_URL || '').trim() || undefined;
  try {
    const existingApps = getApps();
    if (existingApps.length > 0) {
      adminAppInstance = existingApps[0]!;
    } else if (serviceAccount) {
      adminAppInstance = initializeApp({
        credential: cert(serviceAccount),
        ...(candidateProjectId ? { projectId: candidateProjectId } : {}),
        ...(resolvedStorageBucket ? { storageBucket: resolvedStorageBucket } : {}),
        ...(databaseURL ? { databaseURL } : {}),
      });
    } else {
      resolvedAuthMode = 'application_default';
      adminAppInstance = initializeApp({
        credential: applicationDefault(),
        ...(candidateProjectId ? { projectId: candidateProjectId } : {}),
        ...(resolvedStorageBucket ? { storageBucket: resolvedStorageBucket } : {}),
        ...(databaseURL ? { databaseURL } : {}),
      });
    }

    if (databaseURL) {
      rtdbInstance = getDatabase(adminAppInstance);
    }
    firestoreInstance = firestoreDbId
      ? getFirestore(adminAppInstance, firestoreDbId)
      : getFirestore(adminAppInstance);
    storageInstance = getStorage(adminAppInstance);
    initialized = true;
    lastInitError = null;
  } catch (err) {
    lastInitError = err instanceof Error ? err.message : String(err);
    console.warn('Firebase Admin initialization warning:', lastInitError);
    initialized = false;
  }

  return {
    enabled: initialized,
    app: adminAppInstance,
    rtdb: rtdbInstance,
    firestore: firestoreInstance,
    storage: storageInstance,
  };
}

export function isFirebaseAdminActive(): boolean {
  return ensureFirebaseAdminInitialized().enabled;
}

export function getFirebaseAdminApp(): App | null {
  return ensureFirebaseAdminInitialized().app;
}

export function getFirebaseAdminFirestore(): Firestore | null {
  return ensureFirebaseAdminInitialized().firestore;
}

export function getFirebaseAdminStorage(): Storage | null {
  return ensureFirebaseAdminInitialized().storage;
}

export function getFirebaseAdminBucket(bucketName?: string) {
  const storage = getFirebaseAdminStorage();
  if (!storage) return null;
  const target = (bucketName || resolvedStorageBucket || '').replace(/^gs:\/\//i, '').trim();
  return target ? storage.bucket(target) : storage.bucket();
}

export function getResolvedFirebaseAdminConfig(): ResolvedFirebaseAdminConfig {
  ensureFirebaseAdminInitialized();
  const appletCfg = readAppletConfigFile();
  return {
    projectId: resolvedProjectId || appletCfg.projectId || '',
    firestoreDatabaseId: resolvedDbId || appletCfg.firestoreDatabaseId || '(default)',
    storageBucket: resolvedStorageBucket || appletCfg.storageBucket || '',
    authMode: resolvedAuthMode,
    initialized,
    error: lastInitError,
  };
}

export async function getGoogleCloudAccessToken(
  scopes: string[] = ['https://www.googleapis.com/auth/cloud-platform']
): Promise<string> {
  ensureFirebaseAdminInitialized();
  const sa = cachedServiceAccount;
  const auth = sa
    ? new GoogleAuth({
        credentials: {
          client_email: (sa as { client_email?: string }).client_email || sa.clientEmail,
          private_key: (sa as { private_key?: string }).private_key || sa.privateKey,
        },
        projectId: resolvedProjectId || (sa as { project_id?: string }).project_id || sa.projectId,
        scopes,
      })
    : new GoogleAuth({
        ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
        scopes,
      });

  const client = await auth.getClient();
  const tokenRes = await client.getAccessToken();
  const token = typeof tokenRes === 'string' ? tokenRes : tokenRes?.token;
  if (!token) {
    throw new Error('Failed to acquire Google Cloud OAuth2 access token.');
  }
  return token;
}

export async function checkFirebaseConnectionHealth(): Promise<{
  adminInitialized: boolean;
  firestoreConnected: boolean;
  storageConnected: boolean;
  projectId: string;
  firestoreDatabaseId: string;
  storageBucket: string;
  authMode: ResolvedFirebaseAdminConfig['authMode'];
  error: string | null;
}> {
  const { enabled, firestore } = ensureFirebaseAdminInitialized();
  const cfg = getResolvedFirebaseAdminConfig();
  if (!enabled) {
    return {
      adminInitialized: false,
      firestoreConnected: false,
      storageConnected: false,
      projectId: cfg.projectId,
      firestoreDatabaseId: cfg.firestoreDatabaseId,
      storageBucket: cfg.storageBucket,
      authMode: cfg.authMode,
      error:
        cfg.error ||
        'Firebase Admin SDK credentials not configured on this runtime (set FIREBASE_SERVICE_ACCOUNT_JSON or run on Cloud Run with ADC).',
    };
  }

  let firestoreConnected = false;
  let storageConnected = false;
  let errMsg: string | null = null;

  try {
    if (firestore) {
      await firestore.collection('system_backup_config').limit(1).get();
      firestoreConnected = true;
    }
  } catch (err) {
    errMsg = err instanceof Error ? err.message : String(err);
  }

  try {
    const bucket = getFirebaseAdminBucket(cfg.storageBucket);
    if (bucket) {
      await bucket.getFiles({ maxResults: 1, autoPaginate: false });
      storageConnected = true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errMsg = errMsg ? `${errMsg}; ${msg}` : msg;
  }

  return {
    adminInitialized: true,
    firestoreConnected,
    storageConnected,
    projectId: cfg.projectId,
    firestoreDatabaseId: cfg.firestoreDatabaseId,
    storageBucket: cfg.storageBucket,
    authMode: cfg.authMode,
    error: errMsg,
  };
}

function sanitizeKey(raw: string): string {
  return raw.replace(/[.#$/[\]]/g, '_');
}

export async function syncUserRecordToFirebase(user: ServerUser): Promise<void> {
  const { enabled, rtdb, firestore } = ensureFirebaseAdminInitialized();
  if (!enabled) return;

  const safeId = sanitizeKey(user.userId);
  const record: Record<string, unknown> = {
    id: user.id,
    userId: user.userId,
    isMasterAdmin: Boolean(user.isMasterAdmin),
    fullName: user.fullName,
    role: user.role,
    mobile: user.mobile,
    email: user.email || '',
    address: user.address,
    designation: user.designation || '',
    departmentCode: user.departmentCode || 'DEPT-CSC',
    joiningDate: user.joiningDate || '',
    branch: user.branch,
    status: user.status,
    mobileVerified: Boolean(user.mobileVerified),
    emailVerified: Boolean(user.emailVerified),
    passwordHash: user.passwordHash,
    passwordAlgo: user.passwordAlgo || 'bcrypt-12',
    mustChangePassword: Boolean(user.mustChangePassword),
    passwordMigrationRequired: Boolean(user.passwordMigrationRequired),
    isFirstLogin:
      typeof user.isFirstLogin === 'boolean'
        ? user.isFirstLogin
        : Boolean(user.mustChangePassword || user.passwordMigrationRequired),
    passwordChanged:
      typeof user.passwordChanged === 'boolean'
        ? user.passwordChanged
        : !(user.mustChangePassword || user.passwordMigrationRequired),
    totpEnabled: Boolean(user.totpEnabled),
    totpSecretEncrypted: user.totpSecretEncrypted || '',
    totpEnrolledAt: user.totpEnrolledAt || '',
    lastTotpStepUsed: user.lastTotpStepUsed ?? null,
    recoveryCodeHashes: user.recoveryCodeHashes ?? [],
    failedLoginAttempts: user.failedLoginAttempts,
    lockedUntil: user.lockedUntil ?? null,
    createdBy: user.createdBy ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    passwordChangedAt: user.passwordChangedAt,
    customPermissions: user.customPermissions || {},
    customRoleCode: user.customRoleCode || '',
    firebaseUid: user.firebaseUid || '',
  };

  await Promise.allSettled([
    rtdb ? rtdb.ref(`auth_users/${safeId}`).set(record) : Promise.resolve(),
    firestore
      ? firestore.collection('auth_users').doc(safeId).set(record, { merge: true })
      : Promise.resolve(),
  ]);
}

export async function syncSessionRecordToFirebase(session: ServerSession): Promise<void> {
  const { enabled, rtdb, firestore } = ensureFirebaseAdminInitialized();
  if (!enabled) return;

  const safeKey = sanitizeKey(session.tokenHash);
  const payload = {
    id: session.id,
    tokenHash: session.tokenHash,
    userId: session.userId,
    role: session.role,
    ipAddress: session.ipAddress,
    deviceInfo: session.deviceInfo,
    deviceId: session.deviceId || '',
    lastActiveAt: session.lastActiveAt || session.createdAt,
    rotatedFromSessionId: session.rotatedFromSessionId || '',
    rememberMe: session.rememberMe,
    status: session.status,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    maxAllowedExpiresAt: session.maxAllowedExpiresAt,
    reauthenticatedUntil: session.reauthenticatedUntil ?? null,
  };

  await Promise.allSettled([
    rtdb ? rtdb.ref(`auth_sessions/${safeKey}`).set(payload) : Promise.resolve(),
    firestore
      ? firestore.collection('auth_sessions').doc(safeKey).set(payload, { merge: true })
      : Promise.resolve(),
  ]);
}

export async function syncAuthChallengeToFirebase(challenge: AuthChallenge): Promise<void> {
  const { enabled, rtdb, firestore } = ensureFirebaseAdminInitialized();
  if (!enabled) return;

  const safeId = sanitizeKey(challenge.id);
  const payload = { ...challenge };
  await Promise.allSettled([
    rtdb ? rtdb.ref(`auth_challenges/${safeId}`).set(payload) : Promise.resolve(),
    firestore
      ? firestore.collection('auth_challenges').doc(safeId).set(payload, { merge: true })
      : Promise.resolve(),
  ]);
}

export async function removeAuthChallengeFromFirebase(challengeId: string): Promise<void> {
  const { enabled, rtdb, firestore } = ensureFirebaseAdminInitialized();
  if (!enabled) return;
  const safeId = sanitizeKey(challengeId);
  await Promise.allSettled([
    rtdb ? rtdb.ref(`auth_challenges/${safeId}`).remove() : Promise.resolve(),
    firestore ? firestore.collection('auth_challenges').doc(safeId).delete() : Promise.resolve(),
  ]);
}

export async function syncSecurityLogToFirebase(log: SecurityLogRecord): Promise<void> {
  const { enabled, rtdb, firestore } = ensureFirebaseAdminInitialized();
  if (!enabled) return;
  const key = `log_${String(log.id).padStart(8, '0')}_${Date.now().toString(36)}`;
  await Promise.allSettled([
    rtdb ? rtdb.ref(`auth_audit_logs/${key}`).set(log) : Promise.resolve(),
    firestore ? firestore.collection('auth_audit_logs').doc(key).set(log) : Promise.resolve(),
  ]);
}

let hydrationPromise: Promise<void> | null = null;

export async function hydrateAuthStateFromFirebase(target: {
  users: ServerUser[];
  sessions: Map<string, ServerSession>;
  authChallenges: Map<string, AuthChallenge>;
}): Promise<void> {
  if (hydrationPromise) return hydrationPromise;
  const { enabled, rtdb, firestore } = ensureFirebaseAdminInitialized();
  if (!enabled) return;

  hydrationPromise = (async () => {
    try {
      let rawUsers: Record<string, Partial<ServerUser>> | null = null;
      let rawSessions: Record<string, ServerSession> | null = null;
      let rawChallenges: Record<string, AuthChallenge> | null = null;

      if (rtdb) {
        const [uSnap, sSnap, cSnap] = await Promise.all([
          rtdb.ref('auth_users').get(),
          rtdb.ref('auth_sessions').get(),
          rtdb.ref('auth_challenges').get(),
        ]);
        rawUsers = (uSnap.val() as Record<string, Partial<ServerUser>> | null) ?? null;
        rawSessions = (sSnap.val() as Record<string, ServerSession> | null) ?? null;
        rawChallenges = (cSnap.val() as Record<string, AuthChallenge> | null) ?? null;
      } else if (firestore) {
        const [uSnap, sSnap, cSnap] = await Promise.all([
          firestore.collection('auth_users').get(),
          firestore.collection('auth_sessions').where('status', '==', 'ACTIVE').get(),
          firestore.collection('auth_challenges').get(),
        ]);
        if (!uSnap.empty) {
          rawUsers = {};
          uSnap.forEach((d) => {
            rawUsers![d.id] = d.data() as Partial<ServerUser>;
          });
        }
        if (!sSnap.empty) {
          rawSessions = {};
          sSnap.forEach((d) => {
            rawSessions![d.id] = d.data() as ServerSession;
          });
        }
        if (!cSnap.empty) {
          rawChallenges = {};
          cSnap.forEach((d) => {
            rawChallenges![d.id] = d.data() as AuthChallenge;
          });
        }
      }

      if (rawUsers) {
        for (const rec of Object.values(rawUsers)) {
          if (!rec.userId) continue;
          const upperId = rec.userId.toUpperCase();
          if (
            (upperId === 'MC2627110003' ||
              upperId === 'MC2627110004' ||
              upperId === 'MC2627110005') &&
            (rec.createdBy === 'SYSTEM' || !rec.createdBy)
          ) {
            continue;
          }
          const existing = target.users.find(
            (u) => u.userId.toUpperCase() === upperId
          );
          if (existing) {
            const recPwdTime = Date.parse(String(rec.passwordChangedAt || ''));
            const curPwdTime = Date.parse(String(existing.passwordChangedAt || ''));
            const canOverwritePassword =
              !Number.isFinite(curPwdTime) ||
              (Number.isFinite(recPwdTime) && recPwdTime > curPwdTime);

            if (canOverwritePassword) {
              if (rec.passwordHash) existing.passwordHash = rec.passwordHash;
              if (rec.passwordAlgo) existing.passwordAlgo = rec.passwordAlgo;
              if (rec.passwordChangedAt) existing.passwordChangedAt = rec.passwordChangedAt;
              if (typeof rec.mustChangePassword === 'boolean') {
                existing.mustChangePassword = rec.mustChangePassword;
              }
              if (typeof rec.passwordMigrationRequired === 'boolean') {
                existing.passwordMigrationRequired = rec.passwordMigrationRequired;
              }
              if (typeof rec.isFirstLogin === 'boolean') {
                existing.isFirstLogin = rec.isFirstLogin;
              }
              if (typeof rec.passwordChanged === 'boolean') {
                existing.passwordChanged = rec.passwordChanged;
              }
            }
            if (typeof rec.totpEnabled === 'boolean') existing.totpEnabled = rec.totpEnabled;
            if (rec.totpSecretEncrypted) existing.totpSecretEncrypted = rec.totpSecretEncrypted;
            if (rec.totpEnrolledAt) existing.totpEnrolledAt = rec.totpEnrolledAt;
            if (typeof rec.lastTotpStepUsed === 'number') {
              existing.lastTotpStepUsed = rec.lastTotpStepUsed;
            }
            if (Array.isArray(rec.recoveryCodeHashes)) {
              existing.recoveryCodeHashes = rec.recoveryCodeHashes;
            }
            if (rec.status) existing.status = rec.status;
          } else if (rec.passwordHash && rec.role && rec.fullName) {
            target.users.push({
              id: Number(rec.id || target.users.length + 1),
              userId: rec.userId,
              isMasterAdmin: Boolean(rec.isMasterAdmin),
              fullName: rec.fullName,
              role: rec.role,
              mobile: rec.mobile || '',
              email: rec.email || '',
              address: rec.address || '',
              designation: rec.designation || '',
              departmentCode: rec.departmentCode || 'DEPT-CSC',
              joiningDate: rec.joiningDate || '',
              branch: rec.branch || 'Main Service Center',
              status: rec.status || 'ACTIVE',
              mobileVerified: Boolean(rec.mobileVerified),
              emailVerified: Boolean(rec.emailVerified),
              passwordHash: rec.passwordHash,
              passwordAlgo: rec.passwordAlgo || 'bcrypt-12',
              mustChangePassword: Boolean(rec.mustChangePassword),
              passwordMigrationRequired: Boolean(rec.passwordMigrationRequired),
              failedLoginAttempts: Number(rec.failedLoginAttempts || 0),
              lockedUntil: rec.lockedUntil ?? null,
              createdBy: rec.createdBy ?? null,
              createdAt: rec.createdAt || new Date().toISOString(),
              updatedAt: rec.updatedAt || new Date().toISOString(),
              passwordChangedAt: rec.passwordChangedAt || new Date().toISOString(),
              customPermissions: rec.customPermissions || {},
              customRoleCode: rec.customRoleCode || undefined,
              totpEnabled: Boolean(rec.totpEnabled),
              totpSecretEncrypted: rec.totpSecretEncrypted || undefined,
              totpEnrolledAt: rec.totpEnrolledAt || undefined,
              lastTotpStepUsed: rec.lastTotpStepUsed ?? undefined,
              recoveryCodeHashes: Array.isArray(rec.recoveryCodeHashes)
                ? rec.recoveryCodeHashes
                : undefined,
            });
          }
        }
      }

      const now = Date.now();
      if (rawSessions) {
        for (const sess of Object.values(rawSessions)) {
          if (sess?.tokenHash && sess.status === 'ACTIVE' && sess.expiresAt > now) {
            target.sessions.set(sess.tokenHash, sess);
          }
        }
      }

      if (rawChallenges) {
        for (const ch of Object.values(rawChallenges)) {
          if (ch?.id && ch.expiresAt > now) {
            target.authChallenges.set(ch.id, ch);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isPermDenied =
        /PERMISSION_DENIED|Missing or insufficient permissions/i.test(msg) ||
        (err as { code?: number } | null)?.code === 7;
      if (isPermDenied) {
        lastInitError =
          'Firebase Admin SDK lacks IAM permissions on Firestore (7 PERMISSION_DENIED). Falling back to Express store persistence.';
        console.warn('Firebase Auth state hydration skipped:', lastInitError);
        // Do not clear hydrationPromise on PERMISSION_DENIED so every /api request does not repeat failed IAM calls
      } else {
        console.error('Firebase Auth state hydration error:', msg);
        hydrationPromise = null;
      }
    }
  })();

  return hydrationPromise;
}

export async function purgeDemoDataFromFirebaseAdmin(): Promise<{
  executed: boolean;
  deletedDocs: number;
  reason?: string;
}> {
  const { enabled, rtdb, firestore } = ensureFirebaseAdminInitialized();
  if (!enabled) {
    return {
      executed: false,
      deletedDocs: 0,
      reason: 'Firebase Admin service account credentials are not configured on this server.',
    };
  }
  let deletedDocs = 0;

  if (rtdb) {
    const usersSnap = await rtdb.ref('auth_users').get();
    const raw = (usersSnap.val() as Record<string, Partial<ServerUser>> | null) ?? {};
    for (const [key, val] of Object.entries(raw)) {
      if (val?.userId !== 'MC2627110001' && val?.userId !== 'MC2627110002') {
        await rtdb.ref(`auth_users/${key}`).remove();
        deletedDocs += 1;
      }
    }
    await rtdb.ref('auth_challenges').remove();
    await rtdb.ref('auth_audit_logs').remove();
  }

  if (firestore) {
    const collectionsToClear = [
      'customers',
      'applications',
      'payments',
      'expenses',
      'refunds',
      'dailyCashClosings',
      'cscOrders',
      'pvcOrders',
      'cscGrievances',
      'cscDocuments',
      'wholesaleShops',
      'managerServiceAssignments',
      'staffServiceRequests',
      'staffServicePermissions',
      'serviceApprovalLogs',
      'securityLogs',
      'auditLogs',
      'notifications',
      'auth_challenges',
      'auth_audit_logs',
    ];
    for (const colName of collectionsToClear) {
      const snap = await firestore.collection(colName).get();
      if (!snap.empty) {
        for (const d of snap.docs) {
          await d.ref.delete();
          deletedDocs += 1;
        }
      }
    }
    const authUsersSnap = await firestore.collection('auth_users').get();
    for (const d of authUsersSnap.docs) {
      if (d.id !== 'MC2627110001' && d.id !== 'MC2627110002') {
        await d.ref.delete();
        deletedDocs += 1;
      }
    }
  }

  return { executed: true, deletedDocs };
}

function buildAdminCustomerRecord(c: ErpCustomer): Record<string, unknown> {
  const cleanUrl =
    typeof (c.photoDownloadURL || c.photoUrl) === 'string' &&
    /^(https:\/\/|\/api\/erp\/storage\/files\/)[^\s]+$/i.test(String(c.photoDownloadURL || c.photoUrl).trim())
      ? String(c.photoDownloadURL || c.photoUrl).trim()
      : '';
  return {
    id: c.id,
    customerId: c.customerId,
    referenceNo: c.referenceNo || `MCR-${c.customerId.replace(/^MCC-/, '')}`,
    fullName: c.fullName,
    name: c.fullName,
    fatherOrHusbandName: c.fatherOrHusbandName || '',
    dob: c.dob || '',
    gender: c.gender || 'Male',
    mobile: c.mobile,
    whatsapp: c.whatsapp || c.mobile,
    email: c.email || '',
    aadhaarLast4: c.aadhaarLast4 || '',
    aadhaarMasked: c.aadhaarLast4 ? `XXXX-XXXX-${c.aadhaarLast4}` : '',
    panNumber: c.panNumber || '',
    pan: c.panNumber || '',
    voterId: c.voterId || '',
    village: c.village || '',
    postOffice: c.postOffice || '',
    policeStation: c.policeStation || '',
    district: c.district || 'Murshidabad',
    pinCode: c.pinCode || '',
    presentAddress: c.presentAddress || '',
    permanentAddress: c.permanentAddress || '',
    sameAsPresent: c.sameAsPresent !== false,
    photoStoragePath: c.photoStoragePath || '',
    photoDownloadURL: cleanUrl,
    photoUrl: cleanUrl,
    segment: c.segment || 'Regular',
    crmTag: c.crmTag || 'New',
    status: c.status || 'Active',
    verificationStatus: c.verificationStatus || 'Unverified',
    mobileOtpVerifiedAt: c.mobileOtpVerifiedAt ?? null,
    consents: Array.isArray(c.consents) ? c.consents : [],
    consentHistory: Array.isArray(c.consentHistory) ? c.consentHistory : [],
    contactHistory: Array.isArray(c.contactHistory) ? c.contactHistory : [],
    notesAndFollowUps: Array.isArray(c.notesAndFollowUps) ? c.notesAndFollowUps : [],
    statusHistory: Array.isArray(c.statusHistory) ? c.statusHistory : [],
    mergedFromCustomerIds: Array.isArray(c.mergedFromCustomerIds) ? c.mergedFromCustomerIds : [],
    mergedIntoCustomerId: c.mergedIntoCustomerId || null,
    isArchived: Boolean(c.isArchived || c.deletedAt),
    deletedAt: c.deletedAt ?? null,
    deletedBy: c.deletedBy ?? null,
    createdBy: c.createdBy || 'SYSTEM',
    createdAt: c.createdAt || new Date().toISOString(),
    updatedAt: c.updatedAt || new Date().toISOString(),
  };
}

let erpCustHydrationPromise: Promise<void> | null = null;
let erpCustPermDenied = false;

export async function syncErpCustomerToFirebase(customer: ErpCustomer): Promise<void> {
  if (erpCustPermDenied) return;
  const { enabled, rtdb, firestore } = ensureFirebaseAdminInitialized();
  if (!enabled || !customer?.customerId) return;

  const safeId = sanitizeKey(customer.customerId);
  const payload = buildAdminCustomerRecord(customer);
  try {
    await Promise.allSettled([
      rtdb ? rtdb.ref(`erp_customers/${safeId}`).set(payload) : Promise.resolve(),
      firestore
        ? firestore.collection('erp_customers').doc(safeId).set(payload, { merge: true })
        : Promise.resolve(),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/PERMISSION_DENIED|Missing or insufficient permissions/i.test(msg)) {
      erpCustPermDenied = true;
    }
  }
}

export async function deleteErpCustomerFromFirebaseAdmin(customerId: string): Promise<void> {
  if (erpCustPermDenied) return;
  const { enabled, rtdb, firestore } = ensureFirebaseAdminInitialized();
  if (!enabled || !customerId) return;

  const safeId = sanitizeKey(customerId);
  try {
    await Promise.allSettled([
      rtdb ? rtdb.ref(`erp_customers/${safeId}`).remove() : Promise.resolve(),
      rtdb ? rtdb.ref(`erp_customer_tombstones/${safeId}`).set({ customerId, deletedAt: new Date().toISOString() }) : Promise.resolve(),
      firestore ? firestore.collection('erp_customers').doc(safeId).delete() : Promise.resolve(),
      firestore ? firestore.collection('customers').doc(safeId).delete() : Promise.resolve(),
      firestore
        ? firestore.collection('erp_customer_tombstones').doc(safeId).set({
            customerId,
            deletedAt: new Date().toISOString(),
          })
        : Promise.resolve(),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/PERMISSION_DENIED|Missing or insufficient permissions/i.test(msg)) {
      erpCustPermDenied = true;
    }
  }
}

export async function hydrateErpCustomersFromFirebase(target: {
  customers: ErpCustomer[];
  deletedCustomerIds: Set<string>;
  seedSequence?: (customerId: string) => void;
}): Promise<void> {
  if (erpCustHydrationPromise) return erpCustHydrationPromise;
  const { enabled, rtdb, firestore } = ensureFirebaseAdminInitialized();
  if (!enabled || erpCustPermDenied) return;

  erpCustHydrationPromise = (async () => {
    try {
      const tombIds = new Set<string>();
      const rawCustomers: Array<Record<string, unknown>> = [];

      if (rtdb) {
        const [cSnap, tSnap] = await Promise.all([
          rtdb.ref('erp_customers').get(),
          rtdb.ref('erp_customer_tombstones').get(),
        ]);
        const tVal = (tSnap.val() as Record<string, { customerId?: string }> | null) ?? {};
        for (const [k, v] of Object.entries(tVal)) {
          tombIds.add(v?.customerId || k);
        }
        const cVal = (cSnap.val() as Record<string, Record<string, unknown>> | null) ?? {};
        for (const rec of Object.values(cVal)) {
          if (rec) rawCustomers.push(rec);
        }
      } else if (firestore) {
        const [cSnap, pubSnap, tSnap] = await Promise.all([
          firestore.collection('erp_customers').get(),
          firestore.collection('customers').get(),
          firestore.collection('erp_customer_tombstones').get(),
        ]);
        tSnap.forEach((d) => {
          const data = d.data() as { customerId?: string };
          tombIds.add(data?.customerId || d.id);
        });
        cSnap.forEach((d) => rawCustomers.push(d.data() as Record<string, unknown>));
        pubSnap.forEach((d) => rawCustomers.push({ customerId: d.id, ...(d.data() as Record<string, unknown>) }));
      }

      for (const tid of tombIds) {
        target.deletedCustomerIds.add(tid);
      }

      for (const rec of rawCustomers) {
        const cid = String(rec.customerId || '').trim();
        if (!cid || target.deletedCustomerIds.has(cid)) continue;
        target.seedSequence?.(cid);
        const existing = target.customers.find((c) => c.customerId === cid);
        if (!existing) {
          const fullName = String(rec.fullName || rec.name || '').trim();
          const mobile = String(rec.mobile || '').trim();
          if (!fullName || !mobile) continue;
          const deletedAt = typeof rec.deletedAt === 'string' && rec.deletedAt ? rec.deletedAt : null;
          target.customers.push({
            id: Number(rec.id || target.customers.length + 1),
            customerId: cid,
            referenceNo: String(rec.referenceNo || `MCR-${cid.replace(/^MCC-/, '')}`),
            fullName,
            fatherOrHusbandName: String(rec.fatherOrHusbandName || ''),
            dob: String(rec.dob || ''),
            gender: (['Male', 'Female', 'Other'].includes(String(rec.gender)) ? rec.gender : 'Male') as ErpCustomer['gender'],
            mobile,
            whatsapp: String(rec.whatsapp || mobile),
            email: String(rec.email || ''),
            aadhaarLast4: typeof rec.aadhaarLast4 === 'string' && rec.aadhaarLast4 ? rec.aadhaarLast4 : undefined,
            panNumber: typeof rec.panNumber === 'string' && rec.panNumber ? rec.panNumber : undefined,
            voterId: typeof rec.voterId === 'string' && rec.voterId ? rec.voterId : undefined,
            village: String(rec.village || 'Local Area'),
            postOffice: String(rec.postOffice || ''),
            policeStation: String(rec.policeStation || ''),
            district: String(rec.district || 'Murshidabad'),
            pinCode: String(rec.pinCode || ''),
            presentAddress: String(rec.presentAddress || ''),
            permanentAddress: String(rec.permanentAddress || ''),
            sameAsPresent: rec.sameAsPresent !== false,
            photoStoragePath: typeof rec.photoStoragePath === 'string' && rec.photoStoragePath ? rec.photoStoragePath : undefined,
            photoDownloadURL: typeof rec.photoDownloadURL === 'string' && rec.photoDownloadURL ? rec.photoDownloadURL : undefined,
            photoUrl: typeof rec.photoUrl === 'string' && rec.photoUrl ? rec.photoUrl : undefined,
            segment: (['Regular', 'General', 'VIP', 'Individual', 'Corporate', 'Government'].includes(String(rec.segment))
              ? rec.segment
              : 'Regular') as ErpCustomer['segment'],
            crmTag: ([
              'New',
              'Regular',
              'VIP',
              'Active',
              'Inactive',
              'Follow-up Required',
              'Pending Payment',
              'Service Completed',
            ].includes(String(rec.crmTag))
              ? rec.crmTag
              : 'New') as ErpCustomer['crmTag'],
            status: (['Active', 'Inactive', 'Blocked'].includes(String(rec.status)) ? rec.status : 'Active') as ErpCustomer['status'],
            verificationStatus: ([
              'Unverified',
              'Mobile Verified',
              'Consent Verified',
              'Fully Verified',
              'Verification Expired',
              'Re-verification Required',
            ].includes(String(rec.verificationStatus))
              ? rec.verificationStatus
              : 'Unverified') as ErpCustomer['verificationStatus'],
            mobileOtpVerifiedAt: typeof rec.mobileOtpVerifiedAt === 'string' ? rec.mobileOtpVerifiedAt : null,
            consents: Array.isArray(rec.consents) ? (rec.consents as ErpCustomer['consents']) : [],
            consentHistory: Array.isArray(rec.consentHistory) ? (rec.consentHistory as ErpCustomer['consentHistory']) : [],
            contactHistory: Array.isArray(rec.contactHistory) ? (rec.contactHistory as ErpCustomer['contactHistory']) : [],
            notesAndFollowUps: Array.isArray(rec.notesAndFollowUps) ? (rec.notesAndFollowUps as ErpCustomer['notesAndFollowUps']) : [],
            statusHistory: Array.isArray(rec.statusHistory) ? (rec.statusHistory as ErpCustomer['statusHistory']) : [],
            isArchived: Boolean(rec.isArchived || deletedAt),
            deletedAt,
            deletedBy: typeof rec.deletedBy === 'string' ? rec.deletedBy : null,
            createdBy: String(rec.createdBy || 'SYSTEM'),
            createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : new Date().toISOString(),
            updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        /PERMISSION_DENIED|Missing or insufficient permissions/i.test(msg) ||
        (err as { code?: number } | null)?.code === 7
      ) {
        erpCustPermDenied = true;
      } else {
        erpCustHydrationPromise = null;
      }
    }
  })();

  return erpCustHydrationPromise;
}
