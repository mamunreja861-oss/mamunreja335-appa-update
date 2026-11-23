import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import { SecurityStore } from '../server/securityStore';
import { hmacOtp } from '../server/crypto';

const secretCache = new WeakMap<SecurityStore, Map<string, string>>();
const passwordCache = new WeakMap<SecurityStore, Map<string, string>>();

function getStoreSecretMap(store: SecurityStore): Map<string, string> {
  let map = secretCache.get(store);
  if (!map) {
    map = new Map<string, string>();
    secretCache.set(store, map);
  }
  return map;
}

function getStorePasswordMap(store: SecurityStore): Map<string, string> {
  let map = passwordCache.get(store);
  if (!map) {
    map = new Map<string, string>();
    passwordCache.set(store, map);
  }
  return map;
}

export function extractCookiesFromHeaders(rawList: string[]): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const entry of rawList) {
    const firstPart = entry.split(';')[0];
    const idx = firstPart.indexOf('=');
    if (idx > -1) {
      jar[firstPart.slice(0, idx).trim()] = decodeURIComponent(
        firstPart.slice(idx + 1).trim()
      );
    }
  }
  return jar;
}

export async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any; cookies: Record<string, string> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  const setCookies: string[] =
    typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie()
      : res.headers.get('set-cookie')
      ? [res.headers.get('set-cookie')!]
      : [];
  return {
    status: res.status,
    body: parsed,
    cookies: extractCookiesFromHeaders(setCookies),
  };
}

export function issueTestCaptcha(store: SecurityStore): { id: string; answer: string } {
  const id = `test-cap-${Math.random().toString(36).slice(2, 10)}`;
  const answer = 'K7M2P';
  store.captchaChallenges.set(id, {
    id,
    answerHash: hmacOtp(answer, id),
    expiresAt: Date.now() + 60_000,
  });
  return { id, answer };
}

export async function performFourLayerLogin(
  baseUrl: string,
  store: SecurityStore,
  userId: string,
  password: string,
  options?: {
    rememberMe?: boolean;
    userAgent?: string;
    deviceName?: string;
    preserveMustChangePassword?: boolean;
  }
): Promise<{
  cookies: Record<string, string>;
  user: any;
  session: any;
  loginData: any;
  smsData: any;
  totpData: any;
  verifyData: any;
}> {
  const headers: Record<string, string> = {};
  if (options?.userAgent) headers['User-Agent'] = options.userAgent;
  if (options?.deviceName) headers['X-Device-Name'] = options.deviceName;

  const storePwds = getStorePasswordMap(store);
  const canonicalLookup = userId.trim().toUpperCase();
  const effectivePassword = storePwds.get(canonicalLookup) || password;

  // Step 1: Unified Credentials + CAPTCHA -> Dispatches Fast2SMS OTP
  const cap = issueTestCaptcha(store);
  const step1 = await postJson(
    baseUrl,
    '/api/auth/login-step1-send-otp',
    {
      userId,
      password: effectivePassword,
      rememberMe: Boolean(options?.rememberMe),
      captchaId: cap.id,
      captchaAnswer: cap.answer,
    },
    headers
  );
  assert.equal(
    step1.status,
    200,
    `Step 1 login-step1-send-otp failed for ${userId}: ${step1.body?.message}`
  );
  const canonicalUserId = String(step1.body?.data?.userId || userId);
  const ch2Id = step1.body?.data?.challengeId;
  const smsOtp = step1.body?.data?.sandboxOtpPreview;
  assert.ok(ch2Id && smsOtp, 'Expected ch2 challengeId and sandboxOtpPreview');

  // Verify SMS OTP -> Advances to Step 2 Google Authenticator TOTP
  const stepSms = await postJson(
    baseUrl,
    '/api/auth/verify-sms-otp',
    {
      challengeId: ch2Id,
      otp: smsOtp,
    },
    headers
  );
  assert.equal(
    stepSms.status,
    200,
    `SMS OTP verification failed for ${userId}: ${stepSms.body?.message}`
  );
  const ch3Id = stepSms.body?.data?.challengeId;
  assert.ok(ch3Id, 'Expected ch3 challengeId');

  const storeSecrets = getStoreSecretMap(store);
  if (stepSms.body?.data?.manualSecret) {
    storeSecrets.set(canonicalUserId, stepSms.body.data.manualSecret);
  }
  const secret = storeSecrets.get(canonicalUserId);
  assert.ok(secret, `Expected TOTP secret to be cached for ${canonicalUserId}`);

  // Reset lastTotpStepUsed in tests so multiple logins within 30s window succeed cleanly
  const userObj = store.findUserByUserId(canonicalUserId);
  if (userObj) {
    userObj.lastTotpStepUsed = undefined;
  }

  const totp = new OTPAuth.TOTP({
    issuer: 'MUN COMPUTER',
    label: String(stepSms.body?.data?.accountLabel || canonicalUserId),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  const totpCode = totp.generate();

  // Step 2: TOTP -> issues session cookies
  const step2 = await postJson(
    baseUrl,
    '/api/auth/verify-totp',
    {
      challengeId: ch3Id,
      code: totpCode,
    },
    headers
  );
  assert.equal(
    step2.status,
    200,
    `Step 2 verify-totp failed for ${userId}: ${step2.body?.message}`
  );
  assert.ok(step2.cookies.mun_session, 'Expected HttpOnly mun_session cookie');
  assert.ok(step2.cookies.mun_csrf, 'Expected mun_csrf cookie');

  let finalUser = step2.body.data.user;
  if (!options?.preserveMustChangePassword && finalUser?.mustChangePassword) {
    const rotatedPassword = `${effectivePassword}_Rotated#26`;
    const cookieHeader = Object.entries(step2.cookies)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('; ');
    const pwdRes = await postJson(
      baseUrl,
      `/api/users/${encodeURIComponent(canonicalUserId)}/change-password`,
      {
        currentPassword: effectivePassword,
        newPassword: rotatedPassword,
        confirmPassword: rotatedPassword,
      },
      {
        ...headers,
        Cookie: cookieHeader,
        'X-CSRF-Token': step2.cookies.mun_csrf,
      }
    );
    assert.equal(
      pwdRes.status,
      200,
      `Automatic first-login password update failed for ${canonicalUserId}: ${pwdRes.body?.message}`
    );
    storePwds.set(canonicalUserId.toUpperCase(), rotatedPassword);
    if (pwdRes.body?.data?.user) {
      finalUser = pwdRes.body.data.user;
    } else {
      finalUser.mustChangePassword = false;
      finalUser.passwordMigrationRequired = false;
    }
  }

  return {
    cookies: step2.cookies,
    user: finalUser,
    session: step2.body.data.session,
    loginData: step1.body.data,
    smsData: step1.body.data,
    totpData: stepSms.body.data,
    verifyData: step2.body.data,
  };
}

export async function createTestUser(
  baseUrl: string,
  adminCookies: Record<string, string>,
  params: {
    fullName?: string;
    role: 'STAFF' | 'AUDITOR' | 'CUSTOMER' | 'MANAGER';
    mobile?: string;
    email?: string;
    password?: string;
    departmentCode?: string;
  }
): Promise<{ userId: string; password: string; user: any }> {
  const pwd = params.password || 'TestStrong@2026!';
  const randSuffix = Math.floor(1000000 + Math.random() * 8999999);
  const mobile = params.mobile || `+91987${randSuffix}`;
  const cookieHeader = Object.entries(adminCookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('; ');

  const res = await postJson(
    baseUrl,
    '/api/users',
    {
      fullName: params.fullName || `Test ${params.role} ${randSuffix}`,
      role: params.role,
      mobile,
      email: params.email || `test.${params.role.toLowerCase()}.${randSuffix}@muncomputer.local`,
      address: 'Domkal Service Desk, Murshidabad',
      departmentCode: params.departmentCode || 'DEPT-CSC',
      password: pwd,
      confirmPassword: pwd,
    },
    {
      Cookie: cookieHeader,
      'X-CSRF-Token': adminCookies.mun_csrf,
    }
  );
  assert.equal(res.status, 201, `Failed creating test ${params.role}: ${res.body?.message}`);
  return {
    userId: res.body.data.user.userId,
    password: pwd,
    user: res.body.data.user,
  };
}

export async function grantStaffServiceAccess(
  baseUrl: string,
  adminCookies: Record<string, string>,
  managerCookies: Record<string, string>,
  staffUserId: string,
  serviceIds: string[],
  permissions: string[] = ['VIEW', 'ADD', 'EDIT', 'ASSIGN', 'EXECUTE']
): Promise<void> {
  const adminHeaders = {
    Cookie: Object.entries(adminCookies)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('; '),
    'X-CSRF-Token': adminCookies.mun_csrf,
  };
  const mgrHeaders = {
    Cookie: Object.entries(managerCookies)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('; '),
    'X-CSRF-Token': managerCookies.mun_csrf,
  };

  for (const serviceId of serviceIds) {
    const msa = await postJson(
      baseUrl,
      '/api/service-permissions/manager-assignments',
      {
        managerUserId: 'MC2627110002',
        serviceId,
        serviceName: `Service ${serviceId}`,
        departmentCode: 'DEPT-CSC',
        permissions,
      },
      adminHeaders
    );
    assert.equal(msa.status, 201, `Failed MSA assignment for ${serviceId}: ${msa.body?.message}`);

    const reqRes = await postJson(
      baseUrl,
      '/api/service-permissions/staff-requests',
      {
        staffUserId,
        serviceId,
        requestedPermissions: permissions,
        reason: 'Test suite operational permission',
      },
      mgrHeaders
    );
    assert.equal(reqRes.status, 201, `Failed SSR submission for ${serviceId}: ${reqRes.body?.message}`);

    const approveRes = await postJson(
      baseUrl,
      `/api/service-permissions/staff-requests/${reqRes.body.data.requestCode}/decide`,
      { decision: 'APPROVE', notes: 'Approved for automated test execution' },
      adminHeaders
    );
    assert.equal(approveRes.status, 200, `Failed SSR approval for ${serviceId}: ${approveRes.body?.message}`);
  }
}
