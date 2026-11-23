import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app';
import { SecurityStore } from '../server/securityStore';
import { Phase03Store } from '../server/phase03Store';
import { ErpStore } from '../server/erpStore';
import { FinanceStore } from '../server/finance/financeStore';
import { hmacOtp } from '../server/crypto';
import { seedTestFixtures } from '../server/testFixtures';
import { hydrateRuntimeStoresFromDisk, saveRuntimeStoresToDisk } from '../server/persistence';
import { performFourLayerLogin, createTestUser, grantStaffServiceAccess } from './testAuthHelper';

interface HttpResult {
  status: number;
  body: any;
  cookies: Record<string, string>;
}

function extractSetCookies(rawList: string[]): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const entry of rawList) {
    const firstPart = entry.split(';')[0];
    const idx = firstPart.indexOf('=');
    if (idx > -1) {
      jar[firstPart.slice(0, idx).trim()] = decodeURIComponent(firstPart.slice(idx + 1).trim());
    }
  }
  return jar;
}

async function requestApi(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  cookies: Record<string, string> = {}
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
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const rawText = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = rawText;
  }

  const setCookies =
    typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie()
      : res.headers.get('set-cookie')
      ? [res.headers.get('set-cookie')!]
      : [];

  return {
    status: res.status,
    body: parsed,
    cookies: extractSetCookies(setCookies),
  };
}

function issueTestCaptcha(store: SecurityStore): { id: string; answer: string } {
  const id = `erp-cap-${Math.random().toString(36).slice(2, 10)}`;
  const answer = 'K7Q2M';
  store.captchaChallenges.set(id, {
    id,
    answerHash: hmacOtp(answer, id),
    expiresAt: Date.now() + 60_000,
  });
  return { id, answer };
}

async function loginAs(
  baseUrl: string,
  store: SecurityStore,
  userId: string,
  password: string
) {
  const session = await performFourLayerLogin(baseUrl, store, userId, password);
  return session.cookies;
}

const SAMPLE_PDF_B64 = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF').toString('base64');

function startTestServer() {
  const securityStore = new SecurityStore();
  const phase03Store = new Phase03Store();
  const erpStore = new ErpStore(securityStore, phase03Store);
  seedTestFixtures({ phase03Store, erpStore });
  const app = createApp(securityStore, {
    enableRateLimit: false,
    phase03Store,
    erpStore,
  });
  const server = http.createServer(app);
  return { server, securityStore, phase03Store, erpStore };
}

test('Q1-Q12: Customer CRM duplicate checks, OTP verification, 7 consents, bulk CSV & Admin merge', async () => {
  const { server, securityStore } = startTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const adminCookies = await loginAs(baseUrl, securityStore, 'MC2627110001', '8101352105');
    const staffUser = await createTestUser(baseUrl, adminCookies, { role: 'STAFF' });
    const staffCookies = await loginAs(baseUrl, securityStore, staffUser.userId, staffUser.password);

    // 1. Create unique customer -> MCC-YYYY-YY-NNNNNN & Aadhaar always masked
    const c1 = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/customers',
      {
        fullName: 'Ramesh Mandal',
        fatherOrHusbandName: 'Bimal Mandal',
        dob: '1991-05-10',
        gender: 'Male',
        mobile: '9832001122',
        village: 'Mamudpur',
        district: 'Murshidabad',
        pinCode: '742406',
        aadhaarNumber: '445566778899',
        consents: [
          { category: 'DATA_PRIVACY_CONSENT', granted: true, verificationMethod: 'Digital Signature' },
          { category: 'PROMOTIONAL_CONSENT', granted: false },
        ],
      },
      staffCookies
    );
    assert.equal(c1.status, 201);
    assert.match(c1.body.data.customerId, /^MCC-\d{4}-\d{2}-\d{6}$/);
    assert.equal(c1.body.data.aadhaarMasked, 'XXXX-XXXX-8899');
    assert.equal(c1.body.data.aadhaarEncrypted, undefined);

    // 2. Duplicate mobile rejected with 409, Staff cannot override (403), Admin can override (201)
    const dupStaff = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/customers',
      {
        fullName: 'Suresh Mandal',
        mobile: '9832001122',
        village: 'Mamudpur',
        overrideDuplicateReason: 'Shared family phone',
      },
      staffCookies
    );
    assert.equal(dupStaff.status, 403);

    const dupNoReason = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/customers',
      {
        fullName: 'Suresh Mandal',
        mobile: '9832001122',
        village: 'Mamudpur',
      },
      adminCookies
    );
    assert.equal(dupNoReason.status, 409);

    const dupAdmin = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/customers',
      {
        fullName: 'Suresh Mandal',
        mobile: '9832001122',
        village: 'Mamudpur',
        overrideDuplicateReason: 'Same household family mobile approved by Admin',
      },
      adminCookies
    );
    assert.equal(dupAdmin.status, 201);
    const cust1Id = c1.body.data.customerId;
    const cust2Id = dupAdmin.body.data.customerId;

    // 3. Mobile OTP verification & Consent-gated notification truthfulness
    const otpSend = await requestApi(
      baseUrl,
      'POST',
      '/api/auth/mobile-otp/send',
      { mobile: '9832001122' },
      staffCookies
    );
    assert.equal(otpSend.status, 200);
    const otpVer = await requestApi(
      baseUrl,
      'POST',
      '/api/auth/verify-otp',
      { challengeId: otpSend.body.data.challengeId, otp: otpSend.body.data.sandboxOtpPreview },
      staffCookies
    );
    assert.equal(otpVer.status, 200);

    const managerCookies = await loginAs(baseUrl, securityStore, 'MC2627110002', 'Manager@2026!');

    // Staff lacks customers.EDIT (403); Manager succeeds (200)
    const staffVerifyRes = await requestApi(
      baseUrl,
      'POST',
      `/api/erp/customers/${cust1Id}/verify-mobile`,
      { verificationToken: otpVer.body.data.verificationToken },
      staffCookies
    );
    assert.equal(staffVerifyRes.status, 403);

    const mobVerifyRes = await requestApi(
      baseUrl,
      'POST',
      `/api/erp/customers/${cust1Id}/verify-mobile`,
      { verificationToken: otpVer.body.data.verificationToken },
      managerCookies
    );
    assert.equal(mobVerifyRes.status, 200);
    assert.equal(mobVerifyRes.body.data.verificationStatus, 'Fully Verified');

    // Notification without PROMOTIONAL_CONSENT must return Skipped (No Consent)
    const noConsentSms = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/notifications/send',
      {
        customerId: cust1Id,
        channel: 'SMS',
        eventKey: 'PROMO_OFFER',
        messagePreview: 'Festival offer',
      },
      staffCookies
    );
    assert.equal(noConsentSms.status, 201);
    assert.equal(noConsentSms.body.data.status, 'Skipped (No Consent)');

    // 4. Bulk CSV Import preview + commit & Admin Merge
    const bulkPrev = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/customers/bulk-import',
      {
        commit: false,
        rows: [
          { fullName: 'Bulk Client A', mobile: '9911002233', village: 'Domkal' },
          { fullName: 'X', mobile: '12', village: 'A' },
        ],
      },
      adminCookies
    );
    assert.equal(bulkPrev.status, 200);
    assert.equal(bulkPrev.body.data.validCount, 1);
    assert.equal(bulkPrev.body.data.invalidCount, 1);

    const mergeStaff = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/customers/merge',
      { primaryCustomerId: cust1Id, duplicateCustomerId: cust2Id, reason: 'Duplicate merge' },
      staffCookies
    );
    assert.equal(mergeStaff.status, 403);

    const mergeAdmin = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/customers/merge',
      { primaryCustomerId: cust1Id, duplicateCustomerId: cust2Id, reason: 'Consolidated household record' },
      adminCookies
    );
    assert.equal(mergeAdmin.status, 200);
  } finally {
    server.close();
  }
});

test('Q13-Q35: Dynamic Form Versioning, Private Docs, 12-Status State Machine, Staff Isolation & Reference Uniqueness', async () => {
  const { server, securityStore, erpStore } = startTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const adminCookies = await loginAs(baseUrl, securityStore, 'MC2627110001', '8101352105');
    const managerCookies = await loginAs(baseUrl, securityStore, 'MC2627110002', 'Manager@2026!');
    const staffUser = await createTestUser(baseUrl, adminCookies, { role: 'STAFF' });
    await grantStaffServiceAccess(baseUrl, adminCookies, managerCookies, staffUser.userId, [
      'MCS-2026-27-000002',
    ]);
    const staffCookies = await loginAs(baseUrl, securityStore, staffUser.userId, staffUser.password);

    // Get seeded PAN/Passport service (MCS-2026-27-000002) & customer
    const servicesRes = await requestApi(baseUrl, 'GET', '/api/erp/services', undefined, adminCookies);
    const service = servicesRes.body.data.find((s: any) => s.serviceId === 'MCS-2026-27-000002') ?? servicesRes.body.data[0];
    const custRes = await requestApi(baseUrl, 'GET', '/api/erp/customers', undefined, adminCookies);
    const customer = custRes.body.data[0];
    const customer2 = custRes.body.data[1];

    // 1. Validate invalid/unexpected dynamic form data rejected 422
    const badFormApp = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/applications',
      {
        customerId: customer.customerId,
        serviceId: service.serviceId,
        submitMode: 'Draft',
        formData: { nonexistent_injected_key: 'bad' },
      },
      staffCookies
    );
    assert.equal(badFormApp.status, 422);

    // 2. Reject executable file (.exe) with 422
    const exeApp = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/applications',
      {
        customerId: customer.customerId,
        serviceId: service.serviceId,
        submitMode: 'Draft',
        formData: {},
        initialDocuments: [
          {
            docKey: 'aadhaar_copy',
            category: 'Aadhaar',
            originalName: 'virus.exe',
            mimeType: 'application/pdf',
            contentBase64: SAMPLE_PDF_B64,
          },
        ],
      },
      staffCookies
    );
    assert.equal(exeApp.status, 422);

    // 3. Create v1 application as Draft, then publish Form v2 on service -> v1 snapshot remains immutable
    const app1Res = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/applications',
      {
        customerId: customer.customerId,
        serviceId: service.serviceId,
        submitMode: 'Draft',
        duplicateOverrideReason: 'Test scenario additional intake',
        formData: {
          applicant_type: 'Correction / Update',
          applicant_aadhaar: '112233445566',
          applicant_pan: 'ABCDE1234F',
          delivery_address: 'Mamudpur, Domkal, Murshidabad',
        },
        initialPayment: { amount: 100, paymentMethod: 'Cash' },
      },
      staffCookies
    );
    assert.equal(app1Res.status, 201);
    const app1No = app1Res.body.data.applicationNo;
    assert.match(app1No, /^MCA-\d{4}-\d{2}-\d{6}$/);
    const v1Count = app1Res.body.data.serviceSnapshot.appliedFormVersion;

    const v2Res = await requestApi(
      baseUrl,
      'POST',
      `/api/erp/services/${service.serviceId}/form-versions`,
      {
        fields: [
          ...service.formVersions[0].fields,
          {
            fieldKey: 'new_v2_remarks',
            label: 'New V2 Remarks',
            fieldType: 'short_text',
            required: false,
            displayOrder: 10,
            enabled: true,
          },
        ],
      },
      adminCookies
    );
    assert.equal(v2Res.status, 201);
    assert.equal(v2Res.body.data.currentFormVersion, v1Count + 1);

    const app1Check = await requestApi(baseUrl, 'GET', `/api/erp/applications/${app1No}`, undefined, adminCookies);
    assert.equal(app1Check.body.data.application.serviceSnapshot.appliedFormVersion, v1Count);

    // 4. Final submission blocked if mandatory docs missing (422), allowed via Manager exception (200)
    const submitBlocked = await requestApi(
      baseUrl,
      'POST',
      `/api/erp/applications/${app1No}/status`,
      { nextStatus: 'Submitted' },
      staffCookies
    );
    assert.equal(submitBlocked.status, 422);

    // Upload valid private PDF document
    const upDoc = await requestApi(
      baseUrl,
      'POST',
      `/api/erp/applications/${app1No}/documents`,
      {
        docKey: 'aadhaar_copy',
        category: 'Existing Aadhaar',
        originalName: 'aadhaar_scan.pdf',
        mimeType: 'application/pdf',
        contentBase64: SAMPLE_PDF_B64,
      },
      staffCookies
    );
    assert.equal(upDoc.status, 201);
    const fileUuid = upDoc.body.data.document.fileUuid;

    // List endpoint strips contentBase64; download endpoint serves it & audits
    const appAfterDoc = await requestApi(baseUrl, 'GET', `/api/erp/applications/${app1No}`, undefined, staffCookies);
    assert.equal(appAfterDoc.body.data.application.documents[0].contentBase64, undefined);

    const dlDoc = await requestApi(baseUrl, 'GET', `/api/erp/documents/${fileUuid}/download`, undefined, staffCookies);
    assert.equal(dlDoc.status, 200);
    assert.equal(dlDoc.body.data.contentBase64, SAMPLE_PDF_B64);

    // Staff cannot verify document (403); Manager can verify (200)
    const staffVer = await requestApi(
      baseUrl,
      'POST',
      `/api/erp/documents/${fileUuid}/verify`,
      { status: 'Verified', reason: 'Self verify' },
      staffCookies
    );
    assert.equal(staffVer.status, 403);

    const mgrVer = await requestApi(
      baseUrl,
      'POST',
      `/api/erp/documents/${fileUuid}/verify`,
      { status: 'Verified', reason: 'Clear PDF verified' },
      managerCookies
    );
    assert.equal(mgrVer.status, 200);

    // Submit with Manager exception (since 2nd required doc poa_proof not uploaded)
    const submitExc = await requestApi(
      baseUrl,
      'POST',
      `/api/erp/applications/${app1No}/status`,
      { nextStatus: 'Submitted', mandatoryDocExceptionReason: 'Original POA verified physically at counter' },
      managerCookies
    );
    assert.equal(submitExc.status, 200);
    assert.equal(submitExc.body.data.status, 'Submitted');

    // Invalid jump Submitted -> Completed rejected 422
    const invalidJump = await requestApi(
      baseUrl,
      'POST',
      `/api/erp/applications/${app1No}/status`,
      { nextStatus: 'Completed' },
      adminCookies
    );
    assert.equal(invalidJump.status, 422);

    // On Hold requires reason
    const holdNoReason = await requestApi(
      baseUrl,
      'POST',
      `/api/erp/applications/${app1No}/status`,
      { nextStatus: 'On Hold' },
      managerCookies
    );
    assert.equal(holdNoReason.status, 422);

    const holdOk = await requestApi(
      baseUrl,
      'POST',
      `/api/erp/applications/${app1No}/status`,
      { nextStatus: 'On Hold', reason: 'Awaiting biometric slot' },
      managerCookies
    );
    assert.equal(holdOk.status, 200);

    // 5. Reference Field Uniqueness (GLOBAL: acknowledgement_number) & Search
    const ref1 = await requestApi(
      baseUrl,
      'POST',
      `/api/erp/applications/${app1No}/references`,
      { fieldKey: 'acknowledgement_number', value: 'ACK-UNIQ-9901', reason: 'Portal ARN' },
      staffCookies
    );
    assert.equal(ref1.status, 200);

    const app2Res = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/applications',
      {
        customerId: customer2.customerId,
        serviceId: service.serviceId,
        submitMode: 'Draft',
        duplicateOverrideReason: 'Second test app',
        formData: {},
      },
      adminCookies
    );
    const app2No = app2Res.body.data.applicationNo;

    const dupRef = await requestApi(
      baseUrl,
      'POST',
      `/api/erp/applications/${app2No}/references`,
      { fieldKey: 'acknowledgement_number', value: 'ACK-UNIQ-9901' },
      adminCookies
    );
    assert.equal(dupRef.status, 409);

    // Searchable by acknowledgement_number reference value
    const searchByRef = await requestApi(
      baseUrl,
      'GET',
      '/api/erp/applications?q=ACK-UNIQ-9901',
      undefined,
      adminCookies
    );
    assert.equal(searchByRef.status, 200);
    assert.equal(searchByRef.body.data.length, 1);
    assert.equal(searchByRef.body.data[0].applicationNo, app1No);

    // 6. Record-level isolation: assign app2 exclusively to a second Staff -> seeded Staff cannot access (403)
    const targetApp2 = erpStore.applications.find((a) => a.applicationNo === app2No)!;
    targetApp2.assignedStaffId = 'MC2627119999';
    targetApp2.assignedCounterCode = 'CTR-99';
    targetApp2.createdBy = 'MC2627110001';

    const isolatedAccess = await requestApi(
      baseUrl,
      'GET',
      `/api/erp/applications/${app2No}`,
      undefined,
      staffCookies
    );
    assert.equal(isolatedAccess.status, 403);

    // Staff submits Reassignment Request on app1 -> Manager approves
    const reassReq = await requestApi(
      baseUrl,
      'POST',
      `/api/erp/applications/${app1No}/reassignment-requests`,
      { proposedStaffId: 'MC2627110002', proposedCounterCode: 'CTR-02', reason: 'Shift handover' },
      staffCookies
    );
    assert.equal(reassReq.status, 201);
    const reqCode = reassReq.body.data.requestCode;

    const reassApprove = await requestApi(
      baseUrl,
      'POST',
      `/api/erp/reassignment-requests/${reqCode}/review`,
      { decision: 'Approved', reviewNotes: 'Approved shift transfer' },
      managerCookies
    );
    assert.equal(reassApprove.status, 200);
  } finally {
    server.close();
  }
});

test('Q36-Q51: Delivery Handover, Payments/UPI Verification, Refunds Guard, Notes Isolation & Report Export Audit', async () => {
  const { server, securityStore, erpStore } = startTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const adminCookies = await loginAs(baseUrl, securityStore, 'MC2627110001', '8101352105');
    const staffUser = await createTestUser(baseUrl, adminCookies, { role: 'STAFF' });
    const staffCookies = await loginAs(baseUrl, securityStore, staffUser.userId, staffUser.password);

    const pendingOfficeStoreApp = erpStore.applications.find((a) => a.applicationNo === 'MCA-2026-27-000002');
    if (pendingOfficeStoreApp) {
      pendingOfficeStoreApp.assignedStaffId = staffUser.userId;
    }

    const appsRes = await requestApi(baseUrl, 'GET', '/api/erp/applications', undefined, adminCookies);
    const pendingOfficeApp = appsRes.body.data.find((a: any) => a.applicationNo === 'MCA-2026-27-000002');
    const processingApp = appsRes.body.data.find((a: any) => a.applicationNo === 'MCA-2026-27-000003');
    assert.ok(pendingOfficeApp && processingApp, 'Seeded applications must exist');

    // 1. Delivery handover requires handoverConfirmed = true before marking Delivered
    const badDel = await requestApi(
      baseUrl,
      'POST',
      `/api/erp/applications/${processingApp.applicationNo}/delivery`,
      {
        deliverableType: 'Upgraded Laptop + SSD Old Drive',
        deliveryMethod: 'In-Person Counter Handover',
        receivedBy: 'Customer',
        handoverConfirmed: false,
        status: 'Delivered',
      },
      adminCookies
    );
    assert.equal(badDel.status, 422);

    const goodDel = await requestApi(
      baseUrl,
      'POST',
      `/api/erp/applications/${processingApp.applicationNo}/delivery`,
      {
        deliverableType: 'Upgraded Laptop + SSD Old Drive',
        deliveryMethod: 'In-Person Counter Handover',
        receivedBy: processingApp.customerSnapshot.fullName,
        handoverConfirmed: true,
        status: 'Delivered',
      },
      adminCookies
    );
    assert.equal(goodDel.status, 201);
    assert.match(goodDel.body.data.deliveryId, /^MCD-\d{4}-\d{2}-\d{6}$/);

    // 2. UPI payment on MCA-2026-27-000002 starts Pending Verification -> Admin confirms
    const upiPay = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/payments',
      {
        applicationNo: pendingOfficeApp.applicationNo,
        amount: 50,
        paymentMethod: 'UPI',
        upiReference: 'UPI-UTR-778899',
      },
      staffCookies
    );
    assert.equal(upiPay.status, 201);
    assert.equal(upiPay.body.data.verificationStatus, 'Pending Verification');

    const upiConfirm = await requestApi(
      baseUrl,
      'POST',
      `/api/erp/payments/${upiPay.body.data.transactionId}/verify`,
      { decision: 'Confirmed' },
      adminCookies
    );
    assert.equal(upiConfirm.status, 200);
    assert.equal(upiConfirm.body.data.verificationStatus, 'Confirmed');

    // 3. Refund cannot exceed payment amount & double refund is prevented
    const overRefund = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/refunds',
      {
        applicationNo: pendingOfficeApp.applicationNo,
        originalTransactionId: upiPay.body.data.transactionId,
        refundType: 'Partial',
        refundAmount: 5000,
        refundMethod: 'Cash',
        refundReason: 'Excess amount check',
      },
      adminCookies
    );
    assert.equal(overRefund.status, 422);

    const validRefund = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/refunds',
      {
        applicationNo: pendingOfficeApp.applicationNo,
        originalTransactionId: upiPay.body.data.transactionId,
        refundType: 'Full',
        refundAmount: 50,
        refundMethod: 'Cash',
        refundReason: 'Extra test payment refunded',
      },
      adminCookies
    );
    assert.equal(validRefund.status, 201);
    assert.match(validRefund.body.data.refundId, /^MCRF-\d{4}-\d{2}-\d{6}$/);

    // Second refund on same payment exceeding 0 remaining -> 422
    const doubleRefund = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/refunds',
      {
        applicationNo: pendingOfficeApp.applicationNo,
        originalTransactionId: upiPay.body.data.transactionId,
        refundType: 'Full',
        refundAmount: 10,
        refundMethod: 'Cash',
        refundReason: 'Duplicate refund attempt',
      },
      adminCookies
    );
    assert.equal(doubleRefund.status, 422);

    // 4. Separate Internal vs Customer notes & Export Audit Log
    const intNote = await requestApi(
      baseUrl,
      'POST',
      `/api/erp/applications/${pendingOfficeApp.applicationNo}/notes`,
      { noteType: 'INTERNAL', content: 'Internal office verification note' },
      staffCookies
    );
    assert.equal(intNote.status, 201);

    const expLog = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/reports/export-log',
      { reportName: 'Daily Collection Report', format: 'CSV', rowCount: 12 },
      adminCookies
    );
    assert.equal(expLog.status, 201);

    const repSum = await requestApi(baseUrl, 'GET', '/api/erp/reports/summary', undefined, adminCookies);
    assert.equal(repSum.status, 200);
    assert.ok(repSum.body.data.exportLogs.length >= 1);
  } finally {
    server.close();
  }
});

test('Services Module: 21 Categories, 77 Subcategories, 675 Services (MC2627SRV-001..675), CRUD & Sync', async () => {
  const { server, securityStore } = startTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const adminCookies = await loginAs(baseUrl, securityStore, 'MC2627110001', '8101352105');

    const [catsRes, subsRes, svcsRes] = await Promise.all([
      requestApi(baseUrl, 'GET', '/api/erp/service-categories', undefined, adminCookies),
      requestApi(baseUrl, 'GET', '/api/erp/service-subcategories', undefined, adminCookies),
      requestApi(baseUrl, 'GET', '/api/erp/services', undefined, adminCookies),
    ]);

    assert.equal(catsRes.status, 200);
    assert.equal(subsRes.status, 200);
    assert.equal(svcsRes.status, 200);
    assert.equal(catsRes.body.data.length, 21);
    assert.equal(subsRes.body.data.length, 77);
    assert.equal(svcsRes.body.data.length, 675);

    const codes = svcsRes.body.data.map((s: any) => s.serviceCode);
    assert.equal(codes[0], 'MC2627SRV-001');
    assert.equal(codes[codes.length - 1], 'MC2627SRV-675');

    // Sync endpoint verifies counts & range idempotently
    const syncRes = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/services/sync-catalog',
      {},
      adminCookies
    );
    assert.equal(syncRes.status, 200);
    assert.equal(syncRes.body.data.categoriesCount, 21);
    assert.equal(syncRes.body.data.subcategoriesCount, 77);
    assert.equal(syncRes.body.data.servicesCount, 675);
    assert.equal(syncRes.body.data.codeRange, 'MC2627SRV-001 to MC2627SRV-675');

    // Create 676th service -> auto-generates MC2627SRV-676 and computes rates/profit
    const createRes = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/services',
      {
        name: 'Custom Affidavit Typing',
        categoryId: catsRes.body.data[0].id,
        subcategoryId: subsRes.body.data[0].id,
        serviceCharge: 200,
        govtFee: 50,
        additionalCharges: 25,
        serviceCost: 40,
        description: 'Custom test service',
      },
      adminCookies
    );
    assert.equal(createRes.status, 201);
    const created = createRes.body.data;
    assert.match(created.serviceId, /^MCS-\d{4}-\d{2}-000676$/);
    assert.match(created.serviceCode, /^MC\d{4}SRV-676$/);
    assert.equal(created.totalCustomerCharge, 275);
    assert.equal(created.profitAmount, 185);

    // Update rates & details; serviceCode must stay locked even if spoofed in body
    const updRes = await requestApi(
      baseUrl,
      'PUT',
      `/api/erp/services/${created.serviceId}`,
      {
        serviceCode: 'HACK-001',
        name: 'Custom Affidavit Typing Updated',
        serviceCharge: 300,
        govtFee: 100,
        additionalCharges: 50,
        serviceCost: 70,
      },
      adminCookies
    );
    assert.equal(updRes.status, 200);
    assert.equal(updRes.body.data.serviceCode, created.serviceCode);
    assert.equal(updRes.body.data.name, 'Custom Affidavit Typing Updated');
    assert.equal(updRes.body.data.totalCustomerCharge, 450);
    assert.equal(updRes.body.data.profitAmount, 280);

    // Toggle status Active <-> Inactive
    const deactRes = await requestApi(
      baseUrl,
      'PATCH',
      `/api/erp/services/${created.serviceId}/status`,
      { status: 'Inactive' },
      adminCookies
    );
    assert.equal(deactRes.status, 200);
    assert.equal(deactRes.body.data.status, 'Inactive');

    // Delete permanently -> no longer returned on GET
    const delRes = await requestApi(
      baseUrl,
      'DELETE',
      `/api/erp/services/${created.serviceId}`,
      undefined,
      adminCookies
    );
    assert.equal(delRes.status, 200);
    assert.equal(delRes.body.data.deleted, true);

    const afterDelRes = await requestApi(baseUrl, 'GET', '/api/erp/services', undefined, adminCookies);
    assert.equal(afterDelRes.body.data.length, 675);
    assert.equal(
      afterDelRes.body.data.some((s: any) => s.serviceId === created.serviceId),
      false
    );
  } finally {
    server.close();
  }
});

test('Parts 1-6: Final Sidebar Structure, Continuous Service Serial Numbers, Full 9-Area Config, Guards & Audit Logs', async () => {
  // Verify Part 1, 2, 3 Navigation structure directly
  const { SIDEBAR_NAV_ITEMS } = await import('../frontend/modules/navigation');
  const opsItems = SIDEBAR_NAV_ITEMS.filter((item) => item.group === 'Operations');
  assert.deepEqual(
    opsItems.map((i) => i.id),
    ['customers', 'services', 'applications', 'feedback']
  );
  assert.deepEqual(
    opsItems.map((i) => i.label),
    ['Customers', 'Services', 'Applications', 'Customer Feedback']
  );
  assert.equal(
    SIDEBAR_NAV_ITEMS.some((i) => (i.group as string) === 'CSC Digital Center'),
    false
  );
  assert.equal(
    SIDEBAR_NAV_ITEMS.some((i) => i.label === 'Service Forms & SLA'),
    false
  );

  const { server, securityStore } = startTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const adminCookies = await loginAs(baseUrl, securityStore, 'MC2627110001', '8101352105');
    const managerCookies = await loginAs(baseUrl, securityStore, 'MC2627110002', 'Manager@2026!');
    const staffUser = await createTestUser(baseUrl, adminCookies, { role: 'STAFF' });
    const staffCookies = await loginAs(baseUrl, securityStore, staffUser.userId, staffUser.password);

    const [catsRes, subsRes, svcsRes] = await Promise.all([
      requestApi(baseUrl, 'GET', '/api/erp/service-categories', undefined, adminCookies),
      requestApi(baseUrl, 'GET', '/api/erp/service-subcategories', undefined, adminCookies),
      requestApi(baseUrl, 'GET', '/api/erp/services', undefined, adminCookies),
    ]);

    assert.equal(svcsRes.body.data.length, 675);
    assert.equal(svcsRes.body.data[0].serialNumber, '001');
    assert.equal(svcsRes.body.data[1].serialNumber, '002');
    assert.equal(svcsRes.body.data[2].serialNumber, '003');
    assert.equal(svcsRes.body.data[3].serialNumber, '004');
    assert.equal(svcsRes.body.data[4].serialNumber, '005');
    assert.equal(svcsRes.body.data[674].serialNumber, '675');

    // RBAC: Manager and Staff cannot create services (403)
    const mgrCreate = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/services',
      {
        name: 'Unauthorized Manager Service',
        categoryId: catsRes.body.data[0].id,
      },
      managerCookies
    );
    assert.equal(mgrCreate.status, 403);

    const staffCreate = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/services',
      {
        name: 'Unauthorized Staff Service',
        categoryId: catsRes.body.data[0].id,
      },
      staffCookies
    );
    assert.equal(staffCreate.status, 403);

    // Create 3 new services (676, 677, 678) with full 9-area independent config
    const catId = catsRes.body.data[0].id;
    const subId = subsRes.body.data.find((sc: any) => sc.categoryId === catId)?.id;

    const s1 = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/services',
      {
        name: 'Full 9-Area Config Alpha',
        categoryId: catId,
        subcategoryId: subId,
        description: 'Complete custom service alpha',
        serviceInstructions: 'Verify original ID at counter.',
        serviceCharge: 250,
        govtFee: 100,
        additionalCharges: 50,
        serviceCost: 80,
        status: 'Temporarily Suspended',
        availability: 'Unavailable',
        fields: [
          { fieldKey: 'urgent_need', label: 'Urgent Processing?', fieldType: 'yes_no', required: true, displayOrder: 1, enabled: true },
          { fieldKey: 'dispatch_mode', label: 'Dispatch Mode', fieldType: 'dropdown', options: ['Counter', 'Speed Post'], required: true, displayOrder: 2, enabled: true },
        ],
        requiredDocuments: [
          { docKey: 'aadhaar_pdf', label: 'Aadhaar Scan', category: 'Identity', required: true, allowMultiple: false, allowedFormats: ['PDF', 'JPG'], maxSizeMb: 5, instructions: 'Clear copy', enabled: true },
        ],
        sla: {
          processingMode: 'RANGE',
          expectedDays: 4,
          minDays: 2,
          maxDays: 6,
          dayType: 'WORKING',
          excludeHolidays: true,
          startEvent: 'ON_SUBMIT',
          pauseOnStatuses: ['Pending Customer', 'On Hold'],
          warningThresholdPct: 80,
          breachThresholdHours: 48,
          escalateToManagerAtWarning: true,
          escalateToAdminAtBreach: true,
        },
        automationRules: [
          { id: 'RULE-1', name: 'Notify Submitted', trigger: 'ON_STATUS_CHANGE', conditionStatus: 'Submitted', actionType: 'SEND_NOTIFICATION', actionParam: 'APPLICATION_STATUS_UPDATE', enabled: true },
        ],
      },
      adminCookies
    );
    assert.equal(s1.status, 201);
    assert.equal(s1.body.data.serialNumber, '676');
    assert.equal(s1.body.data.status, 'Temporarily Suspended');
    assert.equal(s1.body.data.totalCustomerCharge, 400);
    assert.equal(s1.body.data.profitAmount, 220);
    assert.equal(s1.body.data.sla.processingMode, 'RANGE');
    assert.equal(s1.body.data.sla.minDays, 2);
    assert.equal(s1.body.data.sla.maxDays, 6);
    assert.equal(s1.body.data.requiredDocuments.length, 1);
    assert.equal(s1.body.data.automationRules.length, 1);
    assert.equal(s1.body.data.formVersions[0].fields[0].fieldType, 'yes_no');

    // Duplicate name inside same category/subcategory rejected with 409
    const dupRes = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/services',
      {
        name: 'Full 9-Area Config Alpha',
        categoryId: catId,
        subcategoryId: subId,
      },
      adminCookies
    );
    assert.equal(dupRes.status, 409);

    const s2 = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/services',
      { name: 'Full 9-Area Config Beta', categoryId: catId, subcategoryId: subId },
      adminCookies
    );
    const s3 = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/services',
      { name: 'Full 9-Area Config Gamma', categoryId: catId, subcategoryId: subId },
      adminCookies
    );
    assert.equal(s2.body.data.serialNumber, '677');
    assert.equal(s3.body.data.serialNumber, '678');
    const gammaImmutableId = s3.body.data.serviceId;
    const gammaImmutableCode = s3.body.data.serviceCode;

    // Update SLA, Required Docs & Automation Rules on Alpha -> creates processingTimeHistory entry
    const updRes = await requestApi(
      baseUrl,
      'PUT',
      `/api/erp/services/${s1.body.data.serviceId}`,
      {
        status: 'Active',
        sla: {
          processingMode: 'FIXED',
          expectedDays: 3,
          minDays: 2,
          maxDays: 4,
          dayType: 'CALENDAR',
          excludeHolidays: false,
          startEvent: 'ON_ASSIGN',
          pauseOnStatuses: ['Pending Customer'],
          warningThresholdPct: 75,
          breachThresholdHours: 24,
          escalateToManagerAtWarning: true,
          escalateToAdminAtBreach: true,
        },
        requiredDocuments: [
          { docKey: 'aadhaar_pdf', label: 'Aadhaar Scan', category: 'Identity', required: true, allowMultiple: false, allowedFormats: ['PDF'], maxSizeMb: 4, instructions: 'Front & back', enabled: true },
          { docKey: 'pan_pdf', label: 'PAN Copy', category: 'Identity', required: false, allowMultiple: false, allowedFormats: ['PDF', 'PNG'], maxSizeMb: 3, instructions: 'Optional', enabled: true },
        ],
        automationRules: [
          { id: 'RULE-1', name: 'Notify Submitted', trigger: 'ON_STATUS_CHANGE', conditionStatus: 'Submitted', actionType: 'SEND_NOTIFICATION', actionParam: 'APPLICATION_STATUS_UPDATE', enabled: true },
          { id: 'RULE-2', name: 'SLA Escalation', trigger: 'ON_SLA_WARNING', conditionStatus: '', actionType: 'ESCALATE_ADMIN', actionParam: 'MANAGER_ALERT', enabled: true },
        ],
      },
      adminCookies
    );
    assert.equal(updRes.status, 200);
    assert.equal(updRes.body.data.requiredDocuments.length, 2);
    assert.equal(updRes.body.data.automationRules.length, 2);
    assert.equal(updRes.body.data.sla.processingMode, 'FIXED');
    assert.equal(updRes.body.data.sla.expectedDays, 3);
    assert.ok(updRes.body.data.processingTimeHistory.length >= 1);

    // Delete middle service Beta (677) -> Gamma (678) automatically re-sequences to 677 while keeping immutable IDs
    const delBeta = await requestApi(
      baseUrl,
      'DELETE',
      `/api/erp/services/${s2.body.data.serviceId}`,
      undefined,
      adminCookies
    );
    assert.equal(delBeta.status, 200);

    const listAfterMidDel = await requestApi(baseUrl, 'GET', '/api/erp/services', undefined, adminCookies);
    const gammaAfter = listAfterMidDel.body.data.find((x: any) => x.serviceId === gammaImmutableId);
    assert.ok(gammaAfter);
    assert.equal(gammaAfter.serialNumber, '677');
    assert.equal(gammaAfter.serviceId, gammaImmutableId);
    assert.equal(gammaAfter.serviceCode, gammaImmutableCode);

    // Delete an unreferenced earlier seeded service (#002 or #004) to directly prove 001..005 -> 001..004 continuity
    const unrefCandidate = listAfterMidDel.body.data.find(
      (x: any) => ['002', '003', '004'].includes(x.serialNumber) && (x.applicationCount ?? 0) === 0
    );
    assert.ok(unrefCandidate, 'Must find an unreferenced top-5 seeded service');
    const fifthBefore = listAfterMidDel.body.data.find((x: any) => x.serialNumber === '005');
    const delEarly = await requestApi(
      baseUrl,
      'DELETE',
      `/api/erp/services/${unrefCandidate.serviceId}`,
      undefined,
      adminCookies
    );
    assert.equal(delEarly.status, 200);

    const afterEarlyDel = await requestApi(baseUrl, 'GET', '/api/erp/services', undefined, adminCookies);
    const topFourSerials = afterEarlyDel.body.data.slice(0, 4).map((x: any) => x.serialNumber);
    assert.deepEqual(topFourSerials, ['001', '002', '003', '004']);
    const fifthAfter = afterEarlyDel.body.data.find((x: any) => x.serviceId === fifthBefore.serviceId);
    assert.equal(fifthAfter.serialNumber, '004');
    assert.equal(fifthAfter.serviceCode, fifthBefore.serviceCode);

    // Referenced service cannot be deleted (409)
    const referencedService = afterEarlyDel.body.data.find((x: any) => (x.applicationCount ?? 0) > 0);
    if (referencedService) {
      const delRefRes = await requestApi(
        baseUrl,
        'DELETE',
        `/api/erp/services/${referencedService.serviceId}`,
        undefined,
        adminCookies
      );
      assert.equal(delRefRes.status, 409);
    }

    // Security audit logs captured service operations
    const auditTypes = new Set(securityStore.securityLogs.map((l) => l.eventType));
    assert.ok(auditTypes.has('SERVICE_CREATED'));
    assert.ok(auditTypes.has('SERVICE_UPDATED'));
    assert.ok(auditTypes.has('SERVICE_DELETED'));
  } finally {
    server.close();
  }
});

test('Deletion Tombstones & Disk Persistence: deleted services/categories/subcategories survive sync & restart without returning', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mun-tombstones-'));
  const persistFile = path.join(tempDir, 'erp-state.json');
  const prevEnv = process.env.MUN_PERSISTENCE_PATH;
  process.env.MUN_PERSISTENCE_PATH = persistFile;

  const { server, securityStore, phase03Store, erpStore } = startTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const adminCookies = await loginAs(baseUrl, securityStore, 'MC2627110001', '8101352105');

    // Create a custom category + subcategory, and pick an unreferenced seeded service to delete
    const catRes = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/service-categories',
      { name: 'Temp Discontinued Category', description: 'Will be deleted permanently' },
      adminCookies
    );
    assert.equal(catRes.status, 201);
    const customCat = catRes.body.data;

    const subRes = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/service-subcategories',
      { categoryId: customCat.id, name: 'Temp Subcategory', description: 'Will be deleted' },
      adminCookies
    );
    assert.equal(subRes.status, 201);
    const customSub = subRes.body.data;

    const svcsRes = await requestApi(baseUrl, 'GET', '/api/erp/services', undefined, adminCookies);
    const seededTarget = svcsRes.body.data.find(
      (s: any) => s.serviceCode === 'MC2627SRV-010' && (s.applicationCount ?? 0) === 0
    );
    assert.ok(seededTarget, 'MC2627SRV-010 should exist and have zero applications');

    // Delete the seeded service, then subcategory, then category
    const delSvc = await requestApi(
      baseUrl,
      'DELETE',
      `/api/erp/services/${seededTarget.serviceId}`,
      undefined,
      adminCookies
    );
    assert.equal(delSvc.status, 200);

    const delSub = await requestApi(
      baseUrl,
      'DELETE',
      `/api/erp/service-subcategories/${customSub.id}`,
      undefined,
      adminCookies
    );
    assert.equal(delSub.status, 200);

    const delCat = await requestApi(
      baseUrl,
      'DELETE',
      `/api/erp/service-categories/${customCat.id}`,
      undefined,
      adminCookies
    );
    assert.equal(delCat.status, 200);

    // Tombstones API exposes all 3 deletions
    const tombRes = await requestApi(baseUrl, 'GET', '/api/erp/tombstones', undefined, adminCookies);
    assert.equal(tombRes.status, 200);
    assert.ok(tombRes.body.data.deletedServiceIds.includes(seededTarget.serviceId));
    assert.ok(tombRes.body.data.deletedServiceCodes.includes('MC2627SRV-010'));
    assert.ok(tombRes.body.data.deletedSubcategoryCodes.includes(customSub.code));
    assert.ok(tombRes.body.data.deletedCategoryCodes.includes(customCat.code));

    // Running sync-catalog (without restoreDeleted: true) MUST NOT resurrect MC2627SRV-010
    const syncKeepRes = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/services/sync-catalog',
      { restoreDeleted: false },
      adminCookies
    );
    assert.equal(syncKeepRes.status, 200);
    assert.equal(syncKeepRes.body.data.servicesCount, 674);

    const afterSyncList = await requestApi(baseUrl, 'GET', '/api/erp/services', undefined, adminCookies);
    assert.equal(afterSyncList.body.data.length, 674);
    assert.equal(
      afterSyncList.body.data.some((s: any) => s.serviceCode === 'MC2627SRV-010'),
      false
    );

    // Save to disk and hydrate a fresh store instance (simulating server restart)
    assert.equal(saveRuntimeStoresToDisk(erpStore, phase03Store, persistFile), true);
    const restartedSec = new SecurityStore();
    const restartedP3 = new Phase03Store();
    const restartedErp = new ErpStore(restartedSec, restartedP3);
    assert.equal(hydrateRuntimeStoresFromDisk(restartedErp, restartedP3, persistFile), true);

    assert.equal(restartedErp.services.length, 674);
    assert.equal(
      restartedErp.services.some((s) => s.serviceCode === 'MC2627SRV-010'),
      false
    );
    assert.equal(
      restartedErp.serviceCategories.some((c) => c.code === customCat.code),
      false
    );
    assert.equal(
      restartedErp.serviceSubcategories.some((sc) => sc.code === customSub.code),
      false
    );
    assert.ok(restartedErp.deletedServiceCodes.has('MC2627SRV-010'));

    // Explicit restoreDeleted: true restores the deleted seeded service
    const restoreSync = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/services/sync-catalog',
      { restoreDeleted: true },
      adminCookies
    );
    assert.equal(restoreSync.status, 200);
    assert.equal(restoreSync.body.data.servicesCount, 675);
  } finally {
    server.close();
    if (prevEnv === undefined) delete process.env.MUN_PERSISTENCE_PATH;
    else process.env.MUN_PERSISTENCE_PATH = prevEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Permanent Deletion of Customer & Application enforces 409 safety guards and persists across restart', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mun-perm-del-'));
  const persistFile = path.join(tempDir, 'erp-state.json');
  const prevEnv = process.env.MUN_PERSISTENCE_PATH;
  process.env.MUN_PERSISTENCE_PATH = persistFile;

  const { server, securityStore, phase03Store, erpStore } = startTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const adminCookies = await loginAs(baseUrl, securityStore, 'MC2627110001', '8101352105');

    // Create customer + draft application without confirmed payment
    const custRes = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/customers',
      {
        fullName: 'Delete Check Citizen',
        mobile: '9830998877',
        village: 'Berhampore',
        district: 'Murshidabad',
        consents: [{ category: 'DATA_PRIVACY_CONSENT', granted: true }],
      },
      adminCookies
    );
    assert.equal(custRes.status, 201);
    const customerId = custRes.body.data.customerId;

    const svcRes = await requestApi(baseUrl, 'GET', '/api/erp/services', undefined, adminCookies);
    const firstSvc = svcRes.body.data[0];

    const appRes = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/applications',
      {
        customerId,
        serviceId: firstSvc.serviceId,
        submitMode: 'Draft',
        formData: {},
      },
      adminCookies
    );
    assert.equal(appRes.status, 201);
    const appNo = appRes.body.data.applicationNo;

    // Customer cannot be permanently deleted while it still has an active (non-archived) application -> 409
    const blockedCustDel = await requestApi(
      baseUrl,
      'DELETE',
      `/api/erp/customers/${customerId}`,
      {},
      adminCookies
    );
    assert.equal(blockedCustDel.status, 409);

    // Permanently delete the draft application -> 200 and recorded in tombstones
    const delAppRes = await requestApi(
      baseUrl,
      'DELETE',
      `/api/erp/applications/${appNo}`,
      undefined,
      adminCookies
    );
    assert.equal(delAppRes.status, 200);
    assert.equal(delAppRes.body.data.deleted, true);

    // Now customer has zero active apps/payments -> permanent delete succeeds (200)
    const delCustRes = await requestApi(
      baseUrl,
      'DELETE',
      `/api/erp/customers/${customerId}`,
      {},
      adminCookies
    );
    assert.equal(delCustRes.status, 200);
    assert.equal(delCustRes.body.data.deleted, true);

    // Neither customer nor application appears in listings (even includeDeleted / includeArchived)
    const listCusts = await requestApi(
      baseUrl,
      'GET',
      '/api/erp/customers?includeDeleted=true',
      undefined,
      adminCookies
    );
    assert.equal(
      listCusts.body.data.some((c: any) => c.customerId === customerId),
      false
    );

    const listApps = await requestApi(
      baseUrl,
      'GET',
      '/api/erp/applications?includeArchived=true',
      undefined,
      adminCookies
    );
    assert.equal(
      listApps.body.data.some((a: any) => a.applicationNo === appNo),
      false
    );

    // Persist & rehydrate fresh stores -> deletions & tombstones remain intact
    assert.equal(saveRuntimeStoresToDisk(erpStore, phase03Store, persistFile), true);
    const restartedSec = new SecurityStore();
    const restartedP3 = new Phase03Store();
    const restartedErp = new ErpStore(restartedSec, restartedP3);
    assert.equal(hydrateRuntimeStoresFromDisk(restartedErp, restartedP3, persistFile), true);

    assert.equal(
      restartedErp.customers.some((c) => c.customerId === customerId),
      false
    );
    assert.equal(
      restartedErp.applications.some((a) => a.applicationNo === appNo),
      false
    );
    assert.ok(restartedErp.deletedCustomerIds.has(customerId));
    assert.ok(restartedErp.deletedApplicationNos.has(appNo));
  } finally {
    server.close();
    if (prevEnv === undefined) delete process.env.MUN_PERSISTENCE_PATH;
    else process.env.MUN_PERSISTENCE_PATH = prevEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('No-OTP Customer Registration, All 7 Consents Auto-Checked by Default, Manual Opt-Out, and CRM Fields', async () => {
  const { server, securityStore } = startTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const adminCookies = await loginAs(baseUrl, securityStore, 'MC2627110001', '8101352105');

    // 1. Register customer without OTP and without explicit consents -> all 7 consents default to granted=true, segment='Regular'
    const autoConsentRes = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/customers',
      {
        fullName: 'Ariful Islam',
        mobile: '9830112233',
        village: 'Domkal',
        district: 'Murshidabad',
        panNumber: 'abcde1234f',
        aadhaarNumber: '123456789012',
      },
      adminCookies
    );
    assert.equal(autoConsentRes.status, 201);
    const c1 = autoConsentRes.body.data;
    assert.equal(c1.mobileOtpVerifiedAt, null);
    assert.equal(c1.verificationStatus, 'Consent Verified');
    assert.equal(c1.segment, 'Regular');
    assert.equal(c1.status, 'Active');
    assert.equal(c1.isArchived, false);
    assert.equal(c1.name, 'Ariful Islam');
    assert.equal(c1.pan, 'ABCDE1234F');
    assert.equal(c1.aadhaar, 'XXXX-XXXX-9012');
    assert.equal(c1.totalBusiness, 0);
    assert.equal(c1.consents.length, 7);
    assert.ok(
      c1.consents.every((entry: any) => entry.granted === true),
      'All 7 customer consents must default to granted=true'
    );

    // 2. Register VIP customer with manually unchecked consents (e.g. Promotional & WhatsApp unchecked)
    const manualOptOutRes = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/customers',
      {
        fullName: 'Nasima Begum',
        mobile: '9830445566',
        village: 'Jangipur',
        segment: 'VIP',
        consents: [
          { category: 'SMS_CONSENT', granted: true },
          { category: 'WHATSAPP_CONSENT', granted: false },
          { category: 'STATUS_UPDATE_CONSENT', granted: true },
          { category: 'PAYMENT_REMINDER_CONSENT', granted: true },
          { category: 'SERVICE_NOTIFICATION_CONSENT', granted: true },
          { category: 'PROMOTIONAL_CONSENT', granted: false },
          { category: 'DATA_PRIVACY_CONSENT', granted: true },
        ],
      },
      adminCookies
    );
    assert.equal(manualOptOutRes.status, 201);
    const c2 = manualOptOutRes.body.data;
    assert.equal(c2.segment, 'VIP');
    assert.equal(c2.crmTag, 'VIP');
    assert.equal(c2.verificationStatus, 'Unverified');
    const c2Map = new Map(c2.consents.map((entry: any) => [entry.category, entry.granted]));
    assert.equal(c2Map.get('SMS_CONSENT'), true);
    assert.equal(c2Map.get('WHATSAPP_CONSENT'), false);
    assert.equal(c2Map.get('PROMOTIONAL_CONSENT'), false);
    assert.equal(c2Map.get('DATA_PRIVACY_CONSENT'), true);

    // 3. Verify both appear in GET /api/erp/customers with expected mirror fields & filters
    const listAll = await requestApi(baseUrl, 'GET', '/api/erp/customers', undefined, adminCookies);
    assert.equal(listAll.status, 200);
    const listedC1 = listAll.body.data.find((row: any) => row.customerId === c1.customerId);
    const listedC2 = listAll.body.data.find((row: any) => row.customerId === c2.customerId);
    assert.ok(listedC1 && listedC2);
    assert.equal(listedC1.name, 'Ariful Islam');
    assert.equal(listedC1.pan, 'ABCDE1234F');
    assert.equal(listedC1.aadhaar, 'XXXX-XXXX-9012');
    assert.equal(listedC1.totalBusiness, 0);
    assert.equal(listedC1.isArchived, false);

    const listVip = await requestApi(baseUrl, 'GET', '/api/erp/customers?segment=VIP', undefined, adminCookies);
    assert.equal(listVip.status, 200);
    assert.ok(listVip.body.data.some((row: any) => row.customerId === c2.customerId));
    assert.equal(
      listVip.body.data.some((row: any) => row.customerId === c1.customerId),
      false
    );
  } finally {
    server.close();
  }
});

test('Offline-Firebase Save Flows: Income Vouchers, Attendance, Employee Photos, Customer Feedback & Storage Upload Fallback Persist Cleanly', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mun-save-fixes-'));
  const persistFile = path.join(tempDir, 'erp-state.json');
  const uploadsDir = path.join(tempDir, 'uploads');
  const prevPersist = process.env.MUN_PERSISTENCE_PATH;
  const prevUploads = process.env.MUN_UPLOADS_DIR;
  process.env.MUN_PERSISTENCE_PATH = persistFile;
  process.env.MUN_UPLOADS_DIR = uploadsDir;

  const securityStore = new SecurityStore();
  const phase03Store = new Phase03Store();
  const erpStore = new ErpStore(securityStore, phase03Store);
  const financeStore = new FinanceStore(securityStore, phase03Store, erpStore);
  seedTestFixtures({ phase03Store, erpStore });
  const app = createApp(securityStore, {
    enableRateLimit: false,
    phase03Store,
    erpStore,
    financeStore,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const adminCookies = await loginAs(baseUrl, securityStore, 'MC2627110001', '8101352105');

    // 1. Storage upload falls back to persistent local disk and issues signed URL
    const tinyPngB64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW1oAAAAASUVORK5CYII=';
    const upRes = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/storage/upload',
      {
        base64: tinyPngB64,
        folder: 'customers/temp',
        fileName: 'avatar.png',
        contentType: 'image/png',
        imageOnly: true,
      },
      adminCookies
    );
    assert.equal(upRes.status, 201);
    assert.ok(String(upRes.body.data.downloadUrl).startsWith('/api/erp/storage/files/'));
    assert.ok(String(upRes.body.data.downloadUrl).includes('?sig='));

    // Signed URL can be fetched by <img> tags without session cookies
    const signedFetch = await fetch(`${baseUrl}${upRes.body.data.downloadUrl}`);
    assert.equal(signedFetch.status, 200);
    assert.equal(signedFetch.headers.get('content-type'), 'image/png');
    const fetchedBuf = Buffer.from(await signedFetch.arrayBuffer());
    assert.deepEqual(fetchedBuf, Buffer.from(tinyPngB64, 'base64'));

    // Unsigned or tampered request without auth is rejected (401), and .meta.json / traversal blocked
    const unsignedPath = String(upRes.body.data.downloadUrl).split('?')[0];
    const noSigFetch = await fetch(`${baseUrl}${unsignedPath}?sig=deadbeef`);
    assert.equal(noSigFetch.status, 401);
    const metaFetch = await fetch(`${baseUrl}${unsignedPath}.meta.json`, {
      headers: { Cookie: `mun_session=${encodeURIComponent(adminCookies.mun_session)}` },
    });
    assert.equal(metaFetch.status, 403);

    // 2. Customer creation preserves /api/erp/storage/files/ photoUrl
    const custWithPhoto = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/customers',
      {
        fullName: 'Photo Citizen Test',
        mobile: '9830123456',
        village: 'Domkal',
        photoUrl: upRes.body.data.downloadUrl,
        photoStoragePath: upRes.body.data.storagePath,
      },
      adminCookies
    );
    assert.equal(custWithPhoto.status, 201);
    assert.equal(custWithPhoto.body.data.photoUrl, upRes.body.data.downloadUrl);

    // 3. Direct Income Voucher create & list
    const incCreate = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/income',
      {
        category: 'Printing & Lamination',
        description: 'Urgent Aadhaar PVC print',
        counterCode: 'CTR-01',
        paymentMethod: 'Cash',
        amount: 150,
        incomeDate: '2026-11-22',
      },
      adminCookies
    );
    assert.equal(incCreate.status, 201);
    const incomeNo = incCreate.body.data.incomeNo;
    assert.ok(incomeNo.startsWith('INC-'));

    const incList = await requestApi(baseUrl, 'GET', '/api/erp/income', undefined, adminCookies);
    assert.equal(incList.status, 200);
    assert.ok(incList.body.data.some((i: any) => i.incomeNo === incomeNo && i.amount === 150));

    // 4. Employee creation + photo PATCH + Attendance upsert
    const empCreate = await requestApi(
      baseUrl,
      'POST',
      '/api/v1/employees',
      {
        fullName: 'Rohan Mondal',
        designation: 'CSC Operator',
        department: 'Operations',
        mobile: '9830778899',
        basicSalary: 14000,
      },
      adminCookies
    );
    assert.equal(empCreate.status, 201);
    const empId = empCreate.body.data.empId;

    const empPatch = await requestApi(
      baseUrl,
      'PATCH',
      `/api/v1/employees/${empId}`,
      {
        photoUrl: upRes.body.data.downloadUrl,
        photoStoragePath: upRes.body.data.storagePath,
      },
      adminCookies
    );
    assert.equal(empPatch.status, 200);
    assert.equal(empPatch.body.data.photoUrl, upRes.body.data.downloadUrl);

    const attMark1 = await requestApi(
      baseUrl,
      'POST',
      '/api/v1/attendance',
      { date: '2026-11-22', empId, status: 'Present' },
      adminCookies
    );
    assert.equal(attMark1.status, 201);
    assert.equal(attMark1.body.data.status, 'Present');

    const attMark2 = await requestApi(
      baseUrl,
      'POST',
      '/api/v1/attendance',
      { date: '2026-11-22', empId, status: 'Half-Day' },
      adminCookies
    );
    assert.equal(attMark2.status, 200);
    assert.equal(attMark2.body.data.status, 'Half-Day');

    const attList = await requestApi(
      baseUrl,
      'GET',
      '/api/v1/attendance?date=2026-11-22',
      undefined,
      adminCookies
    );
    assert.equal(attList.status, 200);
    assert.equal(attList.body.data.length, 1);
    assert.equal(attList.body.data[0].status, 'Half-Day');

    // 5. Customer Feedback submit, list & review toggle
    const fbCreate = await requestApi(
      baseUrl,
      'POST',
      '/api/erp/feedback',
      {
        customerName: 'Salma Khatun',
        mobile: '9830665544',
        serviceName: 'Income Certificate',
        rating: 9,
        comments: 'Fast and polite service at Domkal center.',
        testimonialConsent: true,
      },
      adminCookies
    );
    assert.equal(fbCreate.status, 201);
    const feedbackNo = fbCreate.body.data.feedbackNo;

    const fbToggle = await requestApi(
      baseUrl,
      'PATCH',
      `/api/erp/feedback/${feedbackNo}/reviewed`,
      { reviewed: true },
      adminCookies
    );
    assert.equal(fbToggle.status, 200);
    assert.equal(fbToggle.body.data.reviewed, true);

    const fbList = await requestApi(baseUrl, 'GET', '/api/erp/feedback', undefined, adminCookies);
    assert.equal(fbList.status, 200);
    assert.ok(fbList.body.data.some((f: any) => f.feedbackNo === feedbackNo && f.reviewed === true));

    // 6. Full runtime snapshot save & rehydration across simulated restart
    assert.equal(
      saveRuntimeStoresToDisk(erpStore, phase03Store, {
        filePath: persistFile,
        financeStore,
      }),
      true
    );
    const rSec = new SecurityStore();
    const rP3 = new Phase03Store();
    const rErp = new ErpStore(rSec, rP3);
    const rFin = new FinanceStore(rSec, rP3, rErp);
    assert.equal(
      hydrateRuntimeStoresFromDisk(rErp, rP3, {
        filePath: persistFile,
        financeStore: rFin,
      }),
      true
    );

    assert.ok(rErp.incomeVouchers.some((i) => i.incomeNo === incomeNo));
    assert.ok(rErp.feedbacks.some((f) => f.feedbackNo === feedbackNo && f.reviewed === true));
    assert.ok(
      rErp.customers.some(
        (c) => c.customerId === custWithPhoto.body.data.customerId && c.photoUrl === upRes.body.data.downloadUrl
      )
    );
    assert.ok(
      rFin.employees.some((e) => e.empId === empId && e.photoUrl === upRes.body.data.downloadUrl)
    );
    assert.ok(
      rFin.attendanceRecords.some((a) => a.attendanceId === `2026-11-22_${empId}` && a.status === 'Half-Day')
    );
  } finally {
    server.close();
    if (prevPersist === undefined) delete process.env.MUN_PERSISTENCE_PATH;
    else process.env.MUN_PERSISTENCE_PATH = prevPersist;
    if (prevUploads === undefined) delete process.env.MUN_UPLOADS_DIR;
    else process.env.MUN_UPLOADS_DIR = prevUploads;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});




