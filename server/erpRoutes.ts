import { Express, Request, Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SecurityStore } from './securityStore.js';
import { Phase03Store } from './phase03Store.js';
import {
  addDaysIso,
  ALLOWED_STATUS_TRANSITIONS,
  DEFAULT_CONSENT_DEFINITIONS,
  ErpStore,
  REASONS_REQUIRED_STATUSES,
} from './erpStore.js';
import {
  ApplicationDeliveryRecord,
  ApplicationDocumentRecord,
  ConsentCategoryKey,
  DynamicFormFieldDef,
  ErpApplication,
  ErpApplicationStatus,
  ErpCustomer,
  ErpService,
  ServiceRequiredDocumentDef,
  ServiceSubcategory,
} from './erpTypes.js';
import {
  decryptSensitiveField,
  encryptSensitiveField,
  hmacOtp,
  sanitizeText,
  signStoragePath,
  verifyStoragePathSignature,
} from './crypto.js';
import { ModuleKey, PermissionType, ServerUser } from './types.js';
import type { FinanceStore } from './finance/financeStore.js';
import { sendFast2SmsTemplateMessage } from './fast2smsService.js';
import {
  deleteErpCustomerFromFirebaseAdmin,
  getFirebaseAdminBucket,
  syncErpCustomerToFirebase,
} from './firebaseAdminDb.js';

interface AuthedRequest extends Request {
  authUser?: ServerUser;
}

const ALLOWED_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const ALLOWED_EXT_MAP: Record<string, string[]> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
};
const BLOCKED_EXECUTABLE_EXTS = new Set([
  'exe', 'bat', 'cmd', 'sh', 'msi', 'js', 'vbs', 'ps1', 'com', 'scr', 'dll', 'php', 'py',
]);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB strictly enforced

function ok(res: Response, data: unknown, message = 'OK', status = 200) {
  return res.status(status).json({
    success: true,
    message,
    data,
    meta: { timestamp: new Date().toISOString() },
  });
}

function fail(
  res: Response,
  message: string,
  status = 400,
  errors?: Record<string, string[]>
) {
  return res.status(status).json({
    success: false,
    message,
    data: null,
    meta: { timestamp: new Date().toISOString() },
    ...(errors ? { errors } : {}),
  });
}

function getIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || '127.0.0.1';
}

function normalizePhone(val: string): string {
  return String(val || '').replace(/[^\d]/g, '').slice(-10);
}

function validateCustomerMobileValue(raw: unknown): { valid: boolean; normalized: string; message?: string } {
  const s = String(raw ?? '').trim();
  if (!s) {
    return { valid: false, normalized: '', message: 'Valid 10-digit mobile number is required.' };
  }
  const plus91Match = /^\+91[\s-]*(.*)$/.exec(s);
  if (plus91Match) {
    const body = plus91Match[1].replace(/[\s-]/g, '');
    if (!/^[0-9]{10}$/.test(body)) {
      return { valid: false, normalized: body.slice(0, 10), message: 'Mobile number must be exactly 10 digits.' };
    }
    return { valid: true, normalized: body };
  }
  if (/^\+[1-9][0-9]{9,13}$/.test(s)) {
    return { valid: true, normalized: s };
  }
  const compact = s.replace(/[\s-]/g, '');
  if (!/^[0-9]{10}$/.test(compact)) {
    return {
      valid: false,
      normalized: compact.replace(/\D/g, '').slice(0, 10),
      message: 'Valid 10-digit mobile number is required (0-9 only).',
    };
  }
  return { valid: true, normalized: compact };
}

function isSafeRemoteHttpsUrl(val: unknown): boolean {
  if (typeof val !== 'string') return false;
  const trimmed = val.trim();
  if (!trimmed) return false;
  if (/^(blob:|javascript:|data:|vbscript:)/i.test(trimmed)) return false;
  return /^(https:\/\/|\/api\/erp\/storage\/files\/)[^\s]+$/i.test(trimmed);
}

function resolveLocalUploadsDir(): string {
  const custom = process.env.MUN_UPLOADS_DIR?.trim();
  const preferred = custom
    ? path.resolve(custom)
    : path.resolve(process.cwd(), 'storage', 'uploads');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    const tmpDir = '/tmp/mun-erp-uploads';
    fs.mkdirSync(tmpDir, { recursive: true });
    return tmpDir;
  }
}

function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function registerErpRoutes(
  app: Express,
  securityStore: SecurityStore,
  p3: Phase03Store,
  erp: ErpStore,
  requireAuth: (req: AuthedRequest, res: Response, next: () => void) => void,
  financeStore?: FinanceStore
) {
  const reservedCustomerIds = new Set<string>();
  const checkPerm = (
    req: AuthedRequest,
    res: Response,
    mod: ModuleKey,
    perm: PermissionType
  ): ServerUser | null => {
    const actor = req.authUser;
    if (!actor) {
      fail(res, 'Authentication required.', 401);
      return null;
    }
    if (!securityStore.hasPermission(actor, mod, perm)) {
      securityStore.addSecurityLog({
        actorUserId: actor.userId,
        eventType: 'UNAUTHORIZED_ACCESS',
        result: 'BLOCKED',
        ipAddress: getIp(req),
        deviceInfo: String(req.headers['user-agent'] || 'Client').slice(0, 120),
        summary: `Blocked ${actor.role} access to ERP ${mod}.${perm} (${req.method} ${req.path}).`,
      });
      fail(res, `Forbidden: ${actor.role} lacks ${mod}.${perm} permission.`, 403);
      return null;
    }
    return actor;
  };

  const getStaffAssignedCounterCodes = (userId: string): Set<string> => {
    const set = new Set<string>();
    for (const ctr of p3.counters) {
      if (ctr.assignedUserId === userId) set.add(ctr.counterCode);
    }
    return set;
  };

  const canAccessApplication = (actor: ServerUser, application: ErpApplication): boolean => {
    if (actor.role === 'ADMIN' || actor.role === 'MANAGER') return true;
    const myCounters = getStaffAssignedCounterCodes(actor.userId);
    if (application.assignedStaffId === actor.userId) return true;
    if (application.createdBy === actor.userId) return true;
    if (!application.assignedStaffId) return true; // Unassigned intake queue
    if (application.assignedCounterCode && myCounters.has(application.assignedCounterCode)) {
      return true;
    }
    return false;
  };

  const enrichApplication = (application: ErpApplication, includeInternalNotes = true) => {
    const checklist = erp.computeDocumentChecklist(application);
    const sla = erp.computeSlaStatus(application);
    const docs = erp.documents
      .filter((d) => d.applicationNo === application.applicationNo && !d.deletedAt)
      .map((d) => erp.sanitizePublicDocument(d));
    const appPayments = erp.payments.filter((p) => p.applicationNo === application.applicationNo);
    const appRefunds = erp.refunds.filter((r) => r.applicationNo === application.applicationNo);
    const totalPaid = round2(
      appPayments
        .filter((p) => p.verificationStatus === 'Confirmed')
        .reduce((acc, p) => acc + p.amount, 0)
    );
    const totalRefunded = round2(
      appRefunds
        .filter((r) => r.status === 'Processed')
        .reduce((acc, r) => acc + r.refundAmount, 0)
    );
    const totalDue = round2(
      Math.max(0, application.serviceSnapshot.customerChargeSnapshot - totalPaid)
    );
    const appFollowUps = erp.followUps.filter((f) => f.applicationNo === application.applicationNo);
    const appNotes = erp.notes.filter(
      (n) =>
        n.applicationNo === application.applicationNo &&
        (includeInternalNotes ? true : n.noteType === 'CUSTOMER_REMARK')
    );
    const delivery =
      erp.deliveries.find((d) => d.applicationNo === application.applicationNo) || null;
    const cancellations = erp.cancellationRequests.filter(
      (c) => c.applicationNo === application.applicationNo
    );
    const reassignments = erp.reassignmentRequests.filter(
      (r) => r.applicationNo === application.applicationNo
    );
    const appNotifications = erp.notifications.filter(
      (n) => n.applicationNo === application.applicationNo
    );
    const appActivities = erp.activities.filter(
      (a) => a.applicationNo === application.applicationNo
    );

    return {
      ...application,
      checklistSummary: checklist,
      slaStatus: sla,
      documents: docs,
      financialSummary: {
        serviceCharge: application.serviceSnapshot.customerChargeSnapshot,
        serviceCost: application.serviceSnapshot.serviceCostSnapshot,
        profitAmount: application.serviceSnapshot.profitSnapshot,
        totalPaid,
        totalRefunded,
        netCollected: round2(Math.max(0, totalPaid - totalRefunded)),
        balanceDue: totalDue,
        paymentStatus:
          totalPaid === 0
            ? 'Unpaid'
            : totalDue <= 0
              ? totalRefunded > 0
                ? 'Refunded'
                : 'Fully Paid'
              : 'Partially Paid',
      },
      payments: appPayments,
      refunds: appRefunds,
      followUps: appFollowUps,
      notes: appNotes,
      delivery,
      cancellations,
      reassignments,
      notifications: appNotifications,
      activities: appActivities,
    };
  };

  // ==========================================================================
  // 1. CUSTOMER MANAGEMENT & CRM ROUTES
  // ==========================================================================
  app.get('/api/erp/customers', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'customers', 'VIEW');
    if (!actor) return;

    const search = String(req.query.q ?? '').trim().toLowerCase();
    const status = String(req.query.status ?? '').trim();
    const segment = String(req.query.segment ?? '').trim();
    const includeDeleted = String(req.query.includeDeleted ?? '') === 'true';

    const filtered = erp.customers.filter((c) => {
      const archived = Boolean(c.deletedAt || c.isArchived);
      if (!includeDeleted && archived) return false;
      if (status && c.status !== status) return false;
      if (segment && c.segment !== segment) return false;
      if (search) {
        const hay = [
          c.customerId,
          c.fullName,
          c.fatherOrHusbandName,
          c.mobile,
          c.whatsapp,
          c.village,
          c.email,
          c.panNumber ?? '',
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    const data = filtered.map((c) => {
      const sanitized = erp.sanitizePublicCustomer(c);
      const custApps = erp.applications.filter(
        (a) => a.customerId === c.customerId && !a.archivedAt
      );
      const custPayments = erp.payments.filter(
        (p) => p.customerId === c.customerId && p.verificationStatus === 'Confirmed'
      );
      const totalBilled = round2(
        custApps
          .filter((a) => a.status !== 'Cancelled')
          .reduce((acc, a) => acc + a.serviceSnapshot.customerChargeSnapshot, 0)
      );
      const totalPaid = round2(custPayments.reduce((acc, p) => acc + p.amount, 0));
      return {
        ...sanitized,
        name: sanitized.fullName,
        pan: sanitized.panNumber ?? '',
        aadhaar: sanitized.aadhaarMasked ?? '',
        totalBusiness: totalPaid,
        isArchived: Boolean(c.deletedAt || c.isArchived),
        stats: {
          applicationCount: custApps.length,
          activeApplications: custApps.filter(
            (a) => !['Completed', 'Cancelled', 'Rejected'].includes(a.status)
          ).length,
          totalPaid,
          pendingBalance: round2(Math.max(0, totalBilled - totalPaid)),
        },
      };
    });

    return ok(res, data);
  });

  app.get('/api/erp/customers/:customerId', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'customers', 'VIEW');
    if (!actor) return;

    const customer = erp.customers.find((c) => c.customerId === req.params.customerId);
    if (!customer) return fail(res, 'Customer not found.', 404);

    const custApps = erp.applications
      .filter((a) => a.customerId === customer.customerId && (canAccessApplication(actor, a)))
      .map((a) => enrichApplication(a, true));
    const custDocs = erp.documents
      .filter((d) => d.customerId === customer.customerId && !d.deletedAt)
      .map((d) => erp.sanitizePublicDocument(d));
    const custPayments = erp.payments.filter((p) => p.customerId === customer.customerId);
    const custRefunds = erp.refunds.filter((r) => r.customerId === customer.customerId);
    const custDeliveries = erp.deliveries.filter((d) => d.customerId === customer.customerId);
    const custFollowUps = erp.followUps.filter((f) =>
      custApps.some((a) => a.applicationNo === f.applicationNo)
    );
    const custNotifs = erp.notifications.filter((n) => n.customerId === customer.customerId);

    return ok(res, {
      customer: erp.sanitizePublicCustomer(customer),
      applications: custApps,
      documents: custDocs,
      payments: custPayments,
      refunds: custRefunds,
      deliveries: custDeliveries,
      followUps: custFollowUps,
      notifications: custNotifs,
    });
  });

  app.post('/api/erp/customers/reserve-id', requireAuth, async (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'customers', 'ADD');
    if (!actor) return;

    const b = req.body ?? {};
    const errors: Record<string, string[]> = {};
    const fullName = sanitizeText(String(b.fullName ?? ''));
    const rawMobile = String(b.mobile ?? '').trim();
    const village = sanitizeText(String(b.village ?? ''));
    const mobileCheck = validateCustomerMobileValue(rawMobile);
    if (fullName && fullName.length < 2) errors.fullName = ['Customer full name must be at least 2 characters.'];
    if (rawMobile && !mobileCheck.valid) errors.mobile = [mobileCheck.message || 'Valid 10-digit mobile number is required.'];
    if (village && village.length < 2) errors.village = ['Village / Locality is required.'];

    const rawAadhaar = b.aadhaarNumber ? String(b.aadhaarNumber).replace(/[\s-]/g, '') : '';
    if (rawAadhaar && !/^\d{12}$/.test(rawAadhaar)) {
      errors.aadhaarNumber = ['Aadhaar must be exactly 12 digits.'];
    }
    const rawPin = b.pinCode !== undefined ? String(b.pinCode).trim() : '';
    if (rawPin && !/^\d{6}$/.test(rawPin)) {
      errors.pinCode = ['PIN Code must be exactly 6 digits.'];
    }
    const rawPan = (b.panNumber ?? b.pan) ? String(b.panNumber ?? b.pan).trim().toUpperCase() : '';
    if (rawPan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(rawPan)) {
      errors.panNumber = ['PAN must follow standard format AAAAA9999A.'];
    }
    if (Object.keys(errors).length > 0) {
      return fail(res, 'Customer validation failed.', 422, errors);
    }

    if (rawMobile) {
      const normMob = normalizePhone(mobileCheck.normalized);
      const dupMob = erp.customers.find(
        (c) => !c.deletedAt && normalizePhone(c.mobile) === normMob
      );
      const dupAadhaar = rawAadhaar
        ? erp.customers.find((c) => {
            if (c.deletedAt || !c.aadhaarEncrypted) return false;
            try {
              return decryptSensitiveField(c.aadhaarEncrypted) === rawAadhaar;
            } catch {
              return false;
            }
          })
        : undefined;

      if ((dupMob || dupAadhaar) && !b.overrideDuplicateReason) {
        return fail(
          res,
          `Potential duplicate customer detected (${dupMob ? dupMob.customerId + ' matches mobile' : dupAadhaar!.customerId + ' matches Aadhaar'}). Provide authorized override reason to create anyway.`,
          409
        );
      }
      if ((dupMob || dupAadhaar) && b.overrideDuplicateReason && actor.role === 'STAFF') {
        return fail(res, 'Only Manager or Admin may authorize duplicate Customer override.', 403);
      }
    }

    const minSequence = Math.max(0, Math.floor(Number(b.minSequence) || 0));
    if (minSequence > 0) {
      p3.docSequence.seed('CUSTOMER', 'MCC', p3.docSequence.getCurrentFinancialYear(), minSequence);
    }

    const customerId = await p3.docSequence.allocateNext('CUSTOMER', 'MCC');
    reservedCustomerIds.add(customerId);
    const referenceNo = `MCR-${customerId.replace(/^MCC-/, '')}`;
    return ok(res, { customerId, referenceNo }, `Reserved Customer ID ${customerId}.`);
  });

  app.post('/api/erp/customers', requireAuth, async (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'customers', 'ADD');
    if (!actor) return;

    const b = req.body ?? {};
    const errors: Record<string, string[]> = {};
    const fullName = sanitizeText(String(b.fullName ?? ''));
    const rawMobile = String(b.mobile ?? '').trim();
    const mobileCheck = validateCustomerMobileValue(rawMobile);
    const mobile = mobileCheck.valid ? mobileCheck.normalized : sanitizeText(rawMobile);
    const village = sanitizeText(String(b.village ?? ''));
    if (fullName.length < 2) errors.fullName = ['Customer full name is required.'];
    if (!mobileCheck.valid) errors.mobile = [mobileCheck.message || 'Valid 10-digit mobile number is required.'];
    if (village.length < 2) errors.village = ['Village / Locality is required.'];

    const rawWhatsapp = b.whatsapp !== undefined && b.whatsapp !== null ? String(b.whatsapp).trim() : '';
    if (rawWhatsapp) {
      const waCheck = validateCustomerMobileValue(rawWhatsapp);
      if (!waCheck.valid) {
        errors.whatsapp = ['WhatsApp number must be exactly 10 digits.'];
      }
    }

    let aadhaarEncrypted: string | undefined;
    let aadhaarLast4: string | undefined;
    const rawAadhaar = b.aadhaarNumber ? String(b.aadhaarNumber).replace(/[\s-]/g, '') : '';
    if (rawAadhaar) {
      if (!/^\d{12}$/.test(rawAadhaar)) {
        errors.aadhaarNumber = ['Aadhaar must be exactly 12 digits.'];
      } else {
        aadhaarEncrypted = encryptSensitiveField(rawAadhaar);
        aadhaarLast4 = rawAadhaar.slice(-4);
      }
    }

    const rawPin = b.pinCode !== undefined && b.pinCode !== null ? String(b.pinCode).trim() : '';
    if (rawPin && !/^\d{6}$/.test(rawPin)) {
      errors.pinCode = ['PIN Code must be exactly 6 digits.'];
    }

    const rawPan = (b.panNumber ?? b.pan) ? sanitizeText(String(b.panNumber ?? b.pan).toUpperCase()) : '';
    if (rawPan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(rawPan)) {
      errors.panNumber = ['PAN must follow standard format AAAAA9999A (e.g., ABCDE1234F).'];
    }

    const rawPhotoUrl = String(b.photoDownloadURL ?? b.photoUrl ?? '').trim();
    const rawPhotoStoragePath = sanitizeText(String(b.photoStoragePath ?? '')).slice(0, 300);
    if (rawPhotoUrl && !isSafeRemoteHttpsUrl(rawPhotoUrl)) {
      errors.photoDownloadURL = ['Photograph URL must be a valid HTTPS Firebase Storage download URL.'];
    }

    if (Object.keys(errors).length > 0) {
      return fail(res, 'Customer validation failed.', 422, errors);
    }

    // Duplicate Mobile & Aadhaar Check (Rule 11/20)
    const normMob = normalizePhone(mobile);
    const dupMob = erp.customers.find(
      (c) => !c.deletedAt && normalizePhone(c.mobile) === normMob
    );
    const dupAadhaar = aadhaarLast4
      ? erp.customers.find((c) => {
          if (c.deletedAt || !c.aadhaarEncrypted) return false;
          try {
            return decryptSensitiveField(c.aadhaarEncrypted) === rawAadhaar;
          } catch {
            return false;
          }
        })
      : undefined;

    if ((dupMob || dupAadhaar) && !b.overrideDuplicateReason) {
      return fail(
        res,
        `Potential duplicate customer detected (${dupMob ? dupMob.customerId + ' matches mobile' : dupAadhaar!.customerId + ' matches Aadhaar'}). Provide authorized override reason to create anyway.`,
        409
      );
    }

    if ((dupMob || dupAadhaar) && b.overrideDuplicateReason && actor.role === 'STAFF') {
      return fail(
        res,
        'Only Manager or Admin may authorize duplicate Customer override.',
        403
      );
    }

    const requestedReservedId =
      typeof b.reservedCustomerId === 'string' ? b.reservedCustomerId.trim() : '';
    const isWellFormedCustomerId = /^MCC-\d{4}-\d{2}-\d{6}$/.test(requestedReservedId);
    let customerId: string;
    if (
      requestedReservedId &&
      (reservedCustomerIds.has(requestedReservedId) || isWellFormedCustomerId) &&
      !erp.customers.some((c) => c.customerId === requestedReservedId)
    ) {
      reservedCustomerIds.delete(requestedReservedId);
      customerId = requestedReservedId;
      const seqMatch = /^MCC-(\d{4}-\d{2})-(\d{6})$/.exec(customerId);
      if (seqMatch) {
        p3.docSequence.seed('CUSTOMER', 'MCC', seqMatch[1], Number(seqMatch[2]));
      }
    } else {
      customerId = await p3.docSequence.allocateNext('CUSTOMER', 'MCC');
    }

    const referenceNo = sanitizeText(
      String(b.referenceNo || `MCR-${customerId.replace(/^MCC-/, '')}`)
    ).slice(0, 64);

    const now = new Date().toISOString();
    const presentAddress = sanitizeText(String(b.presentAddress ?? `${village}, ${b.district || 'Murshidabad'}`));
    const sameAsPresent = b.sameAsPresent !== false;
    const permanentAddress = sameAsPresent
      ? presentAddress
      : sanitizeText(String(b.permanentAddress ?? presentAddress));

    const hasExplicitConsents = Array.isArray(b.consents);
    const requestedConsents = hasExplicitConsents ? b.consents : [];
    const consents = DEFAULT_CONSENT_DEFINITIONS.map((def) => {
      const matched = requestedConsents.find((rc: { category?: string }) => rc?.category === def.category);
      const granted = hasExplicitConsents ? Boolean(matched?.granted) : true;
      return {
        category: def.category,
        label: def.label,
        granted,
        recordedAt: granted ? now : null,
        recordedBy: actor.userId,
        verificationMethod: (granted ? matched?.verificationMethod || 'Digital Signature' : 'Not Set') as
          | 'Digital Signature'
          | 'Printed Signed Form'
          | 'OTP Confirmed'
          | 'Not Set',
      };
    });

    const allowedSegments = ['Regular', 'General', 'VIP', 'Individual', 'Corporate', 'Government'];
    const resolvedSegment = (
      allowedSegments.includes(String(b.segment)) ? String(b.segment) : 'Regular'
    ) as ErpCustomer['segment'];

    const normalizedWa = rawWhatsapp ? validateCustomerMobileValue(rawWhatsapp).normalized : mobile;

    const newCustomer: ErpCustomer = {
      id: erp.nextNumericId('customer'),
      customerId,
      referenceNo,
      fullName,
      fatherOrHusbandName: sanitizeText(String(b.fatherOrHusbandName ?? '')),
      dob: sanitizeText(String(b.dob ?? '')),
      gender: (['Male', 'Female', 'Other'].includes(String(b.gender)) ? b.gender : 'Male') as ErpCustomer['gender'],
      mobile,
      whatsapp: normalizedWa || mobile,
      email: sanitizeText(String(b.email ?? '')),
      aadhaarEncrypted,
      aadhaarLast4,
      panNumber: rawPan || undefined,
      voterId: b.voterId ? sanitizeText(String(b.voterId).toUpperCase()) : undefined,
      village,
      postOffice: sanitizeText(String(b.postOffice ?? '')),
      policeStation: sanitizeText(String(b.policeStation ?? '')),
      district: sanitizeText(String(b.district ?? 'Murshidabad')),
      pinCode: rawPin,
      presentAddress,
      permanentAddress,
      sameAsPresent,
      photoStoragePath: rawPhotoStoragePath || undefined,
      photoDownloadURL: rawPhotoUrl || undefined,
      photoUrl: rawPhotoUrl || undefined,
      segment: resolvedSegment,
      crmTag: resolvedSegment === 'VIP' ? 'VIP' : 'New',
      status: 'Active',
      verificationStatus: consents.every((c) => c.category === 'PROMOTIONAL_CONSENT' || c.granted)
        ? 'Consent Verified'
        : 'Unverified',
      mobileOtpVerifiedAt: null,
      consents,
      consentHistory: [],
      contactHistory: [],
      notesAndFollowUps: [],
      statusHistory: [],
      isArchived: false,
      deletedAt: null,
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    };

    erp.customers.unshift(newCustomer);
    void syncErpCustomerToFirebase(newCustomer);

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: b.overrideDuplicateReason ? 'CREATE_CUSTOMER_DUPLICATE_OVERRIDE' : 'CREATE_CUSTOMER',
      newValue: newCustomer.customerId,
      reason: b.overrideDuplicateReason ? sanitizeText(String(b.overrideDuplicateReason)) : 'Customer registered',
      ipAddress: getIp(req),
    });

    const sanitizedNew = erp.sanitizePublicCustomer(newCustomer);
    return ok(
      res,
      {
        ...sanitizedNew,
        name: sanitizedNew.fullName,
        pan: sanitizedNew.panNumber ?? '',
        aadhaar: sanitizedNew.aadhaarMasked ?? '',
        totalBusiness: 0,
        isArchived: false,
      },
      `Customer ${customerId} registered.`,
      201
    );
  });

  app.put('/api/erp/customers/:customerId', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'customers', 'EDIT');
    if (!actor) return;

    const customer = erp.customers.find((c) => c.customerId === req.params.customerId);
    if (!customer) return fail(res, 'Customer not found.', 404);

    const b = req.body ?? {};
    const errors: Record<string, string[]> = {};
    if (typeof b.pinCode === 'string' && b.pinCode.trim() && !/^\d{6}$/.test(b.pinCode.trim())) {
      errors.pinCode = ['PIN Code must be exactly 6 digits.'];
    }
    if (typeof b.panNumber === 'string' || typeof b.pan === 'string') {
      const nextPan = sanitizeText(String(b.panNumber ?? b.pan ?? '').toUpperCase());
      if (nextPan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(nextPan)) {
        errors.panNumber = ['PAN must follow standard format AAAAA9999A.'];
      }
    }
    const nextPhotoUrl =
      typeof b.photoDownloadURL === 'string'
        ? b.photoDownloadURL.trim()
        : typeof b.photoUrl === 'string'
        ? b.photoUrl.trim()
        : undefined;
    if (nextPhotoUrl && !isSafeRemoteHttpsUrl(nextPhotoUrl)) {
      errors.photoDownloadURL = ['Photograph URL must be a valid HTTPS download URL.'];
    }
    if (Object.keys(errors).length > 0) {
      return fail(res, 'Customer validation failed.', 422, errors);
    }

    if (typeof b.fullName === 'string' && b.fullName.trim().length >= 2) {
      customer.fullName = sanitizeText(b.fullName);
    }
    if (typeof b.fatherOrHusbandName === 'string') {
      customer.fatherOrHusbandName = sanitizeText(b.fatherOrHusbandName);
    }
    if (typeof b.dob === 'string') customer.dob = sanitizeText(b.dob);
    if (['Male', 'Female', 'Other'].includes(String(b.gender))) customer.gender = b.gender;
    if (typeof b.email === 'string') customer.email = sanitizeText(b.email);
    if (typeof b.village === 'string' && b.village.trim()) customer.village = sanitizeText(b.village);
    if (typeof b.postOffice === 'string') customer.postOffice = sanitizeText(b.postOffice);
    if (typeof b.policeStation === 'string') customer.policeStation = sanitizeText(b.policeStation);
    if (typeof b.district === 'string') customer.district = sanitizeText(b.district);
    if (typeof b.pinCode === 'string') customer.pinCode = sanitizeText(b.pinCode.trim());
    if (typeof b.presentAddress === 'string') customer.presentAddress = sanitizeText(b.presentAddress);
    if (typeof b.sameAsPresent === 'boolean') customer.sameAsPresent = b.sameAsPresent;
    if (typeof b.permanentAddress === 'string') {
      customer.permanentAddress = customer.sameAsPresent
        ? customer.presentAddress
        : sanitizeText(b.permanentAddress);
    }
    if (typeof b.panNumber === 'string' || typeof b.pan === 'string') {
      const nextPan = sanitizeText(String(b.panNumber ?? b.pan ?? '').toUpperCase());
      customer.panNumber = nextPan || undefined;
    }
    if (typeof b.photoStoragePath === 'string') {
      customer.photoStoragePath = sanitizeText(b.photoStoragePath).slice(0, 300) || undefined;
    }
    if (nextPhotoUrl !== undefined) {
      customer.photoDownloadURL = nextPhotoUrl || undefined;
      customer.photoUrl = nextPhotoUrl || undefined;
    }
    if (['Regular', 'General', 'VIP', 'Individual', 'Corporate', 'Government'].includes(String(b.segment))) {
      customer.segment = b.segment;
      if (b.segment === 'VIP') customer.crmTag = 'VIP';
    }
    if (typeof b.crmTag === 'string') customer.crmTag = b.crmTag;

    if (['Active', 'Inactive', 'Blocked'].includes(String(b.status)) && b.status !== customer.status) {
      customer.statusHistory.unshift({
        previousStatus: customer.status,
        newStatus: b.status,
        changedBy: actor.userId,
        reason: sanitizeText(String(b.statusReason ?? 'Status updated by operator')),
        changedAt: new Date().toISOString(),
      });
      customer.status = b.status;
    }

    customer.updatedAt = new Date().toISOString();
    void syncErpCustomerToFirebase(customer);
    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'UPDATE_CUSTOMER',
      newValue: customer.customerId,
      ipAddress: getIp(req),
    });

    return ok(res, erp.sanitizePublicCustomer(customer), 'Customer profile updated.');
  });

  // Mobile / WhatsApp OTP Verification & Change
  app.post('/api/erp/customers/:customerId/verify-mobile', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'customers', 'EDIT');
    if (!actor) return;

    const customer = erp.customers.find((c) => c.customerId === req.params.customerId);
    if (!customer) return fail(res, 'Customer not found.', 404);

    const { newMobile, newWhatsapp, verificationToken, adminOverrideReason } = req.body ?? {};

    let verifiedByOtp = false;
    if (verificationToken) {
      const challenge = securityStore.otpChallenges.get(String(verificationToken));
      if (!challenge || !challenge.verified || challenge.purpose !== 'MOBILE_VERIFICATION') {
        return fail(res, 'Mobile verification OTP token is invalid or not verified.', 422);
      }
      verifiedByOtp = true;
    } else if (!adminOverrideReason || actor.role !== 'ADMIN') {
      return fail(
        res,
        'OTP verification token is required (only Admin may override with documented reason).',
        422
      );
    }

    const now = new Date().toISOString();
    if (newMobile && normalizePhone(newMobile) !== normalizePhone(customer.mobile)) {
      customer.contactHistory.unshift({
        id: customer.contactHistory.length + 1,
        field: 'mobile',
        oldValue: customer.mobile,
        newValue: sanitizeText(String(newMobile)),
        verifiedByOtp,
        adminOverrideReason: adminOverrideReason ? sanitizeText(String(adminOverrideReason)) : undefined,
        changedBy: actor.userId,
        changedAt: now,
      });
      customer.mobile = sanitizeText(String(newMobile));
    }
    if (newWhatsapp && normalizePhone(newWhatsapp) !== normalizePhone(customer.whatsapp)) {
      customer.contactHistory.unshift({
        id: customer.contactHistory.length + 1,
        field: 'whatsapp',
        oldValue: customer.whatsapp,
        newValue: sanitizeText(String(newWhatsapp)),
        verifiedByOtp,
        adminOverrideReason: adminOverrideReason ? sanitizeText(String(adminOverrideReason)) : undefined,
        changedBy: actor.userId,
        changedAt: now,
      });
      customer.whatsapp = sanitizeText(String(newWhatsapp));
    }

    if (verifiedByOtp) {
      customer.mobileOtpVerifiedAt = now;
      const coreConsentsGranted = customer.consents
        .filter((c) => c.category !== 'PROMOTIONAL_CONSENT')
        .some((c) => c.granted);
      customer.verificationStatus = coreConsentsGranted ? 'Fully Verified' : 'Mobile Verified';
    }
    customer.updatedAt = now;
    void syncErpCustomerToFirebase(customer);

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: verifiedByOtp ? 'CUSTOMER_MOBILE_OTP_VERIFIED' : 'CUSTOMER_CONTACT_ADMIN_OVERRIDE',
      newValue: `${customer.customerId} -> ${customer.mobile}`,
      reason: adminOverrideReason ? sanitizeText(String(adminOverrideReason)) : 'OTP verified',
      ipAddress: getIp(req),
    });

    return ok(res, erp.sanitizePublicCustomer(customer), 'Customer contact verification recorded.');
  });

  // 7 Separate Customer Consent Categories Update
  app.put('/api/erp/customers/:customerId/consents', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'customers', 'EDIT');
    if (!actor) return;

    const customer = erp.customers.find((c) => c.customerId === req.params.customerId);
    if (!customer) return fail(res, 'Customer not found.', 404);

    const { updates, verificationMethod, notes } = req.body ?? {};
    if (!Array.isArray(updates) || updates.length === 0) {
      return fail(res, 'Consent updates array is required.', 422);
    }

    const now = new Date().toISOString();
    const method = ['Digital Signature', 'Printed Signed Form', 'OTP Confirmed'].includes(
      String(verificationMethod)
    )
      ? verificationMethod
      : 'Digital Signature';

    for (const upd of updates) {
      const cat = upd.category as ConsentCategoryKey;
      const existing = customer.consents.find((c) => c.category === cat);
      if (!existing) continue;
      const newVal = Boolean(upd.granted);
      if (existing.granted !== newVal) {
        customer.consentHistory.unshift({
          id: customer.consentHistory.length + 1,
          category: cat,
          previousGranted: existing.granted,
          newGranted: newVal,
          actorUserId: actor.userId,
          method,
          notes: sanitizeText(String(notes ?? 'Customer consent updated')),
          recordedAt: now,
        });
      }
      existing.granted = newVal;
      existing.recordedAt = now;
      existing.recordedBy = actor.userId;
      existing.verificationMethod = method;
    }

    const privacyOk = customer.consents.find((c) => c.category === 'DATA_PRIVACY_CONSENT')?.granted;
    if (customer.mobileOtpVerifiedAt && privacyOk) {
      customer.verificationStatus = 'Fully Verified';
    } else if (privacyOk) {
      customer.verificationStatus = 'Consent Verified';
    }
    customer.updatedAt = now;
    void syncErpCustomerToFirebase(customer);

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'UPDATE_CUSTOMER_CONSENTS',
      newValue: customer.customerId,
      reason: sanitizeText(String(notes ?? method)),
      ipAddress: getIp(req),
    });

    return ok(res, erp.sanitizePublicCustomer(customer), 'Customer consent preferences saved.');
  });

  app.post('/api/erp/customers/:customerId/notes', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'customers', 'EDIT');
    if (!actor) return;

    const customer = erp.customers.find((c) => c.customerId === req.params.customerId);
    if (!customer) return fail(res, 'Customer not found.', 404);

    const { type, text, followUpDate, status } = req.body ?? {};
    if (!text || String(text).trim().length < 2) {
      return fail(res, 'Note text is required.', 422);
    }

    customer.notesAndFollowUps.unshift({
      id: customer.notesAndFollowUps.length + 1,
      type: type === 'FOLLOW_UP' ? 'FOLLOW_UP' : 'INTERNAL_NOTE',
      text: sanitizeText(String(text)),
      followUpDate: followUpDate ? sanitizeText(String(followUpDate)) : undefined,
      status: type === 'FOLLOW_UP' ? status || 'Pending' : undefined,
      assignedStaffId: actor.userId,
      authorUserId: actor.userId,
      createdAt: new Date().toISOString(),
    });
    customer.updatedAt = new Date().toISOString();
    void syncErpCustomerToFirebase(customer);

    return ok(res, erp.sanitizePublicCustomer(customer), 'Customer CRM note added.', 201);
  });

  app.get('/api/erp/customers/:customerId/aadhaar', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN') {
      return fail(res, 'Only ADMIN is authorized to decrypt customer Aadhaar numbers.', 403);
    }
    const customer = erp.customers.find((c) => c.customerId === req.params.customerId);
    if (!customer || !customer.aadhaarEncrypted) {
      return fail(res, 'No Aadhaar stored for this customer.', 404);
    }
    const plain = decryptSensitiveField(customer.aadhaarEncrypted);
    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'AUTHORIZED_CUSTOMER_AADHAAR_DECRYPT',
      newValue: customer.customerId,
      reason: 'Authorized Admin verification (number omitted from logs)',
      ipAddress: getIp(req),
    });
    return ok(res, {
      customerId: customer.customerId,
      aadhaarFormatted: `${plain.slice(0, 4)}-${plain.slice(4, 8)}-${plain.slice(8, 12)}`,
    });
  });

  app.post('/api/erp/customers/:customerId/soft-delete', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'customers', 'DELETE');
    if (!actor) return;
    const customer = erp.customers.find((c) => c.customerId === req.params.customerId);
    if (!customer) return fail(res, 'Customer not found.', 404);
    customer.isArchived = true;
    customer.deletedAt = new Date().toISOString();
    customer.deletedBy = actor.userId;
    customer.updatedAt = customer.deletedAt;
    void syncErpCustomerToFirebase(customer);
    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'SOFT_DELETE_CUSTOMER',
      newValue: customer.customerId,
      reason: sanitizeText(String(req.body?.reason ?? 'Archived by Admin')),
      ipAddress: getIp(req),
    });
    return ok(res, { archived: true, customerId: customer.customerId }, 'Customer archived (soft deleted).');
  });

  app.post('/api/erp/customers/:customerId/restore', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'customers', 'DELETE');
    if (!actor) return;
    const customer = erp.customers.find((c) => c.customerId === req.params.customerId);
    if (!customer) return fail(res, 'Customer not found.', 404);
    customer.isArchived = false;
    customer.deletedAt = null;
    customer.deletedBy = null;
    customer.updatedAt = new Date().toISOString();
    void syncErpCustomerToFirebase(customer);
    return ok(res, erp.sanitizePublicCustomer(customer), 'Customer restored from archive.');
  });

  app.delete('/api/erp/customers/:customerId', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'customers', 'DELETE');
    if (!actor) return;
    if (actor.role !== 'ADMIN') {
      return fail(res, 'Only ADMIN can permanently delete customers.', 403);
    }
    const customerId = decodeURIComponent(req.params.customerId);
    const idx = erp.customers.findIndex((c) => c.customerId === customerId);
    if (idx === -1) return fail(res, 'Customer not found.', 404);

    const hasActiveApps = erp.applications.some(
      (a) => a.customerId === customerId && !a.archivedAt
    );
    const hasConfirmedPayments = erp.payments.some(
      (p) => p.customerId === customerId && p.verificationStatus === 'Confirmed'
    );
    if (hasActiveApps || hasConfirmedPayments) {
      return fail(
        res,
        'Cannot permanently delete customer with active applications or confirmed financial payments. Archive the customer or linked applications first.',
        409
      );
    }

    const removed = erp.customers.splice(idx, 1)[0];
    erp.deletedCustomerIds.add(removed.customerId);
    void deleteErpCustomerFromFirebaseAdmin(removed.customerId);
    // Clean up archived-only linked drafts if any
    erp.applications = erp.applications.filter((a) => a.customerId !== removed.customerId);
    erp.documents = erp.documents.filter((d) => d.customerId !== removed.customerId);

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'DELETE_CUSTOMER_PERMANENT',
      newValue: removed.customerId,
      reason: sanitizeText(String(req.body?.reason ?? 'Permanently deleted by Admin')),
      ipAddress: getIp(req),
    });
    securityStore.addSecurityLog({
      actorUserId: actor.userId,
      eventType: 'CUSTOMER_DELETED',
      result: 'SUCCESS',
      ipAddress: getIp(req),
      deviceInfo: String(req.headers['user-agent'] || 'Client').slice(0, 120),
      summary: `Permanently deleted customer ${removed.customerId} (${removed.fullName}).`,
    });
    return ok(
      res,
      { deleted: true, customerId: removed.customerId },
      `Customer ${removed.customerId} deleted permanently.`
    );
  });

  app.get('/api/erp/tombstones', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    const canView =
      actor.role === 'ADMIN' ||
      actor.role === 'MANAGER' ||
      securityStore.hasPermission(actor, 'services', 'VIEW') ||
      securityStore.hasPermission(actor, 'customers', 'VIEW');
    if (!canView) return fail(res, 'Forbidden.', 403);
    return ok(res, erp.getTombstones());
  });

  // Idempotent customer rehydration across serverless cold starts or multi-instance requests
  app.post('/api/erp/customers/sync', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'customers', 'VIEW');
    if (!actor) return;

    const rawList = Array.isArray(req.body?.customers) ? req.body.customers.slice(0, 500) : [];
    const canEditExisting = securityStore.hasPermission(actor, 'customers', 'EDIT');
    const skippedTombstonedIds: string[] = [];
    const syncedRecords: ErpCustomer[] = [];
    const allowedSegments = new Set(['Regular', 'General', 'VIP', 'Individual', 'Corporate', 'Government']);
    const allowedStatuses = new Set(['Active', 'Inactive', 'Blocked']);
    const allowedGenders = new Set(['Male', 'Female', 'Other']);

    for (const item of rawList) {
      if (!item || typeof item !== 'object') continue;
      const raw = item as Record<string, unknown>;
      const customerId = sanitizeText(String(raw.customerId ?? '')).slice(0, 64);
      if (!/^[A-Za-z0-9_-]{4,64}$/.test(customerId)) continue;

      if (erp.deletedCustomerIds.has(customerId)) {
        skippedTombstonedIds.push(customerId);
        continue;
      }

      const fullName = sanitizeText(String(raw.fullName ?? raw.name ?? '')).slice(0, 120);
      const mobileCheck = validateCustomerMobileValue(raw.mobile);
      if (fullName.length < 2 || !mobileCheck.valid) continue;

      const existing = erp.customers.find((c) => c.customerId === customerId);
      const now = new Date().toISOString();
      const rawPin = raw.pinCode ? String(raw.pinCode).trim() : '';
      const safePin = /^\d{6}$/.test(rawPin) ? rawPin : '';
      const rawPan = (raw.panNumber ?? raw.pan) ? sanitizeText(String(raw.panNumber ?? raw.pan).toUpperCase()) : '';
      const safePan = /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(rawPan) ? rawPan : undefined;
      const rawMasked = String(raw.aadhaarMasked ?? raw.aadhaar ?? '').trim();
      const maskedMatch = /(\d{4})$/.exec(rawMasked.replace(/\D/g, ''));
      const aadhaarLast4 = maskedMatch ? maskedMatch[1] : undefined;
      const rawPhotoUrl = String(raw.photoDownloadURL ?? raw.photoUrl ?? '').trim();
      const safePhotoUrl = isSafeRemoteHttpsUrl(rawPhotoUrl) ? rawPhotoUrl : undefined;
      const safePhotoPath = raw.photoStoragePath
        ? sanitizeText(String(raw.photoStoragePath)).slice(0, 300)
        : undefined;
      const deletedAt =
        typeof raw.deletedAt === 'string' && raw.deletedAt.trim().length > 0
          ? raw.deletedAt.trim()
          : null;
      const isArchived = Boolean(raw.isArchived || deletedAt);
      const segment = (allowedSegments.has(String(raw.segment))
        ? String(raw.segment)
        : 'Regular') as ErpCustomer['segment'];
      const status = (allowedStatuses.has(String(raw.status))
        ? String(raw.status)
        : 'Active') as ErpCustomer['status'];
      const gender = (allowedGenders.has(String(raw.gender))
        ? String(raw.gender)
        : 'Male') as ErpCustomer['gender'];

      const rawConsents = Array.isArray(raw.consents) ? raw.consents : [];
      const consents = DEFAULT_CONSENT_DEFINITIONS.map((def) => {
        const matched = rawConsents.find(
          (rc: unknown) =>
            rc && typeof rc === 'object' && (rc as { category?: string }).category === def.category
        ) as
          | {
              granted?: boolean;
              recordedAt?: string | null;
              recordedBy?: string;
              verificationMethod?: string;
            }
          | undefined;
        const granted = matched ? Boolean(matched.granted) : true;
        return {
          category: def.category,
          label: def.label,
          granted,
          recordedAt: matched?.recordedAt ?? (granted ? now : null),
          recordedBy: matched?.recordedBy || actor.userId,
          verificationMethod: (['Digital Signature', 'Printed Signed Form', 'OTP Confirmed', 'Not Set'].includes(
            String(matched?.verificationMethod)
          )
            ? matched!.verificationMethod
            : granted
            ? 'Digital Signature'
            : 'Not Set') as
            | 'Digital Signature'
            | 'Printed Signed Form'
            | 'OTP Confirmed'
            | 'Not Set',
        };
      });

      const referenceNo = sanitizeText(
        String(raw.referenceNo || `MCR-${customerId.replace(/^MCC-/, '')}`)
      ).slice(0, 64);

      if (!existing) {
        const village = sanitizeText(String(raw.village ?? 'Local Area')).slice(0, 120) || 'Local Area';
        const district = sanitizeText(String(raw.district ?? 'Murshidabad')).slice(0, 120) || 'Murshidabad';
        const presentAddress = sanitizeText(String(raw.presentAddress ?? `${village}, ${district}`)).slice(0, 300);
        const sameAsPresent = raw.sameAsPresent !== false;
        const permanentAddress = sameAsPresent
          ? presentAddress
          : sanitizeText(String(raw.permanentAddress ?? presentAddress)).slice(0, 300);
        const waCheck = raw.whatsapp ? validateCustomerMobileValue(raw.whatsapp) : null;

        const rawCrmTag = sanitizeText(String(raw.crmTag || (segment === 'VIP' ? 'VIP' : 'New')));
        const crmTag: ErpCustomer['crmTag'] = (
          [
            'New',
            'Regular',
            'VIP',
            'Active',
            'Inactive',
            'Follow-up Required',
            'Pending Payment',
            'Service Completed',
          ].includes(rawCrmTag)
            ? rawCrmTag
            : segment === 'VIP'
            ? 'VIP'
            : 'New'
        ) as ErpCustomer['crmTag'];
        const rawVerificationStatus = sanitizeText(
          String(raw.verificationStatus || 'Consent Verified')
        );
        const verificationStatus: ErpCustomer['verificationStatus'] = (
          [
            'Unverified',
            'Mobile Verified',
            'Consent Verified',
            'Fully Verified',
            'Verification Expired',
            'Re-verification Required',
          ].includes(rawVerificationStatus)
            ? rawVerificationStatus
            : 'Consent Verified'
        ) as ErpCustomer['verificationStatus'];

        const restoredCustomer: ErpCustomer = {
          id: erp.nextNumericId('customer'),
          customerId,
          referenceNo,
          fullName,
          fatherOrHusbandName: sanitizeText(String(raw.fatherOrHusbandName ?? '')).slice(0, 120),
          dob: sanitizeText(String(raw.dob ?? '')).slice(0, 32),
          gender,
          mobile: mobileCheck.normalized,
          whatsapp: waCheck?.valid ? waCheck.normalized : mobileCheck.normalized,
          email: sanitizeText(String(raw.email ?? '')).slice(0, 160),
          aadhaarLast4,
          panNumber: safePan,
          voterId: raw.voterId ? sanitizeText(String(raw.voterId).toUpperCase()).slice(0, 32) : undefined,
          village,
          postOffice: sanitizeText(String(raw.postOffice ?? '')).slice(0, 120),
          policeStation: sanitizeText(String(raw.policeStation ?? '')).slice(0, 120),
          district,
          pinCode: safePin,
          presentAddress,
          permanentAddress,
          sameAsPresent,
          photoStoragePath: safePhotoPath,
          photoDownloadURL: safePhotoUrl,
          photoUrl: safePhotoUrl,
          segment,
          crmTag,
          status,
          verificationStatus,
          mobileOtpVerifiedAt:
            typeof raw.mobileOtpVerifiedAt === 'string' ? raw.mobileOtpVerifiedAt : null,
          consents,
          consentHistory: Array.isArray(raw.consentHistory)
            ? (raw.consentHistory as ErpCustomer['consentHistory']).slice(0, 100)
            : [],
          contactHistory: Array.isArray(raw.contactHistory)
            ? (raw.contactHistory as ErpCustomer['contactHistory']).slice(0, 50)
            : [],
          notesAndFollowUps: Array.isArray(raw.notesAndFollowUps)
            ? (raw.notesAndFollowUps as ErpCustomer['notesAndFollowUps']).slice(0, 100)
            : [],
          statusHistory: Array.isArray(raw.statusHistory)
            ? (raw.statusHistory as ErpCustomer['statusHistory']).slice(0, 50)
            : [],
          isArchived,
          deletedAt,
          deletedBy: typeof raw.deletedBy === 'string' ? raw.deletedBy : null,
          createdBy: sanitizeText(String(raw.createdBy || actor.userId)).slice(0, 64),
          createdAt:
            typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : now,
          updatedAt:
            typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : now,
        };
        erp.customers.unshift(restoredCustomer);
        erp.seedCustomerSequenceFromId(customerId);
        syncedRecords.push(restoredCustomer);
        void syncErpCustomerToFirebase(restoredCustomer);
      } else if (canEditExisting) {
        const incomingTime = Date.parse(String(raw.updatedAt || raw.createdAt || '')) || 0;
        const existingTime = Date.parse(existing.updatedAt || existing.createdAt || '') || 0;
        if (incomingTime > existingTime) {
          existing.fullName = fullName;
          existing.referenceNo = existing.referenceNo || referenceNo;
          if (safePhotoPath && !existing.photoStoragePath) existing.photoStoragePath = safePhotoPath;
          if (safePhotoUrl && !existing.photoDownloadURL) {
            existing.photoDownloadURL = safePhotoUrl;
            existing.photoUrl = safePhotoUrl;
          }
          existing.segment = segment;
          existing.status = status;
          existing.isArchived = isArchived;
          existing.deletedAt = deletedAt;
          existing.updatedAt = String(raw.updatedAt);
          syncedRecords.push(existing);
          void syncErpCustomerToFirebase(existing);
        }
      }
    }

    if (syncedRecords.length > 0) {
      erp.customers.sort((a, b) => {
        const aTime = Date.parse(a.createdAt || '') || 0;
        const bTime = Date.parse(b.createdAt || '') || 0;
        if (bTime !== aTime) return bTime - aTime;
        return (b.id || 0) - (a.id || 0);
      });
    }

    return ok(
      res,
      {
        syncedCount: syncedRecords.length,
        skippedTombstonedIds,
        customers: syncedRecords.map((c) => erp.sanitizePublicCustomer(c)),
      },
      `Synchronized ${syncedRecords.length} customer record(s).`
    );
  });

  // Admin Customer Merge
  app.post('/api/erp/customers/merge', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN') {
      return fail(res, 'Only ADMIN can merge duplicate Customer accounts.', 403);
    }
    const { primaryCustomerId, duplicateCustomerId, reason } = req.body ?? {};
    if (!primaryCustomerId || !duplicateCustomerId || primaryCustomerId === duplicateCustomerId) {
      return fail(res, 'Distinct primaryCustomerId and duplicateCustomerId are required.', 422);
    }
    const primary = erp.customers.find((c) => c.customerId === primaryCustomerId && !c.deletedAt);
    const duplicate = erp.customers.find((c) => c.customerId === duplicateCustomerId && !c.deletedAt);
    if (!primary || !duplicate) {
      return fail(res, 'Both primary and duplicate active customers must exist.', 404);
    }

    let movedApps = 0;
    for (const a of erp.applications) {
      if (a.customerId === duplicate.customerId) {
        a.customerId = primary.customerId;
        a.customerSnapshot.customerId = primary.customerId;
        movedApps += 1;
      }
    }
    for (const p of erp.payments) {
      if (p.customerId === duplicate.customerId) p.customerId = primary.customerId;
    }
    for (const d of erp.documents) {
      if (d.customerId === duplicate.customerId) d.customerId = primary.customerId;
    }
    for (const r of erp.refunds) {
      if (r.customerId === duplicate.customerId) r.customerId = primary.customerId;
    }
    for (const del of erp.deliveries) {
      if (del.customerId === duplicate.customerId) del.customerId = primary.customerId;
    }

    primary.mergedFromCustomerIds = [...(primary.mergedFromCustomerIds ?? []), duplicate.customerId];
    duplicate.mergedIntoCustomerId = primary.customerId;
    duplicate.status = 'Inactive';
    duplicate.deletedAt = new Date().toISOString();
    duplicate.deletedBy = actor.userId;
    void syncErpCustomerToFirebase(primary);
    void syncErpCustomerToFirebase(duplicate);

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'MERGE_CUSTOMERS',
      previousValue: duplicate.customerId,
      newValue: primary.customerId,
      reason: sanitizeText(String(reason ?? `Merged ${movedApps} linked application(s) into ${primary.customerId}`)),
      ipAddress: getIp(req),
    });

    return ok(
      res,
      {
        primaryCustomer: erp.sanitizePublicCustomer(primary),
        mergedDuplicateId: duplicate.customerId,
        relinkedApplicationsCount: movedApps,
      },
      `Merged ${duplicate.customerId} into ${primary.customerId}.`
    );
  });

  // Bulk Customer CSV/Excel Import (Preview & Commit)
  app.post('/api/erp/customers/bulk-import', requireAuth, async (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'customers', 'ADD');
    if (!actor) return;

    const { rows, commit } = req.body ?? {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return fail(res, 'Rows array is required for customer bulk import.', 422);
    }

    const preview = [];
    const createdIds: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] ?? {};
      const fullName = sanitizeText(String(r.fullName ?? ''));
      const mobile = sanitizeText(String(r.mobile ?? ''));
      const village = sanitizeText(String(r.village ?? ''));
      const norm = normalizePhone(mobile);

      const rowErrors: string[] = [];
      if (fullName.length < 2) rowErrors.push('Full Name missing');
      if (norm.length < 10) rowErrors.push('Invalid 10-digit Mobile');
      if (village.length < 2) rowErrors.push('Village missing');
      if (
        norm.length >= 10 &&
        erp.customers.some((c) => !c.deletedAt && normalizePhone(c.mobile) === norm)
      ) {
        rowErrors.push('Duplicate mobile already exists');
      }

      preview.push({
        rowNumber: i + 1,
        fullName,
        mobile,
        village,
        valid: rowErrors.length === 0,
        errors: rowErrors,
      });

      if (commit === true && rowErrors.length === 0) {
        const customerId = await p3.docSequence.allocateNext('CUSTOMER', 'MCC');
        const referenceNo = `MCR-${customerId.replace(/^MCC-/, '')}`;
        const now = new Date().toISOString();
        const bulkCustomer: ErpCustomer = {
          id: erp.nextNumericId('customer'),
          customerId,
          referenceNo,
          fullName,
          fatherOrHusbandName: sanitizeText(String(r.fatherOrHusbandName ?? '')),
          dob: sanitizeText(String(r.dob ?? '')),
          gender: 'Male',
          mobile,
          whatsapp: sanitizeText(String(r.whatsapp ?? mobile)),
          email: sanitizeText(String(r.email ?? '')),
          village,
          postOffice: sanitizeText(String(r.postOffice ?? '')),
          policeStation: sanitizeText(String(r.policeStation ?? '')),
          district: sanitizeText(String(r.district ?? 'Murshidabad')),
          pinCode: sanitizeText(String(r.pinCode ?? '')),
          presentAddress: `${village}, ${sanitizeText(String(r.district ?? 'Murshidabad'))}`,
          permanentAddress: `${village}, ${sanitizeText(String(r.district ?? 'Murshidabad'))}`,
          sameAsPresent: true,
          segment: 'Individual',
          crmTag: 'New',
          status: 'Active',
          verificationStatus: 'Unverified',
          mobileOtpVerifiedAt: null,
          consents: DEFAULT_CONSENT_DEFINITIONS.map((def) => ({
            category: def.category,
            label: def.label,
            granted: false,
            recordedAt: null,
            recordedBy: actor.userId,
            verificationMethod: 'Not Set',
          })),
          consentHistory: [],
          contactHistory: [],
          notesAndFollowUps: [],
          statusHistory: [],
          isArchived: false,
          deletedAt: null,
          createdBy: actor.userId,
          createdAt: now,
          updatedAt: now,
        };
        erp.customers.unshift(bulkCustomer);
        void syncErpCustomerToFirebase(bulkCustomer);
        createdIds.push(customerId);
      }
    }

    return ok(
      res,
      {
        mode: commit === true ? 'COMMITTED' : 'PREVIEW',
        totalRows: rows.length,
        validCount: preview.filter((p) => p.valid).length,
        invalidCount: preview.filter((p) => !p.valid).length,
        createdIds,
        preview,
      },
      commit === true
        ? `Imported ${createdIds.length} valid customer(s).`
        : 'Bulk import validation preview ready.'
    );
  });

  // ==========================================================================
  // 2. SERVICE CATEGORIES, SUBCATEGORIES, CATALOG, DYNAMIC FORM BUILDER & SLA
  // ==========================================================================
  const parseNonNegativeAmount = (raw: unknown, fallback = 0): number | null => {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0) return null;
    return Math.round(num * 100) / 100;
  };

  const sanitizeFormFields = (rawFields: unknown[]): DynamicFormFieldDef[] => {
    return rawFields.map((raw, idx) => {
      const f = (raw && typeof raw === 'object' ? raw : {}) as Partial<DynamicFormFieldDef>;
      const rawKey = sanitizeText(String(f.fieldKey || f.label || `field_${idx + 1}`))
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      const validTypes = new Set([
        'short_text',
        'long_text',
        'number',
        'date',
        'mobile',
        'email',
        'dropdown',
        'radio',
        'checkbox',
        'multi_select',
        'file_upload',
        'aadhaar',
        'pan',
        'address',
        'yes_no',
      ]);
      const fieldType = validTypes.has(String(f.fieldType))
        ? (f.fieldType as DynamicFormFieldDef['fieldType'])
        : 'short_text';
      return {
        fieldKey: rawKey || `field_${idx + 1}`,
        label: sanitizeText(String(f.label || `Field ${idx + 1}`)).slice(0, 120),
        description: f.description ? sanitizeText(String(f.description)).slice(0, 240) : undefined,
        fieldType,
        required: Boolean(f.required),
        displayOrder:
          f.displayOrder !== undefined && Number.isFinite(Number(f.displayOrder))
            ? Number(f.displayOrder)
            : idx + 1,
        defaultValue: f.defaultValue ? sanitizeText(String(f.defaultValue)).slice(0, 120) : undefined,
        options: Array.isArray(f.options)
          ? f.options.map((o) => sanitizeText(String(o))).filter(Boolean)
          : undefined,
        minLength: f.minLength !== undefined && Number.isFinite(Number(f.minLength)) ? Number(f.minLength) : undefined,
        maxLength: f.maxLength !== undefined && Number.isFinite(Number(f.maxLength)) ? Number(f.maxLength) : undefined,
        minValue: f.minValue !== undefined && Number.isFinite(Number(f.minValue)) ? Number(f.minValue) : undefined,
        maxValue: f.maxValue !== undefined && Number.isFinite(Number(f.maxValue)) ? Number(f.maxValue) : undefined,
        enabled: f.enabled !== false,
      };
    });
  };

  const sanitizeRequiredDocuments = (rawDocs: unknown[]): ServiceRequiredDocumentDef[] => {
    const allowedFmtSet = new Set(['PDF', 'JPG', 'JPEG', 'PNG']);
    return rawDocs.slice(0, 30).map((raw, idx) => {
      const d = (raw && typeof raw === 'object' ? raw : {}) as Partial<ServiceRequiredDocumentDef>;
      const label = sanitizeText(String(d.label || `Document ${idx + 1}`)).slice(0, 120);
      const rawKey = sanitizeText(String(d.docKey || label || `doc_${idx + 1}`))
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      const rawFormats = Array.isArray(d.allowedFormats)
        ? d.allowedFormats
            .map((fmt) => String(fmt).toUpperCase())
            .filter((fmt): fmt is 'PDF' | 'JPG' | 'JPEG' | 'PNG' => allowedFmtSet.has(fmt))
        : [];
      return {
        docKey: rawKey || `doc_${idx + 1}`,
        label: label || `Document ${idx + 1}`,
        category: sanitizeText(String(d.category || 'Identity / Support')).slice(0, 80),
        required: d.required !== false,
        allowMultiple: Boolean(d.allowMultiple),
        allowedFormats: rawFormats.length > 0 ? rawFormats : ['PDF', 'JPG', 'JPEG', 'PNG'],
        maxSizeMb:
          d.maxSizeMb !== undefined && Number.isFinite(Number(d.maxSizeMb))
            ? Math.min(25, Math.max(1, Number(d.maxSizeMb)))
            : 10,
        instructions: sanitizeText(String(d.instructions || 'Upload clear readable scan.')).slice(0, 300),
        enabled: d.enabled !== false,
      };
    });
  };

  const VALID_RULE_TRIGGERS = new Set([
    'APPLICATION_CREATED',
    'APPLICATION_SUBMITTED',
    'STATUS_CHANGED',
    'DOCUMENT_UPLOADED',
    'DOCUMENT_VERIFIED',
    'DOCUMENT_REJECTED',
    'PAYMENT_RECEIVED',
    'PAYMENT_PENDING',
    'FOLLOWUP_DUE',
    'SLA_WARNING',
    'SLA_BREACH',
    'APPLICATION_COMPLETED',
    'DELIVERY_READY',
    'REFUND_PROCESSED',
  ]);

  const VALID_RULE_ACTIONS = new Set([
    'ASSIGN_STAFF',
    'ASSIGN_COUNTER',
    'CREATE_FOLLOWUP',
    'CREATE_REMINDER',
    'GENERATE_NOTIFICATION',
    'ESCALATE_INTERNAL',
    'GENERATE_REF_NO',
  ]);

  const sanitizeAutomationRules = (
    rawRules: unknown[],
    existingRules: ErpService['automationRules'] = []
  ): ErpService['automationRules'] => {
    return rawRules.slice(0, 20).map((raw, idx) => {
      const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ErpService['automationRules'][number]>;
      const id = sanitizeText(String(r.id || `AUTO-RULE-${idx + 1}`)).slice(0, 64) || `AUTO-RULE-${idx + 1}`;
      const prior = existingRules.find((er) => er.id === id);
      const trigger = VALID_RULE_TRIGGERS.has(String(r.trigger))
        ? (r.trigger as ErpService['automationRules'][number]['trigger'])
        : 'APPLICATION_SUBMITTED';
      const actionType = VALID_RULE_ACTIONS.has(String(r.actionType))
        ? (r.actionType as ErpService['automationRules'][number]['actionType'])
        : 'GENERATE_NOTIFICATION';
      return {
        id,
        name: sanitizeText(String(r.name || `Automation Rule ${idx + 1}`)).slice(0, 120),
        trigger,
        conditionStatus: r.conditionStatus || 'ANY',
        actionType,
        actionParam: sanitizeText(String(r.actionParam || '')).slice(0, 120),
        enabled: r.enabled !== false,
        versionNo: Number(r.versionNo ?? prior?.versionNo ?? 1),
        executionCount: Number(prior?.executionCount ?? r.executionCount ?? 0),
        lastRunAt: prior?.lastRunAt ?? r.lastRunAt ?? null,
        lastError: prior?.lastError ?? r.lastError ?? null,
      };
    });
  };

  const sanitizeSlaConfig = (
    rawSla: Record<string, unknown> | undefined,
    base?: ErpService['sla']
  ): ErpService['sla'] => {
    const fallback: ErpService['sla'] = base ?? {
      processingMode: 'FIXED',
      expectedDays: 3,
      minDays: 1,
      maxDays: 5,
      dayType: 'WORKING',
      excludeHolidays: true,
      startEvent: 'ON_SUBMIT',
      pauseOnStatuses: ['Pending Customer', 'Pending Office', 'On Hold'],
      warningThresholdPct: 75,
      breachThresholdHours: 72,
      escalateToManagerAtWarning: true,
      escalateToAdminAtBreach: true,
    };
    if (!rawSla || typeof rawSla !== 'object') return { ...fallback };
    const expectedDays =
      rawSla.expectedDays !== undefined && Number.isFinite(Number(rawSla.expectedDays))
        ? Math.max(1, Math.round(Number(rawSla.expectedDays)))
        : fallback.expectedDays;
    const minDays =
      rawSla.minDays !== undefined && Number.isFinite(Number(rawSla.minDays))
        ? Math.max(1, Math.round(Number(rawSla.minDays)))
        : fallback.minDays;
    const maxDays =
      rawSla.maxDays !== undefined && Number.isFinite(Number(rawSla.maxDays))
        ? Math.max(minDays, Math.round(Number(rawSla.maxDays)))
        : Math.max(minDays, fallback.maxDays);
    const pauseOnStatuses = Array.isArray(rawSla.pauseOnStatuses)
      ? (rawSla.pauseOnStatuses.map(String) as ErpApplicationStatus[])
      : fallback.pauseOnStatuses;
    return {
      processingMode: rawSla.processingMode === 'RANGE' ? 'RANGE' : rawSla.processingMode === 'FIXED' ? 'FIXED' : fallback.processingMode,
      expectedDays,
      minDays,
      maxDays,
      dayType: rawSla.dayType === 'CALENDAR' ? 'CALENDAR' : rawSla.dayType === 'WORKING' ? 'WORKING' : fallback.dayType,
      excludeHolidays:
        rawSla.excludeHolidays !== undefined ? Boolean(rawSla.excludeHolidays) : fallback.excludeHolidays,
      startEvent: rawSla.startEvent === 'ON_ASSIGN' ? 'ON_ASSIGN' : rawSla.startEvent === 'ON_SUBMIT' ? 'ON_SUBMIT' : fallback.startEvent,
      pauseOnStatuses: pauseOnStatuses.length > 0 ? pauseOnStatuses : ['Pending Customer', 'Pending Office', 'On Hold'],
      warningThresholdPct:
        rawSla.warningThresholdPct !== undefined && Number.isFinite(Number(rawSla.warningThresholdPct))
          ? Math.min(99, Math.max(10, Math.round(Number(rawSla.warningThresholdPct))))
          : fallback.warningThresholdPct,
      breachThresholdHours:
        rawSla.breachThresholdHours !== undefined && Number.isFinite(Number(rawSla.breachThresholdHours))
          ? Math.max(1, Math.round(Number(rawSla.breachThresholdHours)))
          : fallback.breachThresholdHours,
      escalateToManagerAtWarning:
        rawSla.escalateToManagerAtWarning !== undefined
          ? Boolean(rawSla.escalateToManagerAtWarning)
          : fallback.escalateToManagerAtWarning,
      escalateToAdminAtBreach:
        rawSla.escalateToAdminAtBreach !== undefined
          ? Boolean(rawSla.escalateToAdminAtBreach)
          : fallback.escalateToAdminAtBreach,
    };
  };

  const buildSlaSummary = (sla: ErpService['sla']): string => {
    const dur = sla.processingMode === 'RANGE' ? `${sla.minDays}-${sla.maxDays}d` : `${sla.expectedDays}d`;
    return `${sla.processingMode} ${dur} (${sla.dayType}, ${sla.startEvent}, hol:${sla.excludeHolidays ? 'excl' : 'incl'})`;
  };

  app.post('/api/erp/services/sync-catalog', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN' && actor.role !== 'MANAGER') {
      return fail(res, 'Only ADMIN or MANAGER can sync the 675 Services catalog.', 403);
    }
    const restoreDeleted = Boolean(req.body?.restoreDeleted);
    erp.syncCatalog675(actor.userId, { restoreDeleted });
    const activeServices = erp.services.filter((s) => !s.deletedAt);
    const sortedCodes = [...activeServices]
      .sort((a, b) => (a.displayOrder ?? a.id) - (b.displayOrder ?? b.id))
      .map((s) => s.serviceCode);
    const codeRange =
      sortedCodes.length > 0
        ? `${sortedCodes[0]} to ${sortedCodes[sortedCodes.length - 1]}`
        : 'MC2627SRV-001 to MC2627SRV-675';
    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'SYNC_675_CATALOG',
      newValue: `${erp.serviceCategories.length} categories, ${erp.serviceSubcategories.length} subcategories, ${activeServices.length} services (${codeRange})`,
      ipAddress: getIp(req),
    });
    securityStore.addSecurityLog({
      actorUserId: actor.userId,
      eventType: 'SERVICE_CATALOG_SYNCED',
      result: 'SUCCESS',
      ipAddress: getIp(req),
      deviceInfo: String(req.headers['user-agent'] || 'Client').slice(0, 120),
      summary: `Synced master catalog: ${erp.serviceCategories.length} categories, ${erp.serviceSubcategories.length} subcategories, ${activeServices.length} services.`,
    });
    return ok(
      res,
      {
        categoriesCount: erp.serviceCategories.length,
        subcategoriesCount: erp.serviceSubcategories.length,
        servicesCount: activeServices.length,
        codeRange,
        legacyRemovedCount: 0,
      },
      `Synced ${activeServices.length} services (${codeRange}) across ${erp.serviceCategories.length} categories.`
    );
  });

  app.get('/api/erp/service-categories', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'services', 'VIEW');
    if (!actor) return;
    const sorted = [...erp.serviceCategories].sort(
      (a, b) => (a.displayOrder ?? a.id) - (b.displayOrder ?? b.id)
    );
    return ok(res, sorted);
  });

  app.post('/api/erp/service-categories', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN') {
      return fail(res, 'Only ADMIN can create Service Categories.', 403);
    }
    const { name, description, displayOrder } = req.body ?? {};
    if (!name || String(name).trim().length < 2) {
      return fail(res, 'Category name must be at least 2 characters.', 422);
    }
    const cleanName = sanitizeText(String(name));
    const existing = erp.serviceCategories.find(
      (c) => c.name.toLowerCase() === cleanName.toLowerCase()
    );
    if (existing) {
      return fail(res, 'Service Category name already exists.', 409);
    }

    const id = erp.nextNumericId('category');
    const now = new Date().toISOString();
    let code = `CAT-${String(id).padStart(2, '0')}`;
    while (erp.serviceCategories.some((c) => c.code === code)) {
      code = `CAT-${String(id + Math.floor(Math.random() * 1000)).padStart(2, '0')}`;
    }

    const cat = {
      id,
      code,
      name: cleanName,
      description: sanitizeText(String(description ?? '')),
      displayOrder:
        displayOrder !== undefined && Number.isFinite(Number(displayOrder))
          ? Number(displayOrder)
          : erp.serviceCategories.length + 1,
      status: 'active' as const,
      proposedBy: actor.userId,
      approvedBy: actor.userId,
      createdBy: actor.userId,
      updatedBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    };
    erp.serviceCategories.push(cat);
    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'CREATE_CATEGORY',
      newValue: `${cat.code} (${cat.name})`,
      ipAddress: getIp(req),
    });
    securityStore.addSecurityLog({
      actorUserId: actor.userId,
      eventType: 'SERVICE_CATEGORY_CHANGED',
      result: 'SUCCESS',
      ipAddress: getIp(req),
      deviceInfo: String(req.headers['user-agent'] || 'Client').slice(0, 120),
      summary: `Created Service Category ${cat.code} (${cat.name}).`,
    });
    return ok(res, cat, `Service Category "${cat.name}" created.`, 201);
  });

  app.put('/api/erp/service-categories/:id', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN') {
      return fail(res, 'Only ADMIN can edit Service Categories.', 403);
    }
    const catId = Number(req.params.id);
    const cat = erp.serviceCategories.find((c) => c.id === catId);
    if (!cat) return fail(res, 'Category not found.', 404);

    const b = req.body ?? {};
    const now = new Date().toISOString();
    if (typeof b.name === 'string') {
      const cleanName = sanitizeText(b.name);
      if (cleanName.length < 2) {
        return fail(res, 'Category name must be at least 2 characters.', 422);
      }
      const dup = erp.serviceCategories.find(
        (c) => c.id !== catId && c.name.toLowerCase() === cleanName.toLowerCase()
      );
      if (dup) {
        return fail(res, 'Another Service Category already uses this name.', 409);
      }
      cat.name = cleanName;
      for (const sub of erp.serviceSubcategories) {
        if (sub.categoryId === cat.id) sub.categoryName = cleanName;
      }
      for (const svc of erp.services) {
        if (svc.categoryId === cat.id) svc.categoryName = cleanName;
      }
    }
    if (typeof b.description === 'string') cat.description = sanitizeText(b.description);
    if (b.displayOrder !== undefined && Number.isFinite(Number(b.displayOrder))) {
      cat.displayOrder = Number(b.displayOrder);
    }
    if (['active', 'pending_approval', 'archived'].includes(String(b.status))) {
      cat.status = b.status;
    }
    cat.updatedBy = actor.userId;
    cat.updatedAt = now;

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'UPDATE_CATEGORY',
      newValue: `${cat.code} (${cat.name})`,
      ipAddress: getIp(req),
    });
    return ok(res, cat, `Service Category "${cat.name}" updated.`);
  });

  app.delete('/api/erp/service-categories/:id', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN') {
      return fail(res, 'Only ADMIN can delete Service Categories.', 403);
    }
    const catId = Number(req.params.id);
    const idx = erp.serviceCategories.findIndex((c) => c.id === catId);
    if (idx === -1) return fail(res, 'Category not found.', 404);

    const hasSubcategories = erp.serviceSubcategories.some((sc) => sc.categoryId === catId);
    const hasServices = erp.services.some((s) => s.categoryId === catId && !s.deletedAt);
    if (hasSubcategories || hasServices) {
      return fail(
        res,
        'Cannot delete category while subcategories or services are linked to it. Remove or reassign them first.',
        409
      );
    }

    const removed = erp.serviceCategories.splice(idx, 1)[0];
    erp.deletedCategoryCodes.add(removed.code);
    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'DELETE_CATEGORY',
      newValue: `${removed.code} (${removed.name})`,
      ipAddress: getIp(req),
    });
    securityStore.addSecurityLog({
      actorUserId: actor.userId,
      eventType: 'SERVICE_CATEGORY_CHANGED',
      result: 'SUCCESS',
      ipAddress: getIp(req),
      deviceInfo: String(req.headers['user-agent'] || 'Client').slice(0, 120),
      summary: `Deleted Service Category ${removed.code} (${removed.name}).`,
    });
    return ok(res, { deleted: true, id: removed.id }, `Category "${removed.name}" deleted permanently.`);
  });

  app.post('/api/erp/service-categories/:id/approve', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN') {
      return fail(res, 'Only ADMIN can approve pending Service Categories.', 403);
    }
    const cat = erp.serviceCategories.find((c) => c.id === Number(req.params.id));
    if (!cat) return fail(res, 'Category not found.', 404);
    cat.status = req.body?.action === 'ARCHIVE' ? 'archived' : 'active';
    cat.approvedBy = actor.userId;
    cat.updatedBy = actor.userId;
    cat.updatedAt = new Date().toISOString();
    return ok(res, cat, `Category "${cat.name}" updated to ${cat.status}.`);
  });

  app.get('/api/erp/service-subcategories', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'services', 'VIEW');
    if (!actor) return;
    const categoryId = req.query.categoryId ? Number(req.query.categoryId) : null;
    const list = erp.serviceSubcategories
      .filter((sc) => (categoryId ? sc.categoryId === categoryId : true))
      .sort((a, b) => a.categoryId - b.categoryId || a.displayOrder - b.displayOrder || a.id - b.id);
    return ok(res, list);
  });

  app.post('/api/erp/service-subcategories', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN') {
      return fail(res, 'Only ADMIN can create Service Subcategories.', 403);
    }
    const b = req.body ?? {};
    const categoryId = Number(b.categoryId);
    const parentCat = erp.serviceCategories.find((c) => c.id === categoryId);
    if (!parentCat) {
      return fail(res, 'Valid parent Category ID is required.', 422);
    }
    const cleanName = sanitizeText(String(b.name ?? ''));
    if (cleanName.length < 2) {
      return fail(res, 'Subcategory name must be at least 2 characters.', 422);
    }
    const dup = erp.serviceSubcategories.find(
      (sc) => sc.categoryId === categoryId && sc.name.toLowerCase() === cleanName.toLowerCase()
    );
    if (dup) {
      return fail(res, `Subcategory "${cleanName}" already exists under ${parentCat.name}.`, 409);
    }

    const id = erp.nextNumericId('subcategory');
    const now = new Date().toISOString();
    const countInCat = erp.serviceSubcategories.filter((sc) => sc.categoryId === categoryId).length + 1;
    let code = `SUB-${String(categoryId).padStart(2, '0')}-${String(countInCat).padStart(2, '0')}`;
    while (erp.serviceSubcategories.some((sc) => sc.code === code)) {
      code = `SUB-${String(categoryId).padStart(2, '0')}-${String(id).padStart(3, '0')}`;
    }

    const created = {
      id,
      code,
      categoryId: parentCat.id,
      categoryName: parentCat.name,
      name: cleanName,
      description: sanitizeText(String(b.description ?? '')),
      displayOrder:
        b.displayOrder !== undefined && Number.isFinite(Number(b.displayOrder))
          ? Number(b.displayOrder)
          : countInCat,
      status: 'active' as const,
      createdBy: actor.userId,
      updatedBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    };
    erp.serviceSubcategories.push(created);
    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'CREATE_SUBCATEGORY',
      newValue: `${created.code} (${created.name})`,
      ipAddress: getIp(req),
    });
    return ok(res, created, `Subcategory "${created.name}" created.`, 201);
  });

  app.put('/api/erp/service-subcategories/:id', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN') {
      return fail(res, 'Only ADMIN can edit Service Subcategories.', 403);
    }
    const subId = Number(req.params.id);
    const sub = erp.serviceSubcategories.find((sc) => sc.id === subId);
    if (!sub) return fail(res, 'Subcategory not found.', 404);

    const b = req.body ?? {};
    const targetCategoryId = b.categoryId !== undefined ? Number(b.categoryId) : sub.categoryId;
    const parentCat = erp.serviceCategories.find((c) => c.id === targetCategoryId);
    if (!parentCat) {
      return fail(res, 'Valid parent Category ID is required.', 422);
    }

    if (typeof b.name === 'string') {
      const cleanName = sanitizeText(b.name);
      if (cleanName.length < 2) {
        return fail(res, 'Subcategory name must be at least 2 characters.', 422);
      }
      const dup = erp.serviceSubcategories.find(
        (sc) =>
          sc.id !== subId &&
          sc.categoryId === parentCat.id &&
          sc.name.toLowerCase() === cleanName.toLowerCase()
      );
      if (dup) {
        return fail(res, `Subcategory "${cleanName}" already exists under ${parentCat.name}.`, 409);
      }
      sub.name = cleanName;
    }

    sub.categoryId = parentCat.id;
    sub.categoryName = parentCat.name;
    if (typeof b.description === 'string') sub.description = sanitizeText(b.description);
    if (b.displayOrder !== undefined && Number.isFinite(Number(b.displayOrder))) {
      sub.displayOrder = Number(b.displayOrder);
    }
    if (['active', 'archived'].includes(String(b.status))) {
      sub.status = b.status;
    }
    sub.updatedBy = actor.userId;
    sub.updatedAt = new Date().toISOString();

    for (const svc of erp.services) {
      if (svc.subcategoryId === sub.id) {
        svc.subcategoryName = sub.name;
        svc.categoryId = parentCat.id;
        svc.categoryName = parentCat.name;
      }
    }

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'UPDATE_SUBCATEGORY',
      newValue: `${sub.code} (${sub.name})`,
      ipAddress: getIp(req),
    });
    return ok(res, sub, `Subcategory "${sub.name}" updated.`);
  });

  app.delete('/api/erp/service-subcategories/:id', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN') {
      return fail(res, 'Only ADMIN can delete Service Subcategories.', 403);
    }
    const subId = Number(req.params.id);
    const idx = erp.serviceSubcategories.findIndex((sc) => sc.id === subId);
    if (idx === -1) return fail(res, 'Subcategory not found.', 404);

    const hasServices = erp.services.some((s) => s.subcategoryId === subId && !s.deletedAt);
    if (hasServices) {
      return fail(
        res,
        'Cannot delete subcategory while services are linked to it. Reassign or remove linked services first.',
        409
      );
    }

    const removed = erp.serviceSubcategories.splice(idx, 1)[0];
    erp.deletedSubcategoryCodes.add(removed.code);
    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'DELETE_SUBCATEGORY',
      newValue: `${removed.code} (${removed.name})`,
      ipAddress: getIp(req),
    });
    securityStore.addSecurityLog({
      actorUserId: actor.userId,
      eventType: 'SERVICE_CATEGORY_CHANGED',
      result: 'SUCCESS',
      ipAddress: getIp(req),
      deviceInfo: String(req.headers['user-agent'] || 'Client').slice(0, 120),
      summary: `Deleted Service Subcategory ${removed.code} (${removed.name}).`,
    });
    return ok(res, { deleted: true, id: removed.id }, `Subcategory "${removed.name}" deleted permanently.`);
  });

  app.get('/api/erp/services', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'services', 'VIEW');
    if (!actor) return;

    const includeDeleted = String(req.query.includeDeleted ?? '') === 'true';
    const categoryIdFilter = req.query.categoryId ? Number(req.query.categoryId) : null;
    const subcategoryIdFilter = req.query.subcategoryId ? Number(req.query.subcategoryId) : null;
    const statusFilter = String(req.query.status ?? '').trim();
    const search = String(req.query.q ?? '').trim().toLowerCase();

    const serialMap = erp.getActiveServiceSerialMap();

    const list = erp.services
      .filter((s) => (includeDeleted ? true : !s.deletedAt))
      .filter((s) => (categoryIdFilter ? s.categoryId === categoryIdFilter : true))
      .filter((s) => (subcategoryIdFilter ? s.subcategoryId === subcategoryIdFilter : true))
      .filter((s) => (statusFilter ? s.status === statusFilter : true))
      .filter((s) => {
        if (!search) return true;
        const serialNo = serialMap.get(s.serviceId) ?? '';
        return (
          s.name.toLowerCase().includes(search) ||
          s.serviceCode.toLowerCase().includes(search) ||
          s.serviceId.toLowerCase().includes(search) ||
          serialNo.includes(search) ||
          s.categoryName.toLowerCase().includes(search) ||
          (s.subcategoryName || '').toLowerCase().includes(search)
        );
      })
      .sort((a, b) => (a.displayOrder ?? a.id) - (b.displayOrder ?? b.id) || a.id - b.id)
      .map((s) => {
        const linkedApps = erp.applications.filter(
          (a) => a.serviceId === s.serviceId && !a.archivedAt
        );
        return {
          ...erp.withServiceSerial(s, serialMap),
          applicationCount: linkedApps.length,
        };
      });

    return ok(res, list);
  });

  app.post('/api/erp/services', requireAuth, async (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'services', 'ADD');
    if (!actor) return;
    if (actor.role !== 'ADMIN') {
      return fail(res, 'Only ADMIN can create master service offerings.', 403);
    }

    const b = req.body ?? {};
    const name = sanitizeText(String(b.name ?? ''));
    if (name.length < 2) {
      return fail(res, 'Service name must be at least 2 characters.', 422);
    }

    const category = erp.serviceCategories.find((c) => c.id === Number(b.categoryId));
    if (!category) {
      return fail(res, 'Valid Category is required.', 422);
    }

    let subcategory: ServiceSubcategory | undefined;
    if (b.subcategoryId !== undefined && b.subcategoryId !== null && b.subcategoryId !== '') {
      subcategory = erp.serviceSubcategories.find(
        (sc) => sc.id === Number(b.subcategoryId) && sc.categoryId === category.id
      );
      if (!subcategory) {
        return fail(res, 'Selected Subcategory does not belong to the chosen Category.', 422);
      }
    } else {
      subcategory = erp.serviceSubcategories.find((sc) => sc.categoryId === category.id);
    }

    const dup = erp.services.find(
      (s) =>
        !s.deletedAt &&
        s.categoryId === category.id &&
        (subcategory ? s.subcategoryId === subcategory.id : true) &&
        s.name.toLowerCase() === name.toLowerCase()
    );
    if (dup) {
      return fail(res, `Service "${name}" already exists in this category/subcategory (${dup.serviceCode}).`, 409);
    }

    const serviceChargeInput = b.serviceCharge !== undefined ? b.serviceCharge : b.customerCharge;
    const serviceCharge = parseNonNegativeAmount(serviceChargeInput, 0);
    const serviceCost = parseNonNegativeAmount(b.serviceCost, 0);
    const govtFee = parseNonNegativeAmount(b.govtFee, 0);
    const additionalCharges = parseNonNegativeAmount(b.additionalCharges, 0);

    if (
      serviceCharge === null ||
      serviceCost === null ||
      govtFee === null ||
      additionalCharges === null
    ) {
      return fail(res, 'Service charge, service cost, government fee, and additional charges must be valid numbers >= 0.', 422);
    }

    const totalCustomerCharge = Math.round((serviceCharge + govtFee + additionalCharges) * 100) / 100;
    const profitAmount = Math.round((serviceCharge + additionalCharges - serviceCost) * 100) / 100;

    // Server-side transactional MC{FY}SRV-{NNN} code generation (never reuse, read-only after generation)
    const allocated = await erp.allocateNextServiceCode(
      typeof b.financialYearCode === 'string' ? b.financialYearCode : undefined
    );
    let serviceId = await p3.docSequence.allocateNext('SERVICE', 'MCS');
    while (erp.services.some((s) => s.serviceId === serviceId)) {
      serviceId = await p3.docSequence.allocateNext('SERVICE', 'MCS');
    }
    const now = new Date().toISOString();
    const rawFields = Array.isArray(b.fields) && b.fields.length > 0
      ? b.fields
      : [
          {
            fieldKey: 'applicant_name',
            label: 'Applicant Full Name',
            fieldType: 'short_text',
            required: true,
            displayOrder: 1,
            enabled: true,
          },
          {
            fieldKey: 'applicant_mobile',
            label: 'Mobile Number',
            fieldType: 'mobile',
            required: true,
            displayOrder: 2,
            enabled: true,
          },
          {
            fieldKey: 'applicant_notes',
            label: 'Applicant Details / Request Notes',
            fieldType: 'long_text',
            required: false,
            displayOrder: 3,
            enabled: true,
          },
        ];
    const fields = sanitizeFormFields(rawFields);

    const requiredDocs = Array.isArray(b.requiredDocuments)
      ? sanitizeRequiredDocuments(b.requiredDocuments)
      : [];

    const automationRules = Array.isArray(b.automationRules)
      ? sanitizeAutomationRules(b.automationRules)
      : [];

    const serviceInstructions = sanitizeText(
      String(
        b.serviceInstructions ??
          b.termsAndConditions ??
          'MUN COMPUTER provides private filing & digital assistance; statutory outcomes are governed by respective authorities.'
      )
    );

    const status = (
      ['Active', 'Inactive', 'Temporarily Suspended', 'Archived'].includes(String(b.status))
        ? b.status
        : 'Active'
    ) as ErpService['status'];
    const availability = (
      ['Available', 'Unavailable'].includes(String(b.availability))
        ? b.availability
        : status === 'Active'
          ? 'Available'
          : 'Unavailable'
    ) as ErpService['availability'];

    const activeCount = erp.services.filter((s) => !s.deletedAt).length;

    const created: ErpService = {
      id: erp.nextNumericId('service'),
      serviceId,
      serviceCode: allocated.serviceCode,
      name,
      categoryId: category.id,
      categoryName: category.name,
      subcategoryId: subcategory?.id,
      subcategoryName: subcategory?.name,
      description: sanitizeText(String(b.description ?? '')),
      serviceCharge,
      serviceCost,
      govtFee,
      additionalCharges,
      totalCustomerCharge,
      customerCharge: totalCustomerCharge,
      profitAmount,
      status,
      availability,
      serviceInstructions,
      termsAndConditions: serviceInstructions,
      displayOrder:
        b.displayOrder !== undefined && Number.isFinite(Number(b.displayOrder))
          ? Number(b.displayOrder)
          : activeCount + 1,
      sla: sanitizeSlaConfig(b.sla),
      requiredDocuments: requiredDocs,
      currentFormVersion: 1,
      formVersions: [
        {
          versionNo: 1,
          publishedAt: now,
          publishedBy: actor.userId,
          status: 'published',
          fields,
        },
      ],
      automationRules,
      processingTimeHistory: [],
      deletedAt: null,
      createdBy: actor.userId,
      updatedBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    };

    erp.services.push(created);
    erp.reindexServiceDisplayOrder();

    // Keep Phase 03 Service Rate catalog synchronized
    p3.serviceRates.push({
      id: p3.serviceRates.length + 1,
      serviceCode: created.serviceCode,
      serviceName: created.name,
      category: created.categoryName,
      customerCharge: created.totalCustomerCharge,
      serviceCost: created.serviceCost,
      profitAmount: created.profitAmount,
      currentVersion: 1,
      effectiveDate: now.slice(0, 10),
      status: created.status === 'Active' ? 'active' : 'inactive',
      versions: [
        {
          versionNo: 1,
          customerCharge: created.totalCustomerCharge,
          serviceCost: created.serviceCost,
          profitAmount: created.profitAmount,
          effectiveDate: now.slice(0, 10),
          changeReason: 'Created from Services Catalog',
          approvalStatus: 'Approved',
          proposedBy: actor.userId,
          approvedBy: actor.userId,
          createdAt: now,
        },
      ],
    });

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'CREATE_SERVICE',
      newValue: `${created.serviceCode} (${created.name})`,
      ipAddress: getIp(req),
    });
    securityStore.addSecurityLog({
      actorUserId: actor.userId,
      eventType: 'SERVICE_CREATED',
      result: 'SUCCESS',
      ipAddress: getIp(req),
      deviceInfo: String(req.headers['user-agent'] || 'Client').slice(0, 120),
      summary: `Created Service ${created.serviceCode} (${created.serviceId}) — ${created.name} [S.No ${created.serialNumber}].`,
    });

    return ok(res, erp.withServiceSerial(created), `Service ${created.serviceCode} created.`, 201);
  });

  app.put('/api/erp/services/:serviceId', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'services', 'EDIT');
    if (!actor) return;
    if (actor.role !== 'ADMIN') {
      return fail(res, 'Only ADMIN may directly update master Service config.', 403);
    }

    const svc = erp.services.find((s) => s.serviceId === req.params.serviceId);
    if (!svc) return fail(res, 'Service not found.', 404);

    const b = req.body ?? {};
    const now = new Date().toISOString();

    let nextName = svc.name;
    if (typeof b.name === 'string') {
      const cleanName = sanitizeText(b.name);
      if (cleanName.length < 2) {
        return fail(res, 'Service name must be at least 2 characters.', 422);
      }
      nextName = cleanName;
    }

    let nextCatId = svc.categoryId;
    let nextCatName = svc.categoryName;
    if (b.categoryId !== undefined) {
      const cat = erp.serviceCategories.find((c) => c.id === Number(b.categoryId));
      if (!cat) return fail(res, 'Selected Category not found.', 422);
      nextCatId = cat.id;
      nextCatName = cat.name;
    }

    let nextSubId = svc.subcategoryId;
    let nextSubName = svc.subcategoryName;
    if (b.subcategoryId !== undefined) {
      if (b.subcategoryId === null || b.subcategoryId === '') {
        nextSubId = undefined;
        nextSubName = undefined;
      } else {
        const sub = erp.serviceSubcategories.find(
          (sc) => sc.id === Number(b.subcategoryId) && sc.categoryId === nextCatId
        );
        if (!sub) {
          return fail(res, 'Selected Subcategory does not belong to the chosen Category.', 422);
        }
        nextSubId = sub.id;
        nextSubName = sub.name;
      }
    }

    const dup = erp.services.find(
      (s) =>
        !s.deletedAt &&
        s.serviceId !== svc.serviceId &&
        s.categoryId === nextCatId &&
        (nextSubId ? s.subcategoryId === nextSubId : !s.subcategoryId) &&
        s.name.toLowerCase() === nextName.toLowerCase()
    );
    if (dup) {
      return fail(
        res,
        `Another service "${nextName}" already exists in this category/subcategory (${dup.serviceCode}).`,
        409
      );
    }

    svc.name = nextName;
    svc.categoryId = nextCatId;
    svc.categoryName = nextCatName;
    svc.subcategoryId = nextSubId;
    svc.subcategoryName = nextSubName;

    if (typeof b.description === 'string') svc.description = sanitizeText(b.description);
    if (typeof b.serviceInstructions === 'string') {
      svc.serviceInstructions = sanitizeText(b.serviceInstructions);
      svc.termsAndConditions = svc.serviceInstructions;
    } else if (typeof b.termsAndConditions === 'string') {
      svc.termsAndConditions = sanitizeText(b.termsAndConditions);
      svc.serviceInstructions = svc.termsAndConditions;
    }

    if (b.displayOrder !== undefined && Number.isFinite(Number(b.displayOrder))) {
      svc.displayOrder = Number(b.displayOrder);
    }

    // Preserve explicit 0 values and compute Total Customer Charge = Service Charge + Govt Fee + Additional Charges
    const nextServiceCharge =
      b.serviceCharge !== undefined
        ? parseNonNegativeAmount(b.serviceCharge, svc.serviceCharge)
        : b.customerCharge !== undefined &&
            b.govtFee === undefined &&
            b.additionalCharges === undefined
          ? parseNonNegativeAmount(b.customerCharge, svc.serviceCharge)
          : svc.serviceCharge;
    const nextServiceCost =
      b.serviceCost !== undefined ? parseNonNegativeAmount(b.serviceCost, svc.serviceCost) : svc.serviceCost;
    const nextGovtFee =
      b.govtFee !== undefined ? parseNonNegativeAmount(b.govtFee, svc.govtFee) : svc.govtFee;
    const nextAdditionalCharges =
      b.additionalCharges !== undefined
        ? parseNonNegativeAmount(b.additionalCharges, svc.additionalCharges)
        : svc.additionalCharges;

    if (
      nextServiceCharge === null ||
      nextServiceCost === null ||
      nextGovtFee === null ||
      nextAdditionalCharges === null
    ) {
      return fail(res, 'Rate fields must be valid numbers >= 0.', 422);
    }

    svc.serviceCharge = nextServiceCharge;
    svc.serviceCost = nextServiceCost;
    svc.govtFee = nextGovtFee;
    svc.additionalCharges = nextAdditionalCharges;
    svc.totalCustomerCharge =
      Math.round((nextServiceCharge + nextGovtFee + nextAdditionalCharges) * 100) / 100;
    svc.customerCharge = svc.totalCustomerCharge;
    svc.profitAmount =
      Math.round((nextServiceCharge + nextAdditionalCharges - nextServiceCost) * 100) / 100;

    if (['Active', 'Inactive', 'Temporarily Suspended', 'Archived'].includes(String(b.status))) {
      svc.status = b.status;
      if (b.availability === undefined) {
        svc.availability = svc.status === 'Active' ? 'Available' : 'Unavailable';
      }
    }
    if (['Available', 'Unavailable'].includes(String(b.availability))) {
      svc.availability = b.availability;
    }
    if (b.sla && typeof b.sla === 'object') {
      const prevSummary = buildSlaSummary(svc.sla);
      svc.sla = sanitizeSlaConfig(b.sla, svc.sla);
      const newSummary = buildSlaSummary(svc.sla);
      if (prevSummary !== newSummary) {
        svc.processingTimeHistory.unshift({
          previousSummary: prevSummary,
          newSummary,
          changedBy: actor.userId,
          changedAt: now,
        });
      }
    }
    if (Array.isArray(b.requiredDocuments)) {
      svc.requiredDocuments = sanitizeRequiredDocuments(b.requiredDocuments);
    }
    if (Array.isArray(b.automationRules)) {
      svc.automationRules = sanitizeAutomationRules(b.automationRules, svc.automationRules);
    }
    // serviceCode & serviceId are strictly read-only after generation — never overwritten
    svc.updatedBy = actor.userId;
    svc.updatedAt = now;

    // Sync Phase 03 Service Rate without mutating historical applications or payments
    const p3Rate = p3.serviceRates.find((r) => r.serviceCode === svc.serviceCode);
    if (p3Rate) {
      p3Rate.serviceName = svc.name;
      p3Rate.category = svc.categoryName;
      p3Rate.customerCharge = svc.totalCustomerCharge;
      p3Rate.serviceCost = svc.serviceCost;
      p3Rate.profitAmount = svc.profitAmount;
      p3Rate.status = svc.status === 'Active' ? 'active' : 'inactive';
      p3Rate.currentVersion += 1;
      p3Rate.versions.unshift({
        versionNo: p3Rate.currentVersion,
        customerCharge: svc.totalCustomerCharge,
        serviceCost: svc.serviceCost,
        profitAmount: svc.profitAmount,
        effectiveDate: now.slice(0, 10),
        changeReason: 'Synced from Services Catalog',
        approvalStatus: 'Approved',
        proposedBy: actor.userId,
        approvedBy: actor.userId,
        createdAt: now,
      });
    }

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'UPDATE_SERVICE',
      newValue: `${svc.serviceCode} (Total: ₹${svc.totalCustomerCharge}, Profit: ₹${svc.profitAmount})`,
      ipAddress: getIp(req),
    });
    securityStore.addSecurityLog({
      actorUserId: actor.userId,
      eventType: 'SERVICE_UPDATED',
      result: 'SUCCESS',
      ipAddress: getIp(req),
      deviceInfo: String(req.headers['user-agent'] || 'Client').slice(0, 120),
      summary: `Updated Service ${svc.serviceCode} (${svc.name}): Charge ₹${svc.totalCustomerCharge}, Status ${svc.status}.`,
    });

    return ok(
      res,
      erp.withServiceSerial(svc),
      'Service updated; service code locked and historical applications preserve prior snapshots.'
    );
  });

  app.patch('/api/erp/services/:serviceId/status', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'services', 'EDIT');
    if (!actor) return;
    if (actor.role !== 'ADMIN') {
      return fail(res, 'Only ADMIN may activate or deactivate services.', 403);
    }
    const svc = erp.services.find((s) => s.serviceId === decodeURIComponent(req.params.serviceId));
    if (!svc) return fail(res, 'Service not found.', 404);

    const requested = String(req.body?.status ?? '');
    const nextStatus = (
      ['Active', 'Inactive', 'Temporarily Suspended', 'Archived'].includes(requested)
        ? requested
        : 'Active'
    ) as ErpService['status'];
    svc.status = nextStatus;
    svc.availability = nextStatus === 'Active' ? 'Available' : 'Unavailable';
    svc.updatedBy = actor.userId;
    svc.updatedAt = new Date().toISOString();

    const p3Rate = p3.serviceRates.find((r) => r.serviceCode === svc.serviceCode);
    if (p3Rate) {
      p3Rate.status = nextStatus === 'Active' ? 'active' : 'inactive';
    }

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: nextStatus === 'Active' ? 'ACTIVATE_SERVICE' : 'DEACTIVATE_SERVICE',
      newValue: `${svc.serviceCode} -> ${nextStatus}`,
      ipAddress: getIp(req),
    });
    securityStore.addSecurityLog({
      actorUserId: actor.userId,
      eventType: 'SERVICE_UPDATED',
      result: 'SUCCESS',
      ipAddress: getIp(req),
      deviceInfo: String(req.headers['user-agent'] || 'Client').slice(0, 120),
      summary: `Service ${svc.serviceCode} (${svc.name}) status changed to ${nextStatus}.`,
    });

    return ok(res, erp.withServiceSerial(svc), `Service ${svc.serviceCode} marked ${nextStatus}.`);
  });

  app.delete('/api/erp/services/:serviceId', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'services', 'DELETE');
    if (!actor) return;
    if (actor.role !== 'ADMIN') {
      return fail(res, 'Only ADMIN can delete services.', 403);
    }
    const serviceId = decodeURIComponent(req.params.serviceId);
    const idx = erp.services.findIndex((s) => s.serviceId === serviceId || s.serviceCode === serviceId);
    if (idx === -1) {
      return fail(res, 'Service not found.', 404);
    }
    const target = erp.services[idx];
    const hasHistoricalApps = erp.applications.some((a) => a.serviceId === target.serviceId);
    const hasHistoricalPayments = erp.payments.some((p) => p.serviceId === target.serviceId);
    const cscOrders = Array.isArray(req.app?.locals?.cscStore?.orders)
      ? (req.app.locals.cscStore.orders as Array<{ selectedServiceId?: string; items?: Array<{ serviceId?: string }> }>)
      : [];
    const hasCscOrders = cscOrders.some(
      (o) =>
        o.selectedServiceId === target.serviceId ||
        o.selectedServiceId === target.serviceCode ||
        (Array.isArray(o.items) &&
          o.items.some((it) => it.serviceId === target.serviceId || it.serviceId === target.serviceCode))
    );

    if (hasHistoricalApps || hasHistoricalPayments || hasCscOrders) {
      return fail(
        res,
        `Cannot permanently delete service ${target.serviceCode} because historical applications/payments/orders reference it. Deactivate the service instead to preserve historical records.`,
        409
      );
    }

    const removed = erp.services.splice(idx, 1)[0];
    erp.deletedServiceIds.add(removed.serviceId);
    erp.deletedServiceCodes.add(removed.serviceCode);
    const p3Idx = p3.serviceRates.findIndex((r) => r.serviceCode === removed.serviceCode || r.serviceName === removed.name);
    if (p3Idx !== -1) {
      p3.serviceRates.splice(p3Idx, 1);
    }
    erp.reindexServiceDisplayOrder();

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'DELETE_SERVICE',
      newValue: `${removed.serviceId} (${removed.serviceCode})`,
      ipAddress: getIp(req),
    });
    securityStore.addSecurityLog({
      actorUserId: actor.userId,
      eventType: 'SERVICE_DELETED',
      result: 'SUCCESS',
      ipAddress: getIp(req),
      deviceInfo: String(req.headers['user-agent'] || 'Client').slice(0, 120),
      summary: `Deleted Service ${removed.serviceCode} (${removed.serviceId} - ${removed.name}) and reindexed remaining serial numbers.`,
    });
    return ok(
      res,
      {
        deleted: true,
        serviceId: removed.serviceId,
        serviceCode: removed.serviceCode,
        reindexedCount: erp.services.filter((s) => !s.deletedAt).length,
      },
      `Service ${removed.serviceCode} deleted permanently.`
    );
  });

  // Publish new version of Service Dynamic Form Builder (Preserves old versions!)
  app.post('/api/erp/services/:serviceId/form-versions', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'services', 'EDIT');
    if (!actor) return;
    if (actor.role !== 'ADMIN') {
      return fail(res, 'Only ADMIN may publish Service Dynamic Form Versions.', 403);
    }

    const svc = erp.services.find((s) => s.serviceId === req.params.serviceId);
    if (!svc) return fail(res, 'Service not found.', 404);

    const { fields } = req.body ?? {};
    if (!Array.isArray(fields) || fields.length === 0) {
      return fail(res, 'At least one form field definition is required.', 422);
    }

    // Archive older published markers visually while preserving exact snapshot
    const nextVersionNo = svc.currentFormVersion + 1;
    const now = new Date().toISOString();
    const cleanedFields = sanitizeFormFields(fields);

    svc.formVersions.push({
      versionNo: nextVersionNo,
      publishedAt: now,
      publishedBy: actor.userId,
      status: 'published',
      fields: cleanedFields,
    });
    svc.currentFormVersion = nextVersionNo;
    svc.updatedAt = now;
    svc.updatedBy = actor.userId;

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'PUBLISH_FORM_VERSION',
      newValue: `${svc.serviceId} v${nextVersionNo}`,
      ipAddress: getIp(req),
    });
    securityStore.addSecurityLog({
      actorUserId: actor.userId,
      eventType: 'SERVICE_FORM_PUBLISHED',
      result: 'SUCCESS',
      ipAddress: getIp(req),
      deviceInfo: String(req.headers['user-agent'] || 'Client').slice(0, 120),
      summary: `Published Dynamic Form v${nextVersionNo} (${cleanedFields.length} fields) for ${svc.serviceCode}.`,
    });

    return ok(
      res,
      erp.withServiceSerial(svc),
      `Published Dynamic Form v${nextVersionNo} for ${svc.name}. Existing applications retain prior form snapshots.`,
      201
    );
  });

  // ==========================================================================
  // 3. REFERENCE FIELD CONFIGURATION (ADMIN MANAGES, STAFF/MANAGER ENTRY)
  // ==========================================================================
  app.get('/api/erp/reference-fields', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'applications', 'VIEW');
    if (!actor) return;
    return ok(res, erp.referenceFields);
  });

  app.post('/api/erp/reference-fields', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN') {
      return fail(res, 'Only ADMIN may configure dynamic reference number fields.', 403);
    }
    const { fieldKey, label, inputType, serviceId, required, uniqueScope } = req.body ?? {};
    const cleanKey = sanitizeText(String(fieldKey ?? '')).replace(/\s+/g, '_').toLowerCase();
    if (!cleanKey || !label) {
      return fail(res, 'fieldKey and label are required.', 422);
    }
    if (erp.referenceFields.some((r) => r.fieldKey === cleanKey)) {
      return fail(res, 'Reference fieldKey already exists.', 409);
    }

    const def = {
      id: erp.nextNumericId('refField'),
      fieldKey: cleanKey,
      label: sanitizeText(String(label)),
      inputType: (['text', 'number', 'date'].includes(String(inputType)) ? inputType : 'text') as 'text' | 'number' | 'date',
      serviceId: serviceId ? String(serviceId) : 'ALL',
      required: Boolean(required),
      uniqueScope: (['NONE', 'GLOBAL', 'PER_SERVICE'].includes(String(uniqueScope)) ? uniqueScope : 'NONE') as 'NONE' | 'GLOBAL' | 'PER_SERVICE',
      enabled: true,
      createdBy: actor.userId,
      createdAt: new Date().toISOString(),
    };
    erp.referenceFields.push(def);
    return ok(res, def, `Reference field "${def.label}" added.`, 201);
  });

  app.patch('/api/erp/reference-fields/:id', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN') {
      return fail(res, 'Only ADMIN may modify reference field definitions.', 403);
    }
    const def = erp.referenceFields.find((r) => r.id === Number(req.params.id));
    if (!def) return fail(res, 'Reference field not found.', 404);
    const b = req.body ?? {};
    if (typeof b.enabled === 'boolean') def.enabled = b.enabled;
    if (typeof b.required === 'boolean') def.required = b.required;
    if (typeof b.label === 'string' && b.label.trim()) def.label = sanitizeText(b.label);
    if (['NONE', 'GLOBAL', 'PER_SERVICE'].includes(String(b.uniqueScope))) def.uniqueScope = b.uniqueScope;
    if (typeof b.serviceId === 'string') def.serviceId = b.serviceId;
    return ok(res, def, 'Reference field configuration updated (historical values retained).');
  });

  // ==========================================================================
  // 4. APPLICATION WORKFLOW, DUPLICATE CHECK, ASSIGNMENTS, DOCS & HANDOVER
  // ==========================================================================
  app.get('/api/erp/dashboard-summary', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    const visibleApps = erp.applications.filter(
      (a) => !a.archivedAt && canAccessApplication(actor, a)
    );
    const pendingFollowUps = erp.followUps.filter((f) => {
      if (f.status !== 'Pending') return false;
      if (actor.role === 'STAFF' && f.assignedStaffId !== actor.userId) return false;
      return true;
    });
    const pendingDocApps = visibleApps.filter((a) => {
      const chk = erp.computeDocumentChecklist(a);
      return chk.pendingVerification > 0 || chk.missingCount > 0;
    });
    const unassignedApps = visibleApps.filter((a) => !a.assignedStaffId);
    const overdueApps = visibleApps.filter((a) => erp.computeSlaStatus(a).label === 'Overdue');

    const todayStr = new Date().toISOString().slice(0, 10);
    const todayPayments = erp.payments.filter(
      (p) => p.verificationStatus === 'Confirmed' && p.recordedAt.startsWith(todayStr)
    );
    const allConfirmedPayments = erp.payments.filter((p) => p.verificationStatus === 'Confirmed');
    const totalRevenue = allConfirmedPayments.reduce((s, p) => s + p.amount, 0);
    const todayRevenue = todayPayments.reduce((s, p) => s + p.amount, 0);
    const totalExpenses = erp.expenses.reduce((s, e) => s + e.amount, 0);

    return ok(res, {
      kpis: {
        totalCustomers: erp.customers.filter((c) => !c.deletedAt && c.isArchived !== true).length,
        totalApplications: visibleApps.length,
        activeApplications: visibleApps.filter(
          (a) => !['Completed', 'Cancelled', 'Rejected'].includes(a.status)
        ).length,
        pendingApplications: visibleApps.filter((a) =>
          ['Submitted', 'Under Review', 'Pending Customer', 'Pending Office', 'On Hold'].includes(a.status)
        ).length,
        completedApplications: visibleApps.filter((a) => a.status === 'Completed').length,
        rejectedOrCancelled: visibleApps.filter((a) => ['Rejected', 'Cancelled'].includes(a.status)).length,
        todayCollection: todayRevenue,
        totalCollection: totalRevenue,
        totalExpenses,
        netCashBalance: totalRevenue - totalExpenses,
      },
      reminders: {
        pendingFollowUps: pendingFollowUps.length,
        missingOrPendingDocs: pendingDocApps.length,
        unassignedApplications: unassignedApps.length,
        overdueSlaApplications: overdueApps.length,
        pendingReassignments: erp.reassignmentRequests.filter((r) => r.status === 'Pending').length,
        pendingCancellations: erp.cancellationRequests.filter((c) => c.status === 'Pending').length,
      },
      recentApplications: visibleApps.slice(0, 8).map((a) => enrichApplication(a, true)),
      recentPayments: erp.payments.slice(0, 8),
      recentNotifications: erp.notifications.slice(0, 8),
      applicationStatusBreakdown: visibleApps.reduce<Record<string, number>>((acc, a) => {
        acc[a.status] = (acc[a.status] || 0) + 1;
        return acc;
      }, {}),
    });
  });

  app.post('/api/erp/applications/check-duplicate', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'applications', 'ADD');
    if (!actor) return;
    const { customerId, serviceId } = req.body ?? {};
    const matches = erp.applications.filter(
      (a) =>
        !a.archivedAt &&
        a.customerId === customerId &&
        a.serviceId === serviceId &&
        !['Completed', 'Cancelled', 'Rejected'].includes(a.status)
    );
    return ok(res, {
      hasDuplicate: matches.length > 0,
      matches: matches.map((m) => ({
        applicationNo: m.applicationNo,
        status: m.status,
        createdAt: m.createdAt,
      })),
    });
  });

  app.get('/api/erp/applications', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'applications', 'VIEW');
    if (!actor) return;

    const search = String(req.query.q ?? '').trim().toLowerCase();
    const status = String(req.query.status ?? '').trim();
    const serviceId = String(req.query.serviceId ?? '').trim();
    const customerId = String(req.query.customerId ?? '').trim();
    const counterCode = String(req.query.counterCode ?? '').trim();
    const scope = String(req.query.scope ?? 'all'); // all | mine | unassigned | pending_docs | overdue
    const includeArchived = String(req.query.includeArchived ?? '') === 'true';

    const list = erp.applications.filter((a) => {
      if (!includeArchived && a.archivedAt) return false;
      if (!canAccessApplication(actor, a)) return false;

      if (scope === 'mine' && a.assignedStaffId !== actor.userId) return false;
      if (scope === 'unassigned' && a.assignedStaffId !== null) return false;
      if (scope === 'pending_docs') {
        const chk = erp.computeDocumentChecklist(a);
        if (chk.missingCount === 0 && chk.pendingVerification === 0) return false;
      }
      if (scope === 'overdue' && erp.computeSlaStatus(a).label !== 'Overdue') return false;

      if (status && a.status !== status) return false;
      if (serviceId && a.serviceId !== serviceId) return false;
      if (customerId && a.customerId !== customerId) return false;
      if (counterCode && a.assignedCounterCode !== counterCode) return false;

      if (search) {
        const refString = a.references.map((r) => `${r.label} ${r.value}`).join(' ');
        const hay = [
          a.applicationNo,
          a.customerId,
          a.customerSnapshot.fullName,
          a.customerSnapshot.mobile,
          a.customerSnapshot.village,
          a.serviceSnapshot.name,
          a.assignedStaffId ?? '',
          a.assignedCounterCode ?? '',
          refString,
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    return ok(
      res,
      list.map((a) => enrichApplication(a, true))
    );
  });

  app.get('/api/erp/applications/:appNo', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'applications', 'VIEW');
    if (!actor) return;

    const application = erp.applications.find((a) => a.applicationNo === req.params.appNo);
    if (!application) return fail(res, 'Application not found.', 404);
    if (!canAccessApplication(actor, application)) {
      securityStore.addSecurityLog({
        actorUserId: actor.userId,
        eventType: 'UNAUTHORIZED_ACCESS',
        result: 'BLOCKED',
        ipAddress: getIp(req),
        deviceInfo: 'ERP Record Access',
        summary: `Staff ${actor.userId} blocked from accessing another staff application ${application.applicationNo}.`,
      });
      return fail(res, 'Forbidden: you are not assigned to this application.', 403);
    }

    const customer = erp.customers.find((c) => c.customerId === application.customerId) || null;
    return ok(res, {
      application: enrichApplication(application, true),
      customer: customer ? erp.sanitizePublicCustomer(customer) : null,
    });
  });

  app.post('/api/erp/applications', requireAuth, async (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'applications', 'ADD');
    if (!actor) return;

    const b = req.body ?? {};
    const customer = erp.customers.find((c) => c.customerId === b.customerId && !c.deletedAt);
    const service = erp.services.find((s) => s.serviceId === b.serviceId && !s.deletedAt);

    if (!customer) return fail(res, 'Valid active Customer is required.', 422);
    if (!service) return fail(res, 'Valid active Service is required.', 422);
    if (service.status !== 'Active' || service.availability !== 'Available') {
      return fail(res, `Service "${service.name}" is currently ${service.status} / ${service.availability}.`, 422);
    }

    const svcPerm = securityStore.canExecuteServiceOrder(actor, service.serviceId, 'EXECUTE');
    if (!svcPerm.allowed) {
      securityStore.addSecurityLog({
        actorUserId: actor.userId,
        eventType: 'UNAUTHORIZED_ACCESS',
        result: 'BLOCKED',
        ipAddress: getIp(req),
        deviceInfo: 'ERP Service Execution',
        summary: `Blocked ${actor.role} ${actor.userId} executing ${service.serviceId}: ${svcPerm.reason}`,
      });
      return fail(res, `Forbidden: ${svcPerm.reason}`, 403);
    }

    const mode: 'Draft' | 'Submitted' = b.submitMode === 'Draft' ? 'Draft' : 'Submitted';
    const formVersion =
      service.formVersions.find((v) => v.versionNo === service.currentFormVersion) ??
      service.formVersions[service.formVersions.length - 1];
    const formFields = formVersion?.fields ?? [];

    // Validate Dynamic Form Data against published version schema
    const validation = erp.validateDynamicFormData(
      formFields,
      b.formData && typeof b.formData === 'object' ? b.formData : {},
      mode === 'Submitted'
    );
    if (!validation.valid) {
      const errorBag: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(validation.errors)) errorBag[k] = [v];
      return fail(res, 'Service form validation failed.', 422, errorBag);
    }

    // Duplicate Detection
    const dupApps = erp.applications.filter(
      (a) =>
        !a.archivedAt &&
        a.customerId === customer.customerId &&
        a.serviceId === service.serviceId &&
        !['Completed', 'Cancelled', 'Rejected'].includes(a.status)
    );
    if (dupApps.length > 0 && !b.duplicateOverrideReason) {
      return fail(
        res,
        `Duplicate active application detected (${dupApps[0].applicationNo}). Confirm with duplicateOverrideReason to continue.`,
        409
      );
    }

    // Validate Initial Uploaded Documents & Mandatory Checklist Enforcement if Final Submission
    const initialDocsInput = Array.isArray(b.initialDocuments) ? b.initialDocuments : [];
    const reqDocs = service.requiredDocuments.filter((d) => d.enabled);

    for (const d of initialDocsInput) {
      const mime = String(d.mimeType ?? '');
      const name = String(d.originalName ?? '');
      const ext = name.split('.').pop()?.toLowerCase() ?? '';
      const rawBuf = Buffer.from(String(d.contentBase64 ?? ''), 'base64');
      if (BLOCKED_EXECUTABLE_EXTS.has(ext) || !ALLOWED_MIME_TYPES.has(mime) || !(ALLOWED_EXT_MAP[mime] ?? []).includes(ext)) {
        return fail(res, `File "${name}" rejected: only PDF, JPG, JPEG, PNG are allowed.`, 422);
      }
      if (rawBuf.length === 0 || rawBuf.length > MAX_UPLOAD_BYTES) {
        return fail(res, `File "${name}" exceeds 10 MB limit or is empty.`, 422);
      }
    }

    if (mode === 'Submitted') {
      const missingMandatory = reqDocs
        .filter((rd) => rd.required)
        .filter((rd) => !initialDocsInput.some((doc: { docKey?: string }) => doc.docKey === rd.docKey));
      if (missingMandatory.length > 0 && !b.mandatoryDocExceptionReason) {
        return fail(
          res,
          `Missing mandatory document(s): ${missingMandatory.map((m) => m.label).join(', ')}. Upload required files, save as Draft, or authorize an exception with reason.`,
          422
        );
      }
      if (missingMandatory.length > 0 && b.mandatoryDocExceptionReason && actor.role === 'STAFF') {
        return fail(
          res,
          'Only Manager or Admin can submit with a Mandatory Document Exception.',
          403
        );
      }
    }

    // Atomic Server-side Sequence Allocation (MCA-2026-27-NNNNNN)
    const applicationNo = await p3.docSequence.allocateNext('APPLICATION', p3.globalConfig.prefixes.APPLICATION);
    const fy = p3.docSequence.getCurrentFinancialYear();
    const now = new Date().toISOString();
    const expectedDays = service.sla.processingMode === 'RANGE' ? service.sla.maxDays : service.sla.expectedDays;
    const expectedCompletionDate = addDaysIso(now, expectedDays);

    const assignedStaffId = b.assignedStaffId ? sanitizeText(String(b.assignedStaffId)) : actor.userId;
    const assignedCounterCode = b.assignedCounterCode
      ? sanitizeText(String(b.assignedCounterCode))
      : 'CTR-01';

    const newApp: ErpApplication = {
      id: erp.nextNumericId('app'),
      applicationNo,
      financialYear: fy,
      customerId: customer.customerId,
      customerSnapshot: {
        customerId: customer.customerId,
        fullName: customer.fullName,
        fatherOrHusbandName: customer.fatherOrHusbandName,
        dob: customer.dob,
        gender: customer.gender,
        mobile: customer.mobile,
        whatsapp: customer.whatsapp,
        village: customer.village,
        presentAddress: customer.presentAddress,
      },
      serviceId: service.serviceId,
      serviceSnapshot: {
        serviceId: service.serviceId,
        serviceCode: service.serviceCode,
        name: service.name,
        categoryName: service.categoryName,
        appliedFormVersion: formVersion.versionNo,
        formFieldsSnapshot: JSON.parse(JSON.stringify(formFields)),
        requiredDocsSnapshot: JSON.parse(JSON.stringify(service.requiredDocuments)),
        customerChargeSnapshot: service.customerCharge,
        serviceCostSnapshot: service.serviceCost,
        profitSnapshot: service.profitAmount,
        termsSnapshot: service.termsAndConditions,
      },
      formData: validation.cleaned,
      status: mode,
      assignedStaffId,
      assignedCounterCode,
      submissionDate: mode === 'Submitted' ? now : null,
      expectedCompletionDate,
      actualCompletionDate: null,
      slaPausedMinutes: 0,
      mandatoryDocExceptionReason: b.mandatoryDocExceptionReason
        ? sanitizeText(String(b.mandatoryDocExceptionReason))
        : null,
      duplicateOverrideReason: b.duplicateOverrideReason
        ? sanitizeText(String(b.duplicateOverrideReason))
        : null,
      references: [],
      statusHistory: [
        {
          id: erp.nextNumericId('statusEvt'),
          previousStatus: null,
          newStatus: mode,
          changedBy: actor.userId,
          changedByRole: actor.role,
          remarks: mode === 'Draft' ? 'Saved as Draft application' : 'Application formally submitted',
          reason: b.mandatoryDocExceptionReason
            ? `Exception: ${sanitizeText(String(b.mandatoryDocExceptionReason))}`
            : 'Initial creation',
          changedAt: now,
        },
      ],
      assignmentHistory: [
        {
          id: erp.nextNumericId('assign'),
          previousStaffId: null,
          newStaffId: assignedStaffId,
          previousCounterCode: null,
          newCounterCode: assignedCounterCode,
          assignedBy: actor.userId,
          reason: 'Initial application intake assignment',
          assignedAt: now,
        },
      ],
      archivedAt: null,
      archivedBy: null,
      deletionProposalStatus: 'None',
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    };

    erp.applications.unshift(newApp);

    // Store initial private documents
    for (const d of initialDocsInput) {
      const mime = d.mimeType as 'application/pdf' | 'image/jpeg' | 'image/png';
      const rawB64 = typeof d.contentBase64 === 'string' ? d.contentBase64 : '';
      const rawBuf = rawB64 ? Buffer.from(rawB64, 'base64') : Buffer.alloc(0);
      erp.documents.unshift({
        id: erp.nextNumericId('doc'),
        fileUuid: crypto.randomUUID(),
        applicationNo,
        customerId: customer.customerId,
        docKey: sanitizeText(String(d.docKey || 'supporting_doc')),
        category: sanitizeText(String(d.category || 'Supporting Document')),
        originalName: sanitizeText(String(d.originalName)),
        mimeType: mime,
        fileSizeBytes: rawBuf.length || Number(d.sizeBytes ?? d.fileSizeBytes ?? 0),
        contentBase64: rawB64,
        storageUrl:
          typeof d.storageUrl === 'string' && d.storageUrl.trim()
            ? sanitizeText(d.storageUrl.trim()).slice(0, 1000)
            : undefined,
        storagePath:
          typeof d.storagePath === 'string' && d.storagePath.trim()
            ? sanitizeText(d.storagePath.trim()).slice(0, 300)
            : undefined,
        verificationStatus: 'Pending',
        versionNo: 1,
        uploadedBy: actor.userId,
        uploadedAt: now,
        deletedAt: null,
        verificationHistory: [
          {
            status: 'Pending',
            actor: actor.userId,
            reason: 'Uploaded during application creation',
            at: now,
          },
        ],
      });
    }

    // Optional initial payment collected atomically at creation
    if (b.initialPayment && Number(b.initialPayment.amount) > 0) {
      const amt = Number(b.initialPayment.amount);
      if (amt <= service.customerCharge) {
        const method = b.initialPayment.paymentMethod || 'Cash';
        const receiptNo = await p3.docSequence.allocateNext('RECEIPT', p3.globalConfig.prefixes.RECEIPT);
        const invoiceNo =
          amt >= service.customerCharge
            ? await p3.docSequence.allocateNext('INVOICE', p3.globalConfig.prefixes.INVOICE)
            : undefined;
        erp.payments.unshift({
          id: erp.nextNumericId('payment'),
          transactionId: `TXN-${Date.now().toString().slice(-8)}-${erp.payments.length + 1}`,
          receiptNo,
          invoiceNo,
          applicationNo,
          customerId: customer.customerId,
          customerName: customer.fullName,
          serviceId: service.serviceId,
          serviceName: service.name,
          counterCode: assignedCounterCode,
          collectedBy: actor.userId,
          paymentType: amt >= service.customerCharge ? 'Full' : 'Advance',
          paymentMethod: method,
          upiReference: b.initialPayment.upiReference
            ? sanitizeText(String(b.initialPayment.upiReference))
            : undefined,
          amount: amt,
          verificationStatus: method === 'UPI' ? 'Pending Verification' : 'Confirmed',
          verifiedBy: method === 'UPI' ? null : actor.userId,
          verifiedAt: method === 'UPI' ? null : now,
          recordedAt: now,
          notes: sanitizeText(String(b.initialPayment.notes ?? 'Initial intake payment')),
        });
      }
    }

    // Fire Automation & Consent-Gated Notification
    erp.runAutomationsForEvent({
      trigger: mode === 'Submitted' ? 'APPLICATION_SUBMITTED' : 'APPLICATION_CREATED',
      app: newApp,
      actorUserId: actor.userId,
      actorRole: actor.role,
    });
    erp.dispatchNotification({
      customer,
      applicationNo,
      channel: 'DASHBOARD',
      eventKey: mode === 'Submitted' ? 'APPLICATION_SUBMITTED' : 'APPLICATION_CREATED',
      consentCategory: 'STATUS_UPDATE_CONSENT',
      messagePreview: `Application ${applicationNo} (${service.name}) created with status ${mode}.`,
      actorUserId: actor.userId,
    });
    if (mode === 'Submitted') {
      erp.dispatchNotification({
        customer,
        applicationNo,
        channel: 'SMS',
        eventKey: 'APPLICATION_SUBMITTED',
        consentCategory: 'SMS_CONSENT',
        messagePreview: `Dear ${customer.fullName}, your application ${applicationNo} for ${service.name} is Submitted.`,
        actorUserId: actor.userId,
      });
      if (customer.consents.find((c) => c.category === 'SMS_CONSENT')?.granted && customer.mobile) {
        void sendFast2SmsTemplateMessage({
          mobile: customer.mobile,
          purpose: 'SERVICE_REQUEST',
          variables: [applicationNo, service.name],
          fallbackText: `Dear ${customer.fullName}, your service request ${applicationNo} (${service.name}) is registered at MUN COMPUTER.`,
          runtimeConfig: erp.phase03Store.getSmsGatewayConfig(),
        }).catch(() => {});
      }
    }

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: mode === 'Submitted' ? 'CREATE_AND_SUBMIT_APPLICATION' : 'CREATE_DRAFT_APPLICATION',
      applicationNo,
      newValue: `${service.serviceId} -> ${customer.customerId}`,
      reason: b.duplicateOverrideReason
        ? `Duplicate override: ${sanitizeText(String(b.duplicateOverrideReason))}`
        : b.mandatoryDocExceptionReason
          ? `Doc exception: ${sanitizeText(String(b.mandatoryDocExceptionReason))}`
          : 'Application registered',
      ipAddress: getIp(req),
    });

    return ok(
      res,
      enrichApplication(newApp, true),
      `Application ${applicationNo} (${mode}) created.`,
      201
    );
  });

  // Validated 12-Status Workflow Transition Engine
  app.post('/api/erp/applications/:appNo/status', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'applications', 'EDIT');
    if (!actor) return;

    const application = erp.applications.find((a) => a.applicationNo === req.params.appNo);
    if (!application) return fail(res, 'Application not found.', 404);
    if (!canAccessApplication(actor, application)) {
      return fail(res, 'Forbidden: cannot modify another staff application.', 403);
    }

    const { nextStatus, reason, remarks, mandatoryDocExceptionReason } = req.body ?? {};
    const targetStatus = nextStatus as ErpApplicationStatus;
    const allowedNext = ALLOWED_STATUS_TRANSITIONS[application.status] ?? [];
    if (!allowedNext.includes(targetStatus)) {
      return fail(
        res,
        `Invalid workflow transition: "${application.status}" cannot transition directly to "${targetStatus}".`,
        422
      );
    }

    if (
      REASONS_REQUIRED_STATUSES.includes(targetStatus) &&
      (!reason || String(reason).trim().length < 3)
    ) {
      return fail(res, `A mandatory reason is required to transition to "${targetStatus}".`, 422);
    }

    // Reopening Rejected / Completed / Cancelled requires APPROVE permission (Admin / Manager)
    if (
      targetStatus === 'Reopened' &&
      !securityStore.hasPermission(actor, 'applications', 'APPROVE')
    ) {
      return fail(res, 'Forbidden: Reopening closed applications requires Manager or Admin approval.', 403);
    }

    // If transitioning from Draft -> Submitted, enforce mandatory document checklist unless authorized exception
    if (application.status === 'Draft' && targetStatus === 'Submitted') {
      const checklist = erp.computeDocumentChecklist(application);
      if (!checklist.isSubmissionReady) {
        if (!mandatoryDocExceptionReason) {
          return fail(
            res,
            `Mandatory document(s) missing before submission: ${checklist.missingRequiredLabels.join(', ')}.`,
            422
          );
        }
        if (actor.role === 'STAFF') {
          return fail(
            res,
            'Only Manager or Admin can submit an application with a Mandatory Document Exception.',
            403
          );
        }
        application.mandatoryDocExceptionReason = sanitizeText(String(mandatoryDocExceptionReason));
      }
      application.submissionDate = new Date().toISOString();
    }

    const prevStatus = application.status;
    const now = new Date().toISOString();
    application.status = targetStatus;
    if (targetStatus === 'Completed' || targetStatus === 'Approved') {
      application.actualCompletionDate = application.actualCompletionDate ?? now;
    }
    application.updatedAt = now;

    application.statusHistory.unshift({
      id: erp.nextNumericId('statusEvt'),
      previousStatus: prevStatus,
      newStatus: targetStatus,
      changedBy: actor.userId,
      changedByRole: actor.role,
      remarks: sanitizeText(String(remarks ?? '')),
      reason: sanitizeText(String(reason ?? 'Status workflow update')),
      changedAt: now,
    });

    erp.runAutomationsForEvent({
      trigger: targetStatus === 'Completed' ? 'APPLICATION_COMPLETED' : 'STATUS_CHANGED',
      app: application,
      actorUserId: actor.userId,
      actorRole: actor.role,
    });

    const customer = erp.customers.find((c) => c.customerId === application.customerId);
    if (customer) {
      erp.dispatchNotification({
        customer,
        applicationNo: application.applicationNo,
        channel: 'DASHBOARD',
        eventKey: 'STATUS_CHANGED',
        consentCategory: 'STATUS_UPDATE_CONSENT',
        messagePreview: `${application.applicationNo}: ${prevStatus} → ${targetStatus}.`,
        actorUserId: actor.userId,
      });
      if (
        (targetStatus === 'Completed' || targetStatus === 'Approved') &&
        customer.consents.find((c) => c.category === 'SMS_CONSENT')?.granted &&
        customer.mobile
      ) {
        void sendFast2SmsTemplateMessage({
          mobile: customer.mobile,
          purpose: 'TASK_COMPLETED',
          variables: [application.applicationNo, application.serviceSnapshot.name],
          fallbackText: `Dear ${customer.fullName}, your service ${application.applicationNo} (${application.serviceSnapshot.name}) is ${targetStatus} at MUN COMPUTER.`,
          runtimeConfig: erp.phase03Store.getSmsGatewayConfig(),
        }).catch(() => {});
      }
    }

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'STATUS_TRANSITION',
      applicationNo: application.applicationNo,
      previousValue: prevStatus,
      newValue: targetStatus,
      reason: sanitizeText(String(reason ?? remarks ?? '')),
      ipAddress: getIp(req),
    });

    return ok(
      res,
      enrichApplication(application, true),
      `Application ${application.applicationNo} moved from ${prevStatus} to ${targetStatus}.`
    );
  });

  // Update Application Form Data (preserves version schema)
  app.put('/api/erp/applications/:appNo/form-data', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'applications', 'EDIT');
    if (!actor) return;

    const application = erp.applications.find((a) => a.applicationNo === req.params.appNo);
    if (!application) return fail(res, 'Application not found.', 404);
    if (!canAccessApplication(actor, application)) {
      return fail(res, 'Forbidden: cannot edit unassigned/other staff application.', 403);
    }

    const validation = erp.validateDynamicFormData(
      application.serviceSnapshot.formFieldsSnapshot,
      req.body?.formData ?? {},
      application.status !== 'Draft'
    );
    if (!validation.valid) {
      const errorBag: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(validation.errors)) errorBag[k] = [v];
      return fail(res, 'Form data validation failed.', 422, errorBag);
    }

    application.formData = validation.cleaned;
    application.updatedAt = new Date().toISOString();

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'UPDATE_APPLICATION_FORM_DATA',
      applicationNo: application.applicationNo,
      ipAddress: getIp(req),
    });

    return ok(res, enrichApplication(application, true), 'Application form fields updated.');
  });

  // Assignment & Staff Self-Claim Engine
  app.post('/api/erp/applications/:appNo/assign', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'applications', 'EDIT');
    if (!actor) return;

    const application = erp.applications.find((a) => a.applicationNo === req.params.appNo);
    if (!application) return fail(res, 'Application not found.', 404);

    const { assignedStaffId, assignedCounterCode, reason, action } = req.body ?? {};
    const now = new Date().toISOString();

    // Staff self-claim unassigned application
    if (action === 'CLAIM') {
      if (application.assignedStaffId && application.assignedStaffId !== actor.userId) {
        return fail(res, 'Application is already assigned to another staff member.', 403);
      }
      const prevStaff = application.assignedStaffId;
      application.assignedStaffId = actor.userId;
      application.assignedCounterCode =
        assignedCounterCode || application.assignedCounterCode || 'CTR-01';
      application.updatedAt = now;
      application.assignmentHistory.unshift({
        id: erp.nextNumericId('assign'),
        previousStaffId: prevStaff,
        newStaffId: actor.userId,
        previousCounterCode: application.assignedCounterCode,
        newCounterCode: application.assignedCounterCode,
        assignedBy: actor.userId,
        reason: sanitizeText(String(reason ?? 'Staff claimed unassigned application')),
        assignedAt: now,
      });
      erp.addActivity({
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'CLAIM_APPLICATION',
        applicationNo: application.applicationNo,
        newValue: actor.userId,
        ipAddress: getIp(req),
      });
      return ok(res, enrichApplication(application, true), `Claimed by ${actor.userId}.`);
    }

    // Direct Assign / Reassign requires Admin or Manager
    if (actor.role === 'STAFF') {
      return fail(
        res,
        'Staff cannot directly assign or transfer applications to others. Submit a Reassignment Request instead.',
        403
      );
    }

    const prevStaff = application.assignedStaffId;
    const prevCtr = application.assignedCounterCode;
    application.assignedStaffId = assignedStaffId ? sanitizeText(String(assignedStaffId)) : null;
    application.assignedCounterCode = assignedCounterCode
      ? sanitizeText(String(assignedCounterCode))
      : application.assignedCounterCode;
    application.updatedAt = now;

    application.assignmentHistory.unshift({
      id: erp.nextNumericId('assign'),
      previousStaffId: prevStaff,
      newStaffId: application.assignedStaffId,
      previousCounterCode: prevCtr,
      newCounterCode: application.assignedCounterCode,
      assignedBy: actor.userId,
      reason: sanitizeText(String(reason ?? 'Assigned by supervisor')),
      assignedAt: now,
    });

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'ASSIGN_APPLICATION',
      applicationNo: application.applicationNo,
      previousValue: `${prevStaff ?? 'Unassigned'} (${prevCtr ?? '-'})`,
      newValue: `${application.assignedStaffId ?? 'Unassigned'} (${application.assignedCounterCode ?? '-'})`,
      reason: sanitizeText(String(reason ?? '')),
      ipAddress: getIp(req),
    });

    return ok(res, enrichApplication(application, true), 'Application assignment updated.');
  });

  // Reassignment Request Workflow (Staff Requests -> Manager/Admin Approves)
  app.get('/api/erp/reassignment-requests', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'applications', 'VIEW');
    if (!actor) return;
    const list =
      actor.role === 'STAFF'
        ? erp.reassignmentRequests.filter((r) => r.requestedBy === actor.userId)
        : erp.reassignmentRequests;
    return ok(res, list);
  });

  app.post('/api/erp/applications/:appNo/reassignment-requests', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'applications', 'EDIT');
    if (!actor) return;

    const application = erp.applications.find((a) => a.applicationNo === req.params.appNo);
    if (!application) return fail(res, 'Application not found.', 404);
    if (!canAccessApplication(actor, application)) {
      return fail(res, 'Forbidden: cannot request transfer for an application outside your access.', 403);
    }

    const { proposedStaffId, proposedCounterCode, reason } = req.body ?? {};
    if (!reason || String(reason).trim().length < 3) {
      return fail(res, 'Reason for reassignment request is required.', 422);
    }

    const reqItem = {
      id: erp.nextNumericId('reassignReq'),
      requestCode: `REASS-${String(erp.reassignmentRequests.length + 1).padStart(4, '0')}`,
      applicationNo: application.applicationNo,
      requestedBy: actor.userId,
      currentStaffId: application.assignedStaffId,
      proposedStaffId: proposedStaffId ? sanitizeText(String(proposedStaffId)) : null,
      proposedCounterCode: proposedCounterCode ? sanitizeText(String(proposedCounterCode)) : null,
      reason: sanitizeText(String(reason)),
      status: 'Pending' as const,
      reviewedBy: null,
      reviewNotes: null,
      createdAt: new Date().toISOString(),
      reviewedAt: null,
    };
    erp.reassignmentRequests.unshift(reqItem);

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'SUBMIT_REASSIGNMENT_REQUEST',
      applicationNo: application.applicationNo,
      newValue: `${reqItem.requestCode} -> ${reqItem.proposedStaffId ?? 'Queue'}`,
      reason: reqItem.reason,
      ipAddress: getIp(req),
    });

    return ok(res, reqItem, 'Reassignment request submitted for Manager/Admin review.', 201);
  });

  app.post('/api/erp/reassignment-requests/:requestCode/review', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (!securityStore.hasPermission(actor, 'applications', 'APPROVE')) {
      return fail(res, 'Forbidden: only Manager or Admin may review reassignment requests.', 403);
    }
    const reqItem = erp.reassignmentRequests.find((r) => r.requestCode === req.params.requestCode);
    if (!reqItem) return fail(res, 'Reassignment request not found.', 404);
    if (reqItem.status !== 'Pending') return fail(res, 'Request has already been reviewed.', 400);

    const { decision, reviewNotes } = req.body ?? {};
    if (!['Approved', 'Rejected'].includes(String(decision))) {
      return fail(res, 'Decision must be Approved or Rejected.', 422);
    }

    const now = new Date().toISOString();
    reqItem.status = decision;
    reqItem.reviewedBy = actor.userId;
    reqItem.reviewNotes = sanitizeText(String(reviewNotes ?? ''));
    reqItem.reviewedAt = now;

    if (decision === 'Approved') {
      const application = erp.applications.find((a) => a.applicationNo === reqItem.applicationNo);
      if (application) {
        const prevStaff = application.assignedStaffId;
        const prevCtr = application.assignedCounterCode;
        application.assignedStaffId = reqItem.proposedStaffId;
        if (reqItem.proposedCounterCode) application.assignedCounterCode = reqItem.proposedCounterCode;
        application.updatedAt = now;
        application.assignmentHistory.unshift({
          id: erp.nextNumericId('assign'),
          previousStaffId: prevStaff,
          newStaffId: application.assignedStaffId,
          previousCounterCode: prevCtr,
          newCounterCode: application.assignedCounterCode,
          assignedBy: actor.userId,
          reason: `Reassignment Approved (${reqItem.requestCode}): ${reqItem.reason}`,
          assignedAt: now,
        });
      }
    }

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: `REASSIGNMENT_${decision.toUpperCase()}`,
      applicationNo: reqItem.applicationNo,
      newValue: reqItem.requestCode,
      reason: reqItem.reviewNotes || decision,
      ipAddress: getIp(req),
    });

    return ok(res, reqItem, `Reassignment request ${reqItem.requestCode} ${decision}.`);
  });

  // Dynamic Reference Numbers per Application (with Uniqueness Check + History)
  app.post('/api/erp/applications/:appNo/references', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'applications', 'EDIT');
    if (!actor) return;

    const application = erp.applications.find((a) => a.applicationNo === req.params.appNo);
    if (!application) return fail(res, 'Application not found.', 404);
    if (!canAccessApplication(actor, application)) {
      return fail(res, 'Forbidden: cannot edit reference numbers on another staff application.', 403);
    }

    const { fieldKey, value, reason } = req.body ?? {};
    const def = erp.referenceFields.find((r) => r.fieldKey === fieldKey && r.enabled);
    if (!def) {
      return fail(res, 'Reference field is invalid or disabled.', 422);
    }
    if (def.serviceId !== 'ALL' && def.serviceId !== application.serviceId) {
      return fail(res, `Reference field "${def.label}" does not apply to this service.`, 422);
    }
    const cleanVal = sanitizeText(String(value ?? ''));
    if (!cleanVal) {
      return fail(res, 'Reference value is required.', 422);
    }

    // Uniqueness enforcement
    if (def.uniqueScope !== 'NONE') {
      const conflict = erp.applications.find((other) => {
        if (other.applicationNo === application.applicationNo || other.archivedAt) return false;
        if (def.uniqueScope === 'PER_SERVICE' && other.serviceId !== application.serviceId) return false;
        return other.references.some(
          (ref) => ref.fieldKey === def.fieldKey && ref.value.toLowerCase() === cleanVal.toLowerCase()
        );
      });
      if (conflict) {
        return fail(
          res,
          `Duplicate ${def.label}: "${cleanVal}" is already linked to ${conflict.applicationNo}.`,
          409
        );
      }
    }

    const now = new Date().toISOString();
    const existing = application.references.find((r) => r.fieldKey === def.fieldKey);
    if (existing) {
      if (existing.value !== cleanVal) {
        existing.history.unshift({
          previousValue: existing.value,
          newValue: cleanVal,
          changedBy: actor.userId,
          changedAt: now,
          reason: sanitizeText(String(reason ?? 'Reference updated')),
        });
        existing.value = cleanVal;
        existing.updatedBy = actor.userId;
        existing.updatedAt = now;
      }
    } else {
      application.references.push({
        id: erp.nextNumericId('appRef'),
        fieldKey: def.fieldKey,
        label: def.label,
        value: cleanVal,
        addedBy: actor.userId,
        addedAt: now,
        updatedBy: actor.userId,
        updatedAt: now,
        history: [],
      });
    }
    application.updatedAt = now;

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'UPSERT_REFERENCE_NUMBER',
      applicationNo: application.applicationNo,
      newValue: `${def.label}: ${cleanVal}`,
      reason: reason ? sanitizeText(String(reason)) : undefined,
      ipAddress: getIp(req),
    });

    return ok(res, enrichApplication(application, true), `${def.label} saved.`);
  });

  // Smart Private Document Upload, Authenticated Download & Verification
  app.post('/api/erp/applications/:appNo/documents', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'documents', 'ADD');
    if (!actor) return;

    const application = erp.applications.find((a) => a.applicationNo === req.params.appNo);
    if (!application) return fail(res, 'Application not found.', 404);
    if (!canAccessApplication(actor, application)) {
      return fail(res, 'Forbidden: cannot upload documents to another staff application.', 403);
    }

    const {
      docKey,
      category,
      originalName,
      mimeType,
      contentBase64,
      replaceFileUuid,
      expiryDate,
      storageUrl,
      storagePath,
      fileSizeBytes,
    } = req.body ?? {};
    const nameStr = String(originalName ?? '').trim();
    const mimeStr = String(mimeType ?? '').trim();
    const ext = nameStr.split('.').pop()?.toLowerCase() ?? '';

    if (
      !nameStr ||
      BLOCKED_EXECUTABLE_EXTS.has(ext) ||
      !ALLOWED_MIME_TYPES.has(mimeStr) ||
      !(ALLOWED_EXT_MAP[mimeStr] ?? []).includes(ext)
    ) {
      return fail(
        res,
        'Invalid or unsafe file format. Only PDF, JPG, JPEG, and PNG documents are permitted.',
        422
      );
    }

    const rawBase64 = String(contentBase64 ?? '').replace(/^data:[^;]+;base64,/, '');
    const buffer = rawBase64 ? Buffer.from(rawBase64, 'base64') : Buffer.alloc(0);
    const cleanStorageUrl =
      typeof storageUrl === 'string' && /^https?:\/\//i.test(storageUrl.trim())
        ? storageUrl.trim().slice(0, 1000)
        : undefined;
    const cleanStoragePath =
      typeof storagePath === 'string' && storagePath.trim()
        ? sanitizeText(storagePath.trim()).slice(0, 300)
        : undefined;
    const resolvedBytes = buffer.length || Number(fileSizeBytes || 0);
    if (resolvedBytes <= 0 && !cleanStorageUrl) {
      return fail(res, 'Uploaded file content is empty or corrupted.', 422);
    }
    if (resolvedBytes > MAX_UPLOAD_BYTES) {
      return fail(res, 'File exceeds maximum 10 MB upload limit.', 422);
    }

    let versionNo = 1;
    let replacedUuid: string | null = null;
    if (replaceFileUuid) {
      const oldDoc = erp.documents.find((d) => d.fileUuid === replaceFileUuid);
      if (oldDoc) {
        versionNo = oldDoc.versionNo + 1;
        replacedUuid = oldDoc.fileUuid;
        oldDoc.deletedAt = new Date().toISOString();
      }
    }

    const now = new Date().toISOString();
    const newDoc: ApplicationDocumentRecord = {
      id: erp.nextNumericId('doc'),
      fileUuid: crypto.randomUUID(),
      applicationNo: application.applicationNo,
      customerId: application.customerId,
      docKey: sanitizeText(String(docKey || 'supporting_doc')),
      category: sanitizeText(String(category || 'Supporting Document')),
      originalName: sanitizeText(nameStr),
      mimeType: mimeStr as 'application/pdf' | 'image/jpeg' | 'image/png',
      fileSizeBytes: resolvedBytes,
      contentBase64: rawBase64,
      storageUrl: cleanStorageUrl,
      storagePath: cleanStoragePath,
      verificationStatus: 'Pending',
      versionNo,
      replacedFileUuid: replacedUuid,
      expiryDate: expiryDate ? sanitizeText(String(expiryDate)) : null,
      uploadedBy: actor.userId,
      uploadedAt: now,
      deletedAt: null,
      verificationHistory: [
        {
          status: 'Pending',
          actor: actor.userId,
          reason: replacedUuid ? `Replacement v${versionNo} uploaded` : 'Initial upload',
          at: now,
        },
      ],
    };

    erp.documents.unshift(newDoc);
    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: replacedUuid ? 'REPLACE_APPLICATION_DOCUMENT' : 'UPLOAD_APPLICATION_DOCUMENT',
      applicationNo: application.applicationNo,
      newValue: `${newDoc.originalName} (${newDoc.fileUuid})`,
      ipAddress: getIp(req),
    });

    return ok(
      res,
      {
        document: erp.sanitizePublicDocument(newDoc),
        checklistSummary: erp.computeDocumentChecklist(application),
      },
      'Document uploaded to private storage.',
      201
    );
  });

  app.get('/api/erp/documents/:fileUuid/download', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'documents', 'VIEW');
    if (!actor) return;

    const doc = erp.documents.find((d) => d.fileUuid === req.params.fileUuid);
    if (!doc) return fail(res, 'Document not found.', 404);

    const application = erp.applications.find((a) => a.applicationNo === doc.applicationNo);
    if (application && !canAccessApplication(actor, application)) {
      return fail(res, 'Forbidden: unauthorized document download.', 403);
    }

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'DOWNLOAD_PRIVATE_DOCUMENT',
      applicationNo: doc.applicationNo,
      newValue: `${doc.originalName} (${doc.fileUuid})`,
      ipAddress: getIp(req),
    });

    return ok(res, {
      fileUuid: doc.fileUuid,
      originalName: doc.originalName,
      mimeType: doc.mimeType,
      fileSizeBytes: doc.fileSizeBytes,
      contentBase64: doc.contentBase64,
    });
  });

  app.post('/api/erp/documents/:fileUuid/verify', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    const canVerify =
      actor.role === 'ADMIN' ||
      actor.role === 'MANAGER' ||
      securityStore.hasPermission(actor, 'applications', 'APPROVE') ||
      securityStore.hasPermission(actor, 'documents', 'EDIT');
    if (!canVerify) {
      securityStore.addSecurityLog({
        actorUserId: actor.userId,
        eventType: 'UNAUTHORIZED_ACCESS',
        result: 'BLOCKED',
        ipAddress: getIp(req),
        deviceInfo: 'Document Verify',
        summary: `Blocked ${actor.role} ${actor.userId} from verifying document ${req.params.fileUuid}.`,
      });
      return fail(res, 'Forbidden: Document verification requires Manager, Admin, or APPROVE permission.', 403);
    }

    const doc = erp.documents.find((d) => d.fileUuid === req.params.fileUuid && !d.deletedAt);
    if (!doc) return fail(res, 'Active document not found.', 404);

    const { status, reason } = req.body ?? {};
    if (!['Verified', 'Rejected'].includes(String(status))) {
      return fail(res, 'Verification status must be Verified or Rejected.', 422);
    }
    if (status === 'Rejected' && (!reason || String(reason).trim().length < 3)) {
      return fail(res, 'Rejection reason is mandatory when rejecting a document.', 422);
    }

    const now = new Date().toISOString();
    doc.verificationStatus = status;
    doc.rejectionReason = status === 'Rejected' ? sanitizeText(String(reason)) : undefined;
    doc.verifiedBy = actor.userId;
    doc.verifiedAt = now;
    doc.verificationHistory.unshift({
      status,
      actor: actor.userId,
      reason: sanitizeText(String(reason ?? 'Verified ok')),
      at: now,
    });

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: status === 'Verified' ? 'VERIFY_DOCUMENT' : 'REJECT_DOCUMENT',
      applicationNo: doc.applicationNo,
      newValue: `${doc.originalName}: ${status}`,
      reason: reason ? sanitizeText(String(reason)) : undefined,
      ipAddress: getIp(req),
    });

    return ok(res, erp.sanitizePublicDocument(doc), `Document marked ${status}.`);
  });

  // Follow-ups & Reminders
  app.post('/api/erp/applications/:appNo/follow-ups', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'applications', 'EDIT');
    if (!actor) return;

    const application = erp.applications.find((a) => a.applicationNo === req.params.appNo);
    if (!application) return fail(res, 'Application not found.', 404);
    if (!canAccessApplication(actor, application)) return fail(res, 'Forbidden.', 403);

    const { followUpDate, followUpTime, reason, remarks, assignedStaffId } = req.body ?? {};
    if (!followUpDate || !reason) {
      return fail(res, 'Follow-up date and reason are required.', 422);
    }

    const now = new Date().toISOString();
    const item = {
      id: erp.nextNumericId('followUp'),
      applicationNo: application.applicationNo,
      followUpDate: sanitizeText(String(followUpDate)),
      followUpTime: sanitizeText(String(followUpTime || '11:00')),
      reason: sanitizeText(String(reason)),
      assignedStaffId: sanitizeText(String(assignedStaffId || application.assignedStaffId || actor.userId)),
      status: 'Pending' as const,
      remarks: sanitizeText(String(remarks || '')),
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    };
    erp.followUps.unshift(item);

    return ok(res, item, 'Follow-up scheduled.', 201);
  });

  app.patch('/api/erp/follow-ups/:id', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'applications', 'EDIT');
    if (!actor) return;

    const item = erp.followUps.find((f) => f.id === Number(req.params.id));
    if (!item) return fail(res, 'Follow-up not found.', 404);
    if (['Pending', 'Completed', 'Rescheduled', 'Cancelled'].includes(String(req.body?.status))) {
      item.status = req.body.status;
    }
    if (req.body?.nextFollowUpDate) {
      item.nextFollowUpDate = sanitizeText(String(req.body.nextFollowUpDate));
      item.followUpDate = item.nextFollowUpDate;
    }
    if (req.body?.remarks) item.remarks = sanitizeText(String(req.body.remarks));
    item.updatedAt = new Date().toISOString();
    return ok(res, item, 'Follow-up updated.');
  });

  // Separate Internal Notes vs Customer-Facing Remarks
  app.post('/api/erp/applications/:appNo/notes', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'applications', 'EDIT');
    if (!actor) return;

    const application = erp.applications.find((a) => a.applicationNo === req.params.appNo);
    if (!application) return fail(res, 'Application not found.', 404);
    if (!canAccessApplication(actor, application)) return fail(res, 'Forbidden.', 403);

    const { noteType, content } = req.body ?? {};
    if (!['INTERNAL', 'CUSTOMER_REMARK'].includes(String(noteType))) {
      return fail(res, 'noteType must be INTERNAL or CUSTOMER_REMARK.', 422);
    }
    if (!content || String(content).trim().length < 2) {
      return fail(res, 'Note content is required.', 422);
    }

    const note = {
      id: erp.nextNumericId('note'),
      applicationNo: application.applicationNo,
      noteType,
      content: sanitizeText(String(content)),
      createdBy: actor.userId,
      createdAt: new Date().toISOString(),
      editHistory: [],
    };
    erp.notes.unshift(note);
    return ok(res, note, `${noteType === 'INTERNAL' ? 'Internal note' : 'Customer remark'} added.`, 201);
  });

  // Customer Delivery & Handover Tracking (MCD-YYYY-YY-NNNNNN)
  app.post('/api/erp/applications/:appNo/delivery', requireAuth, async (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'applications', 'EDIT');
    if (!actor) return;

    const application = erp.applications.find((a) => a.applicationNo === req.params.appNo);
    if (!application) return fail(res, 'Application not found.', 404);
    if (!canAccessApplication(actor, application)) return fail(res, 'Forbidden.', 403);

    const b = req.body ?? {};
    if (!b.deliverableType || !b.deliveryMethod || !b.receivedBy) {
      return fail(res, 'Deliverable type, delivery method, and receiver name are required.', 422);
    }
    if (b.status === 'Delivered' && !b.handoverConfirmed) {
      return fail(res, 'Handover confirmation checkbox/acknowledgement is required before marking Delivered.', 422);
    }

    const now = new Date().toISOString();
    let existing = erp.deliveries.find((d) => d.applicationNo === application.applicationNo);
    if (!existing) {
      const deliveryId = await p3.docSequence.allocateNext('DELIVERY', 'MCD');
      existing = {
        id: erp.nextNumericId('delivery'),
        deliveryId,
        applicationNo: application.applicationNo,
        customerId: application.customerId,
        serviceId: application.serviceId,
        assignedStaffId: application.assignedStaffId,
        counterCode: application.assignedCounterCode,
        deliverableType: sanitizeText(String(b.deliverableType)),
        deliverableDescription: sanitizeText(String(b.deliverableDescription ?? '')),
        deliveryMethod: b.deliveryMethod,
        deliveryDate: sanitizeText(String(b.deliveryDate ?? now.slice(0, 10))),
        deliveryTime: sanitizeText(String(b.deliveryTime ?? now.slice(11, 16))),
        preparedBy: actor.userId,
        deliveredBy: b.status === 'Delivered' ? actor.userId : null,
        receivedBy: sanitizeText(String(b.receivedBy)),
        representativeDetails: b.representativeDetails ? sanitizeText(String(b.representativeDetails)) : undefined,
        handoverConfirmed: Boolean(b.handoverConfirmed),
        otpConfirmed: Boolean(b.otpConfirmed),
        acknowledgementRef: sanitizeText(String(b.acknowledgementRef ?? `ACK-${deliveryId}`)),
        status: b.status || 'Delivered',
        remarks: sanitizeText(String(b.remarks ?? '')),
        createdAt: now,
        updatedAt: now,
      };
      erp.deliveries.unshift(existing);
    } else {
      existing.deliverableType = sanitizeText(String(b.deliverableType));
      existing.deliverableDescription = sanitizeText(String(b.deliverableDescription ?? existing.deliverableDescription));
      existing.deliveryMethod = b.deliveryMethod;
      existing.receivedBy = sanitizeText(String(b.receivedBy));
      existing.handoverConfirmed = Boolean(b.handoverConfirmed);
      existing.status = b.status || existing.status;
      existing.deliveredBy = existing.status === 'Delivered' ? actor.userId : existing.deliveredBy;
      existing.remarks = sanitizeText(String(b.remarks ?? existing.remarks));
      existing.updatedAt = now;
    }

    if (existing.status === 'Delivered' && application.status === 'Approved') {
      application.status = 'Completed';
      application.actualCompletionDate = now;
      application.statusHistory.unshift({
        id: erp.nextNumericId('statusEvt'),
        previousStatus: 'Approved',
        newStatus: 'Completed',
        changedBy: actor.userId,
        changedByRole: actor.role,
        remarks: `Delivered via ${existing.deliveryId}`,
        reason: 'Customer handover confirmed',
        changedAt: now,
      });
    }

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'RECORD_DELIVERY_HANDOVER',
      applicationNo: application.applicationNo,
      newValue: `${existing.deliveryId} (${existing.status}) -> ${existing.receivedBy}`,
      ipAddress: getIp(req),
    });

    return ok(res, existing, `Delivery ${existing.deliveryId} saved (${existing.status}).`, 201);
  });

  // Cancellation Request & Approval
  app.post('/api/erp/applications/:appNo/cancellation-requests', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'applications', 'EDIT');
    if (!actor) return;

    const application = erp.applications.find((a) => a.applicationNo === req.params.appNo);
    if (!application) return fail(res, 'Application not found.', 404);
    if (!canAccessApplication(actor, application)) return fail(res, 'Forbidden.', 403);

    const { reason } = req.body ?? {};
    if (!reason || String(reason).trim().length < 4) {
      return fail(res, 'Cancellation reason is mandatory.', 422);
    }

    const reqItem = {
      id: erp.nextNumericId('cancelReq'),
      requestCode: `CANC-${String(erp.cancellationRequests.length + 1).padStart(4, '0')}`,
      applicationNo: application.applicationNo,
      reason: sanitizeText(String(reason)),
      requestedBy: actor.userId,
      status: 'Pending' as const,
      reviewedBy: null,
      reviewRemarks: null,
      createdAt: new Date().toISOString(),
      reviewedAt: null,
    };
    erp.cancellationRequests.unshift(reqItem);
    return ok(res, reqItem, 'Cancellation request submitted for Manager/Admin review.', 201);
  });

  app.post('/api/erp/cancellation-requests/:requestCode/review', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (!securityStore.hasPermission(actor, 'applications', 'APPROVE')) {
      return fail(res, 'Forbidden: only Manager or Admin may review cancellation requests.', 403);
    }
    const reqItem = erp.cancellationRequests.find((c) => c.requestCode === req.params.requestCode);
    if (!reqItem) return fail(res, 'Cancellation request not found.', 404);

    const { decision, reviewRemarks } = req.body ?? {};
    if (!['Approved', 'Rejected'].includes(String(decision))) {
      return fail(res, 'Decision must be Approved or Rejected.', 422);
    }

    const now = new Date().toISOString();
    reqItem.status = decision;
    reqItem.reviewedBy = actor.userId;
    reqItem.reviewRemarks = sanitizeText(String(reviewRemarks ?? ''));
    reqItem.reviewedAt = now;

    if (decision === 'Approved') {
      const appItem = erp.applications.find((a) => a.applicationNo === reqItem.applicationNo);
      if (appItem && appItem.status !== 'Cancelled') {
        const prev = appItem.status;
        appItem.status = 'Cancelled';
        appItem.updatedAt = now;
        appItem.statusHistory.unshift({
          id: erp.nextNumericId('statusEvt'),
          previousStatus: prev,
          newStatus: 'Cancelled',
          changedBy: actor.userId,
          changedByRole: actor.role,
          remarks: reqItem.reviewRemarks || 'Cancellation request approved',
          reason: reqItem.reason,
          changedAt: now,
        });
      }
    }

    return ok(res, reqItem, `Cancellation request ${decision}.`);
  });

  // Archive / Soft-Delete Application
  app.post('/api/erp/applications/:appNo/archive', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    const application = erp.applications.find((a) => a.applicationNo === req.params.appNo);
    if (!application) return fail(res, 'Application not found.', 404);

    if (actor.role !== 'ADMIN') {
      application.deletionProposalStatus = 'Pending';
      erp.addActivity({
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'PROPOSE_APPLICATION_ARCHIVE',
        applicationNo: application.applicationNo,
        reason: sanitizeText(String(req.body?.reason ?? 'Requested archival')),
        ipAddress: getIp(req),
      });
      return ok(res, { proposed: true }, 'Archive proposal submitted for Admin confirmation.');
    }

    application.archivedAt = new Date().toISOString();
    application.archivedBy = actor.userId;
    application.deletionProposalStatus = 'None';
    return ok(res, { archived: true }, `Application ${application.applicationNo} archived.`);
  });

  app.delete('/api/erp/applications/:appNo', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'applications', 'DELETE');
    if (!actor) return;
    if (actor.role !== 'ADMIN') {
      return fail(res, 'Only ADMIN can permanently delete applications.', 403);
    }
    const appNo = decodeURIComponent(req.params.appNo);
    const idx = erp.applications.findIndex((a) => a.applicationNo === appNo);
    if (idx === -1) return fail(res, 'Application not found.', 404);

    const hasConfirmedPayments = erp.payments.some(
      (p) => p.applicationNo === appNo && p.verificationStatus === 'Confirmed'
    );
    if (hasConfirmedPayments) {
      return fail(
        res,
        `Cannot permanently delete ${appNo} because it has confirmed payment receipts. Archive it instead to preserve accounting audit trail.`,
        409
      );
    }

    const removed = erp.applications.splice(idx, 1)[0];
    erp.deletedApplicationNos.add(removed.applicationNo);
    erp.documents = erp.documents.filter((d) => d.applicationNo !== removed.applicationNo);
    erp.notes = erp.notes.filter((n) => n.applicationNo !== removed.applicationNo);
    erp.followUps = erp.followUps.filter((f) => f.applicationNo !== removed.applicationNo);
    erp.deliveries = erp.deliveries.filter((d) => d.applicationNo !== removed.applicationNo);
    erp.reassignmentRequests = erp.reassignmentRequests.filter(
      (r) => r.applicationNo !== removed.applicationNo
    );
    erp.cancellationRequests = erp.cancellationRequests.filter(
      (c) => c.applicationNo !== removed.applicationNo
    );
    erp.payments = erp.payments.filter((p) => p.applicationNo !== removed.applicationNo);

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'DELETE_APPLICATION_PERMANENT',
      applicationNo: removed.applicationNo,
      ipAddress: getIp(req),
    });
    return ok(
      res,
      { deleted: true, applicationNo: removed.applicationNo },
      `Application ${removed.applicationNo} deleted permanently.`
    );
  });

  // ==========================================================================
  // 5. FINANCIAL LEDGER: PAYMENTS, UPI VERIFICATION, REFUNDS & EXPENSES
  // ==========================================================================
  app.get('/api/erp/payments', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    const canSeeFinance =
      actor.role === 'ADMIN' ||
      actor.role === 'MANAGER' ||
      securityStore.hasPermission(actor, 'transactions', 'VIEW') ||
      securityStore.hasPermission(actor, 'receipts', 'VIEW');
    if (!canSeeFinance) return fail(res, 'Forbidden.', 403);

    return ok(res, {
      payments: erp.payments,
      refunds: erp.refunds,
      expenses: erp.expenses,
    });
  });

  app.post('/api/erp/payments', requireAuth, async (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'receipts', 'ADD');
    if (!actor) return;

    const { applicationNo, amount, paymentType, paymentMethod, upiReference, counterCode, notes } =
      req.body ?? {};
    const application = erp.applications.find((a) => a.applicationNo === applicationNo);
    if (!application) return fail(res, 'Application not found.', 404);

    const amt = round2(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) {
      return fail(res, 'Payment amount must be greater than zero.', 422);
    }

    const alreadyPaid = round2(
      erp.payments
        .filter((p) => p.applicationNo === application.applicationNo && p.verificationStatus === 'Confirmed')
        .reduce((s, p) => s + p.amount, 0)
    );
    const maxPayable = round2(application.serviceSnapshot.customerChargeSnapshot - alreadyPaid);
    if (amt > maxPayable) {
      return fail(
        res,
        `Payment ₹${amt} exceeds remaining application balance ₹${Math.max(0, maxPayable)}.`,
        422
      );
    }

    const method = (['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other'].includes(String(paymentMethod))
      ? paymentMethod
      : 'Cash') as 'Cash' | 'UPI' | 'Card' | 'Bank Transfer' | 'Other';
    if (method === 'UPI' && (!upiReference || String(upiReference).trim().length < 4)) {
      return fail(res, 'UPI Transaction Reference ID is required for UPI settlements.', 422);
    }

    const now = new Date().toISOString();
    const receiptNo = await p3.docSequence.allocateNext('RECEIPT', p3.globalConfig.prefixes.RECEIPT);
    const becomesFull = round2(alreadyPaid + amt) >= application.serviceSnapshot.customerChargeSnapshot;
    const invoiceNo = becomesFull
      ? await p3.docSequence.allocateNext('INVOICE', p3.globalConfig.prefixes.INVOICE)
      : undefined;

    const customer = erp.customers.find((c) => c.customerId === application.customerId);
    const paymentNumId = erp.nextNumericId('payment');
    const payment = {
      id: paymentNumId,
      transactionId: `TXN-${Date.now().toString().slice(-6)}-${String(paymentNumId).padStart(4, '0')}`,
      receiptNo,
      invoiceNo,
      applicationNo: application.applicationNo,
      customerId: application.customerId,
      customerName: application.customerSnapshot.fullName,
      serviceId: application.serviceId,
      serviceName: application.serviceSnapshot.name,
      counterCode: sanitizeText(String(counterCode || application.assignedCounterCode || 'CTR-01')),
      collectedBy: actor.userId,
      paymentType: (['Advance', 'Partial', 'Full'].includes(String(paymentType))
        ? paymentType
        : becomesFull
          ? 'Full'
          : 'Partial') as 'Advance' | 'Partial' | 'Full',
      paymentMethod: method,
      upiReference: upiReference ? sanitizeText(String(upiReference)) : undefined,
      amount: amt,
      verificationStatus: (method === 'UPI' ? 'Pending Verification' : 'Confirmed') as
        | 'Pending Verification'
        | 'Confirmed',
      verifiedBy: method === 'UPI' ? null : actor.userId,
      verifiedAt: method === 'UPI' ? null : now,
      recordedAt: now,
      notes: sanitizeText(String(notes ?? '')),
    };

    erp.payments.unshift(payment);

    if (financeStore && payment.verificationStatus === 'Confirmed') {
      try {
        financeStore.syncErpPaymentToGl(payment.transactionId, actor.userId);
      } catch (err) {
        erp.payments.shift();
        return fail(res, err instanceof Error ? err.message : 'GL Period Lock blocked payment posting.', 422);
      }
    }

    if (customer) {
      erp.dispatchNotification({
        customer,
        applicationNo: application.applicationNo,
        channel: 'DASHBOARD',
        eventKey: 'PAYMENT_RECEIVED',
        consentCategory: 'PAYMENT_REMINDER_CONSENT',
        messagePreview: `Receipt ${receiptNo} issued for ₹${amt} (${method}) against ${application.applicationNo}.`,
        actorUserId: actor.userId,
      });
      if (
        payment.verificationStatus === 'Confirmed' &&
        (customer.consents.find((c) => c.category === 'SMS_CONSENT')?.granted ||
          customer.consents.find((c) => c.category === 'PAYMENT_REMINDER_CONSENT')?.granted) &&
        customer.mobile
      ) {
        void sendFast2SmsTemplateMessage({
          mobile: customer.mobile,
          purpose: 'PAYMENT_RECEIVED',
          variables: [String(amt), receiptNo, application.applicationNo],
          fallbackText: `MUN COMPUTER: Payment of Rs.${amt} received (${receiptNo}) for ${application.applicationNo}.`,
          runtimeConfig: erp.phase03Store.getSmsGatewayConfig(),
        }).catch(() => {});
      }
    }

    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'RECORD_PAYMENT',
      applicationNo: application.applicationNo,
      newValue: `${receiptNo} · ₹${amt} (${method})`,
      ipAddress: getIp(req),
    });

    return ok(res, payment, `Payment recorded (${receiptNo}).`, 201);
  });

  app.post('/api/erp/payments/:transactionId/verify', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (
      actor.role !== 'ADMIN' &&
      actor.role !== 'MANAGER' &&
      !securityStore.hasPermission(actor, 'transactions', 'FINANCIAL')
    ) {
      return fail(res, 'Forbidden: UPI settlement verification requires Manager/Admin.', 403);
    }

    const payment = erp.payments.find((p) => p.transactionId === req.params.transactionId);
    if (!payment) return fail(res, 'Transaction not found.', 404);
    const { decision } = req.body ?? {};
    if (!['Confirmed', 'Rejected'].includes(String(decision))) {
      return fail(res, 'Decision must be Confirmed or Rejected.', 422);
    }

    payment.verificationStatus = decision;
    payment.verifiedBy = actor.userId;
    payment.verifiedAt = new Date().toISOString();
    if (financeStore && decision === 'Confirmed') {
      financeStore.syncErpPaymentToGl(payment.transactionId, actor.userId);
    }
    return ok(res, payment, `Transaction ${payment.transactionId} marked ${decision}.`);
  });

  // Cancellation Refunds (MCRF-YYYY-YY-NNNNNN) with Double-Refund & Amount Guard
  app.post('/api/erp/refunds', requireAuth, async (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    const canRefund =
      actor.role === 'ADMIN' ||
      actor.role === 'MANAGER' ||
      securityStore.hasPermission(actor, 'transactions', 'FINANCIAL');
    if (!canRefund) {
      return fail(res, 'Forbidden: refund initiation requires Manager, Admin, or FINANCIAL permission.', 403);
    }

    const { applicationNo, originalTransactionId, refundType, refundAmount, refundMethod, refundReason } =
      req.body ?? {};
    const application = erp.applications.find((a) => a.applicationNo === applicationNo);
    const payment = erp.payments.find(
      (p) => p.transactionId === originalTransactionId && p.applicationNo === applicationNo
    );
    if (!application || !payment) {
      return fail(res, 'Valid application and original payment transaction are required.', 404);
    }
    if (payment.verificationStatus !== 'Confirmed') {
      return fail(
        res,
        `Cannot initiate refund on ${payment.transactionId}: payment status is ${payment.verificationStatus} (only Confirmed payments can be refunded).`,
        422
      );
    }
    if (!refundReason || String(refundReason).trim().length < 3) {
      return fail(res, 'Refund reason is mandatory.', 422);
    }

    const amt = round2(Number(refundAmount));
    if (!Number.isFinite(amt) || amt < 0) {
      return fail(res, 'Refund amount cannot be negative.', 422);
    }

    const priorRefunded = round2(
      erp.refunds
        .filter(
          (r) =>
            r.originalTransactionId === payment.transactionId &&
            (r.status === 'Approved' || r.status === 'Processed' || r.status === 'Pending')
        )
        .reduce((s, r) => s + r.refundAmount, 0)
    );

    const remainingRefundable = round2(Math.max(0, payment.amount - priorRefunded));
    if (amt > remainingRefundable) {
      return fail(
        res,
        `Refund amount ₹${amt} exceeds refundable balance ₹${remainingRefundable} on ${payment.transactionId}.`,
        422
      );
    }

    const refundId = await p3.docSequence.allocateNext('REFUND', 'MCRF');
    const now = new Date().toISOString();
    const isAdminDirect = actor.role === 'ADMIN';

    const refundRecord = {
      id: erp.nextNumericId('refund'),
      refundId,
      applicationNo: application.applicationNo,
      customerId: application.customerId,
      originalTransactionId: payment.transactionId,
      refundType: (['Full', 'Partial', 'No Refund'].includes(String(refundType))
        ? refundType
        : amt >= payment.amount
          ? 'Full'
          : 'Partial') as 'Full' | 'Partial' | 'No Refund',
      refundAmount: amt,
      refundMethod: (['Cash', 'UPI', 'Bank Transfer'].includes(String(refundMethod))
        ? refundMethod
        : 'Cash') as 'Cash' | 'UPI' | 'Bank Transfer',
      refundReason: sanitizeText(String(refundReason)),
      status: (isAdminDirect ? 'Processed' : 'Pending') as 'Pending' | 'Processed',
      requestedBy: actor.userId,
      approvedBy: isAdminDirect ? actor.userId : null,
      processedBy: isAdminDirect ? actor.userId : null,
      transactionRef: `RF-REF-${Date.now().toString().slice(-6)}`,
      remarks: isAdminDirect ? 'Processed directly by Admin' : 'Awaiting Admin/Manager approval',
      createdAt: now,
      processedAt: isAdminDirect ? now : null,
    };

    erp.refunds.unshift(refundRecord);
    if (financeStore && refundRecord.status === 'Processed') {
      try {
        financeStore.syncErpRefundToGl(refundRecord.refundId, actor.userId);
      } catch (err) {
        erp.refunds.shift();
        return fail(res, err instanceof Error ? err.message : 'GL Period Lock blocked refund posting.', 422);
      }
    }
    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: isAdminDirect ? 'PROCESS_REFUND' : 'REQUEST_REFUND',
      applicationNo: application.applicationNo,
      newValue: `${refundId} · ₹${amt}`,
      reason: refundRecord.refundReason,
      ipAddress: getIp(req),
    });

    return ok(
      res,
      refundRecord,
      isAdminDirect
        ? `Refund ${refundId} (₹${amt}) processed.`
        : `Refund ${refundId} submitted for Admin approval.`,
      201
    );
  });

  app.post('/api/erp/refunds/:refundId/process', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN') {
      return fail(res, 'Only ADMIN may finalize/process pending refunds.', 403);
    }
    const refund = erp.refunds.find((r) => r.refundId === req.params.refundId);
    if (!refund) return fail(res, 'Refund record not found.', 404);
    if (refund.status === 'Processed') return fail(res, 'Refund has already been processed (duplicate prevented).', 400);

    const decision = req.body?.decision === 'Rejected' ? 'Rejected' : 'Processed';
    const now = new Date().toISOString();
    const prevState = {
      status: refund.status,
      approvedBy: refund.approvedBy,
      processedBy: refund.processedBy,
      processedAt: refund.processedAt,
      remarks: refund.remarks,
    };

    refund.status = decision;
    refund.approvedBy = actor.userId;
    if (decision === 'Processed') refund.processedBy = actor.userId;
    refund.processedAt = now;
    if (req.body?.remarks) refund.remarks = sanitizeText(String(req.body.remarks));

    if (financeStore && decision === 'Processed') {
      try {
        financeStore.syncErpRefundToGl(refund.refundId, actor.userId);
      } catch (err) {
        refund.status = prevState.status;
        refund.approvedBy = prevState.approvedBy;
        refund.processedBy = prevState.processedBy;
        refund.processedAt = prevState.processedAt;
        refund.remarks = prevState.remarks;
        return fail(res, err instanceof Error ? err.message : 'GL Period Lock blocked refund posting.', 422);
      }
    }

    return ok(res, refund, `Refund ${refund.refundId} ${decision}.`);
  });

  app.post('/api/erp/expenses', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'expenses', 'ADD');
    if (!actor) return;

    const { category, description, counterCode, amount, expenseDate } = req.body ?? {};
    const amt = round2(Number(amount));
    if (!category || !description || !Number.isFinite(amt) || amt <= 0) {
      return fail(res, 'Category, description, and positive amount are required.', 422);
    }
    const now = new Date().toISOString();
    const expId = erp.nextNumericId('expense');
    const exp = {
      id: expId,
      voucherNo: `EXP-${now.slice(0, 10).replace(/-/g, '')}-${String(expId).padStart(3, '0')}`,
      category: sanitizeText(String(category)),
      description: sanitizeText(String(description)),
      counterCode: sanitizeText(String(counterCode || 'CTR-01')),
      amount: amt,
      expenseDate: sanitizeText(String(expenseDate || now.slice(0, 10))),
      recordedBy: actor.userId,
      status: (actor.role === 'ADMIN' ? 'Approved' : 'Pending') as 'Approved' | 'Pending',
      createdAt: now,
    };
    erp.expenses.unshift(exp);
    if (financeStore && exp.status === 'Approved') {
      try {
        financeStore.syncErpExpenseToGl(exp.voucherNo, actor.userId);
      } catch (err) {
        erp.expenses.shift();
        return fail(res, err instanceof Error ? err.message : 'GL Period Lock blocked expense posting.', 422);
      }
    }
    return ok(res, exp, `Expense voucher ${exp.voucherNo} logged.`, 201);
  });

  app.get('/api/erp/income', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    const canSeeFinance =
      actor.role === 'ADMIN' ||
      actor.role === 'MANAGER' ||
      securityStore.hasPermission(actor, 'transactions', 'VIEW') ||
      securityStore.hasPermission(actor, 'receipts', 'VIEW');
    if (!canSeeFinance) return fail(res, 'Forbidden.', 403);
    return ok(res, erp.incomeVouchers);
  });

  app.post('/api/erp/income', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'receipts', 'ADD');
    if (!actor) return;

    const { category, description, counterCode, paymentMethod, amount, incomeDate, customerId, applicationNo } =
      req.body ?? {};
    const amt = round2(Number(amount));
    if (!category || !description || !Number.isFinite(amt) || amt <= 0) {
      return fail(res, 'Category, description, and positive amount are required.', 422);
    }
    const now = new Date().toISOString();
    const incId = erp.nextNumericId('income');
    const incomeNo = `INC-${now.slice(0, 10).replace(/-/g, '')}-${String(incId).padStart(3, '0')}`;
    const validMethods = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other'];
    const method = validMethods.includes(String(paymentMethod)) ? String(paymentMethod) : 'Cash';
    const record = {
      id: incId,
      incomeNo,
      category: sanitizeText(String(category)),
      description: sanitizeText(String(description)),
      ...(customerId ? { customerId: sanitizeText(String(customerId)) } : {}),
      ...(applicationNo ? { applicationNo: sanitizeText(String(applicationNo)) } : {}),
      counterCode: sanitizeText(String(counterCode || 'CTR-01')),
      paymentMethod: method,
      amount: amt,
      incomeDate: sanitizeText(String(incomeDate || now.slice(0, 10))).slice(0, 10),
      recordedBy: actor.userId,
      status: 'Approved' as const,
      createdAt: now,
      updatedAt: now,
    };
    erp.incomeVouchers.unshift(record);
    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'RECORD_DIRECT_INCOME',
      newValue: `${incomeNo} · ₹${amt} (${method})`,
      ipAddress: getIp(req),
    });
    return ok(res, record, `Direct income voucher ${incomeNo} saved.`, 201);
  });

  // Customer Feedback & Testimonials
  app.get('/api/erp/feedback', requireAuth, (_req: AuthedRequest, res) => {
    return ok(res, erp.feedbacks);
  });

  app.post('/api/erp/feedback', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    const b = req.body ?? {};
    const customerName = sanitizeText(String(b.customerName || ''));
    const mobileRes = validateCustomerMobileValue(b.mobile);
    const comments = sanitizeText(String(b.comments || ''));
    if (customerName.length < 2 || !mobileRes.valid || comments.length < 2) {
      return fail(res, 'Customer name, valid 10-digit mobile, and feedback comments are required.', 422);
    }
    const waDigits = String(b.whatsapp || '').replace(/\D/g, '').slice(-10);
    const ratingNum = Math.min(10, Math.max(1, Math.round(Number(b.rating ?? 10) || 10)));
    const fbId = erp.nextNumericId('feedback');
    const now = new Date().toISOString();
    const feedbackNo = `FB-${now.slice(0, 4)}-${String(fbId).padStart(5, '0')}`;
    const record = {
      id: feedbackNo,
      feedbackNo,
      customerName,
      mobile: mobileRes.normalized,
      whatsapp: waDigits.length === 10 ? waDigits : mobileRes.normalized,
      serviceName: sanitizeText(String(b.serviceName || 'General Service')),
      invoiceNo: b.invoiceNo ? sanitizeText(String(b.invoiceNo)) : undefined,
      rating: ratingNum,
      comments,
      testimonialConsent: b.testimonialConsent !== false,
      reviewed: false,
      internalRemarks: b.internalRemarks ? sanitizeText(String(b.internalRemarks)) : undefined,
      submittedBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    };
    erp.feedbacks.unshift(record);
    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'SUBMIT_CUSTOMER_FEEDBACK',
      newValue: `${feedbackNo} · ${ratingNum}/10 (${customerName})`,
      ipAddress: getIp(req),
    });
    return ok(res, record, `Feedback ${feedbackNo} saved.`, 201);
  });

  app.patch('/api/erp/feedback/:id/reviewed', requireAuth, (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role !== 'ADMIN' && actor.role !== 'MANAGER') {
      return fail(res, 'Forbidden: Only Admin or Manager can update feedback review status.', 403);
    }
    const target = erp.feedbacks.find(
      (f) => f.id === req.params.id || f.feedbackNo === req.params.id
    );
    if (!target) return fail(res, 'Feedback record not found.', 404);
    const nextReviewed =
      typeof req.body?.reviewed === 'boolean' ? req.body.reviewed : !target.reviewed;
    target.reviewed = nextReviewed;
    target.reviewedBy = actor.userId;
    target.updatedAt = new Date().toISOString();
    return ok(res, target, `Feedback ${target.feedbackNo} marked ${nextReviewed ? 'Reviewed' : 'Pending Review'}.`);
  });

  // ==========================================================================
  // 6. NOTIFICATIONS, ACTIVITY AUDIT, 18+ MIS REPORTS & EXPORT AUDIT LOG
  // ==========================================================================
  app.get('/api/erp/notifications', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'notifications', 'VIEW');
    if (!actor) return;
    return ok(res, erp.notifications);
  });

  app.post('/api/erp/notifications/send', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'notifications', 'VIEW');
    if (!actor) return;

    const { customerId, applicationNo, channel, eventKey, consentCategory, messagePreview } = req.body ?? {};
    const customer = erp.customers.find((c) => c.customerId === customerId);
    if (!customer) return fail(res, 'Customer not found.', 404);
    if (!messagePreview) return fail(res, 'Message preview is required.', 422);

    const dispatch = erp.dispatchNotification({
      customer,
      applicationNo,
      channel: ['DASHBOARD', 'SMS', 'EMAIL_SMTP', 'WHATSAPP'].includes(String(channel))
        ? channel
        : 'DASHBOARD',
      eventKey: sanitizeText(String(eventKey || 'MANUAL_ALERT')),
      consentCategory: (consentCategory || 'SERVICE_NOTIFICATION_CONSENT') as ConsentCategoryKey,
      messagePreview: String(messagePreview),
      actorUserId: actor.userId,
    });

    return ok(res, dispatch, `Notification logged with status: ${dispatch.status}`, 201);
  });

  app.get('/api/erp/reports/summary', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'reports', 'VIEW');
    if (!actor) return;

    const apps = erp.applications.filter((a) => !a.archivedAt);
    const enriched = apps.map((a) => enrichApplication(a, false));

    const staffMap = new Map<string, { staffId: string; total: number; completed: number; pending: number; overdue: number }>();
    const svcMap = new Map<string, { serviceId: string; serviceName: string; count: number; revenue: number; profit: number }>();
    const statusMap: Record<string, number> = {};

    for (const item of enriched) {
      statusMap[item.status] = (statusMap[item.status] || 0) + 1;

      const sKey = item.assignedStaffId || 'Unassigned';
      const sEntry = staffMap.get(sKey) ?? { staffId: sKey, total: 0, completed: 0, pending: 0, overdue: 0 };
      sEntry.total += 1;
      if (item.status === 'Completed') sEntry.completed += 1;
      else if (!['Cancelled', 'Rejected'].includes(item.status)) sEntry.pending += 1;
      if (item.slaStatus.label === 'Overdue') sEntry.overdue += 1;
      staffMap.set(sKey, sEntry);

      const vEntry = svcMap.get(item.serviceId) ?? {
        serviceId: item.serviceId,
        serviceName: item.serviceSnapshot.name,
        count: 0,
        revenue: 0,
        profit: 0,
      };
      vEntry.count += 1;
      if (item.status !== 'Cancelled') {
        vEntry.revenue += item.financialSummary.netCollected;
        vEntry.profit += item.serviceSnapshot.profitSnapshot;
      }
      svcMap.set(item.serviceId, vEntry);
    }

    return ok(res, {
      totalApplications: enriched.length,
      statusSummary: statusMap,
      staffWorkload: Array.from(staffMap.values()),
      serviceSummary: Array.from(svcMap.values()),
      pendingDocumentsApps: enriched.filter(
        (a) => a.checklistSummary.missingCount > 0 || a.checklistSummary.pendingVerification > 0
      ),
      overdueSlaApps: enriched.filter((a) => a.slaStatus.label === 'Overdue'),
      followUps: erp.followUps,
      deliveries: erp.deliveries,
      cancellations: erp.cancellationRequests,
      refunds: erp.refunds,
      exportLogs: erp.exportLogs.slice(0, 40),
      activities: erp.activities.slice(0, 60),
    });
  });

  app.post('/api/erp/reports/export-log', requireAuth, (req: AuthedRequest, res) => {
    const actor = checkPerm(req, res, 'reports', 'EXPORT');
    if (!actor) return;

    const { reportName, format, rowCount } = req.body ?? {};
    const entry = {
      id: erp.nextNumericId('exportLog'),
      reportName: sanitizeText(String(reportName || 'MIS Report')),
      format: (['PDF', 'Excel', 'CSV'].includes(String(format)) ? format : 'CSV') as 'PDF' | 'Excel' | 'CSV',
      rowCount: Number(rowCount || 0),
      exportedBy: actor.userId,
      exportedRole: actor.role,
      exportedAt: new Date().toISOString(),
    };
    erp.exportLogs.unshift(entry);
    erp.addActivity({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'EXPORT_MIS_REPORT',
      newValue: `${entry.reportName} (${entry.format}, ${entry.rowCount} rows)`,
      ipAddress: getIp(req),
    });
    return ok(res, entry, 'Export audit entry recorded.', 201);
  });

  // ==========================================================================
  // Authenticated Server-Side Storage Upload & Retrieval (Firebase Admin or Local Persistent Fallback)
  // ==========================================================================
  app.post('/api/erp/storage/upload', requireAuth, async (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    const b = req.body ?? {};
    const rawBase64 = typeof b.base64 === 'string' ? b.base64.trim() : '';
    const dataUrlMatch = /^data:([^;]+);base64,(.*)$/s.exec(rawBase64);
    const cleanBase64 = dataUrlMatch ? dataUrlMatch[2] : rawBase64;
    if (!cleanBase64) {
      return fail(res, 'File payload (base64) is required.', 422);
    }

    const mimeType = String(b.contentType || dataUrlMatch?.[1] || 'application/octet-stream')
      .trim()
      .toLowerCase();
    const imageOnly = Boolean(b.imageOnly);
    const allowedUploadMimes = imageOnly
      ? new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp'])
      : new Set([
          'application/pdf',
          'image/jpeg',
          'image/jpg',
          'image/png',
          'image/webp',
          'text/csv',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ]);
    if (!allowedUploadMimes.has(mimeType)) {
      return fail(res, `Unsupported file MIME type: ${mimeType}`, 422);
    }

    const buffer = Buffer.from(cleanBase64, 'base64');
    const maxBytes = imageOnly ? 5 * 1024 * 1024 : 10 * 1024 * 1024;
    if (buffer.length <= 0 || buffer.length > maxBytes) {
      return fail(res, `File size (${Math.round(buffer.length / 1024)} KB) exceeds allowed limit.`, 422);
    }

    const cleanSegment = (seg: string) =>
      String(seg || '')
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^\.+/, '')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);

    const safeFolder = String(b.folder || 'documents')
      .split('/')
      .filter(Boolean)
      .map(cleanSegment)
      .filter((s) => Boolean(s) && s !== '.' && s !== '..')
      .join('/') || 'documents';
    const safeName = cleanSegment(String(b.fileName || 'document')) || 'document';
    const rawRequestedPath = typeof b.storagePath === 'string' ? b.storagePath.trim() : '';
    const sanitizedRequested = rawRequestedPath
      ? rawRequestedPath
          .split('/')
          .filter(Boolean)
          .map(cleanSegment)
          .filter((s: string) => Boolean(s) && s !== '.' && s !== '..')
          .join('/')
      : '';
    const storagePath = sanitizedRequested || `${safeFolder}/${Date.now()}_${safeName}`;

    const token = crypto.randomUUID();
    const customMetaInput =
      b.customMetadata && typeof b.customMetadata === 'object' ? b.customMetadata : {};
    const safeCustomMeta: Record<string, string> = {};
    for (const [k, v] of Object.entries(customMetaInput).slice(0, 10)) {
      if (typeof v === 'string' && v.trim()) {
        safeCustomMeta[cleanSegment(k)] = v.trim().slice(0, 200);
      }
    }

    const bucket = getFirebaseAdminBucket();
    if (bucket) {
      try {
        const file = bucket.file(storagePath);
        await file.save(buffer, {
          contentType: mimeType,
          resumable: false,
          metadata: {
            contentType: mimeType,
            metadata: {
              firebaseStorageDownloadTokens: token,
              uploadedByUserId: actor.userId,
              originalName: safeName,
              ...safeCustomMeta,
            },
          },
        });
        const encodedPath = encodeURIComponent(storagePath);
        const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${token}`;
        return ok(
          res,
          {
            storagePath,
            downloadUrl,
            fileSizeBytes: buffer.length,
            mimeType,
          },
          'File uploaded to private Firebase Storage via Admin SDK.',
          201
        );
      } catch (err) {
        console.warn(
          '[Storage Admin Upload Fallback]',
          err instanceof Error ? err.message : err
        );
      }
    }

    // Persistent Local Disk Storage Fallback (used when Firebase Admin Storage credentials are not provisioned)
    try {
      const baseDir = resolveLocalUploadsDir();
      const targetPath = path.resolve(baseDir, storagePath);
      if (!targetPath.startsWith(baseDir + path.sep)) {
        return fail(res, 'Invalid storage path.', 400);
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, buffer);
      fs.writeFileSync(
        `${targetPath}.meta.json`,
        JSON.stringify({
          contentType: mimeType,
          originalName: safeName,
          fileSizeBytes: buffer.length,
          uploadedByUserId: actor.userId,
          uploadedAt: new Date().toISOString(),
          customMetadata: safeCustomMeta,
        }),
        'utf8'
      );
      const sig = signStoragePath(storagePath);
      const urlPath = storagePath
        .split('/')
        .map((seg: string) => encodeURIComponent(seg))
        .join('/');
      const downloadUrl = `/api/erp/storage/files/${urlPath}?sig=${sig}`;
      return ok(
        res,
        {
          storagePath,
          downloadUrl,
          fileSizeBytes: buffer.length,
          mimeType,
        },
        'File uploaded to persistent server storage.',
        201
      );
    } catch (err) {
      return fail(
        res,
        err instanceof Error ? err.message : 'Unable to persist uploaded file.',
        500
      );
    }
  });

  app.use('/api/erp/storage/files', (req: AuthedRequest, res, next) => {
    if (req.method !== 'GET') return next();
    const rawSubPath = req.path.replace(/^\/+/, '');
    if (!rawSubPath) {
      return fail(res, 'File path is required.', 400);
    }
    let decodedSegments: string[];
    try {
      decodedSegments = rawSubPath
        .split('/')
        .filter(Boolean)
        .map((seg) => decodeURIComponent(seg));
    } catch {
      return fail(res, 'Invalid file path encoding.', 400);
    }
    if (
      decodedSegments.length === 0 ||
      decodedSegments.some((s) => !s || s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0'))
    ) {
      return fail(res, 'Forbidden file path.', 403);
    }
    const relPath = decodedSegments.join('/');
    if (relPath.endsWith('.meta.json')) {
      return fail(res, 'Forbidden file path.', 403);
    }
    const sig = typeof req.query.sig === 'string' ? req.query.sig : '';

    const serveFile = () => {
      const baseDir = resolveLocalUploadsDir();
      const targetPath = path.resolve(baseDir, relPath);
      if (!targetPath.startsWith(baseDir + path.sep) || !fs.existsSync(targetPath)) {
        return fail(res, 'Uploaded file not found.', 404);
      }
      const stat = fs.statSync(targetPath);
      if (!stat.isFile()) {
        return fail(res, 'Uploaded file not found.', 404);
      }
      let contentType = 'application/octet-stream';
      const metaPath = `${targetPath}.meta.json`;
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { contentType?: string };
          if (meta.contentType) contentType = meta.contentType;
        } catch {
          // Ignore malformed sidecar metadata
        }
      } else {
        const ext = path.extname(targetPath).toLowerCase();
        if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
        else if (ext === '.png') contentType = 'image/png';
        else if (ext === '.webp') contentType = 'image/webp';
        else if (ext === '.pdf') contentType = 'application/pdf';
        else if (ext === '.csv') contentType = 'text/csv';
      }
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.sendFile(targetPath);
    };

    if (verifyStoragePathSignature(relPath, sig)) {
      return serveFile();
    }
    return requireAuth(req, res, serveFile);
  });
}
