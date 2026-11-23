import crypto from 'node:crypto';
import {
  ApiIntegrationItem,
  BackupRecord,
  BranchItem,
  CompanyProfileSettings,
  CounterItem,
  CustomerPrivacyConfig,
  DailyCashClosingRecord,
  DashboardPreferenceConfig,
  DocumentTemplateItem,
  DocumentType,
  GlobalConfiguration,
  HistoricalTransactionSnapshot,
  LanguageCode,
  MaintenanceSettingsConfig,
  NotificationTemplateItem,
  PaymentQrSettings,
  PrintSettingsConfig,
  ReportSettingsConfig,
  SecurityPolicyConfig,
  ServiceRateItem,
  SettingsHistoryEntry,
  SettingsProposalItem,
  ThemeMode,
  UploadedDocumentItem,
} from './phase03Types.js';
import { decryptSensitiveField, encryptSensitiveField, sha256 } from './crypto.js';
import { cleanFast2SmsApiKey } from './fast2smsService.js';
import {
  FAST2SMS_TEMPLATE_PURPOSES,
  Fast2SmsTemplatePurpose,
  getDefaultFast2SmsGatewayConfig,
} from './smsDefaults.js';

export class DocumentSequenceGenerator {
  private counters = new Map<string, number>();
  private issued = new Set<string>();
  private lock: Promise<void> = Promise.resolve();

  public getCurrentFinancialYear(date = new Date()): string {
    // Convert to Asia/Kolkata (UTC+5:30)
    const istOffsetMs = 330 * 60_000;
    const ist = new Date(date.getTime() + istOffsetMs);
    const year = ist.getUTCFullYear();
    const month = ist.getUTCMonth() + 1;
    const startYear = month >= 4 ? year : year - 1;
    const endShort = String(startYear + 1).slice(-2);
    return `${startYear}-${endShort}`;
  }

  public seed(docType: DocumentType, prefix: string, fy: string, serial: number): void {
    const key = `${docType}:${fy}`;
    const prev = this.counters.get(key) ?? 0;
    if (serial > prev) this.counters.set(key, serial);
    if (serial > 0) {
      this.issued.add(`${prefix}-${fy}-${String(serial).padStart(6, '0')}`);
    }
  }

  public async allocateNext(
    docType: DocumentType,
    prefix: string,
    date = new Date()
  ): Promise<string> {
    let release!: () => void;
    const wait = this.lock;
    this.lock = new Promise((r) => {
      release = r;
    });
    await wait;

    try {
      const fy = this.getCurrentFinancialYear(date);
      const key = `${docType}:${fy}`;
      let next = (this.counters.get(key) ?? 0) + 1;
      let code = `${prefix}-${fy}-${String(next).padStart(6, '0')}`;
      while (this.issued.has(code)) {
        next += 1;
        code = `${prefix}-${fy}-${String(next).padStart(6, '0')}`;
      }
      this.counters.set(key, next);
      this.issued.add(code);
      return code;
    } finally {
      release();
    }
  }

  public getCountersSnapshot(prefixes: GlobalConfiguration['prefixes']) {
    const fy = this.getCurrentFinancialYear();
    return (['RECEIPT', 'INVOICE', 'APPLICATION'] as const).map((docType) => {
      const serial = this.counters.get(`${docType}:${fy}`) ?? 0;
      const prefix = prefixes[docType];
      return {
        docType,
        prefix,
        financialYear: fy,
        lastSerial: serial,
        nextPreview: `${prefix}-${fy}-${String(serial + 1).padStart(6, '0')}`,
      };
    });
  }

  public exportState(): { counters: Record<string, number>; issued: string[] } {
    return {
      counters: Object.fromEntries(this.counters.entries()),
      issued: Array.from(this.issued.values()),
    };
  }

  public hydrateState(state?: { counters?: Record<string, number>; issued?: string[] }): void {
    if (!state) return;
    if (state.counters && typeof state.counters === 'object') {
      for (const [k, v] of Object.entries(state.counters)) {
        const prev = this.counters.get(k) ?? 0;
        if (typeof v === 'number' && v > prev) {
          this.counters.set(k, v);
        }
      }
    }
    if (Array.isArray(state.issued)) {
      for (const code of state.issued) {
        if (typeof code === 'string' && code) this.issued.add(code);
      }
    }
  }
}

export class Phase03Store {
  public readonly docSequence = new DocumentSequenceGenerator();

  public companyProfile: CompanyProfileSettings = {
    companyName: 'MUN COMPUTER',
    addressLine: 'Village Mamudpur (Chowmatha More)',
    postOffice: 'Juginda',
    policeStation: 'Domkal',
    district: 'Murshidabad',
    stateName: 'West Bengal',
    countryName: 'India',
    pinCode: '742406',
    mobile: '+91 8101352105',
    whatsapp: '+91 8101352105',
    email: 'MUNCOMPUTER2019@GMAIL.COM',
    website: '',
    gstNumber: '',
    panNumber: '',
    upiId: '',
    bankDetails: '',
    logoUrl: '/assets/aistudio/MUN_Computer_Orbit_Logo_11zon_1fce5a24.jpg',
    signatureUrl: '',
    stampUrl: '',
    updatedAt: '2026-11-16T10:00:00.000Z',
  };

  public serviceRates: ServiceRateItem[] = [
    {
      id: 1,
      serviceCode: 'MC2627SRV-001',
      serviceName: 'Lakshmir Bhandar Application',
      category: 'Government Scheme Services',
      customerCharge: 500,
      serviceCost: 150,
      profitAmount: 350,
      currentVersion: 1,
      effectiveDate: '2026-04-01',
      status: 'active',
      versions: [
        {
          versionNo: 1,
          customerCharge: 500,
          serviceCost: 150,
          profitAmount: 350,
          effectiveDate: '2026-04-01',
          changeReason: 'FY 2026-27 Base Schedule',
          approvalStatus: 'Approved',
          proposedBy: 'MC2627110001',
          approvedBy: 'MC2627110001',
          createdAt: '2026-04-01T09:00:00.000Z',
        },
      ],
    },
    {
      id: 2,
      serviceCode: 'MC2627SRV-002',
      serviceName: 'Swasthya Sathi Card Application',
      category: 'Government Scheme Services',
      customerCharge: 1200,
      serviceCost: 400,
      profitAmount: 800,
      currentVersion: 1,
      effectiveDate: '2026-04-01',
      status: 'active',
      versions: [
        {
          versionNo: 1,
          customerCharge: 1200,
          serviceCost: 400,
          profitAmount: 800,
          effectiveDate: '2026-04-01',
          changeReason: 'FY 2026-27 Base Schedule',
          approvalStatus: 'Approved',
          proposedBy: 'MC2627110001',
          approvedBy: 'MC2627110001',
          createdAt: '2026-04-01T09:00:00.000Z',
        },
      ],
    },
    {
      id: 3,
      serviceCode: 'MC2627SRV-003',
      serviceName: 'Krishak Bandhu Registration',
      category: 'Government Scheme Services',
      customerCharge: 3200,
      serviceCost: 2400,
      profitAmount: 800,
      currentVersion: 1,
      effectiveDate: '2026-04-01',
      status: 'active',
      versions: [
        {
          versionNo: 1,
          customerCharge: 3200,
          serviceCost: 2400,
          profitAmount: 800,
          effectiveDate: '2026-04-01',
          changeReason: 'FY 2026-27 Base Schedule',
          approvalStatus: 'Approved',
          proposedBy: 'MC2627110001',
          approvedBy: 'MC2627110001',
          createdAt: '2026-04-01T09:00:00.000Z',
        },
      ],
    },
  ];

  // Completed transaction snapshots remain IMMUTABLE even when service rates change
  public completedRateSnapshots: HistoricalTransactionSnapshot[] = [];

  public globalConfig: GlobalConfiguration = {
    financialYearLabel: 'April to March',
    financialYearStartMonth: 4,
    financialYearEndMonth: 3,
    timezone: 'Asia/Kolkata',
    defaultLanguage: 'en',
    dateFormat: 'DD/MM/YYYY',
    currencyCode: 'INR',
    currencySymbol: '₹',
    prefixes: {
      RECEIPT: 'MCR',
      INVOICE: 'MCI',
      APPLICATION: 'MCA',
    },
  };

  public notificationTemplates: NotificationTemplateItem[] = [
    {
      eventKey: 'PAYMENT_RECEIVED',
      eventLabel: 'Payment Received',
      smsEnabled: false,
      emailEnabled: false,
      whatsappEnabled: false,
      dashboardEnabled: true,
      subject: 'MUN COMPUTER — Payment Receipt {{receipt_no}}',
      body: 'Dear {{customer_name}}, we received ₹{{amount}} for {{service_name}} ({{receipt_no}}). Thank you — MUN COMPUTER.',
    },
    {
      eventKey: 'PAYMENT_PENDING',
      eventLabel: 'Payment Pending',
      smsEnabled: false,
      emailEnabled: false,
      whatsappEnabled: false,
      dashboardEnabled: true,
      subject: 'MUN COMPUTER — Payment Reminder {{application_no}}',
      body: 'Dear {{customer_name}}, balance ₹{{balance_due}} is pending for {{application_no}}.',
    },
    {
      eventKey: 'APPLICATION_STATUS_UPDATE',
      eventLabel: 'Application Status Update',
      smsEnabled: false,
      emailEnabled: false,
      whatsappEnabled: false,
      dashboardEnabled: true,
      subject: 'Application {{application_no}} Status: {{status}}',
      body: 'Hello {{customer_name}}, your application {{application_no}} status is now {{status}}.',
    },
    {
      eventKey: 'SERVICE_COMPLETED',
      eventLabel: 'Service Completed',
      smsEnabled: false,
      emailEnabled: false,
      whatsappEnabled: false,
      dashboardEnabled: true,
      subject: 'Service Completed — {{application_no}}',
      body: 'Dear {{customer_name}}, your service {{service_name}} is completed and ready for delivery at MUN COMPUTER.',
    },
    {
      eventKey: 'SECURE_LOGIN_OTP',
      eventLabel: 'Secure Login OTP',
      smsEnabled: false,
      emailEnabled: false,
      whatsappEnabled: false,
      dashboardEnabled: true,
      subject: 'MUN COMPUTER Login Verification OTP',
      body: 'Your one-time verification code is {{otp}}. Valid for 5 minutes. Never share this code.',
    },
    {
      eventKey: 'PASSWORD_RESET_OTP',
      eventLabel: 'Password Reset OTP',
      smsEnabled: false,
      emailEnabled: false,
      whatsappEnabled: false,
      dashboardEnabled: true,
      subject: 'MUN COMPUTER Password Reset OTP',
      body: 'Use code {{otp}} to reset your MUN COMPUTER password. Valid for 5 minutes.',
    },
    {
      eventKey: 'SERVICE_THANK_YOU',
      eventLabel: 'Service Thank You',
      smsEnabled: false,
      emailEnabled: false,
      whatsappEnabled: false,
      dashboardEnabled: true,
      subject: 'Thank You for Visiting MUN COMPUTER',
      body: 'Thank you {{customer_name}} for choosing MUN COMPUTER, Mamudpur, Domkal. Call +91 8101352105 for assistance.',
    },
  ];

  public printSettings: PrintSettingsConfig = {
    paperSize: 'A4',
    printMode: 'Print Preview then Print',
    includeLogo: true,
    includeDigitalSignature: true,
    includeCompanyStamp: true,
    defaultCopies: 1,
  };

  public documentTemplates: DocumentTemplateItem[] = [
    {
      id: 1,
      docType: 'RECEIPT',
      designVariant: 'Simple Professional',
      termsAndConditions:
        '1. All receipts are valid subject to realization of payment. 2. Original receipt required for hardware pickup.',
      disclaimer:
        'MUN COMPUTER is not responsible for customer-supplied external storage media beyond 30 days.',
      showQr: true,
      versionNo: 1,
      updatedAt: '2026-04-01T09:00:00.000Z',
      snapshots: [
        {
          versionNo: 1,
          designVariant: 'Simple Professional',
          termsAndConditions:
            '1. All receipts are valid subject to realization of payment. 2. Original receipt required for hardware pickup.',
          disclaimer:
            'MUN COMPUTER is not responsible for customer-supplied external storage media beyond 30 days.',
          savedAt: '2026-04-01T09:00:00.000Z',
        },
      ],
    },
    {
      id: 2,
      docType: 'INVOICE',
      designVariant: 'Detailed Professional',
      termsAndConditions:
        '1. Payment due upon delivery unless corporate credit is approved. 2. Subject to Murshidabad jurisdiction.',
      disclaimer:
        'Computer-generated invoice verified by MUN COMPUTER authorized counter.',
      showQr: true,
      versionNo: 1,
      updatedAt: '2026-04-01T09:00:00.000Z',
      snapshots: [
        {
          versionNo: 1,
          designVariant: 'Detailed Professional',
          termsAndConditions:
            '1. Payment due upon delivery unless corporate credit is approved. 2. Subject to Murshidabad jurisdiction.',
          disclaimer:
            'Computer-generated invoice verified by MUN COMPUTER authorized counter.',
          savedAt: '2026-04-01T09:00:00.000Z',
        },
      ],
    },
  ];

  public paymentQrSettings: PaymentQrSettings = {
    cashEnabled: true,
    upiEnabled: true,
    otherEnabled: true,
    qrType: 'Static QR',
    qrOnReceipt: true,
    qrOnInvoice: true,
    manualVerificationRequired: true,
    upiId: '',
    staticQrPreviewUrl: '',
    dynamicQrProviderConfigured: false,
  };

  public securityPolicy: SecurityPolicyConfig = {
    masterSettingsAccess: 'ADMIN_ONLY',
    userCreationAuthority: 'ADMIN_ONLY',
    approvalAuthority: 'ADMIN_ONLY',
    sessionDurationMinutes: 60,
    inactivityAutoLogoutMinutes: 60,
    passwordPolicy: 'Strong',
    failedLoginAttemptsLimit: 5,
    accountLockoutMinutes: 3,
    twoFactorRequiredRoles: ['ADMIN', 'MANAGER', 'STAFF'],
  };

  public settingsProposals: SettingsProposalItem[] = [];

  public settingsHistory: SettingsHistoryEntry[] = [
    {
      id: 1,
      settingModule: 'Global Configuration',
      settingName: 'Financial Year & Timezone',
      oldValue: 'Default',
      newValue: 'April–March · Asia/Kolkata · INR ₹',
      changeReason: 'Phase 03 Initial Regional Configuration',
      changedBy: 'MC2627110001',
      approvedBy: 'MC2627110001',
      createdAt: '2026-04-01T09:00:00.000Z',
    },
  ];

  public branches: BranchItem[] = [
    {
      id: 1,
      branchCode: 'BR-01',
      name: 'Single Branch – MUN COMPUTER',
      address:
        'Village Mamudpur (Chowmatha More), P.O. Juginda, P.S. Domkal, Murshidabad, WB - 742406',
      pinCode: '742406',
      isDefault: true,
      status: 'active',
    },
  ];

  public counters: CounterItem[] = [
    {
      id: 1,
      branchId: 1,
      counterCode: 'CTR-01',
      name: 'Counter 01 – Front Desk & Applications',
      assignedUserId: 'MC2627110002',
      status: 'active',
    },
    {
      id: 2,
      branchId: 1,
      counterCode: 'CTR-02',
      name: 'Counter 02 – Hardware & Service Desk',
      assignedUserId: 'MC2627110002',
      status: 'active',
    },
  ];

  public dailyCashClosings: DailyCashClosingRecord[] = [];

  public customerPrivacy: CustomerPrivacyConfig = {
    duplicateCheckMobile: true,
    duplicateCheckAadhaar: true,
    consentMandatory: true,
    maskAadhaarByDefault: true,
    dataExportAdminOnly: true,
    retentionPolicy: 'Long-term retention subject to applicable Indian law',
    declarationModes: ['Digital', 'Printed'],
    termsEditableByAdmin:
      'Customer information is collected solely for requested services at MUN COMPUTER with explicit consent.',
  };

  public uploadedDocuments: UploadedDocumentItem[] = [];

  // Secrets are stored encrypted in `integrationSecrets` and NEVER sent to the frontend!
  private integrationSecrets = new Map<string, string>();
  public apiIntegrations: ApiIntegrationItem[] = [
    {
      channel: 'SMS',
      providerName: 'Fast2SMS API Gateway',
      endpointOrHost: 'https://www.fast2sms.com/dev/bulkV2',
      senderOrFrom:
        process.env.FAST2SMS_SENDER_ID ||
        process.env.SMS_SENDER_ID ||
        process.env.VITE_FAST2SMS_SENDER_ID ||
        getDefaultFast2SmsGatewayConfig()?.senderId ||
        'MUNCMP',
      smsRoute: (['dlt', 'dlt_manual', 'otp', 'q'].includes(
        (
          process.env.FAST2SMS_ROUTE ||
          process.env.VITE_FAST2SMS_ROUTE ||
          getDefaultFast2SmsGatewayConfig()?.route ||
          ''
        )
          .trim()
          .toLowerCase()
      )
        ? (
            process.env.FAST2SMS_ROUTE ||
            process.env.VITE_FAST2SMS_ROUTE ||
            getDefaultFast2SmsGatewayConfig()?.route ||
            ''
          )
            .trim()
            .toLowerCase()
        : 'dlt') as 'dlt' | 'dlt_manual' | 'otp' | 'q',
      dltTemplateId: (
        process.env.FAST2SMS_TEMPLATE_ID ||
        process.env.VITE_FAST2SMS_TEMPLATE_ID ||
        getDefaultFast2SmsGatewayConfig()?.templateId ||
        ''
      ).trim(),
      dltTemplates: Object.fromEntries(
        FAST2SMS_TEMPLATE_PURPOSES.map(({ key }) => [
          key,
          (
            process.env[`FAST2SMS_TEMPLATE_ID_${key}`] ||
            process.env[`VITE_FAST2SMS_TEMPLATE_ID_${key}`] ||
            getDefaultFast2SmsGatewayConfig()?.templates?.[key] ||
            ''
          ).trim(),
        ]).filter(([, val]) => Boolean(val))
      ) as Partial<Record<Fast2SmsTemplatePurpose, string>>,
      isConfigured: Boolean(
        cleanFast2SmsApiKey(
          process.env.FAST2SMS_API_KEY ||
            process.env.SMS_API_KEY ||
            process.env.VITE_FAST2SMS_API_KEY ||
            getDefaultFast2SmsGatewayConfig()?.apiKey
        )
      ),
      hasSecret: Boolean(
        cleanFast2SmsApiKey(
          process.env.FAST2SMS_API_KEY ||
            process.env.SMS_API_KEY ||
            process.env.VITE_FAST2SMS_API_KEY ||
            getDefaultFast2SmsGatewayConfig()?.apiKey
        )
      ),
      lastTestedAt: null,
      lastTestStatus: cleanFast2SmsApiKey(
        process.env.FAST2SMS_API_KEY ||
          process.env.SMS_API_KEY ||
          process.env.VITE_FAST2SMS_API_KEY ||
          getDefaultFast2SmsGatewayConfig()?.apiKey
      )
        ? 'Connected'
        : 'Not Tested',
    },
    {
      channel: 'EMAIL_SMTP',
      providerName: 'SMTP (Gmail / Custom)',
      endpointOrHost: process.env.SMTP_HOST || '',
      senderOrFrom: 'MUNCOMPUTER2019@GMAIL.COM',
      isConfigured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER),
      hasSecret: Boolean(process.env.SMTP_PASS),
      lastTestedAt: null,
      lastTestStatus: 'Not Tested',
    },
    {
      channel: 'WHATSAPP',
      providerName: 'Official WhatsApp Business API',
      endpointOrHost: '',
      senderOrFrom: '+91 8101352105',
      isConfigured: false,
      hasSecret: false,
      lastTestedAt: null,
      lastTestStatus: 'Not Tested',
    },
  ];

  public dashboardPreferences: Record<'ADMIN' | 'MANAGER' | 'STAFF', DashboardPreferenceConfig> = {
    ADMIN: {
      role: 'ADMIN',
      defaultPeriod: 'Today',
      enabledWidgets: [
        'Total Customers',
        'Total Applications',
        'Today Collection',
        'Pending Payments',
        'Total Expenses',
        'Today Profit',
        'Recent Activities',
        'Pending Approvals',
        'Service-wise Reports',
        'Monthly Collection',
      ],
    },
    MANAGER: {
      role: 'MANAGER',
      defaultPeriod: 'Today',
      enabledWidgets: [
        'Total Customers',
        'Total Applications',
        'Today Collection',
        'Pending Payments',
        'Recent Activities',
        'Pending Approvals',
        'Service-wise Reports',
      ],
    },
    STAFF: {
      role: 'STAFF',
      defaultPeriod: 'Today',
      enabledWidgets: [
        'Total Customers',
        'Total Applications',
        'Today Collection',
        'Pending Payments',
        'Recent Activities',
      ],
    },
  };

  public reportSettings: ReportSettingsConfig = {
    defaultExportFormat: 'PDF',
    autoDailyReportEnabled: false,
    autoReportTime: '21:00',
  };

  public appearanceTheme: ThemeMode = 'light';
  public userLanguagePrefs = new Map<string, LanguageCode>();

  public maintenanceSettings: MaintenanceSettingsConfig = {
    maintenanceMode: false,
    maintenanceMessage: 'MUN COMPUTER is undergoing scheduled maintenance.',
    debugMode: false,
    errorAlertAdmin: true,
    errorAlertManager: true,
    lastHealthCheckAt: new Date().toISOString(),
  };

  public backupLogs: BackupRecord[] = [];
  public lastSuccessfulBackupAt: string | null = null;
  public nextScheduledBackupNote =
    'Requires server Cron Job (daily at 23:30 IST) — automatic server cron is not active in preview sandbox.';

  private nextHistoryId = 2;
  private nextProposalNum = 1;
  private nextRateId = 4;
  private nextBackupId = 1;
  private nextClosingId = 1;

  constructor() {
    this.docSequence.seed('RECEIPT', 'MCR', '2026-27', 0);
    this.docSequence.seed('INVOICE', 'MCI', '2026-27', 0);
    this.docSequence.seed('APPLICATION', 'MCA', '2026-27', 0);
    this.docSequence.seed('CUSTOMER', 'MCC', '2026-27', 0);
    this.docSequence.seed('SERVICE', 'MCS', '2026-27', 3);
    this.docSequence.seed('DELIVERY', 'MCD', '2026-27', 0);
    this.docSequence.seed('REFUND', 'MCRF', '2026-27', 0);
  }

  public addHistory(
    entry: Omit<SettingsHistoryEntry, 'id' | 'createdAt'>
  ): SettingsHistoryEntry {
    const rec: SettingsHistoryEntry = {
      id: this.nextHistoryId++,
      ...entry,
      createdAt: new Date().toISOString(),
    };
    this.settingsHistory.unshift(rec);
    return rec;
  }

  public nextProposalCode(): string {
    return `PROP-2026-${String(this.nextProposalNum++).padStart(4, '0')}`;
  }

  public nextRateNumericId(): number {
    return this.nextRateId++;
  }

  public nextClosingCode(): string {
    const n = this.nextClosingId++;
    const istDate = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    return `DCC-${istDate}-${String(n).padStart(2, '0')}`;
  }

  public saveIntegrationCredential(channel: string, rawSecret: string): void {
    const cleaned = channel === 'SMS' ? cleanFast2SmsApiKey(rawSecret) : rawSecret.trim();
    if (cleaned) {
      this.integrationSecrets.set(channel, encryptSensitiveField(cleaned));
    }
  }

  public getIntegrationCredential(channel: string): string {
    const enc = this.integrationSecrets.get(channel);
    if (!enc) return '';
    try {
      const decrypted = decryptSensitiveField(enc);
      return channel === 'SMS' ? cleanFast2SmsApiKey(decrypted) : decrypted;
    } catch {
      return '';
    }
  }

  public exportIntegrationsSnapshot(): {
    apiIntegrations: ApiIntegrationItem[];
    integrationSecrets: Record<string, string>;
  } {
    return {
      apiIntegrations: this.apiIntegrations.map((item) => ({ ...item })),
      integrationSecrets: Object.fromEntries(this.integrationSecrets.entries()),
    };
  }

  public hydrateIntegrationsSnapshot(snapshot?: {
    apiIntegrations?: ApiIntegrationItem[];
    integrationSecrets?: Record<string, string>;
  }): void {
    if (!snapshot || typeof snapshot !== 'object') return;

    if (snapshot.integrationSecrets && typeof snapshot.integrationSecrets === 'object') {
      for (const [channel, encVal] of Object.entries(snapshot.integrationSecrets)) {
        if (typeof encVal === 'string' && encVal.trim()) {
          this.integrationSecrets.set(channel, encVal);
        }
      }
    }

    if (Array.isArray(snapshot.apiIntegrations)) {
      for (const saved of snapshot.apiIntegrations) {
        if (!saved || typeof saved.channel !== 'string') continue;
        const target = this.apiIntegrations.find((i) => i.channel === saved.channel);
        if (!target) continue;
        if (typeof saved.providerName === 'string' && saved.providerName.trim()) {
          target.providerName = saved.providerName;
        }
        if (typeof saved.endpointOrHost === 'string') {
          target.endpointOrHost =
            target.channel === 'SMS' && !saved.endpointOrHost.trim()
              ? 'https://www.fast2sms.com/dev/bulkV2'
              : saved.endpointOrHost;
        }
        if (typeof saved.senderOrFrom === 'string') {
          target.senderOrFrom = saved.senderOrFrom;
        }
        if (saved.smsRoute) {
          target.smsRoute = saved.smsRoute;
        }
        if (typeof saved.dltTemplateId === 'string') {
          target.dltTemplateId = saved.dltTemplateId;
        }
        if (target.channel === 'SMS') {
          target.dltTemplates = this.buildMergedDltTemplates(
            saved.dltTemplates as Partial<Record<Fast2SmsTemplatePurpose, string>> | undefined
          );
          if (!target.dltTemplateId) {
            target.dltTemplateId = (
              process.env.FAST2SMS_TEMPLATE_ID ||
              process.env.VITE_FAST2SMS_TEMPLATE_ID ||
              getDefaultFast2SmsGatewayConfig()?.templateId ||
              ''
            ).trim();
          }
        }
        const hasDecryptedSecret = Boolean(this.getIntegrationCredential(target.channel));
        const hasEnvSecret =
          target.channel === 'SMS'
            ? Boolean(
                cleanFast2SmsApiKey(
                  process.env.FAST2SMS_API_KEY ||
                    process.env.SMS_API_KEY ||
                    process.env.VITE_FAST2SMS_API_KEY ||
                    getDefaultFast2SmsGatewayConfig()?.apiKey
                )
              )
            : target.channel === 'EMAIL_SMTP'
              ? Boolean(process.env.SMTP_PASS)
              : false;
        target.hasSecret = hasDecryptedSecret || hasEnvSecret;
        target.isConfigured = Boolean(target.endpointOrHost && target.hasSecret);
        if (saved.lastTestedAt !== undefined) {
          target.lastTestedAt = saved.lastTestedAt;
        }
        if (saved.lastTestStatus) {
          target.lastTestStatus = saved.lastTestStatus;
        }
      }
    }
  }

  public buildMergedDltTemplates(
    overrides?: Partial<Record<Fast2SmsTemplatePurpose, string>>
  ): Partial<Record<Fast2SmsTemplatePurpose, string>> {
    const defaults = getDefaultFast2SmsGatewayConfig();
    const merged: Partial<Record<Fast2SmsTemplatePurpose, string>> = {};
    for (const { key } of FAST2SMS_TEMPLATE_PURPOSES) {
      const val = (
        overrides?.[key] ||
        process.env[`FAST2SMS_TEMPLATE_ID_${key}`] ||
        process.env[`VITE_FAST2SMS_TEMPLATE_ID_${key}`] ||
        defaults?.templates?.[key] ||
        ''
      ).trim();
      if (val) {
        merged[key] = val;
      }
    }
    return merged;
  }

  public getSmsGatewayConfig(): {
    apiKey: string;
    senderId: string;
    route: string;
    dltTemplateId: string;
    dltTemplates: Partial<Record<Fast2SmsTemplatePurpose, string>>;
    endpoint: string;
  } {
    const sms = this.apiIntegrations.find((i) => i.channel === 'SMS');
    const savedSecret = this.getIntegrationCredential('SMS');
    const defaults = getDefaultFast2SmsGatewayConfig();
    return {
      apiKey:
        savedSecret ||
        cleanFast2SmsApiKey(
          process.env.FAST2SMS_API_KEY ||
            process.env.SMS_API_KEY ||
            process.env.VITE_FAST2SMS_API_KEY ||
            defaults?.apiKey ||
            ''
        ),
      senderId: (
        sms?.senderOrFrom ||
        process.env.FAST2SMS_SENDER_ID ||
        process.env.SMS_SENDER_ID ||
        process.env.VITE_FAST2SMS_SENDER_ID ||
        defaults?.senderId ||
        'MUNCMP'
      ).trim(),
      route: (
        sms?.smsRoute ||
        process.env.FAST2SMS_ROUTE ||
        process.env.VITE_FAST2SMS_ROUTE ||
        defaults?.route ||
        'dlt'
      )
        .trim()
        .toLowerCase(),
      dltTemplateId: (
        sms?.dltTemplateId ||
        process.env.FAST2SMS_TEMPLATE_ID ||
        process.env.VITE_FAST2SMS_TEMPLATE_ID ||
        defaults?.templateId ||
        ''
      ).trim(),
      dltTemplates: this.buildMergedDltTemplates(sms?.dltTemplates),
      endpoint: (sms?.endpointOrHost || 'https://www.fast2sms.com/dev/bulkV2').trim(),
    };
  }

  public createEncryptedBackup(
    storageTarget: 'Hosting Server' | 'Computer Download',
    triggeredBy: string
  ): BackupRecord {
    const snapshot = JSON.stringify({
      exportedAt: new Date().toISOString(),
      companyProfile: this.companyProfile,
      globalConfig: this.globalConfig,
      serviceRates: this.serviceRates,
      notificationTemplates: this.notificationTemplates,
      printSettings: this.printSettings,
      documentTemplates: this.documentTemplates,
      paymentQrSettings: this.paymentQrSettings,
      securityPolicy: this.securityPolicy,
      branches: this.branches,
      counters: this.counters,
      customerPrivacy: this.customerPrivacy,
    });
    const encryptedPayload = encryptSensitiveField(snapshot);
    const checksumSha256 = sha256(encryptedPayload);
    const now = new Date().toISOString();
    const record: BackupRecord = {
      id: this.nextBackupId++,
      backupCode: `BKP-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
      storageTarget,
      encryptionAlgo: 'AES-256-GCM',
      checksumSha256,
      fileSizeBytes: Buffer.byteLength(encryptedPayload, 'utf8'),
      triggeredBy,
      status: 'Success',
      encryptedPayload,
      createdAt: now,
    };
    this.backupLogs.unshift(record);
    this.lastSuccessfulBackupAt = now;
    return record;
  }

  public exportSnapshot() {
    return {
      companyProfile: this.companyProfile,
      serviceRates: this.serviceRates,
      completedRateSnapshots: this.completedRateSnapshots,
      globalConfig: this.globalConfig,
      notificationTemplates: this.notificationTemplates,
      printSettings: this.printSettings,
      documentTemplates: this.documentTemplates,
      paymentQrSettings: this.paymentQrSettings,
      securityPolicy: this.securityPolicy,
      settingsProposals: this.settingsProposals,
      settingsHistory: this.settingsHistory,
      branches: this.branches,
      counters: this.counters,
      dailyCashClosings: this.dailyCashClosings,
      customerPrivacy: this.customerPrivacy,
      uploadedDocuments: this.uploadedDocuments,
      dashboardPreferences: this.dashboardPreferences,
      reportSettings: this.reportSettings,
      appearanceTheme: this.appearanceTheme,
      userLanguagePrefs: Object.fromEntries(this.userLanguagePrefs.entries()),
      maintenanceSettings: this.maintenanceSettings,
      backupLogs: this.backupLogs,
      lastSuccessfulBackupAt: this.lastSuccessfulBackupAt,
      nextHistoryId: this.nextHistoryId,
      nextProposalNum: this.nextProposalNum,
      nextRateId: this.nextRateId,
      nextBackupId: this.nextBackupId,
      nextClosingId: this.nextClosingId,
    };
  }

  public hydrateSnapshot(snapshot?: ReturnType<Phase03Store['exportSnapshot']> | null): void {
    if (!snapshot || typeof snapshot !== 'object') return;
    if (snapshot.companyProfile) this.companyProfile = snapshot.companyProfile;
    if (Array.isArray(snapshot.serviceRates)) this.serviceRates = snapshot.serviceRates;
    if (Array.isArray(snapshot.completedRateSnapshots)) {
      this.completedRateSnapshots = snapshot.completedRateSnapshots;
    }
    if (snapshot.globalConfig) this.globalConfig = snapshot.globalConfig;
    if (Array.isArray(snapshot.notificationTemplates)) {
      this.notificationTemplates = snapshot.notificationTemplates;
    }
    if (snapshot.printSettings) this.printSettings = snapshot.printSettings;
    if (Array.isArray(snapshot.documentTemplates)) this.documentTemplates = snapshot.documentTemplates;
    if (snapshot.paymentQrSettings) this.paymentQrSettings = snapshot.paymentQrSettings;
    if (snapshot.securityPolicy) this.securityPolicy = snapshot.securityPolicy;
    if (Array.isArray(snapshot.settingsProposals)) this.settingsProposals = snapshot.settingsProposals;
    if (Array.isArray(snapshot.settingsHistory)) this.settingsHistory = snapshot.settingsHistory;
    if (Array.isArray(snapshot.branches)) this.branches = snapshot.branches;
    if (Array.isArray(snapshot.counters)) this.counters = snapshot.counters;
    if (Array.isArray(snapshot.dailyCashClosings)) this.dailyCashClosings = snapshot.dailyCashClosings;
    if (snapshot.customerPrivacy) this.customerPrivacy = snapshot.customerPrivacy;
    if (Array.isArray(snapshot.uploadedDocuments)) this.uploadedDocuments = snapshot.uploadedDocuments;
    if (snapshot.dashboardPreferences) this.dashboardPreferences = snapshot.dashboardPreferences;
    if (snapshot.reportSettings) this.reportSettings = snapshot.reportSettings;
    if (snapshot.appearanceTheme) this.appearanceTheme = snapshot.appearanceTheme;
    if (snapshot.userLanguagePrefs && typeof snapshot.userLanguagePrefs === 'object') {
      this.userLanguagePrefs.clear();
      for (const [k, v] of Object.entries(snapshot.userLanguagePrefs)) {
        if (v) this.userLanguagePrefs.set(k, v);
      }
    }
    if (snapshot.maintenanceSettings) this.maintenanceSettings = snapshot.maintenanceSettings;
    if (Array.isArray(snapshot.backupLogs)) this.backupLogs = snapshot.backupLogs;
    if (snapshot.lastSuccessfulBackupAt !== undefined) {
      this.lastSuccessfulBackupAt = snapshot.lastSuccessfulBackupAt;
    }
    if (typeof snapshot.nextHistoryId === 'number') {
      this.nextHistoryId = Math.max(this.nextHistoryId, snapshot.nextHistoryId);
    }
    if (typeof snapshot.nextProposalNum === 'number') {
      this.nextProposalNum = Math.max(this.nextProposalNum, snapshot.nextProposalNum);
    }
    if (typeof snapshot.nextRateId === 'number') {
      this.nextRateId = Math.max(this.nextRateId, snapshot.nextRateId);
    }
    if (typeof snapshot.nextBackupId === 'number') {
      this.nextBackupId = Math.max(this.nextBackupId, snapshot.nextBackupId);
    }
    if (typeof snapshot.nextClosingId === 'number') {
      this.nextClosingId = Math.max(this.nextClosingId, snapshot.nextClosingId);
    }
  }
}
