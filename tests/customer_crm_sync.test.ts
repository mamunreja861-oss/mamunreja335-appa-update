import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCustomerSummaryMetrics,
  filterCustomers,
  mergeCustomerLists,
  normalizeCustomerRecord,
} from '../frontend/services/customerCrmHelpers';
import { ErpCustomerItem } from '../frontend/services/erpApi';

function makeCustomer(overrides: Partial<ErpCustomerItem> = {}): ErpCustomerItem {
  return {
    id: 1,
    customerId: 'MCC-2026-27-000001',
    fullName: 'Sabira Khatun',
    fatherOrHusbandName: '',
    dob: '',
    gender: 'Female',
    mobile: '9830112233',
    whatsapp: '9830112233',
    email: '',
    village: 'Mamudpur',
    postOffice: '',
    policeStation: '',
    district: 'Murshidabad',
    pinCode: '742406',
    presentAddress: 'Mamudpur, Murshidabad',
    permanentAddress: 'Mamudpur, Murshidabad',
    sameAsPresent: true,
    segment: 'Regular',
    crmTag: 'New',
    status: 'Active',
    verificationStatus: 'Consent Verified',
    mobileOtpVerifiedAt: null,
    consents: [],
    consentHistory: [],
    contactHistory: [],
    notesAndFollowUps: [],
    deletedAt: null,
    isArchived: false,
    createdBy: 'MC2627110001',
    createdAt: '2026-11-21T08:50:00.000Z',
    updatedAt: '2026-11-21T08:50:00.000Z',
    ...overrides,
  };
}

test('Customer CRM Sync: newly saved customer appears immediately at top and survives snapshot merge', () => {
  const older = makeCustomer({
    id: 1,
    customerId: 'MCC-2026-27-000000',
    fullName: 'Existing Client',
    createdAt: '2026-11-20T09:00:00.000Z',
    updatedAt: '2026-11-20T09:00:00.000Z',
    totalBusiness: 1200,
  });

  const sabira = makeCustomer({
    id: 2,
    customerId: 'MCC-2026-27-000001',
    fullName: 'Sabira Khatun',
    name: 'Sabira Khatun',
    mobile: '9832445566',
    village: 'Juginda',
    pan: 'ABCDE1234F',
    createdAt: '2026-11-21T08:55:00.000Z',
    updatedAt: '2026-11-21T08:55:00.000Z',
    isArchived: undefined,
  });

  // 1. Optimistic immediate display before Firestore snapshot arrives (stale API only has older record)
  const beforeSnapshot = mergeCustomerLists({
    firestoreCustomers: [older],
    apiCustomers: [older],
    optimisticCustomers: [sabira],
  });
  assert.equal(beforeSnapshot.length, 2);
  assert.equal(beforeSnapshot[0].customerId, 'MCC-2026-27-000001');
  assert.equal(beforeSnapshot[0].fullName, 'Sabira Khatun');

  // 2. Confirmed Firestore onSnapshot arrives ordered by createdAt desc
  const afterSnapshot = mergeCustomerLists({
    firestoreCustomers: [sabira, older],
    apiCustomers: [older],
    optimisticCustomers: [],
  });
  assert.equal(afterSnapshot.length, 2);
  assert.equal(afterSnapshot[0].customerId, 'MCC-2026-27-000001');
  assert.equal(afterSnapshot[0].name, 'Sabira Khatun');
});

test('Customer CRM Filters & Search: default All/All/isArchived=false never hides new docs and search checks all fields', () => {
  // Simulate a Firestore doc with minimal/optional fields omitted
  const minimalFirestoreDoc = normalizeCustomerRecord({
    ...makeCustomer({
      customerId: 'MCC-2026-27-000001',
      fullName: '',
      name: 'Sabira Khatun',
      mobile: '9832445566',
      village: 'Mamudpur',
      pan: 'BNZPM2501F',
      panNumber: undefined,
      isArchived: undefined,
      deletedAt: undefined as unknown as null,
    }),
  });

  const vipDoc = makeCustomer({
    id: 2,
    customerId: 'MCC-2026-27-000002',
    fullName: 'Ramesh Mandal',
    mobile: '9911223344',
    village: 'Domkal',
    panNumber: 'ABCDE9999K',
    segment: 'VIP',
    crmTag: 'VIP',
    status: 'Active',
    totalBusiness: 3500,
    createdAt: '2026-11-21T09:00:00.000Z',
  });

  const archivedDoc = makeCustomer({
    id: 3,
    customerId: 'MCC-2026-27-000003',
    fullName: 'Archived Person',
    isArchived: true,
    deletedAt: '2026-11-19T10:00:00.000Z',
  });

  const all = [vipDoc, minimalFirestoreDoc, archivedDoc];

  // Default All / All / showArchived=false includes both active docs, excludes archived
  const defaultFiltered = filterCustomers(all, {
    query: '',
    segment: 'All',
    status: 'All',
    showArchived: false,
  });
  assert.equal(defaultFiltered.length, 2);
  assert.ok(defaultFiltered.some((c) => c.customerId === 'MCC-2026-27-000001'));

  // Case-insensitive search across name, mobile, customerId, village, and pan
  for (const term of ['sabira', '9832445566', 'mcc-2026-27-000001', 'MAMUDPUR', 'bnzpm2501f']) {
    const res = filterCustomers(all, {
      query: term,
      segment: 'All',
      status: 'All',
      showArchived: false,
    });
    assert.equal(res.length, 1, `Expected search "${term}" to match Sabira Khatun`);
    assert.equal(res[0].customerId, 'MCC-2026-27-000001');
  }

  // Summary metrics dynamically compute Total Customers, Active Customers, VIP Customers, Total Business
  const metrics = computeCustomerSummaryMetrics(all);
  assert.equal(metrics.totalCustomers, 2);
  assert.equal(metrics.activeCustomers, 2);
  assert.equal(metrics.vipCustomers, 1);
  assert.equal(metrics.totalBusiness, 3500);
});

import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { SecurityStore } from '../server/securityStore';
import { Phase03Store } from '../server/phase03Store';
import { ErpStore } from '../server/erpStore';
import { seedTestFixtures } from '../server/testFixtures';
import { performFourLayerLogin, postJson } from './testAuthHelper';
import {
  isSafeRemotePhotoUrl,
  maskAadhaarValue,
  MAX_CUSTOMER_PHOTO_BYTES,
  sanitizeAadhaarInput,
  sanitizeMobileInput,
  sanitizePanInput,
  sanitizePinCodeInput,
  validateAadhaarNumber,
  validateCustomerPhotoFile,
  validateFullName,
  validateMobileNumber,
  validatePanNumber,
  validatePinCode,
  validateVillage,
} from '../frontend/utils/customerValidation';

test('Strict Input Validation: 10-digit Mobile, 12-digit Aadhaar, 6-digit PIN, and PAN format AAAAA9999A', () => {
  // 1. Mobile Number (9, 10, 11 digits, +91 prefix, non-digit filtering, exact 10 pattern)
  assert.equal(validateMobileNumber('9832112233'), null);
  assert.match(validateMobileNumber('983211223')!, /must be exactly 10 digits \(9\/10\)/);
  assert.match(validateMobileNumber('98321122334')!, /must be exactly 10 digits \(11\/10\)/);
  assert.match(validateMobileNumber('983211ABCD')!, /must be exactly 10 digits/);
  assert.equal(validateMobileNumber('', true), '10-digit mobile number is required.');

  const mobSanitizedClean = sanitizeMobileInput('9832112233');
  assert.equal(mobSanitizedClean.value, '9832112233');
  assert.equal(mobSanitizedClean.wasTrimmed, false);

  const mobSanitizedPrefix = sanitizeMobileInput('+91 98321 12233');
  assert.equal(mobSanitizedPrefix.value, '9832112233');

  const mobSanitizedLong = sanitizeMobileInput('98321122334455');
  assert.equal(mobSanitizedLong.value, '9832112233');
  assert.equal(mobSanitizedLong.wasTrimmed, true);
  assert.match(mobSanitizedLong.notice!, /maximum 10 digits/);

  // 2. Aadhaar Number (11, 12, 13 digits, formatting, masking XXXX-XXXX-NNNN)
  assert.equal(validateAadhaarNumber('123456789012'), null);
  assert.match(validateAadhaarNumber('12345678901')!, /must be exactly 12 digits \(11\/12\)/);
  assert.match(validateAadhaarNumber('1234567890123')!, /must be exactly 12 digits \(13\/12\)/);
  assert.match(validateAadhaarNumber('12345678901A')!, /must be exactly 12 digits/);
  assert.equal(validateAadhaarNumber('', false), null);

  const aadhaarSanitized = sanitizeAadhaarInput('1234 5678 9012');
  assert.equal(aadhaarSanitized.value, '123456789012');

  const aadhaarSanitizedLong = sanitizeAadhaarInput('123456789012999');
  assert.equal(aadhaarSanitizedLong.value, '123456789012');
  assert.equal(aadhaarSanitizedLong.wasTrimmed, true);

  assert.equal(maskAadhaarValue('123456789012'), 'XXXX-XXXX-9012');
  assert.equal(maskAadhaarValue('XXXX-XXXX-9012'), 'XXXX-XXXX-9012');

  // 3. PIN Code (5, 6, 7 digits, non-numeric filtering)
  assert.equal(validatePinCode('742406'), null);
  assert.match(validatePinCode('74240')!, /must be exactly 6 digits \(5\/6\)/);
  assert.match(validatePinCode('7424067')!, /must be exactly 6 digits \(7\/6\)/);
  assert.match(validatePinCode('74240A')!, /must be exactly 6 digits/);

  const pinSanitized = sanitizePinCodeInput('742-406');
  assert.equal(pinSanitized.value, '742406');

  const pinSanitizedLong = sanitizePinCodeInput('74240699');
  assert.equal(pinSanitizedLong.value, '742406');
  assert.equal(pinSanitizedLong.wasTrimmed, true);

  // 4. PAN Number (AAAAA9999A format: 5 letters, 4 digits, 1 letter)
  assert.equal(validatePanNumber('ABCDE1234F'), null);
  assert.equal(validatePanNumber('AAAAA9999A'), null);
  assert.match(validatePanNumber('12345ABCDE')!, /standard format AAAAA9999A/);
  assert.match(validatePanNumber('ABC123456F')!, /standard format AAAAA9999A/);
  assert.match(validatePanNumber('ABCDEF1234')!, /standard format AAAAA9999A/);
  assert.match(validatePanNumber('ABCDE12345')!, /standard format AAAAA9999A/);
  assert.match(validatePanNumber('ABCDE123')!, /standard format AAAAA9999A/);

  const panSanitizedLower = sanitizePanInput('abcde1234f');
  assert.equal(panSanitizedLower.value, 'ABCDE1234F');
  assert.equal(panSanitizedLower.wasTrimmed, false);

  const panSanitizedInvalidPos = sanitizePanInput('12345ABCDE');
  assert.equal(panSanitizedInvalidPos.wasTrimmed, true);
  assert.match(panSanitizedInvalidPos.notice!, /PAN format is AAAAA9999A/);

  // 5. Customer Name & Village mandatory minimum lengths
  assert.equal(validateFullName('Ramesh Mandal'), null);
  assert.match(validateFullName('A')!, /at least 2 characters/);
  assert.equal(validateVillage('Mamudpur'), null);
  assert.match(validateVillage('')!, /Village \/ Locality is required/);
});

test('Customer Photo Capture & Storage: file size, MIME formats, and HTTPS download URL validation', () => {
  // 1. Photo File validation (5MB max, JPG/JPEG/PNG/WEBP)
  const validJpg = { name: 'profile.jpg', type: 'image/jpeg', size: 2 * 1024 * 1024 };
  assert.equal(validateCustomerPhotoFile(validJpg), null);

  const validPng = { name: 'profile.png', type: 'image/png', size: 1.5 * 1024 * 1024 };
  assert.equal(validateCustomerPhotoFile(validPng), null);

  const validWebp = { name: 'profile.webp', type: 'image/webp', size: 800 * 1024 };
  assert.equal(validateCustomerPhotoFile(validWebp), null);

  const oversizedFile = { name: 'large.jpg', type: 'image/jpeg', size: 5.5 * 1024 * 1024 };
  assert.match(validateCustomerPhotoFile(oversizedFile)!, /exceeds the 5 MB maximum limit/);

  const emptyFile = { name: 'empty.jpg', type: 'image/jpeg', size: 0 };
  assert.match(validateCustomerPhotoFile(emptyFile)!, /empty or unreadable/);

  const invalidGif = { name: 'profile.gif', type: 'image/gif', size: 500 * 1024 };
  assert.match(validateCustomerPhotoFile(invalidGif)!, /Unsupported image format/);

  const invalidPdf = { name: 'doc.pdf', type: 'application/pdf', size: 500 * 1024 };
  assert.match(validateCustomerPhotoFile(invalidPdf)!, /Unsupported image format/);

  // 2. Safe remote HTTPS download URLs vs temporary Blob / unsafe schemes
  assert.equal(
    isSafeRemotePhotoUrl('https://firebasestorage.googleapis.com/v0/b/bucket/o/customers%2Fprofile.jpg?alt=media'),
    true
  );
  assert.equal(isSafeRemotePhotoUrl('blob:http://localhost:3000/a38d6121-1234'), false);
  assert.equal(isSafeRemotePhotoUrl('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...'), false);
  assert.equal(isSafeRemotePhotoUrl('javascript:alert(1)'), false);
  assert.equal(isSafeRemotePhotoUrl(''), false);
  assert.equal(isSafeRemotePhotoUrl(null), false);
  assert.equal(isSafeRemotePhotoUrl(undefined), false);
});

test('Customer CRM Server API: strict validation, photo reference retention, and reservation workflow', async () => {
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
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const adminSession = await performFourLayerLogin(baseUrl, securityStore, 'MC2627110001', '8101352105');
    const adminCookies = adminSession.cookies;
    const cookieHeader = Object.entries(adminCookies)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('; ');
    const authHeaders = {
      Cookie: cookieHeader,
      'X-CSRF-Token': adminCookies.mun_csrf || '',
    };

    // 1. Reserve Customer ID rejects invalid 9-digit mobile (422)
    const resBadMob = await postJson(
      baseUrl,
      '/api/erp/customers/reserve-id',
      {
        fullName: 'Sabira Khatun',
        mobile: '983211223', // 9 digits
        village: 'Mamudpur',
      },
      authHeaders
    );
    assert.equal(resBadMob.status, 422);
    assert.ok(resBadMob.body.errors?.mobile);

    // 2. Reserve Customer ID rejects invalid 11-digit Aadhaar (422)
    const resBadAadhaar = await postJson(
      baseUrl,
      '/api/erp/customers/reserve-id',
      {
        fullName: 'Sabira Khatun',
        mobile: '9832112233',
        village: 'Mamudpur',
        aadhaarNumber: '12345678901', // 11 digits
      },
      authHeaders
    );
    assert.equal(resBadAadhaar.status, 422);
    assert.ok(resBadAadhaar.body.errors?.aadhaarNumber);

    // 3. Reserve Customer ID rejects invalid 5-digit PIN (422)
    const resBadPin = await postJson(
      baseUrl,
      '/api/erp/customers/reserve-id',
      {
        fullName: 'Sabira Khatun',
        mobile: '9832112233',
        village: 'Mamudpur',
        pinCode: '74240', // 5 digits
      },
      authHeaders
    );
    assert.equal(resBadPin.status, 422);
    assert.ok(resBadPin.body.errors?.pinCode);

    // 4. Reserve Customer ID rejects invalid PAN pattern (422)
    const resBadPan = await postJson(
      baseUrl,
      '/api/erp/customers/reserve-id',
      {
        fullName: 'Sabira Khatun',
        mobile: '9832112233',
        village: 'Mamudpur',
        panNumber: '12345ABCDE', // Invalid PAN pattern
      },
      authHeaders
    );
    assert.equal(resBadPan.status, 422);
    assert.ok(resBadPan.body.errors?.panNumber);

    // 5. Reserve Customer ID succeeds with valid credentials
    const resReserve = await postJson(
      baseUrl,
      '/api/erp/customers/reserve-id',
      {
        fullName: 'Sabira Khatun',
        mobile: '9832112233',
        village: 'Mamudpur',
        pinCode: '742406',
        aadhaarNumber: '123456789012',
        panNumber: 'ABCDE1234F',
      },
      authHeaders
    );
    assert.equal(resReserve.status, 200);
    assert.match(resReserve.body.data.customerId, /^MCC-\d{4}-\d{2}-\d{6}$/);
    assert.match(resReserve.body.data.referenceNo, /^MCR-\d{4}-\d{2}-\d{6}$/);
    const allocatedId = resReserve.body.data.customerId;
    const allocatedRef = resReserve.body.data.referenceNo;

    // 6. Direct customer creation rejects unsafe blob: photo URL (422)
    const resUnsafePhoto = await postJson(
      baseUrl,
      '/api/erp/customers',
      {
        fullName: 'Sabira Khatun',
        mobile: '9832112233',
        village: 'Mamudpur',
        pinCode: '742406',
        photoDownloadURL: 'blob:http://localhost:3000/temp-uuid',
      },
      authHeaders
    );
    assert.equal(resUnsafePhoto.status, 422);
    assert.ok(resUnsafePhoto.body.errors?.photoDownloadURL);

    // 7. Successful creation with reserved ID, HTTPS photo download URL, and photoStoragePath
    const validPhotoUrl = 'https://firebasestorage.googleapis.com/v0/b/app/o/customers%2Fprofile.jpg?alt=media';
    const validPhotoPath = `customers/${allocatedId}/profile_1732176000000.jpg`;
    const resCreate = await postJson(
      baseUrl,
      '/api/erp/customers',
      {
        reservedCustomerId: allocatedId,
        referenceNo: allocatedRef,
        fullName: 'Sabira Khatun',
        fatherOrHusbandName: 'Late Akhtar Hossain',
        dob: '1995-04-12',
        gender: 'Female',
        mobile: '9832112233',
        village: 'Mamudpur',
        district: 'Murshidabad',
        pinCode: '742406',
        aadhaarNumber: '123456789012',
        panNumber: 'ABCDE1234F',
        photoStoragePath: validPhotoPath,
        photoDownloadURL: validPhotoUrl,
      },
      authHeaders
    );
    assert.equal(resCreate.status, 201);
    assert.equal(resCreate.body.data.customerId, allocatedId);
    assert.equal(resCreate.body.data.referenceNo, allocatedRef);
    assert.equal(resCreate.body.data.aadhaarMasked, 'XXXX-XXXX-9012');
    assert.equal(resCreate.body.data.aadhaarEncrypted, undefined); // sensitive plaintext never exposed
    assert.equal(resCreate.body.data.photoStoragePath, validPhotoPath);
    assert.equal(resCreate.body.data.photoDownloadURL, validPhotoUrl);

    // 8. Reserve ID respects Firestore max minSequence so cold-started backend skips already-used IDs
    const resMinSeq = await postJson(
      baseUrl,
      '/api/erp/customers/reserve-id',
      {
        fullName: 'Arjun Roy',
        mobile: '9832998877',
        village: 'Domkal',
        minSequence: 25,
      },
      authHeaders
    );
    assert.equal(resMinSeq.status, 200);
    assert.ok(
      resMinSeq.body.data.customerId.endsWith('-000026'),
      `Expected -000026 after minSequence=25, got ${resMinSeq.body.data.customerId}`
    );

    // 9. POST /api/erp/customers accepts a well-formed Firestore-synchronized ID across serverless cold starts
    const fySuffix = phase03Store.docSequence.getCurrentFinancialYear();
    const coldStartSyncedId = `MCC-${fySuffix}-000031`;
    const coldStartSyncedRef = `MCR-${fySuffix}-000031`;
    const resColdStartCreate = await postJson(
      baseUrl,
      '/api/erp/customers',
      {
        reservedCustomerId: coldStartSyncedId,
        referenceNo: coldStartSyncedRef,
        fullName: 'Nusrat Begum',
        mobile: '9832776655',
        village: 'Juginda',
        district: 'Murshidabad',
        pinCode: '742406',
      },
      authHeaders
    );
    assert.equal(resColdStartCreate.status, 201);
    assert.equal(resColdStartCreate.body.data.customerId, coldStartSyncedId);
    assert.equal(resColdStartCreate.body.data.referenceNo, coldStartSyncedRef);

    // Subsequent reservation advances past 000031
    const resAfterSeed = await postJson(
      baseUrl,
      '/api/erp/customers/reserve-id',
      {
        fullName: 'Kamal Hasan',
        mobile: '9832665544',
        village: 'Domkal',
      },
      authHeaders
    );
    assert.equal(resAfterSeed.status, 200);
    assert.ok(
      resAfterSeed.body.data.customerId.endsWith('-000032'),
      `Expected -000032 after seeded -000031, got ${resAfterSeed.body.data.customerId}`
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

import {
  findCachedCustomer,
  getMaxCachedCustomerSequence,
  loadCachedCustomers,
  markCustomerTombstoned,
  reconcileTombstonesFromServer,
  upsertCachedCustomer,
} from '../frontend/services/customerLocalCache';

test('Customer Local Cache & Merge: survives cold server returning empty list while honoring tombstones', () => {
  const created = makeCustomer({
    id: 101,
    customerId: 'MCC-2026-27-000101',
    referenceNo: 'MCR-2026-27-000101',
    fullName: 'Amina Khatun',
    mobile: '9832554433',
    village: 'Domkal',
    pinCode: '742406',
    panNumber: 'ABCDE1234F',
    aadhaarMasked: 'XXXX-XXXX-8765',
    createdAt: '2026-11-22T10:00:00.000Z',
    updatedAt: '2026-11-22T10:00:00.000Z',
  });

  // Cold-start backend returns [] and Firestore client auth is null -> []
  const merged = mergeCustomerLists({
    cachedCustomers: [created],
    firestoreCustomers: [],
    apiCustomers: [],
    optimisticCustomers: [],
    deletedCustomerIds: [],
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].customerId, 'MCC-2026-27-000101');
  assert.equal(merged[0].referenceNo, 'MCR-2026-27-000101');

  // Tombstoned ID is never resurrected even if present in cache
  const afterDelete = mergeCustomerLists({
    cachedCustomers: [created],
    firestoreCustomers: [],
    apiCustomers: [],
    optimisticCustomers: [],
    deletedCustomerIds: ['MCC-2026-27-000101'],
  });
  assert.equal(afterDelete.length, 0);

  // Verify browser localStorage durability via a lightweight Storage shim
  const memStore = new Map<string, string>();
  const prevWindow = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (k: string) => memStore.get(k) ?? null,
      setItem: (k: string, v: string) => {
        memStore.set(k, String(v));
      },
      removeItem: (k: string) => {
        memStore.delete(k);
      },
    },
  };
  try {
    upsertCachedCustomer(created, { allowUntombstone: true });
    assert.equal(loadCachedCustomers().length, 1);
    assert.equal(findCachedCustomer('MCC-2026-27-000101')?.referenceNo, 'MCR-2026-27-000101');
    assert.equal(getMaxCachedCustomerSequence('2026-27'), 101);

    markCustomerTombstoned('MCC-2026-27-000101');
    assert.equal(loadCachedCustomers().length, 0);

    // Reconciling server tombstones drops matching cached entries
    const second = makeCustomer({
      id: 102,
      customerId: 'MCC-2026-27-000102',
      referenceNo: 'MCR-2026-27-000102',
      fullName: 'Raju Mandal',
    });
    upsertCachedCustomer(second, { allowUntombstone: true });
    assert.equal(loadCachedCustomers().length, 1);
    reconcileTombstonesFromServer(['MCC-2026-27-000102']);
    assert.equal(loadCachedCustomers().length, 0);
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = prevWindow;
    }
  }
});

test('Customer Cold-Start Rehydration API: /api/erp/customers/sync restores customer & sequence while respecting permanent delete tombstones', async () => {
  // Server 1: Operator registers a new customer and sees Ref No + 360 Profile
  const sec1 = new SecurityStore();
  const p3_1 = new Phase03Store();
  const erp1 = new ErpStore(sec1, p3_1);
  seedTestFixtures({ phase03Store: p3_1, erpStore: erp1 });
  const app1 = createApp(sec1, { enableRateLimit: false, phase03Store: p3_1, erpStore: erp1 });
  const srv1 = http.createServer(app1);
  await new Promise<void>((resolve) => srv1.listen(0, resolve));
  const url1 = `http://127.0.0.1:${(srv1.address() as AddressInfo).port}`;

  let createdCustomer: ErpCustomerItem;
  try {
    const login1 = await performFourLayerLogin(url1, sec1, 'MC2627110001', '8101352105');
    const headers1 = {
      Cookie: Object.entries(login1.cookies)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('; '),
      'X-CSRF-Token': login1.cookies.mun_csrf || '',
    };

    const resCreate = await postJson(
      url1,
      '/api/erp/customers',
      {
        fullName: 'Farhana Yasmin',
        mobile: '9832445511',
        village: 'Mamudpur',
        district: 'Murshidabad',
        pinCode: '742406',
        aadhaarNumber: '123456789012',
        panNumber: 'ABCDE1234F',
      },
      headers1
    );
    assert.equal(resCreate.status, 201);
    createdCustomer = resCreate.body.data;
    assert.ok(createdCustomer.customerId.startsWith('MCC-'));
    assert.ok(createdCustomer.referenceNo?.startsWith('MCR-'));
    assert.equal(createdCustomer.aadhaarMasked, 'XXXX-XXXX-9012');
  } finally {
    await new Promise<void>((resolve) => srv1.close(() => resolve()));
  }

  // Server 2: Simulates a fresh cold-started serverless instance with empty customer RAM
  const sec2 = new SecurityStore();
  const p3_2 = new Phase03Store();
  const erp2 = new ErpStore(sec2, p3_2);
  seedTestFixtures({ phase03Store: p3_2, erpStore: erp2 });
  const app2 = createApp(sec2, { enableRateLimit: false, phase03Store: p3_2, erpStore: erp2 });
  const srv2 = http.createServer(app2);
  await new Promise<void>((resolve) => srv2.listen(0, resolve));
  const url2 = `http://127.0.0.1:${(srv2.address() as AddressInfo).port}`;

  try {
    const login2 = await performFourLayerLogin(url2, sec2, 'MC2627110001', '8101352105');
    const headers2 = {
      Cookie: Object.entries(login2.cookies)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('; '),
      'X-CSRF-Token': login2.cookies.mun_csrf || '',
    };

    // Before sync, cold-started server does NOT contain the customer registered on Server 1
    const beforeRes = await fetch(`${url2}/api/erp/customers`, { headers: headers2 });
    const beforeJson = (await beforeRes.json()) as { data: ErpCustomerItem[] };
    assert.ok(
      !beforeJson.data.some((c) => c.customerId === createdCustomer!.customerId),
      `Expected ${createdCustomer!.customerId} to be absent on cold Server 2 before sync`
    );

    // Client syncs cached customer -> restored on Server 2 with full Reference No & profile
    const syncRes = await postJson(
      url2,
      '/api/erp/customers/sync',
      { customers: [createdCustomer!] },
      headers2
    );
    assert.equal(syncRes.status, 200);
    assert.equal(syncRes.body.data.syncedCount, 1);

    // 360 profile endpoint now resolves cleanly with Ref No & Aadhaar masked intact
    const profileRes = await fetch(
      `${url2}/api/erp/customers/${encodeURIComponent(createdCustomer!.customerId)}`,
      { headers: headers2 }
    );
    assert.equal(profileRes.status, 200);
    const profileJson = (await profileRes.json()) as { data: { customer: ErpCustomerItem } };
    assert.equal(profileJson.data.customer.customerId, createdCustomer!.customerId);
    assert.equal(profileJson.data.customer.referenceNo, createdCustomer!.referenceNo);
    assert.equal(profileJson.data.customer.aadhaarMasked, 'XXXX-XXXX-9012');

    // Sequence advances beyond synced customer's serial
    const nextRes = await postJson(
      url2,
      '/api/erp/customers/reserve-id',
      {
        fullName: 'Suman Das',
        mobile: '9832445522',
        village: 'Domkal',
      },
      headers2
    );
    assert.equal(nextRes.status, 200);
    assert.notEqual(nextRes.body.data.customerId, createdCustomer!.customerId);

    // Bulk import also emits MCR- referenceNo
    const bulkRes = await postJson(
      url2,
      '/api/erp/customers/bulk-import',
      {
        commit: true,
        rows: [
          {
            fullName: 'Bulk Imported User',
            mobile: '9832445599',
            village: 'Islampur',
            district: 'Murshidabad',
          },
        ],
      },
      headers2
    );
    assert.equal(bulkRes.status, 200);
    assert.equal(bulkRes.body.data.createdIds.length, 1);
    const bulkProfileRes = await fetch(
      `${url2}/api/erp/customers/${encodeURIComponent(bulkRes.body.data.createdIds[0])}`,
      { headers: headers2 }
    );
    assert.equal(bulkProfileRes.status, 200);
    const bulkProfileJson = (await bulkProfileRes.json()) as { data: { customer: ErpCustomerItem } };
    assert.ok(bulkProfileJson.data.customer.referenceNo?.startsWith('MCR-'));

    // Permanent delete creates a server tombstone; subsequent /sync MUST NOT resurrect deleted record
    const delRes = await fetch(
      `${url2}/api/erp/customers/${encodeURIComponent(createdCustomer!.customerId)}`,
      { method: 'DELETE', headers: headers2 }
    );
    assert.equal(delRes.status, 200);

    const tombRes = await fetch(`${url2}/api/erp/tombstones`, { headers: headers2 });
    const tombJson = (await tombRes.json()) as { data: { deletedCustomerIds: string[] } };
    assert.ok(tombJson.data.deletedCustomerIds.includes(createdCustomer!.customerId));

    const resyncDeleted = await postJson(
      url2,
      '/api/erp/customers/sync',
      { customers: [createdCustomer!] },
      headers2
    );
    assert.equal(resyncDeleted.status, 200);
    assert.equal(resyncDeleted.body.data.syncedCount, 0);
    assert.ok(resyncDeleted.body.data.skippedTombstonedIds.includes(createdCustomer!.customerId));

    const listAfterDel = await fetch(`${url2}/api/erp/customers?includeDeleted=true`, {
      headers: headers2,
    });
    const listAfterJson = (await listAfterDel.json()) as { data: ErpCustomerItem[] };
    assert.ok(!listAfterJson.data.some((c) => c.customerId === createdCustomer!.customerId));
  } finally {
    await new Promise<void>((resolve) => srv2.close(() => resolve()));
  }
});

