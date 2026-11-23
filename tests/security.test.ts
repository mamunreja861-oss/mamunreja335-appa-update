import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import * as OTPAuth from 'otpauth';
import { decryptTotpSecret } from '../server/crypto';
import { createApp } from '../server/app';
import { SecurityStore } from '../server/securityStore';
import { createTestUser, issueTestCaptcha, performFourLayerLogin } from './testAuthHelper';

interface HttpResult {
  status: number;
  body: any;
  cookies: Record<string, string>;
}

function extractSetCookies(headers: http.IncomingHttpHeaders): Record<string, string> {
  const raw = headers['set-cookie'];
  const jar: Record<string, string> = {};
  if (!raw) return jar;
  const list = Array.isArray(raw) ? raw : [raw];
  for (const entry of list) {
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

async function requestJson(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  cookies: Record<string, string> = {},
  extraHeaders: Record<string, string> = {}
): Promise<HttpResult> {
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('; ');

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(cookies.mun_csrf ? { 'X-CSRF-Token': cookies.mun_csrf } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const parsed = await res.json();
  const setCookies =
    typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie()
      : res.headers.get('set-cookie')
      ? [res.headers.get('set-cookie')!]
      : [];

  return {
    status: res.status,
    body: parsed,
    cookies: extractSetCookies({ 'set-cookie': setCookies }),
  };
}

async function loginAs(
  baseUrl: string,
  store: SecurityStore,
  userId: string,
  password: string,
  preserveMustChangePassword = false
): Promise<{ cookies: Record<string, string>; user: any; sessionId: string }> {
  const result = await performFourLayerLogin(baseUrl, store, userId, password, {
    preserveMustChangePassword,
  });
  return {
    cookies: result.cookies,
    user: result.user,
    sessionId: result.session.id,
  };
}

async function withServer(
  fn: (baseUrl: string, store: SecurityStore) => Promise<void>,
  storeOptions: ConstructorParameters<typeof SecurityStore>[0] = {}
) {
  const store = new SecurityStore(storeOptions);
  const app = createApp(store, { enableRateLimit: false });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl, store);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
}

test('1-3. Admin mandatory password change, Manager login, 2-step auth, and demo account removal', async () => {
  await withServer(async (baseUrl, store) => {
    const cfgRes = await requestJson(baseUrl, 'GET', '/api/auth/config');
    assert.equal(cfgRes.status, 200);
    assert.equal(cfgRes.body.data.authMode, '2-step-4-layer-backend');

    const legacy = await requestJson(baseUrl, 'POST', '/api/auth/login', {
      userId: 'MC2627110001',
      password: '8101352105',
    });
    assert.equal(legacy.status, 410);

    // Demo accounts MC2627110003 / 0004 / 0005 must NOT exist
    for (const demoCreds of [
      ['MC2627110003', 'Staff@2026!'],
      ['MC2627110004', 'Auditor@2026!'],
      ['MC2627110005', 'Customer@2026!'],
    ]) {
      const cap = issueTestCaptcha(store);
      const demoAttempt = await requestJson(baseUrl, 'POST', '/api/auth/login-step1-send-otp', {
        userId: demoCreds[0],
        password: demoCreds[1],
        captchaId: cap.id,
        captchaAnswer: cap.answer,
      });
      assert.equal(demoAttempt.status, 401, `Removed demo account ${demoCreds[0]} must be rejected`);
    }

    const capRes = await requestJson(baseUrl, 'GET', '/api/auth/captcha');
    assert.equal(capRes.status, 200);
    assert.ok(capRes.body.data.svg.includes('<svg'));

    // Admin first login with default password 8101352105 forces password change before portal access
    const firstAdmin = await loginAs(baseUrl, store, 'MC2627110001', '8101352105', true);
    assert.equal(firstAdmin.user.role, 'ADMIN');
    assert.equal(firstAdmin.user.mustChangePassword, true);

    const blockedUsers = await requestJson(baseUrl, 'GET', '/api/users', undefined, firstAdmin.cookies);
    assert.equal(blockedUsers.status, 403);
    assert.equal(blockedUsers.body.data.passwordChangeRequired, true);

    // Reusing default password 8101352105 rejected (422)
    const reuseDefault = await requestJson(
      baseUrl,
      'POST',
      '/api/users/MC2627110001/change-password',
      {
        currentPassword: '8101352105',
        newPassword: '8101352105',
        confirmPassword: '8101352105',
      },
      firstAdmin.cookies
    );
    assert.equal(reuseDefault.status, 422);

    // Strong new password succeeds and unlocks portal
    const changed = await requestJson(
      baseUrl,
      'POST',
      '/api/users/MC2627110001/change-password',
      {
        currentPassword: '8101352105',
        newPassword: 'MasterAdmin#2026!',
        confirmPassword: 'MasterAdmin#2026!',
      },
      firstAdmin.cookies
    );
    assert.equal(changed.status, 200);
    assert.equal(changed.body.data.user.mustChangePassword, false);

    const unlockedUsers = await requestJson(baseUrl, 'GET', '/api/users', undefined, firstAdmin.cookies);
    assert.equal(unlockedUsers.status, 200);

    const manager = await loginAs(baseUrl, store, 'MC2627110002', 'Manager@2026!');
    assert.equal(manager.user.role, 'MANAGER');
  });
});

test('4-5. Invalid password, invalid SMS OTP rejection, and account lockout after 5 attempts', async () => {
  await withServer(async (baseUrl, store) => {
    const admin = await loginAs(baseUrl, store, 'MC2627110001', '8101352105');
    const createdStaff = await createTestUser(baseUrl, admin.cookies, {
      role: 'STAFF',
      fullName: 'Lockout Test Staff',
    });

    // 4 consecutive invalid passwords via 2-step Step 1 endpoint
    for (let i = 0; i < 4; i += 1) {
      const cap = issueTestCaptcha(store);
      const res = await requestJson(baseUrl, 'POST', '/api/auth/login-step1-send-otp', {
        userId: createdStaff.userId,
        password: 'WrongPassword123',
        captchaId: cap.id,
        captchaAnswer: cap.answer,
      });
      assert.equal(res.status, 401);
    }

    // 5th attempt triggers lock (423)
    const cap5 = issueTestCaptcha(store);
    const lockRes = await requestJson(baseUrl, 'POST', '/api/auth/login-step1-send-otp', {
      userId: createdStaff.userId,
      password: 'WrongPassword123',
      captchaId: cap5.id,
      captchaAnswer: cap5.answer,
    });
    assert.equal(lockRes.status, 423);

    // Even valid password is blocked while locked
    const cap6 = issueTestCaptcha(store);
    const blockedRes = await requestJson(baseUrl, 'POST', '/api/auth/login-step1-send-otp', {
      userId: createdStaff.userId,
      password: createdStaff.password,
      captchaId: cap6.id,
      captchaAnswer: cap6.answer,
    });
    assert.equal(blockedRes.status, 423);

    // Invalid SMS OTP check on Manager account
    const capMgr = issueTestCaptcha(store);
    const step1 = await requestJson(baseUrl, 'POST', '/api/auth/login-step1-send-otp', {
      userId: 'MC2627110002',
      password: 'Manager@2026!',
      captchaId: capMgr.id,
      captchaAnswer: capMgr.answer,
    });
    assert.equal(step1.status, 200);

    const badOtp = await requestJson(baseUrl, 'POST', '/api/auth/verify-sms-otp', {
      challengeId: step1.body.data.challengeId,
      otp: '000000',
    });
    assert.equal(badOtp.status, 401);
  });
});

test('6. Forgot Password & Password Reset OTP enforces TOTP when enrolled and invalidates prior sessions', async () => {
  await withServer(async (baseUrl, store) => {
    const oldSession = await loginAs(baseUrl, store, 'MC2627110002', 'Manager@2026!');

    const forgotRes = await requestJson(baseUrl, 'POST', '/api/auth/forgot-password', {
      userId: 'MC2627110002',
    });
    assert.equal(forgotRes.status, 200);
    assert.equal(forgotRes.body.data.totpRequired, true);
    const resetOtp = forgotRes.body.data.sandboxOtpPreview;

    // Missing TOTP when user has enrolled Google Authenticator must be rejected (422)
    const missingTotpRes = await requestJson(baseUrl, 'POST', '/api/auth/reset-password', {
      challengeId: forgotRes.body.data.challengeId,
      otp: resetOtp,
      newPassword: 'ManagerNew@2026!',
      confirmPassword: 'ManagerNew@2026!',
    });
    assert.equal(missingTotpRes.status, 422);

    // Invalid TOTP code must be rejected (401)
    const wrongTotpRes = await requestJson(baseUrl, 'POST', '/api/auth/reset-password', {
      challengeId: forgotRes.body.data.challengeId,
      otp: resetOtp,
      totpCode: '000000',
      newPassword: 'ManagerNew@2026!',
      confirmPassword: 'ManagerNew@2026!',
    });
    assert.equal(wrongTotpRes.status, 401);

    // Valid TOTP code completes reset & invalidates old session
    const mgrUser = store.findUserByUserId('MC2627110002')!;
    mgrUser.lastTotpStepUsed = undefined;
    const mgrSecret = decryptTotpSecret(mgrUser.totpSecretEncrypted!);
    const mgrTotp = new OTPAuth.TOTP({
      issuer: 'MUN COMPUTER',
      label: mgrUser.userId,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(mgrSecret),
    }).generate();

    const resetRes = await requestJson(baseUrl, 'POST', '/api/auth/reset-password', {
      challengeId: forgotRes.body.data.challengeId,
      otp: resetOtp,
      totpCode: mgrTotp,
      newPassword: 'ManagerNew@2026!',
      confirmPassword: 'ManagerNew@2026!',
    });
    assert.equal(resetRes.status, 200);

    // Prior session must be invalidated
    const staleMe = await requestJson(
      baseUrl,
      'GET',
      '/api/auth/me',
      undefined,
      oldSession.cookies
    );
    assert.equal(staleMe.status, 401);

    // New password must succeed
    const newSession = await loginAs(baseUrl, store, 'MC2627110002', 'ManagerNew@2026!');
    assert.equal(newSession.user.userId, 'MC2627110002');
  });
});

test('7-8. Automatic User ID generation format (MCYYFFMMSSSS) and concurrent duplicate prevention', async () => {
  const store = new SecurityStore();
  const concurrent = await Promise.all([
    store.sequenceService.allocateNext('STAFF', 2026, 11),
    store.sequenceService.allocateNext('STAFF', 2026, 11),
    store.sequenceService.allocateNext('STAFF', 2026, 11),
    store.sequenceService.allocateNext('MANAGER', 2026, 11),
    store.sequenceService.allocateNext('ADMIN', 2026, 11),
  ]);

  assert.equal(new Set(concurrent).size, 5, 'All concurrently issued User IDs must be unique');
  for (const id of concurrent) {
    assert.match(id, /^MC\d{6}\d{4}$/, `Expected canonical MCYYFFMMSSSS ID, got ${id}`);
  }
  assert.equal(concurrent[0], 'MC2627110003');
  assert.equal(concurrent[1], 'MC2627110004');
  assert.equal(concurrent[2], 'MC2627110005');
  assert.equal(concurrent[3], 'MC2627110006');
  assert.equal(concurrent[4], 'MC2627110007');
});

test('9-10. Public registration disabled; Manager onboarding + Admin Approval & Rejection with Audit Log', async () => {
  await withServer(async (baseUrl, store) => {
    const admin = await loginAs(baseUrl, store, 'MC2627110001', '8101352105');
    const createdStaff = await createTestUser(baseUrl, admin.cookies, { role: 'STAFF' });

    // Public unauthenticated registration submission is strictly disabled
    const publicAttempt = await requestJson(baseUrl, 'POST', '/api/registration-requests', {
      applicantName: 'Unauthorized Public',
      mobile: '+8801799887766',
      address: 'Road 12, Uttara',
      password: 'StaffJoin@2026!',
      confirmPassword: 'StaffJoin@2026!',
    });
    assert.equal(publicAttempt.status, 401);

    // Staff cannot initiate registration onboarding either
    const staff = await loginAs(baseUrl, store, createdStaff.userId, createdStaff.password);
    const staffAttempt = await requestJson(
      baseUrl,
      'POST',
      '/api/registration-requests',
      {
        applicantName: 'Unauthorized Staff Sub',
        mobile: '+8801799887766',
        address: 'Road 12, Uttara',
        password: 'StaffJoin@2026!',
        confirmPassword: 'StaffJoin@2026!',
      },
      staff.cookies
    );
    assert.equal(staffAttempt.status, 403);

    // Mobile OTP flow + authenticated Manager submits two onboarding requests
    const manager = await loginAs(baseUrl, store, 'MC2627110002', 'Manager@2026!');
    const sendMobile1 = await requestJson(baseUrl, 'POST', '/api/auth/mobile-otp/send', {
      mobile: '+8801799887766',
    });
    assert.equal(sendMobile1.status, 200);
    const verifyMobile1 = await requestJson(baseUrl, 'POST', '/api/auth/verify-otp', {
      challengeId: sendMobile1.body.data.challengeId,
      otp: sendMobile1.body.data.sandboxOtpPreview,
    });
    assert.equal(verifyMobile1.status, 200);

    const regRes = await requestJson(
      baseUrl,
      'POST',
      '/api/registration-requests',
      {
        applicantName: 'Kamrul Hasan',
        mobile: '+8801799887766',
        email: 'kamrul@muncomputer.local',
        address: 'Road 12, Uttara',
        password: 'StaffJoin@2026!',
        confirmPassword: 'StaffJoin@2026!',
        mobileVerificationToken: verifyMobile1.body.data.verificationToken,
      },
      manager.cookies
    );
    assert.equal(regRes.status, 201);
    assert.equal(regRes.body.data.submittedBy, 'MC2627110002');
    const createdReqId = regRes.body.data.requestId;

    const sendMobile2 = await requestJson(baseUrl, 'POST', '/api/auth/mobile-otp/send', {
      mobile: '+8801799887799',
    });
    assert.equal(sendMobile2.status, 200);
    const verifyMobile2 = await requestJson(baseUrl, 'POST', '/api/auth/verify-otp', {
      challengeId: sendMobile2.body.data.challengeId,
      otp: sendMobile2.body.data.sandboxOtpPreview,
    });
    assert.equal(verifyMobile2.status, 200);

    const regRes2 = await requestJson(
      baseUrl,
      'POST',
      '/api/registration-requests',
      {
        applicantName: 'Tariqul Islam',
        mobile: '+8801799887799',
        email: 'tariqul@muncomputer.local',
        address: 'Sector 9',
        password: 'StaffJoin@2026!',
        confirmPassword: 'StaffJoin@2026!',
        mobileVerificationToken: verifyMobile2.body.data.verificationToken,
      },
      manager.cookies
    );
    assert.equal(regRes2.status, 201);
    const rejectReqId = regRes2.body.data.requestId;

    // Approve first request -> issues canonical MCYYFFMMSSSS User ID
    const approveRes = await requestJson(
      baseUrl,
      'POST',
      `/api/registration-requests/${createdReqId}/approve`,
      { notes: 'Verified mobile and ID.' },
      admin.cookies
    );
    assert.equal(approveRes.status, 200);
    assert.match(approveRes.body.data.issuedUserId, /^MC\d{6}\d{4}$/);

    // Reject second pending request
    const rejectRes = await requestJson(
      baseUrl,
      'POST',
      `/api/registration-requests/${rejectReqId}/reject`,
      { notes: 'Incomplete address proof.' },
      admin.cookies
    );
    assert.equal(rejectRes.status, 200);
    assert.equal(rejectRes.body.data.status, 'REJECTED');

    // Verify audit logs recorded both actions
    const auditRes = await requestJson(baseUrl, 'GET', '/api/audit-logs', undefined, admin.cookies);
    assert.equal(auditRes.status, 200);
    assert.ok(auditRes.body.data.some((l: any) => l.action === 'APPROVE_REGISTRATION'));
    assert.ok(auditRes.body.data.some((l: any) => l.action === 'REJECT_REGISTRATION'));
  });
});

test('11-12. Permission restrictions, RBAC boundaries, and Unauthorized/CSRF checks', async () => {
  await withServer(async (baseUrl, store) => {
    const admin = await loginAs(baseUrl, store, 'MC2627110001', '8101352105');
    const createdStaff = await createTestUser(baseUrl, admin.cookies, { role: 'STAFF' });

    // Unauthenticated API request -> 401
    const unauth = await requestJson(baseUrl, 'GET', '/api/users');
    assert.equal(unauth.status, 401);

    // Staff cannot access user directory, approvals, or security logs
    const staff = await loginAs(baseUrl, store, createdStaff.userId, createdStaff.password);
    assert.equal(
      (await requestJson(baseUrl, 'GET', '/api/users', undefined, staff.cookies)).status,
      403
    );
    assert.equal(
      (await requestJson(baseUrl, 'GET', '/api/security-logs', undefined, staff.cookies)).status,
      403
    );
    assert.equal(
      (await requestJson(baseUrl, 'GET', '/api/registration-requests', undefined, staff.cookies)).status,
      403
    );

    // Manager cannot create another Manager or modify permissions
    const manager = await loginAs(baseUrl, store, 'MC2627110002', 'Manager@2026!');
    const mgrCreateMgr = await requestJson(
      baseUrl,
      'POST',
      '/api/users',
      {
        fullName: 'Unauthorized Manager',
        role: 'MANAGER',
        mobile: '+8801711998877',
        address: 'Dhaka',
        password: 'Password@2026!',
        confirmPassword: 'Password@2026!',
      },
      manager.cookies
    );
    assert.equal(mgrCreateMgr.status, 403);

    const mgrEditPerms = await requestJson(
      baseUrl,
      'PUT',
      `/api/users/${createdStaff.userId}/permissions`,
      { permissions: { 'transactions.FINANCIAL': true } },
      manager.cookies
    );
    assert.equal(mgrEditPerms.status, 403);

    // CSRF rejection when cookie session sent without matching X-CSRF-Token
    const noCsrf = await requestJson(
      baseUrl,
      'PATCH',
      `/api/users/${createdStaff.userId}/status`,
      { status: 'SUSPENDED' },
      { mun_session: admin.cookies.mun_session }
    );
    assert.equal(noCsrf.status, 403);
  });
});

test('13-14. Session expiration and Logout invalidation', async () => {
  await withServer(
    async (baseUrl, store) => {
      const manager = await loginAs(baseUrl, store, 'MC2627110002', 'Manager@2026!');
      // Verify active
      const ok = await requestJson(baseUrl, 'GET', '/api/auth/me', undefined, manager.cookies);
      assert.equal(ok.status, 200);

      // Logout invalidates session immediately
      const out = await requestJson(baseUrl, 'POST', '/api/auth/logout', {}, manager.cookies);
      assert.equal(out.status, 200);

      const afterLogout = await requestJson(
        baseUrl,
        'GET',
        '/api/auth/me',
        undefined,
        manager.cookies
      );
      assert.equal(afterLogout.status, 401);
    },
    { sessionTtlMs: 60_000 }
  );

  // Separate short-TTL session expiration test
  await withServer(
    async (baseUrl, store) => {
      const manager = await loginAs(baseUrl, store, 'MC2627110002', 'Manager@2026!');
      await new Promise((r) => setTimeout(r, 40));
      const expired = await requestJson(baseUrl, 'GET', '/api/auth/me', undefined, manager.cookies);
      assert.equal(expired.status, 401);
    },
    { sessionTtlMs: 15 }
  );
});

test('15. Password update & reset clear mustChangePassword, trim whitespace, and persist across restarts', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mun-sec-persist-'));
  const prevErpPath = process.env.MUN_PERSISTENCE_PATH;
  const prevSecPath = process.env.MUN_SECURITY_PERSISTENCE_PATH;
  process.env.MUN_PERSISTENCE_PATH = path.join(tmpDir, 'erp-state.json');
  process.env.MUN_SECURITY_PERSISTENCE_PATH = path.join(tmpDir, 'security-state.json');

  try {
    // Boot #1: First login with default password, change password with whitespace, verify TOTP enrolled
    await withServer(async (baseUrl1, store1) => {
      const firstAdmin = await loginAs(baseUrl1, store1, '  MC2627110001  ', '  8101352105  ', true);
      assert.equal(firstAdmin.user.mustChangePassword, true);

      const changeRes = await requestJson(
        baseUrl1,
        'POST',
        '/api/users/MC2627110001/change-password',
        {
          currentPassword: ' 8101352105 ',
          newPassword: '  MasterNew#2026!  ',
          confirmPassword: '  MasterNew#2026!  ',
        },
        firstAdmin.cookies
      );
      assert.equal(changeRes.status, 200);
      assert.equal(changeRes.body.data.user.mustChangePassword, false);
      assert.equal(changeRes.body.data.user.passwordMigrationRequired, false);

      // Re-login immediately with old default password must fail
      const capOld = issueTestCaptcha(store1);
      const oldPwdAttempt = await requestJson(baseUrl1, 'POST', '/api/auth/login-step1-send-otp', {
        userId: 'MC2627110001',
        password: '8101352105',
        captchaId: capOld.id,
        captchaAnswer: capOld.answer,
      });
      assert.equal(oldPwdAttempt.status, 401);
    });

    // Boot #2: Fresh SecurityStore + createApp simulating full server restart
    await withServer(async (baseUrl2, store2) => {
      // Old default password MUST still fail after restart
      const capOld2 = issueTestCaptcha(store2);
      const oldAfterRestart = await requestJson(baseUrl2, 'POST', '/api/auth/login-step1-send-otp', {
        userId: 'MC2627110001',
        password: '8101352105',
        captchaId: capOld2.id,
        captchaAnswer: capOld2.answer,
      });
      assert.equal(oldAfterRestart.status, 401);

      // Login using registered email + updated password with accidental whitespace MUST succeed
      const capEmail = issueTestCaptcha(store2);
      const step1Email = await requestJson(baseUrl2, 'POST', '/api/auth/login-step1-send-otp', {
        userId: ' admin@muncomputer.local ',
        password: ' MasterNew#2026! ',
        captchaId: capEmail.id,
        captchaAnswer: capEmail.answer,
      });
      assert.equal(step1Email.status, 200);
      const stepSms = await requestJson(baseUrl2, 'POST', '/api/auth/verify-sms-otp', {
        challengeId: step1Email.body.data.challengeId,
        otp: step1Email.body.data.sandboxOtpPreview,
      });
      assert.equal(stepSms.status, 200);
      assert.equal(stepSms.body.data.requiresSetup, false);

      const persistedAdmin = store2.findUserByUserId('MC2627110001')!;
      persistedAdmin.lastTotpStepUsed = undefined;
      const totpSecret = decryptTotpSecret(persistedAdmin.totpSecretEncrypted!);
      const totpCode = new OTPAuth.TOTP({
        issuer: 'MUN COMPUTER',
        label: String(stepSms.body.data.accountLabel || persistedAdmin.userId),
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(totpSecret),
      }).generate();
      const stepTotp = await requestJson(baseUrl2, 'POST', '/api/auth/verify-totp', {
        challengeId: stepSms.body.data.challengeId,
        code: totpCode,
      });
      assert.equal(stepTotp.status, 200);
      assert.equal(stepTotp.body.data.user.userId, 'MC2627110001');
      assert.equal(stepTotp.body.data.user.mustChangePassword, false);
      assert.equal(stepTotp.body.data.user.passwordMigrationRequired, false);
      const reLoginCookies = stepTotp.cookies;

      // Verify Forgot Password + Reset Password flow with whitespace + session revocation + persistence
      const forgotRes = await requestJson(baseUrl2, 'POST', '/api/auth/forgot-password', {
        userId: ' admin@muncomputer.local ',
      });
      assert.equal(forgotRes.status, 200);
      assert.equal(forgotRes.body.data.totpRequired, true);
      const resetChallengeId = forgotRes.body.data.challengeId;
      const resetOtp = forgotRes.body.data.sandboxOtpPreview;
      assert.ok(resetChallengeId && resetOtp);

      persistedAdmin.lastTotpStepUsed = undefined;
      const resetTotpCode = new OTPAuth.TOTP({
        issuer: 'MUN COMPUTER',
        label: String(persistedAdmin.userId),
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(totpSecret),
      }).generate();

      const resetRes = await requestJson(baseUrl2, 'POST', '/api/auth/reset-password', {
        challengeId: resetChallengeId,
        otp: ` ${resetOtp} `,
        totpCode: resetTotpCode,
        newPassword: '  MasterReset#2026!  ',
        confirmPassword: '  MasterReset#2026!  ',
      });
      assert.equal(resetRes.status, 200);

      // Prior session must be revoked after password reset
      const afterResetMe = await requestJson(baseUrl2, 'GET', '/api/auth/me', undefined, reLoginCookies);
      assert.equal(afterResetMe.status, 401);
    });

    // Boot #3: Fresh server restart after forgot/reset password
    await withServer(async (baseUrl3, store3) => {
      const capPrev = issueTestCaptcha(store3);
      const prevPwdAttempt = await requestJson(baseUrl3, 'POST', '/api/auth/login-step1-send-otp', {
        userId: 'MC2627110001',
        password: 'MasterNew#2026!',
        captchaId: capPrev.id,
        captchaAnswer: capPrev.answer,
      });
      assert.equal(prevPwdAttempt.status, 401);

      const capNew = issueTestCaptcha(store3);
      const resetLoginStep1 = await requestJson(baseUrl3, 'POST', '/api/auth/login-step1-send-otp', {
        userId: 'MC2627110001',
        password: '  MasterReset#2026!  ',
        captchaId: capNew.id,
        captchaAnswer: capNew.answer,
      });
      assert.equal(resetLoginStep1.status, 200);
    });
  } finally {
    if (prevErpPath === undefined) delete process.env.MUN_PERSISTENCE_PATH;
    else process.env.MUN_PERSISTENCE_PATH = prevErpPath;
    if (prevSecPath === undefined) delete process.env.MUN_SECURITY_PERSISTENCE_PATH;
    else process.env.MUN_SECURITY_PERSISTENCE_PATH = prevSecPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('16. Session-status non-401 probe, Bearer-vs-cookie precedence, and sess1 role hydration', async () => {
  let capturedBearerToken = '';

  await withServer(async (baseUrl, store) => {
    // Unauthenticated bootstrap probe must return 200 OK (authenticated: false), avoiding noisy 401s
    const unauthStatus = await requestJson(baseUrl, 'GET', '/api/auth/session-status');
    assert.equal(unauthStatus.status, 200);
    assert.equal(unauthStatus.body.data.authenticated, false);
    assert.equal(unauthStatus.body.data.user, null);

    // /api/auth/me remains strictly 401 when unauthenticated
    const unauthMe = await requestJson(baseUrl, 'GET', '/api/auth/me');
    assert.equal(unauthMe.status, 401);

    // Sign in as Manager and capture self-hydrating accessToken + cookies
    const loginResult = await performFourLayerLogin(baseUrl, store, 'MC2627110002', 'Manager@2026!');
    capturedBearerToken = String(loginResult.verifyData?.accessToken || loginResult.cookies.mun_session);
    assert.ok(capturedBearerToken.startsWith('sess1.'));

    // Authenticated session-status returns user + accessToken
    const authedStatus = await requestJson(
      baseUrl,
      'GET',
      '/api/auth/session-status',
      undefined,
      {},
      { Authorization: `Bearer ${capturedBearerToken}` }
    );
    assert.equal(authedStatus.status, 200);
    assert.equal(authedStatus.body.data.authenticated, true);
    assert.equal(authedStatus.body.data.user.userId, 'MC2627110002');
    assert.equal(authedStatus.body.data.accessToken, capturedBearerToken);

    // Valid Authorization Bearer succeeds even when paired with a stale/revoked mun_session cookie
    const staleCookieValidBearer = await requestJson(
      baseUrl,
      'GET',
      '/api/auth/me',
      undefined,
      { mun_session: 'stale-invalid-cookie-token' },
      { Authorization: `Bearer ${capturedBearerToken}` }
    );
    assert.equal(staleCookieValidBearer.status, 200);
    assert.equal(staleCookieValidBearer.body.data.user.role, 'MANAGER');

    // Stale Authorization Bearer falls back cleanly to a valid mun_session cookie
    const staleBearerValidCookie = await requestJson(
      baseUrl,
      'GET',
      '/api/auth/me',
      undefined,
      loginResult.cookies,
      { Authorization: 'Bearer stale-invalid-bearer-token' }
    );
    assert.equal(staleBearerValidCookie.status, 200);
    assert.equal(staleBearerValidCookie.body.data.user.userId, 'MC2627110002');
  });

  // Fresh SecurityStore + createApp simulating cold restart: sess1. self-hydration must preserve exact role
  await withServer(async (freshBaseUrl, freshStore) => {
    const hydratedRes = await requestJson(
      freshBaseUrl,
      'GET',
      '/api/auth/me',
      undefined,
      {},
      { Authorization: `Bearer ${capturedBearerToken}` }
    );
    assert.equal(hydratedRes.status, 200);
    assert.equal(hydratedRes.body.data.user.userId, 'MC2627110002');

    const hydratedSession = Array.from(freshStore.sessions.values()).find(
      (s) => s.userId === 'MC2627110002'
    );
    assert.ok(hydratedSession);
    assert.equal(hydratedSession!.role, 'MANAGER');

    // RBAC-protected route succeeds using self-hydrated session
    const usersRes = await requestJson(
      freshBaseUrl,
      'GET',
      '/api/users',
      undefined,
      {},
      { Authorization: `Bearer ${capturedBearerToken}` }
    );
    assert.equal(usersRes.status, 200);
  });
});

test('17. Password-change refreshes sess1 token so cold-started instances clear mustChangePassword and sync-675 works', async () => {
  let preChangeToken = '';
  let postChangeToken = '';
  let postChangeCsrf = '';

  await withServer(async (baseUrl, store) => {
    const initialLogin = await performFourLayerLogin(
      baseUrl,
      store,
      'MC2627110001',
      '8101352105',
      { preserveMustChangePassword: true }
    );
    preChangeToken = String(initialLogin.verifyData?.accessToken || initialLogin.cookies.mun_session);
    assert.ok(preChangeToken.startsWith('sess1.'));

    // Before changing initial password, sync-675 must be blocked with 403 passwordChangeRequired
    const blockedSync = await requestJson(
      baseUrl,
      'POST',
      '/api/erp/services/sync-catalog',
      {},
      { mun_csrf: initialLogin.cookies.mun_csrf },
      {
        Authorization: `Bearer ${preChangeToken}`,
        'X-CSRF-Token': initialLogin.cookies.mun_csrf,
      }
    );
    assert.equal(blockedSync.status, 403);
    assert.equal(blockedSync.body.data?.passwordChangeRequired, true);

    // Complete mandatory password change and verify refreshed sess1. token + csrfToken are returned
    const pwdRes = await requestJson(
      baseUrl,
      'POST',
      '/api/users/MC2627110001/change-password',
      {
        currentPassword: '8101352105',
        newPassword: 'MasterChanged#2026!',
        confirmPassword: 'MasterChanged#2026!',
      },
      { mun_csrf: initialLogin.cookies.mun_csrf },
      {
        Authorization: `Bearer ${preChangeToken}`,
        'X-CSRF-Token': initialLogin.cookies.mun_csrf,
      }
    );
    assert.equal(pwdRes.status, 200);
    assert.equal(pwdRes.body.data.user.mustChangePassword, false);
    postChangeToken = String(pwdRes.body.data.accessToken || '');
    postChangeCsrf = String(pwdRes.body.data.csrfToken || '');
    assert.ok(postChangeToken.startsWith('sess1.'));
    assert.ok(postChangeCsrf.length > 0);
  });

  // Cold-started server instance where MC2627110001 initializes with default mustChangePassword: true
  await withServer(async (coldBaseUrl, coldStore) => {
    const staleSyncAttempt = await requestJson(
      coldBaseUrl,
      'POST',
      '/api/erp/services/sync-catalog',
      {},
      { mun_csrf: postChangeCsrf },
      {
        Authorization: `Bearer ${preChangeToken}`,
        'X-CSRF-Token': postChangeCsrf,
      }
    );
    assert.equal(staleSyncAttempt.status, 403);
    assert.equal(staleSyncAttempt.body.data?.passwordChangeRequired, true);

    // Post-change refreshed token (mcp: false, newer pca) clears lock on cold instance and allows sync-675
    const unlockedSync = await requestJson(
      coldBaseUrl,
      'POST',
      '/api/erp/services/sync-catalog',
      {},
      { mun_csrf: postChangeCsrf },
      {
        Authorization: `Bearer ${postChangeToken}`,
        'X-CSRF-Token': postChangeCsrf,
      }
    );
    assert.equal(unlockedSync.status, 200);
    assert.equal(coldStore.findUserByUserId('MC2627110001')?.mustChangePassword, false);

    // Customer validation failure returns structured field errors on 422
    const invalidCust = await requestJson(
      coldBaseUrl,
      'POST',
      '/api/erp/customers',
      {
        fullName: 'A',
        mobile: '12345',
        village: 'X',
      },
      { mun_csrf: postChangeCsrf },
      {
        Authorization: `Bearer ${postChangeToken}`,
        'X-CSRF-Token': postChangeCsrf,
      }
    );
    assert.equal(invalidCust.status, 422);
    assert.ok(invalidCust.body.errors?.fullName);
    assert.ok(invalidCust.body.errors?.mobile);
    assert.ok(invalidCust.body.errors?.village);
  });
});

test('18. Profile password change persists mustChangePassword=false across disk restart and subsequent logins', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mun-profile-pwd-'));
  const secPath = path.join(tmpDir, 'security-state.json');
  const erpPath = path.join(tmpDir, 'erp-state.json');
  const prevSecPath = process.env.MUN_SECURITY_PERSISTENCE_PATH;
  const prevErpPath = process.env.MUN_PERSISTENCE_PATH;

  process.env.MUN_SECURITY_PERSISTENCE_PATH = secPath;
  process.env.MUN_PERSISTENCE_PATH = erpPath;

  try {
    await withServer(async (baseUrl, store) => {
      const login = await performFourLayerLogin(
        baseUrl,
        store,
        'MC2627110001',
        '8101352105',
        { preserveMustChangePassword: true }
      );
      assert.equal(login.user.mustChangePassword, true);

      const pwdRes = await requestJson(
        baseUrl,
        'POST',
        '/api/users/MC2627110001/change-password',
        {
          currentPassword: '8101352105',
          newPassword: 'ProfileUpdated#2026!',
          confirmPassword: 'ProfileUpdated#2026!',
        },
        login.cookies
      );
      assert.equal(pwdRes.status, 200);
      assert.equal(pwdRes.body.data.user.mustChangePassword, false);
      assert.equal(pwdRes.body.data.user.passwordMigrationRequired, false);
    });

    // Reboot server from persisted disk snapshot and sign in with the new password
    await withServer(async (baseUrl2, store2) => {
      const cap2 = issueTestCaptcha(store2);
      const step1 = await requestJson(baseUrl2, 'POST', '/api/auth/login-step1-send-otp', {
        userId: 'MC2627110001',
        password: 'ProfileUpdated#2026!',
        captchaId: cap2.id,
        captchaAnswer: cap2.answer,
      });
      assert.equal(step1.status, 200);
      const stepSms = await requestJson(baseUrl2, 'POST', '/api/auth/verify-sms-otp', {
        challengeId: step1.body.data.challengeId,
        otp: step1.body.data.sandboxOtpPreview,
      });
      assert.equal(stepSms.status, 200);
      assert.equal(stepSms.body.data.requiresSetup, false);

      const persistedAdmin = store2.findUserByUserId('MC2627110001')!;
      assert.equal(persistedAdmin.mustChangePassword, false);
      assert.equal(persistedAdmin.passwordMigrationRequired, false);
      persistedAdmin.lastTotpStepUsed = undefined;

      const totpSecret = decryptTotpSecret(persistedAdmin.totpSecretEncrypted!);
      const totpCode = new OTPAuth.TOTP({
        issuer: 'MUN COMPUTER',
        label: String(stepSms.body.data.accountLabel || persistedAdmin.userId),
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(totpSecret),
      }).generate();
      const stepTotp = await requestJson(baseUrl2, 'POST', '/api/auth/verify-totp', {
        challengeId: stepSms.body.data.challengeId,
        code: totpCode,
      });
      assert.equal(stepTotp.status, 200);
      assert.equal(stepTotp.body.data.user.mustChangePassword, false);
      assert.equal(stepTotp.body.data.user.passwordMigrationRequired, false);

      const statusRes = await requestJson(
        baseUrl2,
        'GET',
        '/api/auth/session-status',
        undefined,
        stepTotp.cookies
      );
      assert.equal(statusRes.status, 200);
      assert.equal(statusRes.body.data.user.mustChangePassword, false);

      const usersRes = await requestJson(
        baseUrl2,
        'GET',
        '/api/users',
        undefined,
        stepTotp.cookies
      );
      assert.equal(usersRes.status, 200);
    });
  } finally {
    if (prevSecPath === undefined) delete process.env.MUN_SECURITY_PERSISTENCE_PATH;
    else process.env.MUN_SECURITY_PERSISTENCE_PATH = prevSecPath;
    if (prevErpPath === undefined) delete process.env.MUN_PERSISTENCE_PATH;
    else process.env.MUN_PERSISTENCE_PATH = prevErpPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('19. Mandatory first-login relogin flow (revokeCurrentSession), fp1 resend OTP, recovery-code reset, and 5-password history enforcement', async () => {
  await withServer(async (baseUrl, store) => {
    // 1. Admin first login -> dashboard blocked -> change password with revokeCurrentSession=true
    const firstLogin = await performFourLayerLogin(
      baseUrl,
      store,
      'MC2627110001',
      '8101352105',
      { preserveMustChangePassword: true }
    );
    assert.equal(firstLogin.user.mustChangePassword, true);
    const issuedRecoveryCodes: string[] = firstLogin.verifyData?.recoveryCodes ?? [];
    assert.ok(issuedRecoveryCodes.length > 0, 'Expected recovery codes on first TOTP enrollment');

    const changeAndLogout = await requestJson(
      baseUrl,
      'POST',
      '/api/users/MC2627110001/change-password',
      {
        currentPassword: '8101352105',
        newPassword: 'AdminRelogin#2026!',
        confirmPassword: 'AdminRelogin#2026!',
        revokeCurrentSession: true,
      },
      firstLogin.cookies
    );
    assert.equal(changeAndLogout.status, 200);
    assert.equal(changeAndLogout.body.data.requiresRelogin, true);
    assert.equal(changeAndLogout.body.data.user.mustChangePassword, false);

    // Current session must now be revoked (401)
    const revokedMe = await requestJson(baseUrl, 'GET', '/api/auth/me', undefined, firstLogin.cookies);
    assert.equal(revokedMe.status, 401);

    // Fresh 4-layer login with new password unlocks dashboard
    const relogin = await performFourLayerLogin(
      baseUrl,
      store,
      'MC2627110001',
      'AdminRelogin#2026!'
    );
    assert.equal(relogin.user.mustChangePassword, false);
    const dashboardUsers = await requestJson(baseUrl, 'GET', '/api/users', undefined, relogin.cookies);
    assert.equal(dashboardUsers.status, 200);

    // 2. Password history blocks reusing initial default password '8101352105'
    const reuseInitial = await requestJson(
      baseUrl,
      'POST',
      '/api/users/MC2627110001/change-password',
      {
        currentPassword: 'AdminRelogin#2026!',
        newPassword: '8101352105',
        confirmPassword: '8101352105',
      },
      relogin.cookies
    );
    assert.equal(reuseInitial.status, 422);

    // 3. Forgot password + fp1 Resend OTP + recovery-code reset
    const forgotRes = await requestJson(baseUrl, 'POST', '/api/auth/forgot-password', {
      userId: 'MC2627110001',
    });
    assert.equal(forgotRes.status, 200);
    const oldFpChallengeId = forgotRes.body.data.challengeId;
    const oldFpOtp = forgotRes.body.data.sandboxOtpPreview;

    // Force resend window ready so we can exercise /api/auth/resend-otp with fp1. challenge
    const trackedFp = store.otpChallenges.get(oldFpChallengeId);
    assert.ok(trackedFp);
    trackedFp.resendAvailableAt = Date.now() - 1000;

    const resendRes = await requestJson(baseUrl, 'POST', '/api/auth/resend-otp', {
      challengeId: oldFpChallengeId,
    });
    assert.equal(resendRes.status, 200);
    const nextFpChallengeId = resendRes.body.data.challengeId;
    const nextFpOtp = resendRes.body.data.sandboxOtpPreview;
    assert.ok(nextFpChallengeId && nextFpChallengeId !== oldFpChallengeId);
    assert.ok(nextFpOtp);

    // Old fp1 challenge must be rejected once resent
    const oldFpAttempt = await requestJson(baseUrl, 'POST', '/api/auth/reset-password', {
      challengeId: oldFpChallengeId,
      otp: oldFpOtp,
      totpCode: issuedRecoveryCodes[0],
      newPassword: 'AdminRecovered#2026!',
      confirmPassword: 'AdminRecovered#2026!',
    });
    assert.equal(oldFpAttempt.status, 400);

    // Reset using new resent fp1 challenge + single-use recovery code succeeds
    const resetViaRecovery = await requestJson(baseUrl, 'POST', '/api/auth/reset-password', {
      challengeId: nextFpChallengeId,
      otp: nextFpOtp,
      totpCode: issuedRecoveryCodes[0],
      newPassword: 'AdminRecovered#2026!',
      confirmPassword: 'AdminRecovered#2026!',
    });
    assert.equal(resetViaRecovery.status, 200);

    // Active session must be revoked and new password works on fresh login
    const postResetMe = await requestJson(baseUrl, 'GET', '/api/auth/me', undefined, relogin.cookies);
    assert.equal(postResetMe.status, 401);

    const postRecoveryLogin = await performFourLayerLogin(
      baseUrl,
      store,
      'MC2627110001',
      'AdminRecovered#2026!'
    );
    assert.equal(postRecoveryLogin.user.userId, 'MC2627110001');
  });
});




