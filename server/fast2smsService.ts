import {
  Fast2SmsTemplatePurpose,
  getDefaultFast2SmsGatewayConfig,
} from './smsDefaults.js';

export type { Fast2SmsTemplatePurpose } from './smsDefaults.js';
export type Fast2SmsRoute = 'dlt' | 'dlt_manual' | 'otp' | 'q';

export interface Fast2SmsRuntimeConfig {
  apiKey?: string;
  senderId?: string;
  route?: string;
  dltTemplateId?: string;
  dltTemplates?: Partial<Record<Fast2SmsTemplatePurpose, string>>;
  endpoint?: string;
}

export interface Fast2SmsSendResult {
  sent: boolean;
  providerConfigured: boolean;
  sandboxMode: boolean;
  sandboxOtpPreview?: string;
  routeUsed?: Fast2SmsRoute;
  templateIdUsed?: string;
  detail: string;
}

function normalizeIndianMobile(rawMobile: string): string {
  const digits = rawMobile.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return digits.slice(2);
  }
  if (digits.length === 13 && digits.startsWith('880')) {
    return digits.slice(3);
  }
  if (digits.length > 10) {
    return digits.slice(-10);
  }
  return digits;
}

function normalizeRoute(raw?: string): Fast2SmsRoute | null {
  const cleaned = (raw || '').trim().toLowerCase();
  if (
    cleaned === 'dlt' ||
    cleaned === 'dlt_manual' ||
    cleaned === 'otp' ||
    cleaned === 'q'
  ) {
    return cleaned;
  }
  return null;
}

export function cleanFast2SmsApiKey(raw?: string): string {
  let val = (raw || '').trim();
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1).trim();
  }
  if (/^bearer\s+/i.test(val)) {
    val = val.replace(/^bearer\s+/i, '').trim();
  }
  return val;
}

function normalizeFast2SmsEndpoint(raw?: string): string {
  const trimmed = (raw || '').trim();
  if (trimmed.includes('fast2sms.com') && /\/dev\/bulk(v2)?\/?$/i.test(trimmed)) {
    return trimmed.replace(/\/+$/, '');
  }
  return 'https://www.fast2sms.com/dev/bulkV2';
}

export function resolveFast2SmsTemplateId(
  purpose?: Fast2SmsTemplatePurpose,
  runtime?: Fast2SmsRuntimeConfig,
  defaults = getDefaultFast2SmsGatewayConfig()
): string {
  if (purpose) {
    const purposeSpecific = (
      runtime?.dltTemplates?.[purpose] ||
      process.env[`FAST2SMS_TEMPLATE_ID_${purpose}`] ||
      process.env[`VITE_FAST2SMS_TEMPLATE_ID_${purpose}`] ||
      defaults?.templates?.[purpose] ||
      ''
    ).trim();
    if (purposeSpecific) {
      return purposeSpecific;
    }
  }

  return (
    runtime?.dltTemplateId ||
    process.env.FAST2SMS_TEMPLATE_ID ||
    process.env.VITE_FAST2SMS_TEMPLATE_ID ||
    defaults?.templateId ||
    ''
  ).trim();
}

function resolveFast2SmsConfig(
  runtime?: Fast2SmsRuntimeConfig,
  purpose?: Fast2SmsTemplatePurpose
) {
  const defaults = getDefaultFast2SmsGatewayConfig();
  const apiKey = cleanFast2SmsApiKey(
    runtime?.apiKey ||
      process.env.FAST2SMS_API_KEY ||
      process.env.SMS_API_KEY ||
      process.env.VITE_FAST2SMS_API_KEY ||
      defaults?.apiKey ||
      ''
  );

  const templateId = resolveFast2SmsTemplateId(purpose, runtime, defaults);

  const senderId = (
    runtime?.senderId ||
    process.env.FAST2SMS_SENDER_ID ||
    process.env.SMS_SENDER_ID ||
    process.env.VITE_FAST2SMS_SENDER_ID ||
    defaults?.senderId ||
    'MUNCMP'
  ).trim();

  // Default to 'dlt' (DLT SMS API) so Fast2SMS does not reject with
  // "Before using OTP Message API, complete website verification."
  const explicitRoute =
    normalizeRoute(runtime?.route) ||
    normalizeRoute(process.env.FAST2SMS_ROUTE) ||
    normalizeRoute(process.env.VITE_FAST2SMS_ROUTE) ||
    defaults?.route;
  const route: Fast2SmsRoute = explicitRoute ?? 'dlt';

  const endpoint = normalizeFast2SmsEndpoint(runtime?.endpoint);

  return {
    apiKey,
    templateId,
    senderId,
    route,
    endpoint,
  };
}

export function isFast2SmsConfigured(runtime?: Fast2SmsRuntimeConfig): boolean {
  return Boolean(resolveFast2SmsConfig(runtime).apiKey);
}

export function isSandboxOtpAllowed(): boolean {
  return process.env.ALLOW_SANDBOX_OTP !== 'false';
}

function isProviderErrorSandboxFallbackAllowed(): boolean {
  return process.env.ALLOW_SANDBOX_OTP === 'true';
}

export interface Fast2SmsWalletCheckResult {
  ok: boolean;
  walletBalance: number | null;
  smsCount: number | null;
  detail: string;
}

export async function verifyFast2SmsApiKey(
  rawApiKey: string
): Promise<Fast2SmsWalletCheckResult> {
  const apiKey = cleanFast2SmsApiKey(rawApiKey);
  if (!apiKey) {
    return {
      ok: false,
      walletBalance: null,
      smsCount: null,
      detail: 'Fast2SMS API key is empty.',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('https://www.fast2sms.com/dev/wallet', {
      method: 'POST',
      headers: {
        authorization: apiKey,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    const rawText = await response.text().catch(() => '');
    let data: {
      return?: boolean;
      wallet?: string | number;
      sms_count?: number;
      message?: string | string[];
    } = {};
    try {
      data = rawText ? (JSON.parse(rawText) as typeof data) : {};
    } catch {
      data = {};
    }

    if (response.ok && data.return === true) {
      const walletNum = data.wallet !== undefined ? Number(data.wallet) : null;
      const validWallet = walletNum !== null && Number.isFinite(walletNum) ? walletNum : null;
      const smsCountNum = typeof data.sms_count === 'number' ? data.sms_count : null;
      return {
        ok: true,
        walletBalance: validWallet,
        smsCount: smsCountNum,
        detail: `Fast2SMS API key verified${
          validWallet !== null
            ? ` (Wallet: ₹${validWallet.toFixed(2)}${smsCountNum !== null ? `, ~${smsCountNum} SMS` : ''})`
            : ''
        }.`,
      };
    }

    const errMsg = Array.isArray(data.message)
      ? data.message.join(', ')
      : data.message || `HTTP ${response.status}`;

    return {
      ok: false,
      walletBalance: null,
      smsCount: null,
      detail: `Fast2SMS rejected the API key: ${errMsg}`,
    };
  } catch (err) {
    return {
      ok: false,
      walletBalance: null,
      smsCount: null,
      detail:
        err instanceof Error
          ? `Fast2SMS connection error: ${err.message}`
          : 'Fast2SMS connection failed.',
    };
  } finally {
    clearTimeout(timer);
  }
}

function formatDltVariables(otp: string): string {
  const customFormat = (process.env.FAST2SMS_VARIABLES_FORMAT || '').trim();
  if (customFormat) {
    return customFormat.replace(/\{otp\}/gi, otp);
  }
  return otp;
}

function buildPayloadForRoute(params: {
  route: Fast2SmsRoute;
  senderId: string;
  templateId: string;
  otp: string;
  cleanNumber: string;
}): Record<string, string | number> {
  const { route, senderId, templateId, otp, cleanNumber } = params;

  if (route === 'dlt') {
    return {
      route: 'dlt',
      sender_id: senderId || 'MUNCMP',
      message: templateId,
      variables_values: formatDltVariables(otp),
      flash: 0,
      numbers: cleanNumber,
    };
  }

  if (route === 'dlt_manual') {
    const entityId = (process.env.FAST2SMS_ENTITY_ID || '').trim();
    const messageTemplate = (
      process.env.FAST2SMS_DLT_MESSAGE ||
      'Your MUN COMPUTER login OTP is {otp}. Valid for 5 minutes. Do not share.'
    ).trim();
    return {
      route: 'dlt_manual',
      sender_id: senderId || 'MUNCMP',
      template_id: templateId,
      ...(entityId ? { entity_id: entityId } : {}),
      message: messageTemplate.replace(/\{otp\}/gi, otp),
      flash: 0,
      numbers: cleanNumber,
    };
  }

  if (route === 'q') {
    return {
      route: 'q',
      message: `Your MUN COMPUTER login OTP is ${otp}. Valid for 5 minutes. Do not share.`,
      flash: 0,
      numbers: cleanNumber,
    };
  }

  // 'otp' route (Quick OTP Message API — requires Fast2SMS website verification)
  return {
    route: 'otp',
    variables_values: otp,
    flash: 0,
    numbers: cleanNumber,
  };
}

async function dispatchFast2SmsRequest(params: {
  endpoint: string;
  apiKey: string;
  payload: Record<string, string | number>;
}): Promise<{ ok: boolean; status: number; errMsg: string; requestId?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(params.endpoint, {
      method: 'POST',
      headers: {
        authorization: params.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(params.payload),
      signal: controller.signal,
    });

    const rawText = await response.text().catch(() => '');
    let data: {
      return?: boolean;
      message?: string | string[];
      request_id?: string;
      status_code?: number;
    } = {};
    try {
      data = rawText ? (JSON.parse(rawText) as typeof data) : {};
    } catch {
      data = {};
    }

    if (response.ok && data.return === true) {
      return {
        ok: true,
        status: response.status,
        errMsg: '',
        requestId: data.request_id,
      };
    }

    const fallbackText =
      rawText && !rawText.trim().startsWith('<')
        ? rawText.trim().slice(0, 180)
        : `HTTP ${response.status}`;

    const errMsg = Array.isArray(data.message)
      ? data.message.join(', ')
      : data.message || (data.status_code ? `Fast2SMS status ${data.status_code}` : fallbackText);

    return {
      ok: false,
      status: response.status,
      errMsg,
    };
  } finally {
    clearTimeout(timer);
  }
}

function isWebsiteVerificationRejection(errMsg: string): boolean {
  const lower = errMsg.toLowerCase();
  return (
    lower.includes('website verification') ||
    lower.includes('otp message api') ||
    lower.includes('dlt sms api')
  );
}

/**
 * Server-side Fast2SMS OTP Dispatcher (https://www.fast2sms.com/dev/bulkV2).
 * Supports 'dlt' (default — Sender ID + DLT Template ID), 'dlt_manual', 'otp', and 'q'.
 * - When no API key is configured and non-production sandbox is allowed, returns sandbox OTP preview.
 * - When an API key IS configured, dispatches live via Fast2SMS and surfaces real errors unless ALLOW_SANDBOX_OTP=true.
 * - NEVER leaks OTP values or API keys in response payloads, URLs, or logs.
 */
export async function sendFast2SmsOtp(params: {
  mobile: string;
  otp: string;
  userId?: string;
  purpose?: Fast2SmsTemplatePurpose;
  runtimeConfig?: Fast2SmsRuntimeConfig;
}): Promise<Fast2SmsSendResult> {
  const { apiKey, templateId, senderId, route, endpoint } = resolveFast2SmsConfig(
    params.runtimeConfig,
    params.purpose
  );
  const cleanNumber = normalizeIndianMobile(params.mobile);

  if (!apiKey) {
    if (isSandboxOtpAllowed()) {
      return {
        sent: true,
        providerConfigured: false,
        sandboxMode: true,
        sandboxOtpPreview: params.otp,
        detail:
          'Fast2SMS API key is not configured yet — bootstrap OTP preview active. Sign in as Admin and save your Fast2SMS API key in Master Settings → API Integrations to enable live SMS.',
      };
    }
    return {
      sent: false,
      providerConfigured: false,
      sandboxMode: false,
      detail: 'Fast2SMS gateway (FAST2SMS_API_KEY) is not configured on the server.',
    };
  }

  if (cleanNumber.length < 10) {
    return {
      sent: false,
      providerConfigured: true,
      sandboxMode: false,
      detail: 'Registered user mobile number is invalid for Fast2SMS dispatch.',
    };
  }

  // If DLT route is active but Template ID is not configured, fail clearly with actionable guidance
  // (unless ALLOW_SANDBOX_OTP=true is explicitly set).
  if ((route === 'dlt' || route === 'dlt_manual') && !templateId) {
    const missingTplMsg = `Fast2SMS DLT route (${senderId}) requires FAST2SMS_TEMPLATE_ID (your Fast2SMS DLT approved Template Message ID). Enter it in Master Settings → API Integrations, or switch Fast2SMS Route to Quick SMS (q) if you do not have DLT approved yet.`;
    if (isProviderErrorSandboxFallbackAllowed()) {
      return {
        sent: true,
        providerConfigured: true,
        sandboxMode: true,
        sandboxOtpPreview: params.otp,
        routeUsed: route,
        detail: `${missingTplMsg} Sandbox OTP preview active (ALLOW_SANDBOX_OTP=true).`,
      };
    }
    return {
      sent: false,
      providerConfigured: true,
      sandboxMode: false,
      routeUsed: route,
      detail: missingTplMsg,
    };
  }

  try {
    let activeRoute: Fast2SmsRoute = route;
    let payload = buildPayloadForRoute({
      route: activeRoute,
      senderId,
      templateId,
      otp: params.otp,
      cleanNumber,
    });

    let dispatch = await dispatchFast2SmsRequest({ endpoint, apiKey, payload });

    // If 'otp' route was explicitly configured in env/settings and Fast2SMS rejects it
    // due to missing Website Verification, automatically retry with DLT SMS API when
    // FAST2SMS_TEMPLATE_ID is available (or Quick SMS if explicitly allowed).
    if (!dispatch.ok && activeRoute === 'otp' && isWebsiteVerificationRejection(dispatch.errMsg)) {
      if (templateId) {
        activeRoute = 'dlt';
        payload = buildPayloadForRoute({
          route: 'dlt',
          senderId,
          templateId,
          otp: params.otp,
          cleanNumber,
        });
        dispatch = await dispatchFast2SmsRequest({ endpoint, apiKey, payload });
      } else if (process.env.FAST2SMS_ALLOW_QUICK_FALLBACK === 'true') {
        activeRoute = 'q';
        payload = buildPayloadForRoute({
          route: 'q',
          senderId,
          templateId,
          otp: params.otp,
          cleanNumber,
        });
        dispatch = await dispatchFast2SmsRequest({ endpoint, apiKey, payload });
      }
    }

    if (dispatch.ok) {
      return {
        sent: true,
        providerConfigured: true,
        sandboxMode: false,
        routeUsed: activeRoute,
        templateIdUsed: templateId || undefined,
        detail: `Fast2SMS ${activeRoute.toUpperCase()} OTP dispatched cleanly (request: ${dispatch.requestId || 'accepted'}).`,
      };
    }

    const actionableErr = isWebsiteVerificationRejection(dispatch.errMsg)
      ? `${dispatch.errMsg} — Set Fast2SMS Route to DLT (dlt) with your DLT Template Message ID, or switch to Quick SMS (q) in Master Settings → API Integrations.`
      : dispatch.errMsg;

    if (isProviderErrorSandboxFallbackAllowed()) {
      return {
        sent: true,
        providerConfigured: true,
        sandboxMode: true,
        sandboxOtpPreview: params.otp,
        routeUsed: activeRoute,
        templateIdUsed: templateId || undefined,
        detail: `Fast2SMS notice (${actionableErr}); sandbox OTP preview active (ALLOW_SANDBOX_OTP=true).`,
      };
    }

    return {
      sent: false,
      providerConfigured: true,
      sandboxMode: false,
      routeUsed: activeRoute,
      templateIdUsed: templateId || undefined,
      detail: `Fast2SMS gateway rejected OTP request: ${actionableErr}`,
    };
  } catch (err) {
    const connErr =
      err instanceof Error
        ? `Fast2SMS connection error: ${err.message}`
        : 'Fast2SMS connection failed.';

    if (isProviderErrorSandboxFallbackAllowed()) {
      return {
        sent: true,
        providerConfigured: true,
        sandboxMode: true,
        sandboxOtpPreview: params.otp,
        detail: `${connErr}; sandbox OTP preview active (ALLOW_SANDBOX_OTP=true).`,
      };
    }

    return {
      sent: false,
      providerConfigured: true,
      sandboxMode: false,
      detail: connErr,
    };
  }
}

/**
 * Server-side Fast2SMS DLT Notification Dispatcher for non-OTP business events
 * (Service Request Registration, Account Registration, Password Changed, Task Completed, Payment Received).
 */
export async function sendFast2SmsTemplateMessage(params: {
  mobile: string;
  purpose: Fast2SmsTemplatePurpose;
  variables?: Array<string | number>;
  fallbackText: string;
  runtimeConfig?: Fast2SmsRuntimeConfig;
}): Promise<Fast2SmsSendResult> {
  const { apiKey, templateId, senderId, route, endpoint } = resolveFast2SmsConfig(
    params.runtimeConfig,
    params.purpose
  );
  const cleanNumber = normalizeIndianMobile(params.mobile);

  if (!apiKey) {
    return {
      sent: false,
      providerConfigured: false,
      sandboxMode: false,
      detail: 'Fast2SMS gateway is not configured on the server.',
    };
  }

  if (cleanNumber.length < 10) {
    return {
      sent: false,
      providerConfigured: true,
      sandboxMode: false,
      detail: 'Recipient mobile number is invalid for Fast2SMS dispatch.',
    };
  }

  const normalizedVars = (params.variables ?? [])
    .map((v) => String(v ?? '').trim().replace(/\|/g, '/'))
    .filter((v) => v.length > 0)
    .join('|');

  if ((route === 'dlt' || route === 'dlt_manual') && !templateId) {
    return {
      sent: false,
      providerConfigured: true,
      sandboxMode: false,
      routeUsed: route,
      detail: `Fast2SMS DLT template ID is missing for ${params.purpose}.`,
    };
  }

  const activeRoute: Fast2SmsRoute = route === 'otp' ? (templateId ? 'dlt' : 'q') : route;
  const payload: Record<string, string | number> =
    activeRoute === 'dlt'
      ? {
          route: 'dlt',
          sender_id: senderId || 'MUNCMP',
          message: templateId,
          variables_values: normalizedVars || params.fallbackText.slice(0, 120),
          flash: 0,
          numbers: cleanNumber,
        }
      : activeRoute === 'dlt_manual'
        ? {
            route: 'dlt_manual',
            sender_id: senderId || 'MUNCMP',
            template_id: templateId,
            ...(process.env.FAST2SMS_ENTITY_ID?.trim()
              ? { entity_id: process.env.FAST2SMS_ENTITY_ID.trim() }
              : {}),
            message: params.fallbackText,
            flash: 0,
            numbers: cleanNumber,
          }
        : {
            route: 'q',
            message: params.fallbackText,
            flash: 0,
            numbers: cleanNumber,
          };

  try {
    const dispatch = await dispatchFast2SmsRequest({ endpoint, apiKey, payload });
    if (dispatch.ok) {
      return {
        sent: true,
        providerConfigured: true,
        sandboxMode: false,
        routeUsed: activeRoute,
        templateIdUsed: templateId || undefined,
        detail: `Fast2SMS ${params.purpose} (${templateId || activeRoute}) dispatched cleanly (request: ${dispatch.requestId || 'accepted'}).`,
      };
    }
    return {
      sent: false,
      providerConfigured: true,
      sandboxMode: false,
      routeUsed: activeRoute,
      templateIdUsed: templateId || undefined,
      detail: `Fast2SMS rejected ${params.purpose} notification: ${dispatch.errMsg}`,
    };
  } catch (err) {
    return {
      sent: false,
      providerConfigured: true,
      sandboxMode: false,
      routeUsed: activeRoute,
      templateIdUsed: templateId || undefined,
      detail:
        err instanceof Error
          ? `Fast2SMS connection error: ${err.message}`
          : 'Fast2SMS connection failed.',
    };
  }
}
