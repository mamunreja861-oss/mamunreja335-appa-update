import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { SecurityStore } from '../server/securityStore.js';
import { issueTestCaptcha, performFourLayerLogin } from './testAuthHelper.js';
import {
  cleanFast2SmsApiKey,
  sendFast2SmsOtp,
  sendFast2SmsTemplateMessage,
  verifyFast2SmsApiKey,
} from '../server/fast2smsService.js';

test('Fast2SMS defaults to DLT route and sends sender_id, message=templateId, variables_values=otp, flash=0', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const calls: Array<{ url: string; body: any; headers: any }> = [];

  process.env.NODE_ENV = 'production';
  process.env.ALLOW_SANDBOX_OTP = 'false';
  process.env.FAST2SMS_API_KEY = 'test-fast2sms-key';
  process.env.FAST2SMS_SENDER_ID = 'MUNCMP';
  process.env.FAST2SMS_TEMPLATE_ID = '178901';
  delete process.env.FAST2SMS_ROUTE;

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: init?.headers,
    });
    return new Response(
      JSON.stringify({ return: true, request_id: 'req-dlt-001' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    const res = await sendFast2SmsOtp({ mobile: '+91 9876543210', otp: '482910' });
    assert.equal(res.sent, true);
    assert.equal(res.sandboxMode, false);
    assert.equal(res.routeUsed, 'dlt');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.route, 'dlt');
    assert.equal(calls[0].body.sender_id, 'MUNCMP');
    assert.equal(calls[0].body.message, '178901');
    assert.equal(calls[0].body.variables_values, '482910');
    assert.equal(calls[0].body.flash, 0);
    assert.equal(calls[0].body.numbers, '9876543210');
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test('Fast2SMS automatically falls back from otp route to dlt on website verification rejection when templateId is configured', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const routesCalled: string[] = [];

  process.env.NODE_ENV = 'production';
  process.env.ALLOW_SANDBOX_OTP = 'false';
  process.env.FAST2SMS_API_KEY = 'test-fast2sms-key';
  process.env.FAST2SMS_ROUTE = 'otp';
  process.env.FAST2SMS_SENDER_ID = 'MUNCMP';
  process.env.FAST2SMS_TEMPLATE_ID = '178901';

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = init?.body ? JSON.parse(String(init.body)) : {};
    routesCalled.push(payload.route);

    if (payload.route === 'otp') {
      return new Response(
        JSON.stringify({
          return: false,
          message:
            'Before using OTP Message API, complete website verification. Visit OTP Message menu or use DLT SMS API.',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ return: true, request_id: 'req-dlt-fallback-002' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    const res = await sendFast2SmsOtp({ mobile: '9876543210', otp: '654321' });
    assert.equal(res.sent, true);
    assert.equal(res.routeUsed, 'dlt');
    assert.deepEqual(routesCalled, ['otp', 'dlt']);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test('Fast2SMS production returns actionable DLT guidance when FAST2SMS_TEMPLATE_ID is missing', async () => {
  const originalEnv = { ...process.env };
  process.env.NODE_ENV = 'production';
  process.env.ALLOW_SANDBOX_OTP = 'false';
  process.env.FAST2SMS_API_KEY = 'test-fast2sms-key';
  process.env.FAST2SMS_SENDER_ID = 'MUNCMP';
  delete process.env.FAST2SMS_ROUTE;
  delete process.env.FAST2SMS_TEMPLATE_ID;

  try {
    const res = await sendFast2SmsOtp({ mobile: '9876543210', otp: '112233' });
    assert.equal(res.sent, false);
    assert.match(res.detail, /FAST2SMS_TEMPLATE_ID/);
  } finally {
    process.env = originalEnv;
  }
});

test('Phase03Store SMS gateway runtime config supplies encrypted secret, route, and DLT template ID', async () => {
  const { Phase03Store } = await import('../server/phase03Store.js');
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.NODE_ENV = 'production';
  process.env.ALLOW_SANDBOX_OTP = 'false';
  delete process.env.FAST2SMS_API_KEY;
  delete process.env.FAST2SMS_TEMPLATE_ID;

  const p3 = new Phase03Store();
  p3.saveIntegrationCredential('SMS', 'runtime-encrypted-key');
  const sms = p3.apiIntegrations.find((i) => i.channel === 'SMS')!;
  sms.senderOrFrom = 'MUNCMP';
  sms.smsRoute = 'dlt';
  sms.dltTemplateId = '199887';

  let capturedBody: any = null;
  let capturedAuth = '';
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
    capturedAuth = (init?.headers as Record<string, string>)?.authorization || '';
    return new Response(
      JSON.stringify({ return: true, request_id: 'req-runtime-003' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    const res = await sendFast2SmsOtp({
      mobile: '9876543210',
      otp: '778899',
      runtimeConfig: p3.getSmsGatewayConfig(),
    });
    assert.equal(res.sent, true);
    assert.equal(res.routeUsed, 'dlt');
    assert.equal(capturedAuth, 'runtime-encrypted-key');
    assert.equal(capturedBody.route, 'dlt');
    assert.equal(capturedBody.sender_id, 'MUNCMP');
    assert.equal(capturedBody.message, '199887');
    assert.equal(capturedBody.variables_values, '778899');
    assert.equal(capturedBody.flash, 0);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test('Fast2SMS cleans Bearer/quotes from API key, normalizes homepage endpoint, and surfaces real errors in dev when key is configured', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.NODE_ENV = 'development';
  delete process.env.ALLOW_SANDBOX_OTP;
  delete process.env.FAST2SMS_API_KEY;
  delete process.env.FAST2SMS_TEMPLATE_ID;

  assert.equal(cleanFast2SmsApiKey('  "Bearer abc123key"  '), 'abc123key');

  let calledUrl = '';
  let calledAuth = '';
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calledUrl = String(url);
    calledAuth = (init?.headers as Record<string, string>)?.authorization || '';
    return new Response(
      JSON.stringify({
        return: false,
        status_code: 412,
        message: 'Invalid Authentication, Check Authorization Key',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    // Missing template on default DLT route surfaces real error (not silent sandbox)
    const missingTpl = await sendFast2SmsOtp({
      mobile: '9876543210',
      otp: '112233',
      runtimeConfig: { apiKey: 'Bearer my-dev-key', route: 'dlt' },
    });
    assert.equal(missingTpl.sent, false);
    assert.equal(missingTpl.sandboxMode, false);
    assert.match(missingTpl.detail, /Quick SMS \(q\)/);

    // Quick SMS route calls normalized bulkV2 URL with cleaned key and surfaces real rejection
    const rejected = await sendFast2SmsOtp({
      mobile: '9876543210',
      otp: '112233',
      runtimeConfig: {
        apiKey: '"Bearer my-dev-key"',
        route: 'q',
        endpoint: 'https://www.fast2sms.com/',
      },
    });
    assert.equal(calledUrl, 'https://www.fast2sms.com/dev/bulkV2');
    assert.equal(calledAuth, 'my-dev-key');
    assert.equal(rejected.sent, false);
    assert.equal(rejected.sandboxMode, false);
    assert.match(rejected.detail, /Invalid Authentication/);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test('verifyFast2SmsApiKey checks wallet balance and surfaces invalid key rejections', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: string | URL | Request) => {
      assert.equal(String(url), 'https://www.fast2sms.com/dev/wallet');
      return new Response(
        JSON.stringify({ return: true, wallet: '420.50', sms_count: 2102 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const okRes = await verifyFast2SmsApiKey('Bearer valid-wallet-key');
    assert.equal(okRes.ok, true);
    assert.equal(okRes.walletBalance, 420.5);
    assert.equal(okRes.smsCount, 2102);
    assert.match(okRes.detail, /420\.50/);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ return: false, message: 'Invalid Authentication, Check Authorization Key' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;

    const failRes = await verifyFast2SmsApiKey('bad-key');
    assert.equal(failRes.ok, false);
    assert.match(failRes.detail, /Invalid Authentication/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Fast2SMS API key, Quick SMS route, and test status persist across server restarts and send real login OTP', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mun-f2s-persist-'));
  const secPath = path.join(tmpDir, 'security-state.json');
  const erpPath = path.join(tmpDir, 'erp-state.json');
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  process.env.MUN_SECURITY_PERSISTENCE_PATH = secPath;
  process.env.MUN_PERSISTENCE_PATH = erpPath;
  delete process.env.FAST2SMS_API_KEY;
  delete process.env.SMS_API_KEY;
  delete process.env.FAST2SMS_TEMPLATE_ID;
  delete process.env.FAST2SMS_ROUTE;
  delete process.env.ALLOW_SANDBOX_OTP;

  const fast2smsCalls: Array<{ url: string; auth: string; body: any }> = [];
  const realFetch = originalFetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://www.fast2sms.com/')) {
      const authHeader = (init?.headers as Record<string, string>)?.authorization || '';
      const parsedBody = init?.body ? JSON.parse(String(init.body)) : null;
      fast2smsCalls.push({ url, auth: authHeader, body: parsedBody });
      if (url.endsWith('/dev/wallet')) {
        return new Response(
          JSON.stringify({ return: true, wallet: '150.00', sms_count: 30 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({ return: true, request_id: 'req-live-q-001' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    // Boot #1: Admin logs in (sandbox mode before Fast2SMS is configured), saves Fast2SMS Quick SMS key, and tests connection
    const store1 = new SecurityStore();
    const app1 = createApp(store1, {
      enableRateLimit: false,
      enableReportScheduler: false,
      enableBackupScheduler: false,
    });
    const server1 = http.createServer(app1);
    await new Promise<void>((r) => server1.listen(0, '127.0.0.1', r));
    const base1 = `http://127.0.0.1:${(server1.address() as AddressInfo).port}`;

    try {
      const admin = await performFourLayerLogin(
        base1,
        store1,
        'MC2627110001',
        originalEnv.ADMIN_DEFAULT_PASSWORD || '8101352105'
      );

      const cookieHeader = Object.entries(admin.cookies)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('; ');

      const putRes = await realFetch(`${base1}/api/integrations/SMS`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
          'X-CSRF-Token': admin.cookies.mun_csrf,
        },
        body: JSON.stringify({
          providerName: 'Fast2SMS API Gateway',
          endpointOrHost: 'https://www.fast2sms.com/dev/bulkV2',
          senderOrFrom: 'MUNCMP',
          smsRoute: 'q',
          dltTemplateId: '',
          apiSecret: '  Bearer live-fast2sms-secret-999  ',
        }),
      });
      assert.equal(putRes.status, 200);

      const testRes = await realFetch(`${base1}/api/integrations/SMS/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
          'X-CSRF-Token': admin.cookies.mun_csrf,
        },
        body: JSON.stringify({ testMobile: '+91 8101352105' }),
      });
      assert.equal(testRes.status, 200);
      const testJson = (await testRes.json()) as any;
      assert.equal(testJson.data.lastTestStatus, 'Connected');
      assert.equal(fast2smsCalls.length, 2);
      assert.equal(fast2smsCalls[0].url, 'https://www.fast2sms.com/dev/wallet');
      assert.equal(fast2smsCalls[0].auth, 'live-fast2sms-secret-999');
      assert.equal(fast2smsCalls[1].url, 'https://www.fast2sms.com/dev/bulkV2');
      assert.equal(fast2smsCalls[1].body.route, 'q');
      assert.equal(fast2smsCalls[1].body.numbers, '8101352105');
    } finally {
      await new Promise<void>((r) => server1.close(() => r()));
    }

    // Boot #2: Fresh server & stores hydrate persisted Fast2SMS API key and dispatch live OTP on Step 1 login
    const store2 = new SecurityStore();
    const app2 = createApp(store2, {
      enableRateLimit: false,
      enableReportScheduler: false,
      enableBackupScheduler: false,
    });
    const server2 = http.createServer(app2);
    await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));
    const base2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;

    try {
      const cap = issueTestCaptcha(store2);

      const step1Res = await realFetch(`${base2}/api/auth/login-step1-send-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'MC2627110001',
          password: `${originalEnv.ADMIN_DEFAULT_PASSWORD || '8101352105'}_Rotated#26`,
          captchaId: cap.id,
          captchaAnswer: cap.answer,
        }),
      });
      assert.equal(step1Res.status, 200);
      const step1Json = (await step1Res.json()) as any;
      assert.equal(step1Json.data.providerConfigured, true);
      assert.equal(step1Json.data.deliveryStatus, 'DELIVERED');
      assert.equal(step1Json.data.sandboxOtpPreview, undefined);
      assert.equal(fast2smsCalls.length, 3);
      assert.equal(fast2smsCalls[2].auth, 'live-fast2sms-secret-999');
      assert.equal(fast2smsCalls[2].body.route, 'q');
    } finally {
      await new Promise<void>((r) => server2.close(() => r()));
    }
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Unconfigured Fast2SMS in production allows bootstrap OTP preview unless ALLOW_SANDBOX_OTP=false, and Test Connection auto-saves validated credentials', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mun-f2s-prod-'));
  const secPath = path.join(tmpDir, 'security-state.json');
  const erpPath = path.join(tmpDir, 'erp-state.json');
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  process.env.NODE_ENV = 'production';
  process.env.MUN_SECURITY_PERSISTENCE_PATH = secPath;
  process.env.MUN_PERSISTENCE_PATH = erpPath;
  delete process.env.FAST2SMS_API_KEY;
  delete process.env.SMS_API_KEY;
  delete process.env.ALLOW_SANDBOX_OTP;

  try {
    // 1. In production without any API key and without ALLOW_SANDBOX_OTP=false, bootstrap OTP works so Admin is never locked out
    const bootstrapRes = await sendFast2SmsOtp({ mobile: '9876543210', otp: '135790' });
    assert.equal(bootstrapRes.sent, true);
    assert.equal(bootstrapRes.providerConfigured, false);
    assert.equal(bootstrapRes.sandboxMode, true);
    assert.equal(bootstrapRes.sandboxOtpPreview, '135790');

    // 2. When ALLOW_SANDBOX_OTP=false is explicitly enforced, unconfigured key fails strictly
    process.env.ALLOW_SANDBOX_OTP = 'false';
    const strictRes = await sendFast2SmsOtp({ mobile: '9876543210', otp: '135790' });
    assert.equal(strictRes.sent, false);
    assert.match(strictRes.detail, /FAST2SMS_API_KEY/);

    // 3. Test Connection with a valid unsaved key auto-saves & persists it across restart
    delete process.env.ALLOW_SANDBOX_OTP;
    const realFetch = originalFetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://www.fast2sms.com/')) {
        if (url.endsWith('/dev/wallet')) {
          return new Response(
            JSON.stringify({ return: true, wallet: '250.00', sms_count: 50 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({ return: true, request_id: 'req-prod-autosave-001' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const store1 = new SecurityStore();
    const app1 = createApp(store1, {
      enableRateLimit: false,
      enableReportScheduler: false,
      enableBackupScheduler: false,
    });
    const server1 = http.createServer(app1);
    await new Promise<void>((r) => server1.listen(0, '127.0.0.1', r));
    const base1 = `http://127.0.0.1:${(server1.address() as AddressInfo).port}`;

    try {
      const admin = await performFourLayerLogin(
        base1,
        store1,
        'MC2627110001',
        originalEnv.ADMIN_DEFAULT_PASSWORD || '8101352105'
      );
      const cookieHeader = Object.entries(admin.cookies)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('; ');

      const testOnlyRes = await realFetch(`${base1}/api/integrations/SMS/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
          'X-CSRF-Token': admin.cookies.mun_csrf,
        },
        body: JSON.stringify({
          endpointOrHost: 'https://www.fast2sms.com/dev/bulkV2',
          senderOrFrom: 'MUNCMP',
          smsRoute: 'q',
          apiSecret: 'tested-only-secret-key',
          testMobile: '8101352105',
        }),
      });
      assert.equal(testOnlyRes.status, 200);
      const testOnlyJson = (await testOnlyRes.json()) as any;
      assert.equal(testOnlyJson.data.hasSecret, true);
      assert.equal(testOnlyJson.data.isConfigured, true);
      assert.equal(testOnlyJson.data.smsRoute, 'q');
    } finally {
      await new Promise<void>((r) => server1.close(() => r()));
    }

    // Boot #2 verifies the key saved by Test Connection is active for live OTP
    const store2 = new SecurityStore();
    const app2 = createApp(store2, {
      enableRateLimit: false,
      enableReportScheduler: false,
      enableBackupScheduler: false,
    });
    const server2 = http.createServer(app2);
    await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));
    const base2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;
    try {
      const cap = issueTestCaptcha(store2);
      const step1 = await realFetch(`${base2}/api/auth/login-step1-send-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'MC2627110001',
          password: `${originalEnv.ADMIN_DEFAULT_PASSWORD || '8101352105'}_Rotated#26`,
          captchaId: cap.id,
          captchaAnswer: cap.answer,
        }),
      });
      assert.equal(step1.status, 200);
      const step1Json = (await step1.json()) as any;
      assert.equal(step1Json.data.providerConfigured, true);
      assert.equal(step1Json.data.deliveryStatus, 'DELIVERED');
      assert.equal(step1Json.data.sandboxOtpPreview, undefined);
    } finally {
      await new Promise<void>((r) => server2.close(() => r()));
    }
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Server resolves VITE_FAST2SMS_API_KEY and VITE_FAST2SMS_TEMPLATE_ID fallbacks for DLT SMS dispatch', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const calls: Array<{ url: string; auth: string; body: any }> = [];

  process.env.NODE_ENV = 'production';
  process.env.ALLOW_SANDBOX_OTP = 'false';
  delete process.env.FAST2SMS_API_KEY;
  delete process.env.SMS_API_KEY;
  delete process.env.FAST2SMS_TEMPLATE_ID;
  delete process.env.FAST2SMS_ROUTE;
  process.env.VITE_FAST2SMS_API_KEY = 'vite-fallback-key-123';
  process.env.VITE_FAST2SMS_TEMPLATE_ID = '232252';

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      auth: (init?.headers as Record<string, string>)?.authorization || '',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(
      JSON.stringify({ return: true, request_id: 'req-vite-fallback-232252' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    const { Phase03Store } = await import('../server/phase03Store.js');
    const p3 = new Phase03Store();
    const cfg = p3.getSmsGatewayConfig();
    assert.equal(cfg.apiKey, 'vite-fallback-key-123');
    assert.equal(cfg.dltTemplateId, '232252');
    assert.equal(cfg.route, 'dlt');

    const res = await sendFast2SmsOtp({
      mobile: '9876543210',
      otp: '908172',
      runtimeConfig: cfg,
    });
    assert.equal(res.sent, true);
    assert.equal(res.providerConfigured, true);
    assert.equal(res.sandboxMode, false);
    assert.equal(res.routeUsed, 'dlt');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].auth, 'vite-fallback-key-123');
    assert.equal(calls[0].body.message, '232252');
    assert.equal(calls[0].body.variables_values, '908172');
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test('Sealed server Fast2SMS DLT defaults decrypt cleanly for production while preserving test-runner isolation', async () => {
  const { getDefaultFast2SmsGatewayConfig } = await import('../server/smsDefaults.js');
  const originalFetch = globalThis.fetch;

  // Test context stays isolated by default so unconfigured-sandbox tests remain deterministic
  assert.equal(getDefaultFast2SmsGatewayConfig(), null);

  // Deployed/non-test runtimes receive the pre-sealed Fast2SMS DLT credentials
  const sealed = getDefaultFast2SmsGatewayConfig({ includeInTests: true });
  assert.ok(sealed);
  assert.equal(sealed.route, 'dlt');
  assert.equal(sealed.senderId, 'MUNCMP');
  assert.equal(sealed.templateId, '232252');
  assert.ok(sealed.apiKey.length >= 20);

  const calls: Array<{ auth: string; body: any }> = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      auth: (init?.headers as Record<string, string>)?.authorization || '',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(
      JSON.stringify({ return: true, request_id: 'req-sealed-default-232252' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    const res = await sendFast2SmsOtp({
      mobile: '8101352105',
      otp: '246810',
      runtimeConfig: {
        apiKey: sealed.apiKey,
        senderId: sealed.senderId,
        route: sealed.route,
        dltTemplateId: sealed.templateId,
      },
    });
    assert.equal(res.sent, true);
    assert.equal(res.providerConfigured, true);
    assert.equal(res.sandboxMode, false);
    assert.equal(res.routeUsed, 'dlt');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].auth, sealed.apiKey);
    assert.equal(calls[0].body.route, 'dlt');
    assert.equal(calls[0].body.sender_id, 'MUNCMP');
    assert.equal(calls[0].body.message, '232252');
    assert.equal(calls[0].body.variables_values, '246810');
    assert.equal(calls[0].body.numbers, '8101352105');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('All 7 permanent Fast2SMS DLT template IDs decrypt from sealed config and route by event purpose', async () => {
  const { getDefaultFast2SmsGatewayConfig } = await import('../server/smsDefaults.js');
  const sealed = getDefaultFast2SmsGatewayConfig({ includeInTests: true });
  assert.ok(sealed);
  assert.equal(sealed.apiKey, 'sMsmEMgK9kF4AQnrWzrwPnB43Eol97TE8YpOxTKk85rZgBD1LRSer5zlnWj7');
  assert.deepEqual(sealed.templates, {
    SERVICE_REQUEST: '232328',
    LOGIN_OTP: '232252',
    ACCOUNT_REGISTRATION: '232326',
    PASSWORD_CHANGED: '232298',
    TASK_COMPLETED: '232254',
    PAYMENT_RECEIVED: '232253',
    PORTAL_LOGIN_OTP: '232252',
  });

  const originalFetch = globalThis.fetch;
  const sentPayloads: any[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sentPayloads.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(
      JSON.stringify({ return: true, request_id: `req-${sentPayloads.length}` }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    const runtime = {
      apiKey: sealed.apiKey,
      senderId: sealed.senderId,
      route: sealed.route,
      dltTemplateId: sealed.templateId,
      dltTemplates: sealed.templates,
    };

    const staffOtp = await sendFast2SmsOtp({
      mobile: '9876543210',
      otp: '112233',
      purpose: 'LOGIN_OTP',
      runtimeConfig: runtime,
    });
    assert.equal(staffOtp.sent, true);
    assert.equal(staffOtp.templateIdUsed, '232252');

    const portalOtp = await sendFast2SmsOtp({
      mobile: '9876543210',
      otp: '445566',
      purpose: 'PORTAL_LOGIN_OTP',
      runtimeConfig: runtime,
    });
    assert.equal(portalOtp.sent, true);
    assert.equal(portalOtp.templateIdUsed, '232252');

    const evtChecks: Array<{ purpose: Parameters<typeof sendFast2SmsTemplateMessage>[0]['purpose']; expectedId: string }> = [
      { purpose: 'SERVICE_REQUEST', expectedId: '232328' },
      { purpose: 'ACCOUNT_REGISTRATION', expectedId: '232326' },
      { purpose: 'PASSWORD_CHANGED', expectedId: '232298' },
      { purpose: 'TASK_COMPLETED', expectedId: '232254' },
      { purpose: 'PAYMENT_RECEIVED', expectedId: '232253' },
    ];

    for (const evt of evtChecks) {
      const res = await sendFast2SmsTemplateMessage({
        mobile: '8101352105',
        purpose: evt.purpose,
        variables: ['MCA260001', 'MUN COMPUTER'],
        fallbackText: 'Notification',
        runtimeConfig: runtime,
      });
      assert.equal(res.sent, true);
      assert.equal(res.templateIdUsed, evt.expectedId);
    }

    assert.deepEqual(
      sentPayloads.map((p) => p.message),
      ['232252', '232252', '232328', '232326', '232298', '232254', '232253']
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
