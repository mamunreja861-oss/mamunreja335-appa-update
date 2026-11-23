import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as OTPAuth from 'otpauth';
import { createApp } from '../server/app.js';
import { SecurityStore } from '../server/securityStore.js';
import { createTestUser, issueTestCaptcha, performFourLayerLogin } from './testAuthHelper.js';

function requestJson(
  baseUrl: string,
  method: string,
  route: string,
  body?: unknown,
  cookies: Record<string, string> = {},
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; body: any; cookies: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const cookieHeader = Object.entries(cookies)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('; ');
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      `${baseUrl}${route}`,
      {
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...(cookies.mun_csrf ? { 'X-CSRF-Token': cookies.mun_csrf } : {}),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: any = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            // plain text / json download fallback
          }
          const rawCookies = res.headers['set-cookie'] ?? [];
          const nextCookies: Record<string, string> = { ...cookies };
          for (const entry of rawCookies) {
            const first = entry.split(';')[0];
            const idx = first.indexOf('=');
            if (idx > -1) {
              nextCookies[first.slice(0, idx).trim()] = decodeURIComponent(
                first.slice(idx + 1).trim()
              );
            }
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, cookies: nextCookies });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withPersistedServer(
  fn: (baseUrl: string, store: SecurityStore) => Promise<void>
): Promise<void> {
  const store = new SecurityStore();
  const app = createApp(store, {
    enableRateLimit: false,
    enableBackupScheduler: false,
    enableReportScheduler: false,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl, store);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function loginAcrossRestart(
  baseUrl: string,
  store: SecurityStore,
  userId: string,
  password: string,
  totpSecrets: Map<string, string>
): Promise<{ cookies: Record<string, string>; user: any }> {
  const cap = issueTestCaptcha(store);
  const step1 = await requestJson(baseUrl, 'POST', '/api/auth/login-step1-send-otp', {
    userId,
    password,
    captchaId: cap.id,
    captchaAnswer: cap.answer,
  });
  assert.equal(step1.status, 200, `Step 1 failed for ${userId}: ${step1.body?.message}`);
  const ch2Id = step1.body?.data?.challengeId;
  const smsOtp = step1.body?.data?.sandboxOtpPreview;
  assert.ok(ch2Id && smsOtp);

  const stepSms = await requestJson(baseUrl, 'POST', '/api/auth/verify-sms-otp', {
    challengeId: ch2Id,
    otp: smsOtp,
  });
  assert.equal(stepSms.status, 200, `SMS OTP failed for ${userId}: ${stepSms.body?.message}`);
  const ch3Id = stepSms.body?.data?.challengeId;
  if (stepSms.body?.data?.manualSecret) {
    totpSecrets.set(userId.toUpperCase(), stepSms.body.data.manualSecret);
  }
  const secret = totpSecrets.get(userId.toUpperCase());
  assert.ok(secret, `Expected TOTP secret for ${userId}`);

  const uObj = store.findUserByUserId(userId);
  if (uObj) uObj.lastTotpStepUsed = undefined;

  const totp = new OTPAuth.TOTP({
    issuer: 'MUN COMPUTER',
    label: String(stepSms.body?.data?.accountLabel || userId),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });

  const step2 = await requestJson(baseUrl, 'POST', '/api/auth/verify-totp', {
    challengeId: ch3Id,
    code: totp.generate(),
  });
  assert.equal(step2.status, 200, `TOTP failed for ${userId}: ${step2.body?.message}`);
  return { cookies: step2.cookies, user: step2.body.data.user };
}

test('Permanent persistence across restarts: Admin set-password, restart-safe forgot-password, and all missed module stores', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mun-full-persist-'));
  const prevErp = process.env.MUN_PERSISTENCE_PATH;
  const prevSec = process.env.MUN_SECURITY_PERSISTENCE_PATH;
  process.env.MUN_PERSISTENCE_PATH = path.join(tmpDir, 'erp-state.json');
  process.env.MUN_SECURITY_PERSISTENCE_PATH = path.join(tmpDir, 'security-state.json');

  const totpSecrets = new Map<string, string>();
  let staffUserId = '';
  let staffOldSession: Record<string, string> = {};
  let sealedResetChallengeId = '';
  let sealedResetOtp = '';
  let phase03BackupCode = '';
  let phase08BackupCode = '';
  let createdBugCode = '';
  let createdServiceCode = '';
  let softDeletedDeletionCode = '';

  try {
    // Boot #1: Create user, active staff session, admin set-password, issue forgot-password challenge, mutate Finance/Phase08/Phase03/Phase09/SecurityStore
    await withPersistedServer(async (baseUrl, store) => {
      const admin = await performFourLayerLogin(baseUrl, store, 'MC2627110001', '8101352105');
      if (admin.totpData?.manualSecret) totpSecrets.set('MC2627110001', admin.totpData.manualSecret);

      // 1. Create Staff and log them in
      const createdStaff = await createTestUser(baseUrl, admin.cookies, {
        role: 'STAFF',
        fullName: 'Persist Test Staff',
        password: 'StaffInitial#2026',
      });
      staffUserId = createdStaff.userId;

      const staffLogin = await performFourLayerLogin(
        baseUrl,
        store,
        staffUserId,
        'StaffInitial#2026'
      );
      if (staffLogin.totpData?.manualSecret) {
        totpSecrets.set(staffUserId.toUpperCase(), staffLogin.totpData.manualSecret);
      }
      staffOldSession = staffLogin.cookies;

      // Staff cannot call set-password
      const staffBlocked = await requestJson(
        baseUrl,
        'POST',
        `/api/users/${staffUserId}/set-password`,
        {
          newPassword: 'StaffHackPass#2026',
          confirmPassword: 'StaffHackPass#2026',
        },
        staffOldSession
      );
      assert.equal(staffBlocked.status, 403);

      // Admin sets new password for Staff
      const adminSet = await requestJson(
        baseUrl,
        'POST',
        `/api/users/${staffUserId}/set-password`,
        {
          newPassword: 'AdminAssigned#2026',
          confirmPassword: 'AdminAssigned#2026',
          requireChangeOnNextLogin: false,
        },
        admin.cookies
      );
      assert.equal(adminSet.status, 200);
      assert.equal(adminSet.body.data.updated, true);
      assert.ok(adminSet.body.data.revokedSessions >= 1);

      // Old Staff session must be invalidated immediately
      const oldSessionMe = await requestJson(baseUrl, 'GET', '/api/auth/me', undefined, staffOldSession);
      assert.equal(oldSessionMe.status, 401);

      // Issue forgot-password OTP BEFORE server restart to test restart-proof sealed fp1 challenge
      const forgotRes = await requestJson(baseUrl, 'POST', '/api/auth/forgot-password', {
        userId: 'MC2627110002',
      });
      assert.equal(forgotRes.status, 200);
      sealedResetChallengeId = forgotRes.body.data.challengeId;
      sealedResetOtp = forgotRes.body.data.sandboxOtpPreview;
      assert.ok(sealedResetChallengeId.startsWith('fp1.'));
      assert.ok(sealedResetOtp);

      // Mutate Finance V1 employee & product (previously outside /api/finance/)
      const empRes = await requestJson(
        baseUrl,
        'POST',
        '/api/v1/employees',
        {
          fullName: 'Persisted Employee One',
          designation: 'Senior Operator',
          department: 'CSC Desk',
          mobile: '+919800112233',
          basicSalary: 14000,
        },
        admin.cookies
      );
      assert.equal(empRes.status, 201);

      const prodRes = await requestJson(
        baseUrl,
        'POST',
        '/api/v1/products',
        {
          name: 'Lamination Pouch A4 Pack',
          sku: 'LAM-A4-100',
          category: 'Stationery',
          sellingPrice: 350,
          initialQty: 25,
          initialUnitCost: 220,
        },
        admin.cookies
      );
      assert.equal(prodRes.status, 201);

      // Create & soft-delete a custom service to verify tombstone + recovery persistence
      const srvCreate = await requestJson(
        baseUrl,
        'POST',
        '/api/erp/services',
        {
          name: 'Temp Persist Service',
          categoryId: 1,
          govtFee: 50,
          serviceCharge: 100,
        },
        admin.cookies
      );
      assert.equal(srvCreate.status, 201);
      createdServiceCode = srvCreate.body.data.serviceCode;

      const softDel = await requestJson(
        baseUrl,
        'POST',
        '/api/v1/security/recovery/soft-delete',
        {
          entityType: 'SERVICE',
          entityId: createdServiceCode,
          reason: 'Verify deleted tombstone persists across restart',
        },
        admin.cookies
      );
      assert.equal(softDel.status, 201);
      softDeletedDeletionCode = softDel.body.data.deletionCode;

      // Mutate Phase 03 backup + counter
      const p3BkpRes = await requestJson(
        baseUrl,
        'POST',
        '/api/backups',
        { storageTarget: 'Computer Download' },
        admin.cookies
      );
      assert.equal(p3BkpRes.status, 201);
      phase03BackupCode = p3BkpRes.body.data.backupCode;

      const ctrRes = await requestJson(
        baseUrl,
        'POST',
        '/api/counters',
        { counterCode: 'CTR-PERSIST', name: 'Persistent Counter 9' },
        admin.cookies
      );
      assert.equal(ctrRes.status, 201);

      // Mutate Phase 08 (/api/v1/security/...) backup & custom role
      const roleRes = await requestJson(
        baseUrl,
        'POST',
        '/api/v1/security/custom-roles',
        {
          roleName: 'Branch Auditor Plus',
          baseRole: 'AUDITOR',
          description: 'Persisted custom role across restart',
          permissions: { 'reports.EXPORT': true },
        },
        admin.cookies
      );
      assert.equal(roleRes.status, 201);

      const p8BkpRes = await requestJson(
        baseUrl,
        'POST',
        '/api/v1/security/backups/create',
        { frequency: 'MANUAL' },
        admin.cookies
      );
      assert.equal(p8BkpRes.status, 201);
      phase08BackupCode = p8BkpRes.body.data.backupCode;

      // Mutate Phase 09 QA bug
      const bugRes = await requestJson(
        baseUrl,
        'POST',
        '/api/qa/bugs',
        {
          title: 'Persisted QA Defect Check',
          moduleName: 'Security',
          priority: 'Medium',
          description: 'Bug persistence check across restarts',
          reproductionSteps: '1. Create bug 2. Restart server',
          expectedResult: 'Bug remains in QA tracker',
          actualResult: 'Verifying persistence',
        },
        admin.cookies
      );
      assert.equal(bugRes.status, 201);
      createdBugCode = bugRes.body.data.bugCode;

      // Mutate SecurityStore department
      const deptRes = await requestJson(
        baseUrl,
        'POST',
        '/api/departments',
        { code: 'DEPT-QA', name: 'QA & Compliance Dept' },
        admin.cookies
      );
      assert.equal(deptRes.status, 201);
    });

    // Boot #2: Full server restart — verify ALL state survived and forgot-password completes across restart!
    await withPersistedServer(async (baseUrl2, store2) => {
      // Old password for staff fails; Admin-assigned password works
      const capOld = issueTestCaptcha(store2);
      const oldAttempt = await requestJson(baseUrl2, 'POST', '/api/auth/login-step1-send-otp', {
        userId: staffUserId,
        password: 'StaffInitial#2026',
        captchaId: capOld.id,
        captchaAnswer: capOld.answer,
      });
      assert.equal(oldAttempt.status, 401);

      const staffRestartLogin = await loginAcrossRestart(
        baseUrl2,
        store2,
        staffUserId,
        'AdminAssigned#2026',
        totpSecrets
      );
      assert.equal(staffRestartLogin.user.userId, staffUserId);
      assert.equal(staffRestartLogin.user.mustChangePassword, false);

      // Revoked old staff session must STILL be 401 after restart
      const oldSessionAfterRestart = await requestJson(
        baseUrl2,
        'GET',
        '/api/auth/me',
        undefined,
        staffOldSession
      );
      assert.equal(oldSessionAfterRestart.status, 401);

      // Complete forgot-password challenge issued BEFORE server restart!
      const resetRes = await requestJson(baseUrl2, 'POST', '/api/auth/reset-password', {
        challengeId: sealedResetChallengeId,
        otp: sealedResetOtp,
        newPassword: 'ManagerRestarted#2026',
        confirmPassword: 'ManagerRestarted#2026',
      });
      assert.equal(resetRes.status, 200);

      // Replaying same sealed challenge must be rejected
      const replayRes = await requestJson(baseUrl2, 'POST', '/api/auth/reset-password', {
        challengeId: sealedResetChallengeId,
        otp: sealedResetOtp,
        newPassword: 'ManagerReplay#2026',
        confirmPassword: 'ManagerReplay#2026',
      });
      assert.equal(replayRes.status, 400);

      // Log in as Admin with updated password from Boot #1 (8101352105_Rotated#26 via performFourLayerLogin)
      const admin2 = await loginAcrossRestart(
        baseUrl2,
        store2,
        'MC2627110001',
        '8101352105_Rotated#26',
        totpSecrets
      );

      // Verify Finance v1 employees & products survived
      const empsAfter = await requestJson(baseUrl2, 'GET', '/api/v1/employees', undefined, admin2.cookies);
      assert.equal(empsAfter.status, 200);
      assert.ok(
        empsAfter.body.data.employees.some((e: any) => e.fullName === 'Persisted Employee One')
      );

      const prodsAfter = await requestJson(baseUrl2, 'GET', '/api/v1/products', undefined, admin2.cookies);
      assert.equal(prodsAfter.status, 200);
      assert.ok(prodsAfter.body.data.products.some((p: any) => p.sku === 'LAM-A4-100'));

      // Verify soft-deleted service stays deleted & listed in recovery after restart, then permanently purge
      const servicesAfter = await requestJson(
        baseUrl2,
        'GET',
        '/api/erp/services?includeDeleted=false',
        undefined,
        admin2.cookies
      );
      assert.equal(servicesAfter.status, 200);
      assert.ok(
        !servicesAfter.body.data.some((s: any) => s.serviceCode === createdServiceCode),
        'Soft-deleted service must remain hidden after restart'
      );

      const deletedList = await requestJson(
        baseUrl2,
        'GET',
        '/api/v1/security/recovery/deleted',
        undefined,
        admin2.cookies
      );
      assert.equal(deletedList.status, 200);
      assert.ok(
        deletedList.body.data.deletedRecords.some(
          (d: any) => d.deletionCode === softDeletedDeletionCode && d.recoveryStatus === 'SOFT_DELETED'
        )
      );

      const purgeApprove = await requestJson(
        baseUrl2,
        'POST',
        `/api/v1/security/recovery/${softDeletedDeletionCode}/permanent-review`,
        { approve: true, reason: 'Permanent cleanup confirmed' },
        admin2.cookies
      );
      assert.equal(purgeApprove.status, 200);
      assert.equal(purgeApprove.body.data.recoveryStatus, 'PERMANENTLY_DELETED');

      // Verify Phase 03 backup download & counters survived
      const p3Download = await requestJson(
        baseUrl2,
        'GET',
        `/api/backups/${phase03BackupCode}/download`,
        undefined,
        admin2.cookies
      );
      assert.equal(p3Download.status, 200);
      assert.equal(p3Download.body.backupCode, phase03BackupCode);

      const settingsAfter = await requestJson(
        baseUrl2,
        'GET',
        '/api/master-settings/overview',
        undefined,
        admin2.cookies
      );
      assert.equal(settingsAfter.status, 200);
      assert.ok(settingsAfter.body.data.counters.some((c: any) => c.counterCode === 'CTR-PERSIST'));

      // Verify Phase 08 custom role & encrypted backup verify survived
      const rolesAfter = await requestJson(
        baseUrl2,
        'GET',
        '/api/v1/security/custom-roles',
        undefined,
        admin2.cookies
      );
      assert.equal(rolesAfter.status, 200);
      assert.ok(rolesAfter.body.data.some((r: any) => r.roleName === 'Branch Auditor Plus'));

      const verifyBkp = await requestJson(
        baseUrl2,
        'POST',
        `/api/v1/security/backups/${phase08BackupCode}/verify`,
        {},
        admin2.cookies
      );
      assert.equal(verifyBkp.status, 200);
      assert.equal(verifyBkp.body.data.verified, true);

      // Verify Phase 09 QA bug survived
      const bugsAfter = await requestJson(baseUrl2, 'GET', '/api/qa/bugs', undefined, admin2.cookies);
      assert.equal(bugsAfter.status, 200);
      assert.ok(bugsAfter.body.data.bugs.some((b: any) => b.bugCode === createdBugCode));

      // Verify SecurityStore department survived
      const deptsAfter = await requestJson(baseUrl2, 'GET', '/api/departments', undefined, admin2.cookies);
      assert.equal(deptsAfter.status, 200);
      assert.ok(deptsAfter.body.data.some((d: any) => d.code === 'DEPT-QA'));
    });

    // Boot #3: Confirm Manager login with password reset in Boot #2 & permanently purged service never returns
    await withPersistedServer(async (baseUrl3, store3) => {
      const mgrLogin = await loginAcrossRestart(
        baseUrl3,
        store3,
        'MC2627110002',
        'ManagerRestarted#2026',
        totpSecrets
      );
      assert.equal(mgrLogin.user.userId, 'MC2627110002');

      const servicesBoot3 = await requestJson(
        baseUrl3,
        'GET',
        '/api/erp/services?includeDeleted=true',
        undefined,
        mgrLogin.cookies
      );
      assert.equal(servicesBoot3.status, 200);
      assert.ok(
        !servicesBoot3.body.data.some((s: any) => s.serviceCode === createdServiceCode),
        'Permanently purged service must never reappear after restart'
      );
    });
  } finally {
    if (prevErp === undefined) delete process.env.MUN_PERSISTENCE_PATH;
    else process.env.MUN_PERSISTENCE_PATH = prevErp;
    if (prevSec === undefined) delete process.env.MUN_SECURITY_PERSISTENCE_PATH;
    else process.env.MUN_SECURITY_PERSISTENCE_PATH = prevSec;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Consecutive password changes (P1 -> P2 -> P3), whitespace trimming, and forgot-password clearing first-login flags persist across restarts', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mun-consec-pwd-'));
  const prevErp = process.env.MUN_PERSISTENCE_PATH;
  const prevSec = process.env.MUN_SECURITY_PERSISTENCE_PATH;
  process.env.MUN_PERSISTENCE_PATH = path.join(tmpDir, 'erp-state.json');
  process.env.MUN_SECURITY_PERSISTENCE_PATH = path.join(tmpDir, 'security-state.json');

  const totpSecrets = new Map<string, string>();
  let staffUserId = '';

  try {
    // Boot #1: Create staff, log in, perform P1 -> P2 -> P3 consecutive password changes with whitespace padding
    await withPersistedServer(async (baseUrl, store) => {
      const admin = await performFourLayerLogin(baseUrl, store, 'MC2627110001', '8101352105');
      if (admin.totpData?.manualSecret) totpSecrets.set('MC2627110001', admin.totpData.manualSecret);

      const createdStaff = await createTestUser(baseUrl, admin.cookies, {
        role: 'STAFF',
        fullName: 'Consecutive Change Staff',
        password: 'StaffPassOne#2026',
      });
      staffUserId = createdStaff.userId;

      // Mark isFirstLogin=true via set-password so we also test forgot-password clearing it later
      const staffLogin = await performFourLayerLogin(
        baseUrl,
        store,
        staffUserId,
        '  StaffPassOne#2026  '
      );
      if (staffLogin.totpData?.manualSecret) {
        totpSecrets.set(staffUserId.toUpperCase(), staffLogin.totpData.manualSecret);
      }

      // Change #1: P1 -> P2 with leading/trailing spaces on inputs
      const change1 = await requestJson(
        baseUrl,
        'POST',
        `/api/users/${staffUserId}/change-password`,
        {
          currentPassword: '  StaffPassOne#2026  ',
          newPassword: '  StaffPassTwo#2026  ',
          confirmPassword: '  StaffPassTwo#2026  ',
        },
        staffLogin.cookies
      );
      assert.equal(change1.status, 200);
      assert.equal(change1.body.data.changed, true);
      assert.equal(change1.body.data.user.mustChangePassword, false);

      // Refresh client cookies with updated token/csrf returned by change-password
      const sessionAfterChange1 = {
        ...change1.cookies,
        ...(change1.body.data.accessToken ? { mun_session: change1.body.data.accessToken } : {}),
        ...(change1.body.data.csrfToken ? { mun_csrf: change1.body.data.csrfToken } : {}),
      };

      // Attempting second change using stale P1 must fail cleanly with 401
      const staleAttempt = await requestJson(
        baseUrl,
        'POST',
        `/api/users/${staffUserId}/change-password`,
        {
          currentPassword: 'StaffPassOne#2026',
          newPassword: 'StaffPassThree#2026',
          confirmPassword: 'StaffPassThree#2026',
        },
        sessionAfterChange1
      );
      assert.equal(staleAttempt.status, 401);

      // Consecutive Change #2: P2 -> P3 in same session using latest P2 as currentPassword
      const change2 = await requestJson(
        baseUrl,
        'POST',
        `/api/users/${staffUserId}/change-password`,
        {
          currentPassword: '  StaffPassTwo#2026 ',
          newPassword: ' StaffPassThree#2026 ',
          confirmPassword: ' StaffPassThree#2026 ',
        },
        sessionAfterChange1
      );
      assert.equal(change2.status, 200);
      assert.equal(change2.body.data.changed, true);
      assert.equal(change2.body.data.user.mustChangePassword, false);

      // Force isFirstLogin=true on staff, then reset via forgot-password + whitespace-trimmed password
      const staffUserObj = store.findUserByUserId(staffUserId);
      assert.ok(staffUserObj);
      staffUserObj.mustChangePassword = true;
      staffUserObj.isFirstLogin = true;
      staffUserObj.passwordChanged = false;
    });

    // Boot #2: Verify P1 & P2 rejected, P3 accepted, and reset-password clears isFirstLogin permanently
    await withPersistedServer(async (baseUrl2, store2) => {
      for (const stalePwd of ['StaffPassOne#2026', 'StaffPassTwo#2026']) {
        const cap = issueTestCaptcha(store2);
        const failRes = await requestJson(baseUrl2, 'POST', '/api/auth/login-step1-send-otp', {
          userId: staffUserId,
          password: stalePwd,
          captchaId: cap.id,
          captchaAnswer: cap.answer,
        });
        assert.equal(failRes.status, 401, `Stale password ${stalePwd} must be rejected after restart`);
      }

      const staffRestart = await loginAcrossRestart(
        baseUrl2,
        store2,
        staffUserId,
        '  StaffPassThree#2026  ',
        totpSecrets
      );
      assert.equal(staffRestart.user.userId, staffUserId);

      // Now run forgot-password -> reset-password with whitespace padding and confirm isFirstLogin clears
      const staffObj2 = store2.findUserByUserId(staffUserId);
      assert.ok(staffObj2);
      staffObj2.isFirstLogin = true;
      staffObj2.mustChangePassword = true;

      const forgotRes = await requestJson(baseUrl2, 'POST', '/api/auth/forgot-password', {
        userId: ` ${staffUserId} `,
      });
      assert.equal(forgotRes.status, 200);
      assert.equal(forgotRes.body.data.totpRequired, true);

      const missingTotpReset = await requestJson(baseUrl2, 'POST', '/api/auth/reset-password', {
        challengeId: forgotRes.body.data.challengeId,
        otp: ` ${forgotRes.body.data.sandboxOtpPreview} `,
        newPassword: '  StaffPassFour#2026  ',
        confirmPassword: '  StaffPassFour#2026  ',
      });
      assert.equal(missingTotpReset.status, 422);

      staffObj2.lastTotpStepUsed = undefined;
      const staffSecret = totpSecrets.get(staffUserId.toUpperCase());
      assert.ok(staffSecret);
      const staffResetTotp = new OTPAuth.TOTP({
        issuer: 'MUN COMPUTER',
        label: staffUserId,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(staffSecret),
      }).generate();

      const resetRes = await requestJson(baseUrl2, 'POST', '/api/auth/reset-password', {
        challengeId: forgotRes.body.data.challengeId,
        otp: ` ${forgotRes.body.data.sandboxOtpPreview} `,
        totpCode: staffResetTotp,
        newPassword: '  StaffPassFour#2026  ',
        confirmPassword: '  StaffPassFour#2026  ',
      });
      assert.equal(resetRes.status, 200);
      assert.equal(resetRes.body.data.reset, true);
    });

    // Boot #3: Confirm P4 logs in cleanly with mustChangePassword=false
    await withPersistedServer(async (baseUrl3, store3) => {
      const loginBoot3 = await loginAcrossRestart(
        baseUrl3,
        store3,
        staffUserId,
        'StaffPassFour#2026',
        totpSecrets
      );
      assert.equal(loginBoot3.user.userId, staffUserId);
      assert.equal(loginBoot3.user.mustChangePassword, false);
    });
  } finally {
    if (prevErp === undefined) delete process.env.MUN_PERSISTENCE_PATH;
    else process.env.MUN_PERSISTENCE_PATH = prevErp;
    if (prevSec === undefined) delete process.env.MUN_SECURITY_PERSISTENCE_PATH;
    else process.env.MUN_SECURITY_PERSISTENCE_PATH = prevSec;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
