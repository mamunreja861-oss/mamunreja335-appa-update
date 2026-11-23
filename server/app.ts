import fs from 'node:fs';
import path from 'node:path';
import express, { NextFunction, Request, Response } from 'express';
import {
  decryptSensitiveField,
  encryptSensitiveField,
  generateToken,
  hashPassword,
  maskAadhaar,
  parseCookies,
  sanitizeText,
  sha256,
  verifyPassword,
} from './crypto.js';
import {
  ALL_MODULES,
  ALL_PERMISSION_TYPES,
  CSC_OPERATOR_PERMISSION_KEYS,
  MAX_REMEMBER_ME_MS,
  REPORT_PERMISSION_KEYS,
  ROLE_PERMISSION_MATRIX,
  SecurityStore,
} from './securityStore.js';
import { registerAuthRoutes } from './authRoutes.js';
import {
  isFast2SmsConfigured,
  sendFast2SmsTemplateMessage,
} from './fast2smsService.js';
import { getDefaultFast2SmsGatewayConfig } from './smsDefaults.js';
import {
  hydrateAuthStateFromFirebase,
  hydrateErpCustomersFromFirebase,
  isFirebaseAdminActive,
  purgeDemoDataFromFirebaseAdmin,
  syncSessionRecordToFirebase,
  syncUserRecordToFirebase,
} from './firebaseAdminDb.js';
import {
  AccountStatus,
  ModuleKey,
  PermissionType,
  ReportPermissionKey,
  RoleName,
  ServerSession,
  ServerUser,
} from './types.js';

import { Phase03Store } from './phase03Store.js';
import { registerPhase03Routes } from './phase03Routes.js';
import { ErpStore } from './erpStore.js';
import { registerErpRoutes } from './erpRoutes.js';
import { FinanceStore } from './finance/financeStore.js';
import { registerFinanceRoutes } from './finance/financeRoutes.js';
import { ReportStore } from './reports/reportStore.js';
import { ReportDataEngine } from './reports/reportDataEngine.js';
import { ReportSchedulerService } from './reports/reportScheduler.js';
import { registerReportRoutes } from './reports/reportRoutes.js';
import { Phase08Store } from './phase08/phase08Store.js';
import { BackupSchedulerService } from './phase08/backupScheduler.js';
import { registerPhase08Routes } from './phase08/phase08Routes.js';
import { BackupOrchestrator } from './backup/backupOrchestrator.js';
import { registerFirebaseBackupRoutes } from './backup/backupRoutes.js';
import { parsePrivacyDeviceMetadata } from './phase08/phase08Crypto.js';
import { OtpChannel } from './phase08/phase08Types.js';
import { QaStore } from './phase09/qaStore.js';
import { registerQaRoutes } from './phase09/qaRoutes.js';
import { CscStore } from './cscStore.js';
import { registerCscRoutes } from './cscRoutes.js';
import {
  hydratePasswordHistoryIntoPhase08Store,
  hydratePhase03IntegrationsFromDisk,
  hydrateRuntimeStoresFromDisk,
  hydrateSecurityStoreFromDisk,
  saveRuntimeStoresToDisk,
  saveSecurityStoreToDisk,
} from './persistence.js';

interface AuthedRequest extends Request {
  authUser?: ServerUser;
  authSession?: ServerSession;
}

export interface CreateAppOptions {
  enableRateLimit?: boolean;
  maxAuthRequestsPerMinute?: number;
  phase03Store?: Phase03Store;
  erpStore?: ErpStore;
  financeStore?: FinanceStore;
  reportStore?: ReportStore;
  phase08Store?: Phase08Store;
  firebaseBackupOrchestrator?: BackupOrchestrator;
  qaStore?: QaStore;
  cscStore?: CscStore;
  enableReportScheduler?: boolean;
  enableBackupScheduler?: boolean;
}

function validateStrongPassword(password: unknown): string | null {
  const pwd = typeof password === 'string' ? password : '';
  if (pwd.length < 12) {
    return 'Strong Password Policy requires at least 12 characters.';
  }
  if (!/[A-Z]/.test(pwd) || !/[a-z]/.test(pwd) || !/[0-9]/.test(pwd) || !/[^A-Za-z0-9]/.test(pwd)) {
    return 'Strong Password Policy requires uppercase, lowercase, number, and special character.';
  }
  return null;
}

const SESSION_COOKIE = 'mun_session';
const CSRF_COOKIE = 'mun_csrf';

function getClientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

function getDeviceInfo(req: Request): string {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' && ua.length > 0 ? ua.slice(0, 140) : 'Unknown Client';
}

function isSmsOrEmailConfigured(): boolean {
  return Boolean(
    process.env.SMTP_HOST ||
      process.env.FAST2SMS_API_KEY ||
      process.env.SMS_API_KEY ||
      process.env.VITE_FAST2SMS_API_KEY ||
      getDefaultFast2SmsGatewayConfig()?.apiKey
  );
}

function apiSuccess(res: Response, data: unknown, message = 'OK', status = 200) {
  return res.status(status).json({
    success: true,
    message,
    data,
    meta: {
      timestamp: new Date().toISOString(),
    },
  });
}

function apiError(
  res: Response,
  message: string,
  status = 400,
  errors?: Record<string, string[]>
) {
  return res.status(status).json({
    success: false,
    message,
    data: null,
    meta: {
      timestamp: new Date().toISOString(),
    },
    ...(errors ? { errors } : {}),
  });
}

export function createApp(
  store: SecurityStore = new SecurityStore(),
  options: CreateAppOptions = {}
) {
  const app = express();
  const persistedSecurity = hydrateSecurityStoreFromDisk(store);
  const phase03Store = options.phase03Store ?? new Phase03Store();
  if (!options.phase03Store) {
    hydratePhase03IntegrationsFromDisk(phase03Store, persistedSecurity);
  }
  const erpStore = options.erpStore ?? new ErpStore(store, phase03Store);
  const financeStore = options.financeStore ?? new FinanceStore(store, phase03Store, erpStore);
  const reportStore = options.reportStore ?? new ReportStore();
  const cscStore = options.cscStore ?? new CscStore();
  const reportDataEngine = new ReportDataEngine(
    store,
    phase03Store,
    erpStore,
    financeStore,
    reportStore,
    cscStore
  );
  const reportScheduler = new ReportSchedulerService(store, phase03Store, reportStore, reportDataEngine);
  const phase08Store =
    options.phase08Store ?? new Phase08Store(store, phase03Store, erpStore, financeStore, reportStore);

  const qaStore = options.qaStore ?? new QaStore();

  hydrateRuntimeStoresFromDisk(options.erpStore ? null : erpStore, phase03Store, {
    hydratePhase03: !options.phase03Store,
    cscStore: options.cscStore ? undefined : cscStore,
    financeStore: options.financeStore ? undefined : financeStore,
    reportStore: options.reportStore ? undefined : reportStore,
    phase08Store: options.phase08Store ? undefined : phase08Store,
    qaStore: options.qaStore ? undefined : qaStore,
  });

  if (!options.phase08Store) {
    hydratePasswordHistoryIntoPhase08Store(phase08Store, persistedSecurity);
  }
  const persistSecurityState = () => {
    saveSecurityStoreToDisk(store, phase08Store, phase03Store);
  };
  const persistRuntimeState = () => {
    saveRuntimeStoresToDisk(erpStore, phase03Store, {
      cscStore,
      financeStore,
      reportStore,
      phase08Store,
      qaStore,
    });
  };
  const backupScheduler = new BackupSchedulerService(phase08Store);
  app.locals.cscStore = cscStore;

  // Merge Phase 08 Custom Role & Active Temporary Permissions into SecurityStore
  store.setExternalPermissionResolver((userId, customRoleCode) => {
    const merged: Record<string, boolean> = {};
    if (customRoleCode) {
      const cRole = phase08Store.customRoles.find(
        (r) => r.roleCode === customRoleCode && r.status === 'ACTIVE'
      );
      if (cRole) {
        Object.assign(merged, cRole.permissions);
      }
    }
    const temp = phase08Store.getEffectiveTemporaryPermissions(userId);
    Object.assign(merged, temp);
    return merged;
  });

  app.locals.phase08Store = phase08Store;
  app.locals.qaStore = qaStore;

  const enableRateLimit = options.enableRateLimit ?? true;
  const maxAuthReqs = options.maxAuthRequestsPerMinute ?? 40;

  // Preserve pre-parsed body if a serverless runtime consumed the request stream before Express
  app.use((req, _res, next) => {
    const reqAny = req as Request & { _body?: boolean };
    if (!reqAny._body && req.readableEnded && req.body && typeof req.body === 'object') {
      reqAny._body = true;
    }
    next();
  });

  app.use(express.json({ limit: '16mb' }));

  // Baseline Security Headers against XSS, MIME sniffing, Clickjacking
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      const isWriteMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
      const isRuntimeMutation =
        isWriteMethod &&
        [
          '/api/erp/',
          '/api/csc/',
          '/api/finance/',
          '/api/v1/employees',
          '/api/v1/attendance',
          '/api/v1/products',
          '/api/v1/inventory',
          '/api/reports/',
          '/api/master-settings',
          '/api/service-rates',
          '/api/daily-cash',
          '/api/documents',
          '/api/backups',
          '/api/settings-proposals',
          '/api/counters',
          '/api/document-sequences',
          '/api/integrations',
          '/api/phase08/',
          '/api/security/',
          '/api/v1/security/',
          '/api/qa/',
          '/api/v1/qa/',
        ].some((prefix) => req.path.startsWith(prefix));
      const isSecurityMutation =
        isWriteMethod &&
        [
          '/api/departments',
          '/api/service-permissions/',
          '/api/notifications/security/',
          '/api/users',
          '/api/roles',
          '/api/permissions',
          '/api/registration-requests',
          '/api/sessions',
        ].some((prefix) => req.path.startsWith(prefix));

      if (isRuntimeMutation || isSecurityMutation) {
        let flushed = false;
        const flushBeforeSend = () => {
          if (flushed) return;
          flushed = true;
          if (res.statusCode < 400) {
            if (isSecurityMutation) persistSecurityState();
            if (isRuntimeMutation) persistRuntimeState();
          }
        };
        const origJson = res.json.bind(res);
        res.json = ((body?: unknown) => {
          flushBeforeSend();
          return origJson(body);
        }) as Response['json'];
        const origSend = res.send.bind(res);
        res.send = ((body?: unknown) => {
          flushBeforeSend();
          return origSend(body);
        }) as Response['send'];
        res.on('finish', flushBeforeSend);
      }
    }
    next();
  });

  // Hydrate persistent auth & ERP customer state once on cold-start if Firebase Admin credentials are set
  app.use('/api/', async (_req, _res, next) => {
    try {
      if (isFirebaseAdminActive()) {
        await Promise.all([
          hydrateAuthStateFromFirebase(store),
          hydrateErpCustomersFromFirebase({
            customers: erpStore.customers,
            deletedCustomerIds: erpStore.deletedCustomerIds,
            seedSequence: (cid) => erpStore.seedCustomerSequenceFromId(cid),
          }),
        ]);
      }
    } catch (err) {
      console.error('[API Firebase Hydration Middleware Error]', err);
    }
    next();
  });

  // Rate limiting middleware for /api/auth/*
  const authRateLimiter = (req: Request, res: Response, next: NextFunction) => {
    if (!enableRateLimit) return next();
    const key = `auth:${getClientIp(req)}`;
    const now = Date.now();
    const bucket = store.rateLimitBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      store.rateLimitBuckets.set(key, { count: 1, resetAt: now + 60_000 });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > maxAuthReqs) {
      return apiError(
        res,
        'Too many authentication requests. Please wait a minute and retry.',
        429
      );
    }
    return next();
  };

  const VALID_ROLES: RoleName[] = ['ADMIN', 'MANAGER', 'STAFF', 'AUDITOR', 'CUSTOMER', 'EMPLOYEE'];

  const evaluateSessionToken = (
    req: Request,
    rawToken: string
  ):
    | { ok: true; user: ServerUser; session: ServerSession }
    | { ok: false; status: number; message: string } => {
    const tokenHash = sha256(rawToken);
    if (store.revokedTokenHashes.has(tokenHash)) {
      return { ok: false, status: 401, message: 'Session has been invalidated.' };
    }
    let session = store.sessions.get(tokenHash);
    let sealedMcp: boolean | undefined;
    let sealedPca: string | undefined;
    if (rawToken.startsWith('sess1.')) {
      try {
        const enc = Buffer.from(rawToken.slice(6), 'base64url').toString('utf8');
        const parsed = JSON.parse(decryptSensitiveField(enc)) as {
          sid?: string;
          u?: string;
          role?: RoleName;
          r?: string;
          rm?: boolean;
          di?: string;
          ca?: string;
          ea?: number;
          mea?: number;
          ra?: number;
          mcp?: boolean;
          pca?: string;
        };
        sealedMcp = parsed.mcp;
        sealedPca = parsed.pca;
        if (!session) {
          const resolvedRole: RoleName | undefined =
            parsed.role && VALID_ROLES.includes(parsed.role)
              ? parsed.role
              : parsed.r && VALID_ROLES.includes(parsed.r as RoleName)
                ? (parsed.r as RoleName)
                : parsed.u
                  ? store.findUserByUserId(parsed.u)?.role
                  : undefined;
          if (
            parsed.sid &&
            parsed.u &&
            resolvedRole &&
            parsed.ca &&
            typeof parsed.ea === 'number' &&
            typeof parsed.mea === 'number' &&
            parsed.ea > Date.now() &&
            parsed.mea > Date.now()
          ) {
            session = {
              id: parsed.sid,
              tokenHash,
              userId: parsed.u,
              role: resolvedRole,
              ipAddress: getClientIp(req),
              deviceInfo: getDeviceInfo(req),
              deviceId: parsed.di,
              lastActiveAt: new Date().toISOString(),
              rememberMe: Boolean(parsed.rm),
              status: 'ACTIVE',
              createdAt: parsed.ca,
              expiresAt: parsed.ea,
              maxAllowedExpiresAt: parsed.mea,
              reauthenticatedUntil: parsed.ra,
            };
            store.sessions.set(tokenHash, session);
          }
        }
      } catch {
        if (!session) session = undefined;
      }
    }
    if (!session) {
      return { ok: false, status: 401, message: 'Invalid session token.' };
    }

    if (session.status !== 'ACTIVE') {
      return { ok: false, status: 401, message: 'Session has been invalidated.' };
    }

    const now = Date.now();
    // Enforce server-side absolute cap (Remember Me max 240 minutes, never silently extended)
    if (session.expiresAt <= now || session.maxAllowedExpiresAt <= now) {
      session.status = 'EXPIRED';
      store.addSecurityLog({
        actorUserId: session.userId,
        eventType: 'SESSION_EXPIRED',
        result: 'BLOCKED',
        ipAddress: getClientIp(req),
        deviceInfo: getDeviceInfo(req),
        summary: `Session ${session.id} expired (${session.rememberMe ? '240-min Remember Me limit' : 'standard window'} reached).`,
      });
      return { ok: false, status: 401, message: 'Session expired. Please sign in again.' };
    }

    // Idle session protection for non-Remember-Me sessions (60 min idle cutoff)
    const lastActiveMs = Date.parse(session.lastActiveAt || session.createdAt);
    if (!session.rememberMe && Number.isFinite(lastActiveMs) && now - lastActiveMs > store.sessionTtlMs) {
      session.status = 'EXPIRED';
      store.addSecurityLog({
        actorUserId: session.userId,
        eventType: 'SESSION_EXPIRED',
        result: 'BLOCKED',
        ipAddress: getClientIp(req),
        deviceInfo: getDeviceInfo(req),
        summary: `Session ${session.id} expired due to inactivity.`,
      });
      return {
        ok: false,
        status: 401,
        message: 'Session expired due to inactivity. Please sign in again.',
      };
    }

    const user = store.findUserByUserId(session.userId);
    if (!user || user.status !== 'ACTIVE') {
      session.status = 'REVOKED';
      return { ok: false, status: 401, message: 'User account is not active.' };
    }

    // Propagate server-signed password-change clearance across cold starts / serverless instances
    if ((user.mustChangePassword || user.passwordMigrationRequired) && sealedMcp === false && sealedPca) {
      const sealedPwdMs = Date.parse(sealedPca);
      const localPwdMs = Date.parse(user.passwordChangedAt || '1970-01-01T00:00:00.000Z');
      if (Number.isFinite(sealedPwdMs) && (!Number.isFinite(localPwdMs) || sealedPwdMs > localPwdMs)) {
        user.mustChangePassword = false;
        user.passwordMigrationRequired = false;
        user.isFirstLogin = false;
        user.passwordChanged = true;
        user.passwordChangedAt = sealedPca;
      }
    }

    return { ok: true, user, session };
  };

  const resolveSessionFromRequest = (
    req: Request
  ):
    | {
        ok: true;
        user: ServerUser;
        session: ServerSession;
        rawToken: string;
        source: 'bearer' | 'cookie';
        cookies: Record<string, string>;
      }
    | {
        ok: false;
        status: number;
        message: string;
        hasCookieToken: boolean;
        hasBearerToken: boolean;
      } => {
    const cookies = parseCookies(req.headers.cookie);
    const cookieToken = cookies[SESSION_COOKIE]?.trim() || undefined;
    const authHeader = req.headers.authorization;
    const bearerToken =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim() || undefined
        : undefined;

    const candidates: Array<{ token: string; source: 'bearer' | 'cookie' }> = [];
    if (bearerToken) {
      candidates.push({ token: bearerToken, source: 'bearer' });
    }
    if (cookieToken && cookieToken !== bearerToken) {
      candidates.push({ token: cookieToken, source: 'cookie' });
    }

    if (candidates.length === 0) {
      return {
        ok: false,
        status: 401,
        message: 'Authentication required.',
        hasCookieToken: false,
        hasBearerToken: false,
      };
    }

    let firstFailure: { status: number; message: string } | null = null;
    for (const candidate of candidates) {
      const result = evaluateSessionToken(req, candidate.token);
      if (result.ok) {
        return {
          ok: true,
          user: result.user,
          session: result.session,
          rawToken: candidate.token,
          source: candidate.source,
          cookies,
        };
      }
      if (!firstFailure) {
        firstFailure = { status: result.status, message: result.message };
      }
    }

    return {
      ok: false,
      status: firstFailure?.status ?? 401,
      message: firstFailure?.message ?? 'Authentication required.',
      hasCookieToken: Boolean(cookieToken),
      hasBearerToken: Boolean(bearerToken),
    };
  };

  // Authentication & Session Expiration Middleware
  const requireAuth = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const resolved = resolveSessionFromRequest(req);
    if (!resolved.ok) {
      return apiError(res, resolved.message, resolved.status);
    }

    const { user, session, source, cookies } = resolved;

    // CSRF Protection for state-changing requests authenticated solely via cookies
    if (
      source === 'cookie' &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase())
    ) {
      const csrfCookie = cookies[CSRF_COOKIE];
      const csrfHeader = req.headers['x-csrf-token'];
      if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
        return apiError(res, 'Invalid or missing CSRF token.', 403);
      }
    }

    session.lastActiveAt = new Date().toISOString();
    // Note: session.expiresAt is NEVER silently extended past session.maxAllowedExpiresAt
    req.authUser = user;
    req.authSession = session;

    if (user.mustChangePassword || user.passwordMigrationRequired) {
      const reqPath = (req.originalUrl || req.path || '').split('?')[0];
      let decodedPath = reqPath;
      try {
        decodedPath = decodeURIComponent(reqPath);
      } catch {
        decodedPath = reqPath;
      }
      const allowedWhileLocked =
        reqPath === '/api/auth/me' ||
        reqPath === '/api/auth/logout' ||
        reqPath === '/api/auth/reauthenticate' ||
        reqPath.startsWith('/api/auth/sessions') ||
        reqPath.startsWith('/api/auth/totp') ||
        decodedPath.toLowerCase() === `/api/users/${user.userId.toLowerCase()}/change-password`;
      if (!allowedWhileLocked) {
        return res.status(403).json({
          success: false,
          message: 'Password change required upon first login before accessing the portal.',
          data: { passwordChangeRequired: true, userId: user.userId },
          meta: { timestamp: new Date().toISOString() },
        });
      }
    }

    return next();
  };

  const requirePermission =
    (mod: ModuleKey, perm: PermissionType) =>
    (req: AuthedRequest, res: Response, next: NextFunction) => {
      const user = req.authUser;
      if (!user) return apiError(res, 'Unauthorized.', 401);

      if (!store.hasPermission(user, mod, perm)) {
        store.addSecurityLog({
          actorUserId: user.userId,
          eventType: 'UNAUTHORIZED_ACCESS',
          result: 'BLOCKED',
          ipAddress: getClientIp(req),
          deviceInfo: getDeviceInfo(req),
          summary: `Blocked ${user.role} access to ${mod}.${perm} (${req.method} ${req.path}).`,
        });
        phase08Store.raiseSecurityAlert({
          category: 'UNAUTHORIZED_ACCESS',
          severity: 'MEDIUM',
          title: `Unauthorized Access Blocked: ${user.userId}`,
          description: `Role ${user.role} blocked from ${mod}.${perm} at ${req.method} ${req.path}.`,
          relatedUserId: user.userId,
        });
        phase08Store.recordBeforeAfterAudit({
          userId: user.userId,
          userRole: user.role,
          actionType: 'UNAUTHORIZED_MODULE_ACCESS',
          module: mod,
          recordId: `${mod}.${perm}`,
          beforeValues: null,
          afterValues: { blocked: true, method: req.method, path: req.path },
          ipAddress: getClientIp(req),
          deviceInfo: getDeviceInfo(req),
          actionResult: 'BLOCKED',
        });
        return apiError(
          res,
          `Forbidden: ${user.role} lacks ${mod}.${perm} permission.`,
          403
        );
      }
      return next();
    };

  const isHttpsResponse = (res: Response): boolean => {
    const req = res.req;
    const xfProto = req?.headers?.['x-forwarded-proto'];
    const forwardedHttps =
      typeof xfProto === 'string' && xfProto.split(',')[0].trim().toLowerCase() === 'https';
    return Boolean(req?.secure || forwardedHttps || process.env.NODE_ENV === 'production');
  };

  const setSessionCookies = (
    res: Response,
    rawToken: string,
    csrfToken: string,
    maxAgeMs: number
  ) => {
    const isHttps = isHttpsResponse(res);
    const sameSite = isHttps ? 'SameSite=None; Secure' : 'SameSite=Lax';
    const maxAgeSec = Math.floor(maxAgeMs / 1000);
    res.setHeader('Set-Cookie', [
      `${SESSION_COOKIE}=${encodeURIComponent(rawToken)}; HttpOnly; ${sameSite}; Path=/; Max-Age=${maxAgeSec}`,
      `${CSRF_COOKIE}=${encodeURIComponent(csrfToken)}; ${sameSite}; Path=/; Max-Age=${maxAgeSec}`,
    ]);
  };

  const clearSessionCookies = (res: Response) => {
    const isHttps = isHttpsResponse(res);
    const sameSite = isHttps ? 'SameSite=None; Secure' : 'SameSite=Lax';
    res.setHeader('Set-Cookie', [
      `${SESSION_COOKIE}=; HttpOnly; ${sameSite}; Path=/; Max-Age=0`,
      `${CSRF_COOKIE}=; ${sameSite}; Path=/; Max-Age=0`,
    ]);
  };

  const readLiveBuildManifest = () => {
    const manifestPath = path.resolve(process.cwd(), 'dist', 'version.json');
    try {
      if (fs.existsSync(manifestPath)) {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
          version?: string;
          baseVersion?: string;
          buildId?: string;
          builtAt?: string;
          commitSha?: string | null;
        };
        if (parsed.version && parsed.buildId) {
          return {
            version: parsed.version,
            baseVersion: parsed.baseVersion || parsed.version,
            buildId: parsed.buildId,
            builtAt: parsed.builtAt || new Date().toISOString(),
            commitSha: parsed.commitSha ?? null,
          };
        }
      }
    } catch {
      // Fallback to package.json
    }
    let baseVersion = '1.1.0';
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')
      ) as { version?: string };
      if (pkg.version && pkg.version !== '0.0.0') {
        baseVersion = pkg.version;
      }
    } catch {
      // Keep default version
    }
    const sha =
      process.env.VERCEL_GIT_COMMIT_SHA?.trim().slice(0, 7) ||
      process.env.GITHUB_SHA?.trim().slice(0, 7) ||
      '';
    return {
      version: sha ? `${baseVersion}+${sha}` : baseVersion,
      baseVersion,
      buildId: sha || 'dev',
      builtAt: new Date().toISOString(),
      commitSha: sha || null,
    };
  };

  // ==========================================================================
  // HEALTH & ARCHITECTURE STATUS
  // ==========================================================================
  app.get('/api/version', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    apiSuccess(res, readLiveBuildManifest());
  });

  app.get('/api/health', (_req, res) => {
    const smsCfg = phase03Store.getSmsGatewayConfig();
    const buildInfo = readLiveBuildManifest();
    apiSuccess(res, {
      status: 'ok',
      phase: 'MUN COMPUTER ERP · 4-Layer Backend Authentication',
      appVersion: buildInfo.version,
      buildId: buildInfo.buildId,
      builtAt: buildInfo.builtAt,
      firebaseAuthRemoved: true,
      fast2smsConfigured: isFast2SmsConfigured(smsCfg),
      fast2smsRoute: smsCfg.route,
      fast2smsTemplateConfigured: Boolean(smsCfg.dltTemplateId),
      firebaseAdminDbActive: isFirebaseAdminActive(),
      mysqlConfigured: Boolean(process.env.DB_HOST && process.env.DB_DATABASE),
      smsEmailConfigured: isSmsOrEmailConfigured() || Boolean(smsCfg.apiKey),
      maintenanceMode: phase03Store.maintenanceSettings.maintenanceMode,
      lastHealthCheckAt: phase03Store.maintenanceSettings.lastHealthCheckAt,
    });
  });

  // ==========================================================================
  // 4-LAYER SEQUENTIAL AUTHENTICATION, CAPTCHA, FAST2SMS OTP, TOTP & SESSIONS
  // ==========================================================================
  registerAuthRoutes({
    app,
    store,
    phase03Store,
    phase08Store,
    authRateLimiter,
    requireAuth,
    resolveSessionFromRequest,
    requirePermission,
    setSessionCookies,
    clearSessionCookies,
    getClientIp,
    getDeviceInfo,
    apiSuccess,
    apiError,
    validateStrongPassword,
    persistSecurityState,
    persistRuntimeState,
  });


  // ==========================================================================
  // USER MANAGEMENT ROUTES
  // ==========================================================================
  app.get(
    '/api/users',
    requireAuth,
    requirePermission('users', 'VIEW'),
    (req: AuthedRequest, res) => {
      const actor = req.authUser!;
      const visible = store.users.filter((u) =>
        actor.role === 'MANAGER' ? u.role !== 'ADMIN' : true
      );
      return apiSuccess(
        res,
        visible.map((u) => store.sanitizePublicUser(u, actor.role))
      );
    }
  );

  app.get('/api/users/id-prefix-preview', requireAuth, (req: AuthedRequest, res) => {
    const roleParam = String(req.query.role ?? 'STAFF').toUpperCase() as RoleName;
    if (!['ADMIN', 'MANAGER', 'STAFF', 'AUDITOR', 'CUSTOMER'].includes(roleParam)) {
      return apiError(res, 'Invalid role parameter.', 400);
    }
    const prefix = store.sequenceService.getPrefixPreview(roleParam);
    return apiSuccess(res, {
      role: roleParam,
      prefix,
      format: 'MCYYFFMMSSSS',
      example: `${prefix}XXXX`,
      nextExample: `${prefix}0001`,
    });
  });

  app.get('/api/users/id-generation-history', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (!['ADMIN', 'MANAGER', 'AUDITOR'].includes(actor.role)) {
      return apiError(res, 'Forbidden: cannot view User ID generation ledger.', 403);
    }
    return apiSuccess(res, store.sequenceService.getGenerationHistory());
  });

  app.post(
    '/api/users',
    requireAuth,
    requirePermission('users', 'ADD'),
    async (req: AuthedRequest, res) => {
      const actor = req.authUser!;
      const {
        fullName,
        role,
        mobile,
        email,
        address,
        aadhaarNumber,
        aadhaarConsent,
        password,
        confirmPassword,
        branch,
        designation,
        departmentCode,
        joiningDate,
        emergencyContact,
        profilePhotoUrl,
      } = req.body ?? {};

      const targetRole = String(role ?? 'STAFF').toUpperCase() as RoleName;
      if (!['ADMIN', 'MANAGER', 'STAFF', 'AUDITOR', 'CUSTOMER'].includes(targetRole)) {
        return apiError(res, 'Invalid target role.', 422);
      }

      // Role creation permission matrix per Part 03
      if (actor.role === 'ADMIN') {
        // ADMIN can create ADMIN, MANAGER, STAFF, EMPLOYEE, AUDITOR
      } else if (actor.role === 'MANAGER') {
        if (!['STAFF', 'EMPLOYEE'].includes(targetRole)) {
          store.addSecurityLog({
            actorUserId: actor.userId,
            eventType: 'UNAUTHORIZED_ACCESS',
            result: 'BLOCKED',
            ipAddress: getClientIp(req),
            deviceInfo: getDeviceInfo(req),
            summary: `Manager ${actor.userId} blocked from creating ${targetRole} account.`,
          });
          return apiError(res, 'Managers can only create STAFF and EMPLOYEE accounts.', 403);
        }
      } else if (actor.role === 'STAFF') {
        if (targetRole !== 'EMPLOYEE') {
          store.addSecurityLog({
            actorUserId: actor.userId,
            eventType: 'UNAUTHORIZED_ACCESS',
            result: 'BLOCKED',
            ipAddress: getClientIp(req),
            deviceInfo: getDeviceInfo(req),
            summary: `Staff ${actor.userId} blocked from creating ${targetRole} account.`,
          });
          return apiError(res, 'Staff can only create EMPLOYEE accounts.', 403);
        }
      } else {
        return apiError(res, 'You do not have permission to create user accounts.', 403);
      }

      const errors: Record<string, string[]> = {};
      if (!fullName || String(fullName).trim().length < 2) {
        errors.fullName = ['Full name must be at least 2 characters.'];
      }
      if (!mobile || String(mobile).trim().length < 8) {
        errors.mobile = ['Valid mobile number is required.'];
      }
      if (!address || String(address).trim().length < 4) {
        errors.address = ['Address is required.'];
      }
      const cleanPassword = typeof password === 'string' ? password.trim() : '';
      const cleanConfirmPassword = typeof confirmPassword === 'string' ? confirmPassword.trim() : '';
      const pwdErr = validateStrongPassword(cleanPassword);
      if (pwdErr) {
        errors.password = [pwdErr];
      }
      if (cleanPassword !== cleanConfirmPassword) {
        errors.confirmPassword = ['Passwords do not match.'];
      }
      if (aadhaarNumber) {
        const cleanedAadhaar = String(aadhaarNumber).replace(/\s|-/g, '');
        if (!/^\d{12}$/.test(cleanedAadhaar)) {
          errors.aadhaarNumber = ['Aadhaar must be 12 digits when provided.'];
        }
        if (!aadhaarConsent) {
          errors.aadhaarConsent = [
            'Explicit informed consent is required before encrypting Aadhaar.',
          ];
        }
      }
      if (Object.keys(errors).length > 0) {
        return apiError(res, 'Validation failed.', 422, errors);
      }

      // Duplicate mobile check
      if (store.users.some((u) => u.mobile === String(mobile).trim())) {
        return apiError(res, 'Mobile number is already registered.', 409);
      }

      let aadhaarEncrypted: string | undefined;
      let aadhaarLast4: string | undefined;
      let aadhaarConsentAt: string | undefined;
      if (aadhaarNumber) {
        const cleaned = String(aadhaarNumber).replace(/\s|-/g, '');
        aadhaarEncrypted = encryptSensitiveField(cleaned);
        aadhaarLast4 = cleaned.slice(-4);
        aadhaarConsentAt = new Date().toISOString();
      }

      const resolvedDept = departmentCode ? sanitizeText(String(departmentCode)).toUpperCase() : 'DEPT-CSC';
      const resolvedDesignation = designation ? sanitizeText(String(designation)) : `${targetRole} Associate`;
      const resolvedJoinDate = joiningDate ? sanitizeText(String(joiningDate)) : new Date().toISOString().slice(0, 10);

      // Manager registrations enter approval workflow for Staff; Admin creates directly
      if (actor.role === 'MANAGER') {
        const now = new Date().toISOString();
        const requestRecord = {
          id: store.registrationRequests.length + 1,
          requestId: store.nextRequestCode(),
          applicantName: sanitizeText(String(fullName)),
          requestedRole: 'STAFF' as RoleName,
          mobile: sanitizeText(String(mobile)),
          email: email ? sanitizeText(String(email)) : undefined,
          address: sanitizeText(String(address)),
          designation: resolvedDesignation,
          departmentCode: resolvedDept,
          joiningDate: resolvedJoinDate,
          aadhaarEncrypted,
          aadhaarLast4,
          aadhaarConsentAt,
          passwordHash: hashPassword(cleanPassword),
          mobileVerified: true,
          submittedBy: actor.userId,
          status: 'PENDING' as const,
          createdAt: now,
          updatedAt: now,
        };
        store.registrationRequests.unshift(requestRecord);
        persistSecurityState();

        store.addAuditLog({
          actorUserId: actor.userId,
          action: 'SUBMIT_STAFF_REGISTRATION',
          targetType: 'registration_request',
          targetId: requestRecord.requestId,
          details: `Manager submitted STAFF registration request for ${requestRecord.applicantName}.`,
          ipAddress: getClientIp(req),
        });
        store.addPhase02Notification({
          triggerType: 'STAFF_REGISTRATION_PENDING',
          recipientUserId: 'MC2627110001',
          title: `Staff Registration Pending: ${requestRecord.requestId}`,
          message: `Manager ${actor.userId} submitted STAFF onboarding request for ${requestRecord.applicantName}.`,
          severity: 'INFO',
        });

        return apiSuccess(
          res,
          { registrationRequest: requestRecord, requiresApproval: true },
          'Staff registration submitted to Approval Management workflow.',
          201
        );
      }

      // Admin direct creation -> atomic User ID allocation (MCYYFFMMSSSS)
      const generatedUserId = await store.sequenceService.allocateNext(
        targetRole,
        undefined,
        undefined,
        {
          actorUserId: actor.userId,
          departmentCode: resolvedDept,
        }
      );
      const now = new Date().toISOString();
      const newUser: ServerUser = {
        id: store.users.length + 1,
        userId: generatedUserId,
        isMasterAdmin: false,
        fullName: sanitizeText(String(fullName)),
        role: targetRole,
        mobile: sanitizeText(String(mobile)),
        email: email ? sanitizeText(String(email)) : undefined,
        address: sanitizeText(String(address)),
        designation: resolvedDesignation,
        departmentCode: resolvedDept,
        joiningDate: resolvedJoinDate,
        emergencyContact: emergencyContact ? sanitizeText(String(emergencyContact)) : undefined,
        profilePhotoUrl: profilePhotoUrl ? sanitizeText(String(profilePhotoUrl)) : undefined,
        aadhaarEncrypted,
        aadhaarLast4,
        aadhaarConsentAt,
        passwordHash: hashPassword(cleanPassword),
        passwordAlgo: 'bcrypt-12',
        branch: branch ? sanitizeText(String(branch)) : 'Main Service Center',
        status: 'ACTIVE',
        mobileVerified: true,
        emailVerified: false,
        failedLoginAttempts: 0,
        lockedUntil: null,
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
        passwordChangedAt: now,
        customPermissions: {},
      };
      store.users.unshift(newUser);
      phase08Store.pushPasswordHistory(newUser.userId, newUser.passwordHash);
      persistSecurityState();
      void syncUserRecordToFirebase(newUser).catch(() => {});

      store.addAuditLog({
        actorUserId: actor.userId,
        action: 'CREATE_USER',
        targetType: 'user',
        targetId: newUser.userId,
        details: `Provisioned ${newUser.role} account ${newUser.userId} (${newUser.fullName}, ${resolvedDept}).`,
        ipAddress: getClientIp(req),
      });
      store.addSecurityLog({
        actorUserId: actor.userId,
        targetUserId: newUser.userId,
        eventType: 'USER_CREATED',
        result: 'SUCCESS',
        ipAddress: getClientIp(req),
        deviceInfo: getDeviceInfo(req),
        summary: `Admin created ${newUser.role} account ${newUser.userId} in ${resolvedDept}.`,
      });
      store.addPhase02Notification({
        triggerType: 'STAFF_ACCOUNT_CREATED',
        recipientUserId: newUser.userId,
        title: `Account Provisioned: ${newUser.userId}`,
        message: `Your ${newUser.role} account (${newUser.userId}) is active under ${resolvedDept}.`,
        severity: 'INFO',
      });
      void sendFast2SmsTemplateMessage({
        mobile: newUser.mobile,
        purpose: 'ACCOUNT_REGISTRATION',
        variables: [newUser.userId, newUser.fullName],
        fallbackText: `MUN COMPUTER: Account registered successfully. User ID: ${newUser.userId}.`,
        runtimeConfig: phase03Store.getSmsGatewayConfig(),
      }).catch(() => {});

      return apiSuccess(
        res,
        { user: store.sanitizePublicUser(newUser, actor.role), requiresApproval: false },
        `User ${newUser.userId} created.`,
        201
      );
    }
  );

  app.get('/api/users/:id', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    const target = store.findUserByUserId(req.params.id) ?? store.findUserByNumericId(Number(req.params.id));
    if (!target) {
      return apiError(res, 'User not found.', 404);
    }
    if (actor.userId !== target.userId && !store.hasPermission(actor, 'users', 'VIEW')) {
      return apiError(res, 'Forbidden: cannot inspect another user profile.', 403);
    }
    if (actor.role === 'MANAGER' && target.role === 'ADMIN') {
      return apiError(res, 'Forbidden: Managers cannot inspect Admin accounts.', 403);
    }
    return apiSuccess(res, store.sanitizePublicUser(target, actor.role));
  });

  app.put('/api/users/:id', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    const target = store.findUserByUserId(req.params.id) ?? store.findUserByNumericId(Number(req.params.id));
    if (!target) return apiError(res, 'User not found.', 404);

    const isSelf = actor.userId === target.userId;
    if (!isSelf && !store.hasPermission(actor, 'users', 'EDIT')) {
      return apiError(res, 'Forbidden: insufficient permissions to edit user.', 403);
    }
    if (actor.role === 'MANAGER' && target.role === 'ADMIN') {
      return apiError(res, 'Forbidden: Managers cannot modify Admin accounts.', 403);
    }

    const {
      fullName,
      email,
      address,
      branch,
      designation,
      departmentCode,
      joiningDate,
      emergencyContact,
      profilePhotoUrl,
    } = req.body ?? {};
    // User IDs and Master Admin roles are immutable after creation!
    if (fullName && String(fullName).trim().length >= 2) {
      target.fullName = sanitizeText(String(fullName));
    }
    if (typeof email === 'string') {
      target.email = sanitizeText(email) || undefined;
    }
    if (typeof address === 'string' && address.trim().length >= 4) {
      target.address = sanitizeText(address);
    }
    if (typeof branch === 'string' && !isSelf) {
      target.branch = sanitizeText(branch);
    }
    if (typeof designation === 'string' && !isSelf) {
      target.designation = sanitizeText(designation);
    }
    if (typeof departmentCode === 'string' && !isSelf && actor.role === 'ADMIN') {
      target.departmentCode = sanitizeText(departmentCode).toUpperCase();
    }
    if (typeof joiningDate === 'string' && !isSelf) {
      target.joiningDate = sanitizeText(joiningDate);
    }
    if (typeof emergencyContact === 'string') {
      target.emergencyContact = sanitizeText(emergencyContact) || undefined;
    }
    if (typeof profilePhotoUrl === 'string') {
      target.profilePhotoUrl = sanitizeText(profilePhotoUrl) || undefined;
    }
    target.updatedAt = new Date().toISOString();
    persistSecurityState();
    void syncUserRecordToFirebase(target).catch(() => {});

    store.addAuditLog({
      actorUserId: actor.userId,
      action: 'UPDATE_USER_PROFILE',
      targetType: 'user',
      targetId: target.userId,
      details: `Updated profile details for ${target.userId}.`,
      ipAddress: getClientIp(req),
    });
    store.addSecurityLog({
      actorUserId: actor.userId,
      targetUserId: target.userId,
      eventType: 'PROFILE_UPDATED',
      result: 'SUCCESS',
      ipAddress: getClientIp(req),
      deviceInfo: getDeviceInfo(req),
      summary: `Profile details updated for ${target.userId}.`,
    });

    return apiSuccess(res, store.sanitizePublicUser(target, actor.role), 'Profile updated.');
  });

  app.post('/api/users/:id/change-password', requireAuth, async (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    const target = store.findUserByUserId(req.params.id);
    if (!target || target.userId !== actor.userId) {
      return apiError(res, 'You may only change your own password here.', 403);
    }

    const { currentPassword, newPassword, confirmPassword } = req.body ?? {};
    const cleanCurrent = typeof currentPassword === 'string' ? currentPassword.trim() : '';
    const cleanNew = typeof newPassword === 'string' ? newPassword.trim() : '';
    const cleanConfirm = typeof confirmPassword === 'string' ? confirmPassword.trim() : '';

    if (!cleanCurrent || !verifyPassword(cleanCurrent, target.passwordHash)) {
      return apiError(res, 'Current password is incorrect.', 401);
    }
    const pwdErr = validateStrongPassword(cleanNew);
    if (pwdErr) {
      return apiError(res, pwdErr, 422);
    }
    if (cleanNew !== cleanConfirm) {
      return apiError(res, 'New password and confirmation do not match.', 422);
    }
    if (verifyPassword(cleanNew, target.passwordHash)) {
      return apiError(
        res,
        'New password must be different from your current or default password.',
        422
      );
    }
    const existingHistory = phase08Store.passwordHistory.get(target.userId) ?? [];
    if (target.passwordHash && !existingHistory.includes(target.passwordHash)) {
      phase08Store.pushPasswordHistory(target.userId, target.passwordHash);
    }
    if (phase08Store.checkPasswordAgainstHistory(target.userId, cleanNew)) {
      return apiError(
        res,
        `Password policy prohibits reusing any of your last ${phase08Store.settings.passwordHistoryCount} password(s).`,
        422
      );
    }

    const revokeCurrentSession = Boolean(req.body?.revokeCurrentSession);
    const nextHash = hashPassword(cleanNew);
    target.passwordHash = nextHash;
    target.passwordAlgo = 'bcrypt-12';
    target.mustChangePassword = false;
    target.passwordMigrationRequired = false;
    target.isFirstLogin = false;
    target.passwordChanged = true;
    target.failedLoginAttempts = 0;
    target.lockedUntil = null;
    phase08Store.pushPasswordHistory(target.userId, nextHash);
    target.passwordChangedAt = new Date().toISOString();
    target.updatedAt = target.passwordChangedAt;

    const currentSess = req.authSession!;
    // Revoke other active sessions (and current session if revokeCurrentSession is requested for first-login relogin)
    for (const [tokenHashKey, session] of store.sessions.entries()) {
      if (
        session.userId === target.userId &&
        session.status === 'ACTIVE' &&
        (revokeCurrentSession || session.id !== currentSess.id)
      ) {
        session.status = 'REVOKED';
        store.revokedTokenHashes.add(tokenHashKey);
        if (session.tokenHash) store.revokedTokenHashes.add(session.tokenHash);
        void syncSessionRecordToFirebase(session).catch(() => {});
      }
    }

    let refreshedCsrf = '';
    let refreshedRawToken = '';
    if (revokeCurrentSession) {
      currentSess.status = 'REVOKED';
      if (currentSess.tokenHash) {
        store.revokedTokenHashes.add(currentSess.tokenHash);
      }
      void syncSessionRecordToFirebase(currentSess).catch(() => {});
    } else {
      const remainingTtlMs = Math.max(1000, currentSess.maxAllowedExpiresAt - Date.now());
      refreshedCsrf = generateToken(24);
      const refreshedSealed = Buffer.from(
        encryptSensitiveField(
          JSON.stringify({
            r: generateToken(6),
            sid: currentSess.id,
            u: target.userId,
            role: target.role,
            rm: Boolean(currentSess.rememberMe),
            di: currentSess.deviceId,
            ca: currentSess.createdAt,
            ea: currentSess.expiresAt,
            mea: currentSess.maxAllowedExpiresAt,
            ra: currentSess.reauthenticatedUntil,
            mcp: false,
            pca: target.passwordChangedAt,
          })
        )
      ).toString('base64url');
      refreshedRawToken = `sess1.${refreshedSealed}`;
      const nextTokenHash = sha256(refreshedRawToken);
      currentSess.tokenHash = nextTokenHash;
      store.sessions.set(nextTokenHash, currentSess);
    }

    store.addSecurityLog({
      actorUserId: actor.userId,
      targetUserId: target.userId,
      eventType: 'PASSWORD_CHANGED',
      result: 'SUCCESS',
      ipAddress: getClientIp(req),
      deviceInfo: getDeviceInfo(req),
      summary: revokeCurrentSession
        ? 'Mandatory first-login password updated; all active sessions signed out for fresh login.'
        : 'User updated account password; other active sessions revoked.',
    });
    store.addPhase02Notification({
      triggerType: 'PASSWORD_CHANGED',
      recipientUserId: target.userId,
      title: 'Password Changed',
      message: revokeCurrentSession
        ? 'Your first-login password was updated permanently. Sign in again using your new password.'
        : 'Your account password was changed and other active sessions were signed out.',
      severity: 'INFO',
    });
    phase08Store.recordBeforeAfterAudit({
      userId: actor.userId,
      userRole: actor.role,
      actionType: 'CHANGE_PASSWORD',
      module: 'users',
      recordId: target.userId,
      beforeValues: null,
      afterValues: { passwordChangedAt: target.passwordChangedAt, revokeCurrentSession },
      ipAddress: getClientIp(req),
      deviceInfo: getDeviceInfo(req),
      actionResult: 'SUCCESS',
    });

    persistSecurityState();
    persistRuntimeState();
    await Promise.race([
      Promise.allSettled([
        syncUserRecordToFirebase(target),
        syncSessionRecordToFirebase(currentSess),
      ]),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    if (revokeCurrentSession) {
      clearSessionCookies(res);
    } else {
      const remainingTtlMs = Math.max(1000, currentSess.maxAllowedExpiresAt - Date.now());
      setSessionCookies(res, refreshedRawToken, refreshedCsrf, remainingTtlMs);
    }
    void sendFast2SmsTemplateMessage({
      mobile: target.mobile,
      purpose: 'PASSWORD_CHANGED',
      variables: [target.userId],
      fallbackText: `MUN COMPUTER: Your account password (${target.userId}) was changed successfully.`,
      runtimeConfig: phase03Store.getSmsGatewayConfig(),
    }).catch(() => {});

    return apiSuccess(
      res,
      {
        changed: true,
        requiresRelogin: revokeCurrentSession,
        ...(revokeCurrentSession
          ? {}
          : { csrfToken: refreshedCsrf, accessToken: refreshedRawToken }),
        user: store.sanitizePublicUser(target, target.role),
      },
      revokeCurrentSession
        ? 'Password successfully changed. Please log in again with your new password.'
        : 'Password changed successfully.'
    );
  });

  app.post(
    '/api/users/:id/set-password',
    requireAuth,
    requirePermission('users', 'EDIT'),
    async (req: AuthedRequest, res) => {
      const actor = req.authUser!;
      if (actor.role !== 'ADMIN') {
        return apiError(res, 'Only ADMIN can directly set or reset another user password.', 403);
      }
      const target =
        store.findUserByUserId(req.params.id) ?? store.findUserByNumericId(Number(req.params.id));
      if (!target) return apiError(res, 'User not found.', 404);
      if (target.userId === actor.userId) {
        return apiError(
          res,
          'Use self-service Change Password to update your own account password.',
          400
        );
      }
      if (store.isMasterAdminUser(target) && !store.isMasterAdminUser(actor)) {
        return apiError(
          res,
          'Only Master Admin can update a Master Admin account password.',
          403
        );
      }

      const { newPassword, confirmPassword, requireChangeOnNextLogin } = req.body ?? {};
      const cleanNew = typeof newPassword === 'string' ? newPassword.trim() : '';
      const cleanConfirm = typeof confirmPassword === 'string' ? confirmPassword.trim() : '';
      const pwdErr = validateStrongPassword(cleanNew);
      if (pwdErr) {
        return apiError(res, pwdErr, 422);
      }
      if (cleanNew !== cleanConfirm) {
        return apiError(res, 'New password and confirmation do not match.', 422);
      }
      if (phase08Store.checkPasswordAgainstHistory(target.userId, cleanNew)) {
        return apiError(
          res,
          `Password policy prohibits reusing any of the last ${phase08Store.settings.passwordHistoryCount} password(s).`,
          422
        );
      }

      const nextHash = hashPassword(cleanNew);
      const nowIso = new Date().toISOString();
      target.passwordHash = nextHash;
      target.passwordAlgo = 'bcrypt-12';
      target.mustChangePassword = Boolean(requireChangeOnNextLogin);
      target.passwordMigrationRequired = false;
      target.isFirstLogin = Boolean(requireChangeOnNextLogin);
      target.passwordChanged = !requireChangeOnNextLogin;
      target.failedLoginAttempts = 0;
      target.lockedUntil = null;
      target.passwordChangedAt = nowIso;
      target.updatedAt = nowIso;
      phase08Store.pushPasswordHistory(target.userId, nextHash);

      let revokedSessions = 0;
      for (const [tokenHashKey, session] of store.sessions.entries()) {
        if (session.userId === target.userId && session.status === 'ACTIVE') {
          session.status = 'REVOKED';
          store.revokedTokenHashes.add(tokenHashKey);
          if (session.tokenHash) store.revokedTokenHashes.add(session.tokenHash);
          revokedSessions += 1;
          void syncSessionRecordToFirebase(session).catch(() => {});
        }
      }

      store.addAuditLog({
        actorUserId: actor.userId,
        action: 'ADMIN_SET_USER_PASSWORD',
        targetType: 'user',
        targetId: target.userId,
        details: `Admin set new password for ${target.userId} (mustChangePassword=${target.mustChangePassword}, revokedSessions=${revokedSessions}).`,
        ipAddress: getClientIp(req),
      });
      store.addSecurityLog({
        actorUserId: actor.userId,
        targetUserId: target.userId,
        eventType: 'PASSWORD_RESET',
        result: 'SUCCESS',
        ipAddress: getClientIp(req),
        deviceInfo: getDeviceInfo(req),
        summary: `Admin ${actor.userId} set password for ${target.userId}; ${revokedSessions} session(s) revoked.`,
      });
      store.addPhase02Notification({
        triggerType: 'PASSWORD_CHANGED',
        recipientUserId: target.userId,
        title: 'Password Updated by Administrator',
        message: target.mustChangePassword
          ? 'Your password was reset by an Administrator. Please sign in and set your personal password.'
          : 'Your password was updated by an Administrator and previous sessions were signed out.',
        severity: 'WARNING',
      });
      phase08Store.recordBeforeAfterAudit({
        userId: actor.userId,
        userRole: actor.role,
        actionType: 'ADMIN_SET_PASSWORD',
        module: 'users',
        recordId: target.userId,
        beforeValues: null,
        afterValues: {
          passwordChangedAt: nowIso,
          mustChangePassword: target.mustChangePassword,
          revokedSessions,
        },
        ipAddress: getClientIp(req),
        deviceInfo: getDeviceInfo(req),
        actionResult: 'SUCCESS',
      });

      persistSecurityState();
      persistRuntimeState();
      await Promise.race([
        Promise.allSettled([syncUserRecordToFirebase(target)]),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);

      return apiSuccess(
        res,
        {
          updated: true,
          revokedSessions,
          user: store.sanitizePublicUser(target, actor.role),
        },
        `Password updated for ${target.userId}. ${revokedSessions} active session(s) revoked.`
      );
    }
  );

  app.patch(
    '/api/users/:id/status',
    requireAuth,
    requirePermission('users', 'EDIT'),
    (req: AuthedRequest, res) => {
      const actor = req.authUser!;
      const target = store.findUserByUserId(req.params.id) ?? store.findUserByNumericId(Number(req.params.id));
      if (!target) return apiError(res, 'User not found.', 404);

      if (store.isMasterAdminUser(target)) {
        store.addSecurityLog({
          actorUserId: actor.userId,
          targetUserId: target.userId,
          eventType: 'UNAUTHORIZED_ACCESS',
          result: 'BLOCKED',
          ipAddress: getClientIp(req),
          deviceInfo: getDeviceInfo(req),
          summary: `Blocked attempt to alter protected Master Admin account ${target.userId}.`,
        });
        return apiError(res, 'Master Admin account is protected and cannot be suspended, deactivated, or downgraded.', 403);
      }

      if (actor.role === 'MANAGER' && target.role !== 'STAFF') {
        return apiError(res, 'Managers can only change status of STAFF accounts.', 403);
      }
      if (actor.userId === target.userId) {
        return apiError(res, 'You cannot suspend or deactivate your own account.', 400);
      }

      const nextStatus = String(req.body?.status ?? '').toUpperCase() as AccountStatus;
      if (!['ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'REJECTED'].includes(nextStatus)) {
        return apiError(res, 'Invalid account status.', 422);
      }

      const prevStatus = target.status;
      target.status = nextStatus;
      target.updatedAt = new Date().toISOString();
      if (nextStatus === 'ACTIVE') {
        target.failedLoginAttempts = 0;
        target.lockedUntil = null;
      }
      void syncUserRecordToFirebase(target).catch(() => {});

      // Immediately revoke sessions if suspended or deactivated
      if (nextStatus === 'SUSPENDED' || nextStatus === 'DEACTIVATED') {
        for (const s of store.sessions.values()) {
          if (s.userId === target.userId && s.status === 'ACTIVE') {
            s.status = 'REVOKED';
            store.revokedTokenHashes.add(s.tokenHash);
            void syncSessionRecordToFirebase(s).catch(() => {});
          }
        }
      }
      persistSecurityState();

      store.addSecurityLog({
        actorUserId: actor.userId,
        targetUserId: target.userId,
        eventType: 'ACCOUNT_STATUS_CHANGED',
        result: 'SUCCESS',
        ipAddress: getClientIp(req),
        deviceInfo: getDeviceInfo(req),
        summary: `Changed ${target.userId} status from ${prevStatus} to ${nextStatus}.`,
      });
      store.addAuditLog({
        actorUserId: actor.userId,
        action: 'CHANGE_ACCOUNT_STATUS',
        targetType: 'user',
        targetId: target.userId,
        details: `Status transition: ${prevStatus} -> ${nextStatus}`,
        ipAddress: getClientIp(req),
      });
      phase08Store.recordBeforeAfterAudit({
        userId: actor.userId,
        userRole: actor.role,
        actionType: 'CHANGE_ACCOUNT_STATUS',
        module: 'users',
        recordId: target.userId,
        beforeValues: { status: prevStatus },
        afterValues: { status: nextStatus },
        ipAddress: getClientIp(req),
        deviceInfo: getDeviceInfo(req),
        actionResult: 'SUCCESS',
      });

      return apiSuccess(
        res,
        store.sanitizePublicUser(target, actor.role),
        `Account ${target.userId} marked ${nextStatus}.`
      );
    }
  );

  app.delete(
    '/api/users/:id',
    requireAuth,
    requirePermission('users', 'DELETE'),
    (req: AuthedRequest, res) => {
      const actor = req.authUser!;
      if (actor.role !== 'ADMIN') {
        return apiError(res, 'Only ADMIN can deactivate/delete user accounts.', 403);
      }
      const target = store.findUserByUserId(req.params.id) ?? store.findUserByNumericId(Number(req.params.id));
      if (!target) return apiError(res, 'User not found.', 404);
      if (store.isMasterAdminUser(target)) {
        store.addSecurityLog({
          actorUserId: actor.userId,
          targetUserId: target.userId,
          eventType: 'UNAUTHORIZED_ACCESS',
          result: 'BLOCKED',
          ipAddress: getClientIp(req),
          deviceInfo: getDeviceInfo(req),
          summary: `Blocked deletion attempt on protected Master Admin ${target.userId}.`,
        });
        return apiError(res, 'Master Admin account cannot be deleted or deactivated.', 403);
      }
      if (actor.userId === target.userId) {
        return apiError(res, 'Cannot delete your own active session account.', 400);
      }

      const prev = target.status;
      target.status = 'DEACTIVATED';
      target.updatedAt = new Date().toISOString();
      void syncUserRecordToFirebase(target).catch(() => {});
      for (const s of store.sessions.values()) {
        if (s.userId === target.userId && s.status === 'ACTIVE') {
          s.status = 'REVOKED';
          store.revokedTokenHashes.add(s.tokenHash);
          void syncSessionRecordToFirebase(s).catch(() => {});
        }
      }
      persistSecurityState();
      store.addSecurityLog({
        actorUserId: actor.userId,
        targetUserId: target.userId,
        eventType: 'ACCOUNT_STATUS_CHANGED',
        result: 'SUCCESS',
        ipAddress: getClientIp(req),
        deviceInfo: getDeviceInfo(req),
        summary: `Admin deactivated user ${target.userId} (previous: ${prev}).`,
      });
      return apiSuccess(res, { userId: target.userId, status: target.status }, `User ${target.userId} deactivated.`);
    }
  );

  // Authorized Admin-only Aadhaar reveal (never logged in plaintext)
  app.get('/api/users/:id/aadhaar', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN') {
      return apiError(res, 'Only ADMIN is authorized to decrypt sensitive Aadhaar records.', 403);
    }
    const target = store.findUserByUserId(req.params.id);
    if (!target || !target.aadhaarEncrypted) {
      return apiError(res, 'No Aadhaar record stored for this user.', 404);
    }
    const decrypted = decryptSensitiveField(target.aadhaarEncrypted);
    store.addAuditLog({
      actorUserId: actor.userId,
      action: 'AUTHORIZED_AADHAAR_ACCESS',
      targetType: 'user',
      targetId: target.userId,
      details: 'Authorized admin decrypted masked Aadhaar record (value omitted from log).',
      ipAddress: getClientIp(req),
    });
    return apiSuccess(res, {
      userId: target.userId,
      aadhaarFormatted: `${decrypted.slice(0, 4)}-${decrypted.slice(4, 8)}-${decrypted.slice(8, 12)}`,
      masked: maskAadhaar(target.aadhaarLast4),
    });
  });

  // ==========================================================================
  // REGISTRATION REQUESTS & APPROVAL WORKFLOW
  // (PUBLIC SELF-REGISTRATION DISABLED: ONLY AUTHENTICATED ADMIN/MANAGER)
  // ==========================================================================
  app.get(
    '/api/registration-requests',
    requireAuth,
    requirePermission('approvals', 'VIEW'),
    (_req, res) => {
      const safeRequests = store.registrationRequests.map((r) => ({
        id: r.id,
        requestId: r.requestId,
        applicantName: r.applicantName,
        requestedRole: r.requestedRole,
        mobile: r.mobile,
        email: r.email ?? '',
        address: r.address,
        designation: r.designation ?? '',
        departmentCode: r.departmentCode ?? 'DEPT-CSC',
        joiningDate: r.joiningDate ?? r.createdAt.slice(0, 10),
        aadhaarMasked: r.aadhaarLast4 ? `XXXX-XXXX-${r.aadhaarLast4}` : undefined,
        mobileVerified: r.mobileVerified,
        submittedBy: r.submittedBy,
        status: r.status,
        reviewedBy: r.reviewedBy ?? null,
        approvalDate: r.approvalDate ?? null,
        reviewNotes: r.reviewNotes ?? null,
        issuedUserId: r.issuedUserId ?? null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
      return apiSuccess(res, safeRequests);
    }
  );

  app.post('/api/registration-requests', authRateLimiter, requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN' && actor.role !== 'MANAGER') {
      store.addSecurityLog({
        actorUserId: actor.userId,
        eventType: 'UNAUTHORIZED_ACCESS',
        result: 'BLOCKED',
        ipAddress: getClientIp(req),
        deviceInfo: getDeviceInfo(req),
        summary: `Blocked ${actor.role} ${actor.userId} from submitting staff onboarding registration.`,
      });
      return apiError(
        res,
        'Public registration is disabled. Only Admin or Manager may initiate staff onboarding requests.',
        403
      );
    }

    const {
      applicantName,
      mobile,
      email,
      address,
      password,
      confirmPassword,
      mobileVerificationToken,
      aadhaarNumber,
      aadhaarConsent,
      designation,
      departmentCode,
      joiningDate,
    } = req.body ?? {};

    const errors: Record<string, string[]> = {};
    if (!applicantName || String(applicantName).trim().length < 2) {
      errors.applicantName = ['Applicant full name is required.'];
    }
    if (!mobile || String(mobile).trim().length < 8) {
      errors.mobile = ['Valid mobile number is required.'];
    }
    if (!address || String(address).trim().length < 4) {
      errors.address = ['Residential address is required.'];
    }
    const cleanPassword = typeof password === 'string' ? password.trim() : '';
    const cleanConfirmPassword = typeof confirmPassword === 'string' ? confirmPassword.trim() : '';
    const pwdErr = validateStrongPassword(cleanPassword);
    if (pwdErr) {
      errors.password = [pwdErr];
    }
    if (cleanPassword !== cleanConfirmPassword) {
      errors.confirmPassword = ['Passwords do not match.'];
    }
    if (Object.keys(errors).length > 0) {
      return apiError(res, 'Validation failed.', 422, errors);
    }

    const otpRecord = mobileVerificationToken
      ? store.otpChallenges.get(String(mobileVerificationToken))
      : undefined;
    const isMobileVerified = Boolean(
      otpRecord &&
        otpRecord.purpose === 'MOBILE_VERIFICATION' &&
        otpRecord.verified &&
        otpRecord.target === String(mobile).trim()
    );

    if (!isMobileVerified) {
      return apiError(
        res,
        'Mobile OTP verification must be completed before submitting a registration request.',
        422,
        { mobileVerificationToken: ['Complete mobile OTP verification first.'] }
      );
    }

    let aadhaarEncrypted: string | undefined;
    let aadhaarLast4: string | undefined;
    let aadhaarConsentAt: string | undefined;
    if (aadhaarNumber) {
      const cleaned = String(aadhaarNumber).replace(/\s|-/g, '');
      if (!/^\d{12}$/.test(cleaned) || !aadhaarConsent) {
        return apiError(res, 'Valid 12-digit Aadhaar and explicit consent are required.', 422);
      }
      aadhaarEncrypted = encryptSensitiveField(cleaned);
      aadhaarLast4 = cleaned.slice(-4);
      aadhaarConsentAt = new Date().toISOString();
    }

    const now = new Date().toISOString();
    const resolvedDept = departmentCode ? sanitizeText(String(departmentCode)).toUpperCase() : 'DEPT-CSC';
    const record = {
      id: store.registrationRequests.length + 1,
      requestId: store.nextRequestCode(),
      applicantName: sanitizeText(String(applicantName)),
      requestedRole: 'STAFF' as RoleName,
      mobile: sanitizeText(String(mobile)),
      email: email ? sanitizeText(String(email)) : undefined,
      address: sanitizeText(String(address)),
      designation: designation ? sanitizeText(String(designation)) : 'CSC Counter Operator',
      departmentCode: resolvedDept,
      joiningDate: joiningDate ? sanitizeText(String(joiningDate)) : now.slice(0, 10),
      aadhaarEncrypted,
      aadhaarLast4,
      aadhaarConsentAt,
      passwordHash: hashPassword(cleanPassword),
      mobileVerified: true,
      submittedBy: actor.userId,
      status: 'PENDING' as const,
      createdAt: now,
      updatedAt: now,
    };

    store.registrationRequests.unshift(record);
    store.otpChallenges.delete(String(mobileVerificationToken));
    persistSecurityState();

    store.addAuditLog({
      actorUserId: actor.userId,
      action: 'SUBMIT_REGISTRATION_REQUEST',
      targetType: 'registration_request',
      targetId: record.requestId,
      details: `${actor.role} ${actor.userId} submitted staff registration request for ${record.applicantName}.`,
      ipAddress: getClientIp(req),
    });
    store.addPhase02Notification({
      triggerType: 'STAFF_REGISTRATION_PENDING',
      recipientUserId: 'MC2627110001',
      title: `Staff Onboarding Request: ${record.requestId}`,
      message: `${actor.userId} submitted STAFF onboarding for ${record.applicantName} (${resolvedDept}).`,
      severity: 'INFO',
    });

    return apiSuccess(
      res,
      {
        requestId: record.requestId,
        status: record.status,
        requestedRole: record.requestedRole,
        submittedBy: record.submittedBy,
      },
      'Staff onboarding request submitted for Admin approval.',
      201
    );
  });

  app.post(
    '/api/registration-requests/:id/approve',
    requireAuth,
    requirePermission('approvals', 'APPROVE'),
    async (req: AuthedRequest, res) => {
      const actor = req.authUser!;
      const reqRecord = store.registrationRequests.find(
        (r) => r.requestId === req.params.id || String(r.id) === req.params.id
      );
      if (!reqRecord) return apiError(res, 'Registration request not found.', 404);
      if (reqRecord.status !== 'PENDING' && reqRecord.status !== 'CORRECTION_REQUIRED') {
        return apiError(res, `Request is already ${reqRecord.status}.`, 400);
      }
      if (reqRecord.requestedRole !== 'STAFF' && actor.role !== 'ADMIN') {
        return apiError(res, 'Only Admin can approve non-Staff requests.', 403);
      }

      const issuedUserId = await store.sequenceService.allocateNext(
        reqRecord.requestedRole,
        undefined,
        undefined,
        {
          actorUserId: actor.userId,
          departmentCode: reqRecord.departmentCode ?? 'DEPT-CSC',
        }
      );
      const now = new Date().toISOString();

      const newUser: ServerUser = {
        id: store.users.length + 1,
        userId: issuedUserId,
        isMasterAdmin: false,
        fullName: reqRecord.applicantName,
        role: reqRecord.requestedRole,
        mobile: reqRecord.mobile,
        email: reqRecord.email,
        address: reqRecord.address,
        designation: reqRecord.designation ?? 'CSC Counter Operator',
        departmentCode: reqRecord.departmentCode ?? 'DEPT-CSC',
        joiningDate: reqRecord.joiningDate ?? now.slice(0, 10),
        aadhaarEncrypted: reqRecord.aadhaarEncrypted,
        aadhaarLast4: reqRecord.aadhaarLast4,
        aadhaarConsentAt: reqRecord.aadhaarConsentAt,
        passwordHash: reqRecord.passwordHash,
        passwordAlgo: 'bcrypt-12',
        branch: 'Main Service Center',
        status: 'ACTIVE',
        mobileVerified: reqRecord.mobileVerified,
        emailVerified: false,
        failedLoginAttempts: 0,
        lockedUntil: null,
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
        passwordChangedAt: now,
        customPermissions: {},
      };
      store.users.unshift(newUser);
      phase08Store.pushPasswordHistory(newUser.userId, newUser.passwordHash);

      reqRecord.status = 'APPROVED';
      reqRecord.reviewedBy = actor.userId;
      reqRecord.approvalDate = now;
      reqRecord.reviewNotes = sanitizeText(String(req.body?.notes || 'Approved and activated.'));
      reqRecord.issuedUserId = issuedUserId;
      reqRecord.updatedAt = now;
      persistSecurityState();
      void syncUserRecordToFirebase(newUser).catch(() => {});

      store.addAuditLog({
        actorUserId: actor.userId,
        action: 'APPROVE_REGISTRATION',
        targetType: 'registration_request',
        targetId: reqRecord.requestId,
        details: `Approved ${reqRecord.requestId}; issued User ID ${issuedUserId} for ${reqRecord.applicantName}.`,
        ipAddress: getClientIp(req),
      });
      store.addPhase02Notification({
        triggerType: 'STAFF_ACCOUNT_CREATED',
        recipientUserId: issuedUserId,
        title: `Staff Onboarding Approved: ${issuedUserId}`,
        message: `Your account ${issuedUserId} has been approved and activated.`,
        severity: 'INFO',
      });
      void sendFast2SmsTemplateMessage({
        mobile: newUser.mobile,
        purpose: 'ACCOUNT_REGISTRATION',
        variables: [issuedUserId, newUser.fullName],
        fallbackText: `MUN COMPUTER: Account approved & activated. User ID: ${issuedUserId}.`,
        runtimeConfig: phase03Store.getSmsGatewayConfig(),
      }).catch(() => {});

      return apiSuccess(
        res,
        {
          requestId: reqRecord.requestId,
          status: reqRecord.status,
          issuedUserId,
          user: store.sanitizePublicUser(newUser, actor.role),
        },
        `Request approved. User ID ${issuedUserId} activated.`
      );
    }
  );

  app.post(
    '/api/registration-requests/:id/reject',
    requireAuth,
    requirePermission('approvals', 'APPROVE'),
    (req: AuthedRequest, res) => {
      const actor = req.authUser!;
      const reqRecord = store.registrationRequests.find(
        (r) => r.requestId === req.params.id || String(r.id) === req.params.id
      );
      if (!reqRecord) return apiError(res, 'Registration request not found.', 404);
      if (reqRecord.status === 'APPROVED') {
        return apiError(res, 'Cannot reject an already approved request.', 400);
      }

      const mode = req.body?.correction ? 'CORRECTION_REQUIRED' : 'REJECTED';
      const notes = sanitizeText(String(req.body?.notes || ''));
      if (!notes) {
        return apiError(res, 'Review notes or reason are required.', 422, {
          notes: ['Provide a reason for rejection or correction.'],
        });
      }

      const now = new Date().toISOString();
      reqRecord.status = mode;
      reqRecord.reviewedBy = actor.userId;
      reqRecord.approvalDate = now;
      reqRecord.reviewNotes = notes;
      reqRecord.updatedAt = now;
      persistSecurityState();

      store.addAuditLog({
        actorUserId: actor.userId,
        action: mode === 'REJECTED' ? 'REJECT_REGISTRATION' : 'REQUEST_CORRECTION',
        targetType: 'registration_request',
        targetId: reqRecord.requestId,
        details: `${mode} on ${reqRecord.requestId}: ${notes}`,
        ipAddress: getClientIp(req),
      });

      return apiSuccess(
        res,
        { requestId: reqRecord.requestId, status: reqRecord.status },
        mode === 'REJECTED' ? 'Registration request rejected.' : 'Correction requested.'
      );
    }
  );

  // ==========================================================================
  // ROLES & PERMISSION MATRIX
  // ==========================================================================
  app.get('/api/roles', requireAuth, (_req, res) => {
    const roles = (['ADMIN', 'MANAGER', 'STAFF', 'AUDITOR'] as RoleName[]).map((role) => ({
      role,
      userCount: store.users.filter((u) => u.role === role).length,
      defaultMatrix: ROLE_PERMISSION_MATRIX[role],
    }));
    return apiSuccess(res, roles);
  });

  app.get('/api/permissions', requireAuth, (_req, res) => {
    return apiSuccess(res, {
      modules: ALL_MODULES,
      permissionTypes: ALL_PERMISSION_TYPES,
      reportPermissions: REPORT_PERMISSION_KEYS,
      matrix: ROLE_PERMISSION_MATRIX,
      history: store.permissionHistory,
    });
  });

  app.put(
    '/api/users/:id/permissions',
    requireAuth,
    requirePermission('permissions', 'EDIT'),
    (req: AuthedRequest, res) => {
      const actor = req.authUser!;
      // Strictly Admin-only for mutating permissions
      if (actor.role !== 'ADMIN') {
        store.addSecurityLog({
          actorUserId: actor.userId,
          eventType: 'UNAUTHORIZED_ACCESS',
          result: 'BLOCKED',
          ipAddress: getClientIp(req),
          deviceInfo: getDeviceInfo(req),
          summary: `${actor.role} attempted unauthorized permission modification.`,
        });
        return apiError(res, 'Only ADMIN can modify user permissions.', 403);
      }

      const target = store.findUserByUserId(req.params.id);
      if (!target) return apiError(res, 'Target user not found.', 404);

      if (target.userId === actor.userId) {
        return apiError(res, 'Users cannot modify their own permissions.', 403);
      }
      if (store.isMasterAdminUser(target) || target.role === 'ADMIN') {
        store.addSecurityLog({
          actorUserId: actor.userId,
          targetUserId: target.userId,
          eventType: 'UNAUTHORIZED_ACCESS',
          result: 'BLOCKED',
          ipAddress: getClientIp(req),
          deviceInfo: getDeviceInfo(req),
          summary: `Blocked attempt to alter protected Master Admin permissions on ${target.userId}.`,
        });
        return apiError(res, 'Admin and Master Admin permissions cannot be downgraded.', 403);
      }

      const updates = req.body?.permissions as Record<string, boolean> | undefined;
      if (!updates || typeof updates !== 'object') {
        return apiError(res, 'Permissions object is required.', 422);
      }

      const before = store.getEffectivePermissions(target);
      let changedCount = 0;

      for (const [key, val] of Object.entries(updates)) {
        const isReportPerm = (REPORT_PERMISSION_KEYS as readonly string[]).includes(key);
        const isCscPerm = (CSC_OPERATOR_PERMISSION_KEYS as readonly string[]).includes(key);
        const [mod, perm] = key.split('.') as [ModuleKey, PermissionType];
        const isModulePerm = ALL_MODULES.includes(mod) && ALL_PERMISSION_TYPES.includes(perm);
        if (!isModulePerm && !isReportPerm && !isCscPerm) {
          continue;
        }
        const boolVal = Boolean(val);
        if (before[key as ReportPermissionKey] !== boolVal) {
          target.customPermissions[key] = boolVal;
          changedCount += 1;
          store.permissionHistory.unshift({
            id: store.permissionHistory.length + 1,
            actorUserId: actor.userId,
            targetUserId: target.userId,
            permissionKey: key,
            previousValue: before[key],
            newValue: boolVal,
            createdAt: new Date().toISOString(),
          });
        }
      }

      target.updatedAt = new Date().toISOString();
      persistSecurityState();
      void syncUserRecordToFirebase(target).catch(() => {});

      if (changedCount > 0) {
        store.addSecurityLog({
          actorUserId: actor.userId,
          targetUserId: target.userId,
          eventType: 'PERMISSION_CHANGED',
          result: 'SUCCESS',
          ipAddress: getClientIp(req),
          deviceInfo: getDeviceInfo(req),
          summary: `Updated ${changedCount} permission(s) for ${target.userId}.`,
        });
        store.addAuditLog({
          actorUserId: actor.userId,
          action: 'UPDATE_USER_PERMISSIONS',
          targetType: 'user',
          targetId: target.userId,
          details: `Modified ${changedCount} permission override(s) on ${target.userId}.`,
          ipAddress: getClientIp(req),
        });
        const after = store.getEffectivePermissions(target);
        const beforeDiff: Record<string, boolean> = {};
        const afterDiff: Record<string, boolean> = {};
        for (const key of Object.keys(after)) {
          if (before[key] !== after[key]) {
            beforeDiff[key] = Boolean(before[key]);
            afterDiff[key] = Boolean(after[key]);
          }
        }
        phase08Store.recordBeforeAfterAudit({
          userId: actor.userId,
          userRole: actor.role,
          actionType: 'UPDATE_USER_PERMISSIONS',
          module: 'permissions',
          recordId: target.userId,
          beforeValues: beforeDiff,
          afterValues: afterDiff,
          ipAddress: getClientIp(req),
          deviceInfo: getDeviceInfo(req),
          actionResult: 'SUCCESS',
        });
      }

      return apiSuccess(
        res,
        {
          userId: target.userId,
          permissions: store.getEffectivePermissions(target),
        },
        `Updated permissions for ${target.userId}.`
      );
    }
  );

  // ==========================================================================
  // SECURITY LOGS, AUDIT LOGS & SESSION MANAGEMENT
  // ==========================================================================
  app.get(
    '/api/security-logs',
    requireAuth,
    requirePermission('security_logs', 'VIEW'),
    (req: AuthedRequest, res) => {
      const actor = req.authUser!;
      const logs =
        actor.role === 'ADMIN'
          ? store.securityLogs
          : store.securityLogs.filter(
              (l) =>
                !l.actorUserId.startsWith('MC-AD-') &&
                l.actorUserId !== 'MC2627110001' &&
                l.actorUserId !== 'MC262711001'
            );
      return apiSuccess(res, logs);
    }
  );

  app.get(
    '/api/audit-logs',
    requireAuth,
    requirePermission('security_logs', 'VIEW'),
    (_req, res) => {
      return apiSuccess(res, store.auditLogs);
    }
  );

  app.get('/api/sessions', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    const currentSessionId = req.authSession!.id;
    const list = Array.from(store.sessions.values())
      .filter((s) => (actor.role === 'ADMIN' ? true : s.userId === actor.userId))
      .map((s) => ({
        id: s.id,
        userId: s.userId,
        role: s.role,
        ipAddress: s.ipAddress,
        deviceInfo: s.deviceInfo,
        rememberMe: s.rememberMe,
        status: s.expiresAt <= Date.now() && s.status === 'ACTIVE' ? 'EXPIRED' : s.status,
        createdAt: s.createdAt,
        expiresAt: new Date(s.expiresAt).toISOString(),
        isCurrent: s.id === currentSessionId,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return apiSuccess(res, list);
  });

  app.delete('/api/sessions/:id', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    const targetSession = Array.from(store.sessions.values()).find(
      (s) => s.id === req.params.id
    );
    if (!targetSession) return apiError(res, 'Session not found.', 404);

    if (actor.role !== 'ADMIN' && targetSession.userId !== actor.userId) {
      return apiError(res, 'Forbidden: cannot revoke another user session.', 403);
    }

    targetSession.status = 'REVOKED';
    for (const [tokenHashKey, s] of store.sessions.entries()) {
      if (s.id === targetSession.id) {
        store.revokedTokenHashes.add(tokenHashKey);
      }
    }
    if (targetSession.tokenHash) {
      store.revokedTokenHashes.add(targetSession.tokenHash);
    }
    persistSecurityState();
    void syncSessionRecordToFirebase(targetSession).catch(() => {});
    if (targetSession.id === req.authSession!.id) {
      clearSessionCookies(res);
    }

    store.addSecurityLog({
      actorUserId: actor.userId,
      targetUserId: targetSession.userId,
      eventType: 'SESSION_REVOKED',
      result: 'SUCCESS',
      ipAddress: getClientIp(req),
      deviceInfo: getDeviceInfo(req),
      summary: `Revoked session ${targetSession.id} for ${targetSession.userId}.`,
    });

    return apiSuccess(res, { revoked: true, id: targetSession.id }, 'Session revoked.');
  });

  // ==========================================================================
  // PHASE 02 FINAL MASTER: DEPARTMENTS, 3-TIER SERVICE PERMISSIONS & NOTIFICATIONS
  // ==========================================================================
  app.get('/api/departments', requireAuth, (_req, res) => {
    return apiSuccess(res, store.departments);
  });

  app.post('/api/departments', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN') {
      return apiError(res, 'Only ADMIN can create or modify departments.', 403);
    }
    const { code, name, description, headUserId } = req.body ?? {};
    if (!code || !name) {
      return apiError(res, 'Department code and name are required.', 422);
    }
    const normCode = sanitizeText(String(code)).toUpperCase();
    if (store.departments.some((d) => d.code === normCode)) {
      return apiError(res, `Department ${normCode} already exists.`, 409);
    }
    const now = new Date().toISOString();
    const dept = {
      id: store.departments.length + 1,
      code: normCode,
      name: sanitizeText(String(name)),
      description: sanitizeText(String(description || '')),
      headUserId: headUserId ? sanitizeText(String(headUserId)) : undefined,
      status: 'ACTIVE' as const,
      createdAt: now,
      updatedAt: now,
    };
    store.departments.push(dept);
    return apiSuccess(res, dept, `Department ${dept.code} created.`, 201);
  });

  app.get('/api/service-permissions/overview', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    store.expireStaleServicePermissions();

    const managerAssignments =
      actor.role === 'ADMIN' || actor.role === 'AUDITOR'
        ? store.managerServiceAssignments
        : actor.role === 'MANAGER'
          ? store.managerServiceAssignments.filter((a) => a.managerUserId === actor.userId)
          : [];

    const staffRequests =
      actor.role === 'ADMIN' || actor.role === 'AUDITOR'
        ? store.staffServiceRequests
        : actor.role === 'MANAGER'
          ? store.staffServiceRequests.filter((r) => r.managerUserId === actor.userId)
          : store.staffServiceRequests.filter((r) => r.staffUserId === actor.userId);

    const staffPermissions =
      actor.role === 'ADMIN' || actor.role === 'AUDITOR'
        ? store.staffServicePermissions
        : actor.role === 'MANAGER'
          ? store.staffServicePermissions.filter((p) => p.managerUserId === actor.userId)
          : store.staffServicePermissions.filter((p) => p.staffUserId === actor.userId);

    const approvalLogs =
      actor.role === 'ADMIN' || actor.role === 'AUDITOR'
        ? store.serviceApprovalLogs
        : actor.role === 'MANAGER'
          ? store.serviceApprovalLogs.filter(
              (l) => l.managerUserId === actor.userId || l.actorUserId === actor.userId
            )
          : store.serviceApprovalLogs.filter((l) => l.staffUserId === actor.userId);

    return apiSuccess(res, {
      departments: store.departments,
      managerAssignments,
      staffRequests,
      staffPermissions,
      approvalLogs,
      availableServices: erpStore.services.map((s) => ({
        serviceId: s.serviceId,
        name: s.name,
        category: s.categoryName || s.categoryId,
        status: s.status,
      })),
    });
  });

  app.post('/api/service-permissions/manager-assignments', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN') {
      store.addSecurityLog({
        actorUserId: actor.userId,
        eventType: 'UNAUTHORIZED_ACCESS',
        result: 'BLOCKED',
        ipAddress: getClientIp(req),
        deviceInfo: getDeviceInfo(req),
        summary: `${actor.role} attempted unauthorized Admin manager-service assignment.`,
      });
      return apiError(res, 'Only ADMIN can assign services to Managers.', 403);
    }
    const {
      managerUserId,
      serviceId,
      serviceName,
      departmentCode,
      permissions,
      effectiveDate,
      expiryDate,
      notes,
    } = req.body ?? {};
    if (!managerUserId || !serviceId) {
      return apiError(res, 'managerUserId and serviceId are required.', 422);
    }
    const catalogSvc = erpStore.services.find((s) => s.serviceId === String(serviceId));
    try {
      const assignment = store.assignServiceToManager({
        actor,
        managerUserId: String(managerUserId),
        serviceId: String(serviceId),
        serviceName: serviceName ? sanitizeText(String(serviceName)) : catalogSvc?.name || String(serviceId),
        departmentCode: departmentCode ? sanitizeText(String(departmentCode)).toUpperCase() : 'DEPT-CSC',
        permissions: Array.isArray(permissions) ? permissions : ['VIEW', 'ADD', 'EDIT', 'ASSIGN', 'EXECUTE'],
        effectiveDate: effectiveDate ? String(effectiveDate) : undefined,
        expiryDate: expiryDate ? String(expiryDate) : null,
        notes: notes ? sanitizeText(String(notes)) : undefined,
      });
      return apiSuccess(res, assignment, `Assigned ${assignment.serviceId} to ${assignment.managerUserId}.`, 201);
    } catch (err) {
      return apiError(res, err instanceof Error ? err.message : 'Unable to assign service.', 422);
    }
  });

  app.patch('/api/service-permissions/manager-assignments/:code/status', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN') {
      return apiError(res, 'Only ADMIN can suspend, revoke, or reactivate Manager service assignments.', 403);
    }
    const status = String(req.body?.status ?? '').toUpperCase() as 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
    if (!['ACTIVE', 'SUSPENDED', 'REVOKED'].includes(status)) {
      return apiError(res, 'Invalid status (ACTIVE, SUSPENDED, or REVOKED required).', 422);
    }
    try {
      const result = store.updateManagerServiceAssignmentStatus({
        actor,
        assignmentCode: req.params.code,
        status,
        reason: req.body?.reason ? sanitizeText(String(req.body.reason)) : undefined,
      });
      return apiSuccess(
        res,
        result,
        `Manager assignment ${req.params.code} marked ${status}${result.cascadedStaffCount > 0 ? ` (cascaded to ${result.cascadedStaffCount} Staff permission(s))` : ''}.`
      );
    } catch (err) {
      return apiError(res, err instanceof Error ? err.message : 'Assignment not found.', 404);
    }
  });

  app.post('/api/service-permissions/staff-requests', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'MANAGER') {
      store.addSecurityLog({
        actorUserId: actor.userId,
        eventType: 'UNAUTHORIZED_ACCESS',
        result: 'BLOCKED',
        ipAddress: getClientIp(req),
        deviceInfo: getDeviceInfo(req),
        summary: `Blocked ${actor.role} ${actor.userId} from Manager Staff-service request endpoint.`,
      });
      return apiError(
        res,
        'Only MANAGER may submit Staff service permission requests within Admin-assigned services.',
        403
      );
    }
    const { staffUserId, serviceId, requestedPermissions, reason } = req.body ?? {};
    if (!staffUserId || !serviceId) {
      return apiError(res, 'staffUserId and serviceId are required.', 422);
    }
    try {
      const requestRecord = store.submitStaffServiceRequest({
        actor,
        staffUserId: String(staffUserId),
        serviceId: String(serviceId),
        requestedPermissions: Array.isArray(requestedPermissions) ? requestedPermissions : ['VIEW', 'EXECUTE'],
        reason: reason ? sanitizeText(String(reason)) : undefined,
      });
      return apiSuccess(
        res,
        requestRecord,
        `Staff service request ${requestRecord.requestCode} submitted (Pending Admin Approval).`,
        201
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to submit request.';
      const status = msg.includes('not actively assigned') ? 403 : 422;
      return apiError(res, msg, status);
    }
  });

  app.post('/api/service-permissions/staff-requests/:code/decide', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN') {
      store.addSecurityLog({
        actorUserId: actor.userId,
        eventType: 'UNAUTHORIZED_ACCESS',
        result: 'BLOCKED',
        ipAddress: getClientIp(req),
        deviceInfo: getDeviceInfo(req),
        summary: `Blocked ${actor.role} ${actor.userId} from approving/rejecting Staff service request ${req.params.code}.`,
      });
      return apiError(res, 'Only ADMIN can approve or reject Staff service permission requests.', 403);
    }
    const decision = String(req.body?.decision ?? '').toUpperCase();
    if (!['APPROVE', 'REJECT'].includes(decision)) {
      return apiError(res, 'Decision must be APPROVE or REJECT.', 422);
    }
    try {
      const result = store.decideStaffServiceRequest({
        actor,
        requestCode: req.params.code,
        approve: decision === 'APPROVE',
        notes: req.body?.notes ? sanitizeText(String(req.body.notes)) : undefined,
        expiryDate: req.body?.expiryDate ? String(req.body.expiryDate) : undefined,
      });
      return apiSuccess(
        res,
        result,
        decision === 'APPROVE'
          ? `Staff service request ${req.params.code} approved and activated.`
          : `Staff service request ${req.params.code} rejected.`
      );
    } catch (err) {
      return apiError(res, err instanceof Error ? err.message : 'Decision failed.', 422);
    }
  });

  app.patch('/api/service-permissions/staff-permissions/:code/status', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN') {
      return apiError(res, 'Only ADMIN can modify active Staff service permission states.', 403);
    }
    const status = String(req.body?.status ?? '').toUpperCase() as 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
    if (!['ACTIVE', 'SUSPENDED', 'REVOKED'].includes(status)) {
      return apiError(res, 'Invalid status (ACTIVE, SUSPENDED, or REVOKED required).', 422);
    }
    try {
      const updated = store.updateStaffServicePermissionStatus({
        actor,
        permissionCode: req.params.code,
        status,
        reason: req.body?.reason ? sanitizeText(String(req.body.reason)) : undefined,
      });
      return apiSuccess(res, updated, `Staff permission ${req.params.code} marked ${status}.`);
    } catch (err) {
      return apiError(res, err instanceof Error ? err.message : 'Unable to update status.', 422);
    }
  });

  app.post('/api/service-permissions/check', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    const serviceId = String(req.body?.serviceId ?? '');
    const permission = (String(req.body?.permission ?? 'EXECUTE').toUpperCase()) as PermissionType;
    if (!serviceId) {
      return apiError(res, 'serviceId is required.', 422);
    }
    const check = store.checkServicePermissionStrict(actor, serviceId, permission);
    return apiSuccess(res, { serviceId, permission, ...check });
  });

  app.post('/api/service-permissions/execute', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    const serviceId = String(req.body?.serviceId ?? '');
    const permission = (String(req.body?.permission ?? 'EXECUTE').toUpperCase()) as PermissionType;
    if (!serviceId) {
      return apiError(res, 'serviceId is required.', 422);
    }
    const check = store.checkServicePermissionStrict(actor, serviceId, permission);
    if (!check.allowed) {
      store.addSecurityLog({
        actorUserId: actor.userId,
        eventType: 'UNAUTHORIZED_ACCESS',
        result: 'BLOCKED',
        ipAddress: getClientIp(req),
        deviceInfo: getDeviceInfo(req),
        summary: `Blocked ${actor.role} ${actor.userId} executing ${serviceId}.${permission}: ${check.reason}`,
      });
      return apiError(res, `Forbidden (Default Deny): ${check.reason}`, 403);
    }
    return apiSuccess(res, { executed: true, serviceId, permission, reason: check.reason }, 'Service operation authorized.');
  });

  app.get('/api/notifications/security', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    const list =
      actor.role === 'ADMIN'
        ? store.phase02Notifications
        : store.phase02Notifications.filter((n) => n.recipientUserId === actor.userId);
    return apiSuccess(res, list);
  });

  app.patch('/api/notifications/security/:code/read', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    const notif = store.phase02Notifications.find((n) => n.notificationCode === req.params.code);
    if (!notif) return apiError(res, 'Notification not found.', 404);
    if (actor.role !== 'ADMIN' && notif.recipientUserId !== actor.userId) {
      return apiError(res, 'Forbidden.', 403);
    }
    notif.isRead = true;
    return apiSuccess(res, notif, 'Notification marked read.');
  });

  // ==========================================================================
  // PHASE 03: MASTER SETTINGS, SERVICE RATES, BACKUPS, DAILY CASH, INTEGRATIONS
  // ==========================================================================
  registerPhase03Routes(app, store, phase03Store, requireAuth, persistSecurityState);

  // ==========================================================================
  // ENTERPRISE ERP Q1-51: CUSTOMERS CRM, SERVICES/FORMS, WORKFLOWS & FINANCE
  // ==========================================================================
  registerErpRoutes(app, store, phase03Store, erpStore, requireAuth, financeStore);

  // ==========================================================================
  // PHASE 05: CENTRAL FINANCIAL ENGINE (MODULES 01-94)
  // ==========================================================================
  registerFinanceRoutes(app, store, financeStore, requireAuth);

  // ==========================================================================
  // PHASE 07: ADVANCED REPORTS, PDF, EXCEL, ANALYTICS & PRINTING
  // ==========================================================================
  registerReportRoutes(
    app,
    store,
    phase03Store,
    erpStore,
    financeStore,
    reportStore,
    reportScheduler,
    requireAuth,
    cscStore
  );

  // ==========================================================================
  // DIGITAL SERVICE CENTER / CSC ENTERPRISE MODULE (PARTS 1-18)
  // ==========================================================================
  registerCscRoutes(app, store, cscStore, requireAuth, persistSecurityState, phase03Store);

  // ==========================================================================
  // PHASE 08: ENTERPRISE SECURITY, BACKUP, DISASTER RECOVERY & DATA PROTECTION
  // ==========================================================================
  registerPhase08Routes(app, store, phase08Store, backupScheduler, requireAuth, persistSecurityState);

  const firebaseBackupOrchestrator =
    options.firebaseBackupOrchestrator ?? new BackupOrchestrator();
  if (process.env.NODE_ENV !== 'test') {
    void firebaseBackupOrchestrator.store.hydrateFromFirestore();
  }
  registerFirebaseBackupRoutes(app, requireAuth, firebaseBackupOrchestrator);

  // ==========================================================================
  // PHASE 09: ENTERPRISE TESTING, QA, SECURITY AUDIT, BUGS & RELEASE GATE
  // ==========================================================================
  registerQaRoutes(
    app,
    store,
    phase03Store,
    erpStore,
    financeStore,
    reportStore,
    phase08Store,
    qaStore,
    requireAuth
  );

  if (options.enableReportScheduler !== false && process.env.NODE_ENV !== 'test') {
    reportScheduler.start(60_000);
  }
  if (options.enableBackupScheduler !== false && process.env.NODE_ENV !== 'test') {
    backupScheduler.start(120_000);
  }

  app.post('/api/v1/security/purge-demo-data', requireAuth, async (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN') {
      return apiError(res, 'Only Master Admin can trigger environment data purge.', 403);
    }
    erpStore.purgeDemoRecords();
    cscStore.purgeOperationalRecords();
    financeStore.vouchers = [];
    financeStore.pnbCspLedger = [];
    financeStore.cashTransfers = [];
    financeStore.bankStatements = [];
    financeStore.cheques = [];
    financeStore.customerCredits = [];
    financeStore.supplierBills = [];
    financeStore.payrollRuns = [];
    financeStore.attendanceRecords = [];
    financeStore.taxEntries = [];
    financeStore.fixedAssets = [];
    financeStore.loans = [];
    financeStore.investments = [];
    financeStore.partners = [];
    financeStore.franchises = [];
    financeStore.subscriptions = [];
    financeStore.fraudAlerts = [];
    financeStore.tasks = [];
    financeStore.documentVault = [];
    financeStore.importBatches = [];
    financeStore.auditObservations = [];
    financeStore.recomputeCounterBalances();
    persistRuntimeState();
    persistSecurityState();

    const fbResult = await purgeDemoDataFromFirebaseAdmin();
    store.addSecurityLog({
      actorUserId: actor.userId,
      eventType: 'SENSITIVE_ACTION',
      result: 'SUCCESS',
      ipAddress: getClientIp(req),
      deviceInfo: getDeviceInfo(req),
      summary: `Executed demo-data purge (Firebase Admin executed=${fbResult.executed}, deletedDocs=${fbResult.deletedDocs}).`,
    });
    return apiSuccess(res, {
      purged: true,
      firebaseAdmin: fbResult,
    }, 'Environment cleanup completed.');
  });

  // Ensure unmatched /api/* paths always return structured JSON (never HTML SPA fallback)
  app.use('/api', (req, res) => {
    return apiError(res, `API endpoint not found: ${req.method} ${req.originalUrl}`, 404);
  });

  app.use('/api', (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    console.error(`[API Error] ${req.method} ${req.originalUrl}:`, err);
    if (res.headersSent) return;
    const message = err instanceof Error && err.message ? err.message : 'Internal API server error.';
    return apiError(res, message, 500);
  });

  return app;
}
