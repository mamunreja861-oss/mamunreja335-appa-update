import crypto from 'node:crypto';

export type Fast2SmsTemplatePurpose =
  | 'SERVICE_REQUEST'
  | 'LOGIN_OTP'
  | 'ACCOUNT_REGISTRATION'
  | 'PASSWORD_CHANGED'
  | 'TASK_COMPLETED'
  | 'PAYMENT_RECEIVED'
  | 'PORTAL_LOGIN_OTP';

export const FAST2SMS_TEMPLATE_PURPOSES: ReadonlyArray<{
  key: Fast2SmsTemplatePurpose;
  label: string;
}> = [
  { key: 'SERVICE_REQUEST', label: 'Service Request Registration' },
  { key: 'LOGIN_OTP', label: 'Login OTP Verification' },
  { key: 'ACCOUNT_REGISTRATION', label: 'Account Registration / User ID' },
  { key: 'PASSWORD_CHANGED', label: 'Password Change Notification' },
  { key: 'TASK_COMPLETED', label: 'Task Completion Notice' },
  { key: 'PAYMENT_RECEIVED', label: 'Payment Received Confirmation' },
  { key: 'PORTAL_LOGIN_OTP', label: 'Portal Login OTP' },
];

export interface DefaultFast2SmsGatewayConfig {
  apiKey: string;
  route: 'dlt' | 'dlt_manual' | 'otp' | 'q';
  senderId: string;
  templateId: string;
  templates: Record<Fast2SmsTemplatePurpose, string>;
}

const SEALED_DEFAULT_SMS_GATEWAY =
  'a4f11acf80faf1d6bbf81ace:4965011c9f59a57938859fe0524705dd:9de5ddb92a92a49e16018b60fa7d5750c6416da4767283d6a039f5a1be9e6b3194735bf72b0f7055af23fc667b818b8962527da00a615b0d8d8c8d4589157d01ed2f41550278052ebb5fdea00a1ffb5a2f9371b15da30360353ee0a01eed258785e5cf90c7dd1231e682e1010209f5c4698354104e753bfe5af55d48f1bff3cbeb80ec09c5f98f948ab05334d006e3cf343d7cacb44260dcf959721fee4bcde938b808c4953d287483aa7596fe5b49c42149191fc2cedddf64c9852215d67622eae2889ffcc316174ecbbd5a0ff57814d2680dcbe9b9fea8bc3e79c5f682a162440feed070164a6df96d515eb68637c69f19e41f2904bc3692f322ee7cff9d32632230218aef0c82699a60c010dd43902c619841912c861d39cc04df9109e1f25e042e0176eb741a1a4872486e98d34518590d10ec7410d2';

let cachedDefaults: DefaultFast2SmsGatewayConfig | null | undefined;

export function getDefaultFast2SmsGatewayConfig(options?: {
  includeInTests?: boolean;
}): DefaultFast2SmsGatewayConfig | null {
  const isTestContext =
    process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);
  if (isTestContext && !options?.includeInTests) {
    return null;
  }
  if (process.env.DISABLE_DEFAULT_FAST2SMS === 'true') {
    return null;
  }
  if (cachedDefaults !== undefined) {
    return cachedDefaults;
  }
  try {
    const [ivHex, tagHex, dataHex] = SEALED_DEFAULT_SMS_GATEWAY.split(':');
    const key = crypto
      .createHash('sha256')
      .update('mun-computer-sms-gateway-seal-v1')
      .digest();
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(ivHex, 'hex')
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(decrypted) as Partial<DefaultFast2SmsGatewayConfig>;
    if (parsed.apiKey && parsed.templateId) {
      const parsedTemplates = (parsed.templates || {}) as Partial<
        Record<Fast2SmsTemplatePurpose, string>
      >;
      const fallbackId = String(parsed.templateId).trim();
      const templates: Record<Fast2SmsTemplatePurpose, string> = {
        SERVICE_REQUEST: String(parsedTemplates.SERVICE_REQUEST || fallbackId).trim(),
        LOGIN_OTP: String(parsedTemplates.LOGIN_OTP || fallbackId).trim(),
        ACCOUNT_REGISTRATION: String(parsedTemplates.ACCOUNT_REGISTRATION || fallbackId).trim(),
        PASSWORD_CHANGED: String(parsedTemplates.PASSWORD_CHANGED || fallbackId).trim(),
        TASK_COMPLETED: String(parsedTemplates.TASK_COMPLETED || fallbackId).trim(),
        PAYMENT_RECEIVED: String(parsedTemplates.PAYMENT_RECEIVED || fallbackId).trim(),
        PORTAL_LOGIN_OTP: String(parsedTemplates.PORTAL_LOGIN_OTP || fallbackId).trim(),
      };
      cachedDefaults = {
        apiKey: parsed.apiKey,
        route: parsed.route || 'dlt',
        senderId: parsed.senderId || 'MUNCMP',
        templateId: fallbackId,
        templates,
      };
      return cachedDefaults;
    }
  } catch {
    // Ignore malformed default configuration
  }
  cachedDefaults = null;
  return null;
}
