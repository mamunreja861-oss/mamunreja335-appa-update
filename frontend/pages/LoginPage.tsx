import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  User,
} from 'lucide-react';
import { BrandLogo } from '../components/BrandLogo';
import { Button } from '../components/Button';
import { BRAND } from '../assets/brand';
import { securityRequest, setAuthToken, setCsrfToken } from '../services/securityApi';
import { UserProfile } from '../modules/types';

type AuthStep =
  | 'step1'
  | 'totp'
  | 'recovery-codes-backup'
  | 'forgot-password'
  | 'reset-password';

interface CaptchaData {
  provider: 'svg' | 'turnstile' | 'recaptcha';
  siteKey?: string;
  challengeId: string;
  svg: string;
  questionHint: string;
}

interface PendingSessionPayload {
  user: UserProfile;
  permissions: Record<string, boolean>;
  csrfToken: string;
  recoveryCodes?: string[];
  session: {
    expiresAt: string;
    rememberMe?: boolean;
  };
}

interface LoginPageProps {
  initialUserId?: string;
  initialSuccessBanner?: string | null;
  onLoginSuccess: (
    user: UserProfile,
    permissions: Record<string, boolean>,
    sessionMeta?: { expiresAt?: string; rememberMe?: boolean }
  ) => void;
  onShowToast: (
    type: 'success' | 'error' | 'info',
    title: string,
    description?: string
  ) => void;
}

const STEP_LABELS = [
  { key: 'step1', num: 1, title: 'Credentials & Verification' },
  { key: 'totp', num: 2, title: 'Authenticator' },
] as const;

export const LoginPage: React.FC<LoginPageProps> = ({
  initialUserId = '',
  initialSuccessBanner = null,
  onLoginSuccess,
  onShowToast,
}) => {
  const [step, setStep] = useState<AuthStep>('step1');

  // Step 1: Unified Credentials + CAPTCHA + Fast2SMS OTP
  const [userId, setUserId] = useState(initialUserId);
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const [challengeId, setChallengeId] = useState('');

  const [captchaData, setCaptchaData] = useState<CaptchaData | null>(null);
  const [captchaAnswer, setCaptchaAnswer] = useState('');

  const [maskedMobile, setMaskedMobile] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [sandboxOtp, setSandboxOtp] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [sendingOtp, setSendingOtp] = useState(false);

  // Step 2: Google Authenticator (TOTP) & Recovery
  const [requiresTotpSetup, setRequiresTotpSetup] = useState(false);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('');
  const [manualSecret, setManualSecret] = useState('');
  const [accountLabel, setAccountLabel] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [useRecoveryMode, setUseRecoveryMode] = useState(false);
  const [recoveryCodeInput, setRecoveryCodeInput] = useState('');
  const [secretCopied, setSecretCopied] = useState(false);
  const [issuedRecoveryCodes, setIssuedRecoveryCodes] = useState<string[]>([]);
  const [pendingFinalSession, setPendingFinalSession] = useState<PendingSessionPayload | null>(null);

  // Forgot & Reset Password State
  const [resetUserId, setResetUserId] = useState('');
  const [resetChallengeId, setResetChallengeId] = useState('');
  const [resetMaskedMobile, setResetMaskedMobile] = useState('');
  const [resetTotpRequired, setResetTotpRequired] = useState(false);
  const [resetOtp, setResetOtp] = useState('');
  const [resetTotpCode, setResetTotpCode] = useState('');
  const [resetResendCooldown, setResetResendCooldown] = useState(0);
  const [resendingResetOtp, setResendingResetOtp] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [showResetNewPassword, setShowResetNewPassword] = useState(false);
  const [showResetConfirmPassword, setShowResetConfirmPassword] = useState(false);

  const [loading, setLoading] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(initialSuccessBanner);
  const stepSubmitLockRef = useRef(false);

  const fetchFreshCaptcha = useCallback(async (preserveError = true) => {
    if (!preserveError) {
      setErrorBanner(null);
    }
    try {
      const res = await securityRequest<CaptchaData>('/api/auth/captcha');
      setCaptchaData(res.data);
      setCaptchaAnswer('');
    } catch (err) {
      if (!preserveError) {
        setErrorBanner(err instanceof Error ? err.message : 'Unable to load CAPTCHA.');
      }
    }
  }, []);

  useEffect(() => {
    void fetchFreshCaptcha(true);
  }, [fetchFreshCaptcha]);

  useEffect(() => {
    if (initialUserId) {
      setUserId(initialUserId);
    }
  }, [initialUserId]);

  useEffect(() => {
    if (initialSuccessBanner) {
      setSuccessBanner(initialSuccessBanner);
      setStep('step1');
    }
  }, [initialSuccessBanner]);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => {
      setResendCooldown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  useEffect(() => {
    if (resetResendCooldown <= 0) return;
    const timer = setInterval(() => {
      setResetResendCooldown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [resetResendCooldown]);

  const clearOtpChallengeState = () => {
    setChallengeId('');
    setMaskedMobile('');
    setSandboxOtp(null);
    setOtpCode('');
    setResendCooldown(0);
  };

  const resetToStep1 = () => {
    setErrorBanner(null);
    clearOtpChallengeState();
    setTotpCode('');
    setRecoveryCodeInput('');
    setUseRecoveryMode(false);
    setRequiresTotpSetup(false);
    setQrCodeDataUrl('');
    setManualSecret('');
    setPendingFinalSession(null);
    setIssuedRecoveryCodes([]);
    setStep('step1');
    void fetchFreshCaptcha(true);
  };

  const handleRefreshCaptcha = async (preserveError = false) => {
    if (stepSubmitLockRef.current || sendingOtp) return;
    await fetchFreshCaptcha(preserveError);
  };

  // STEP 1A: Validate User ID + Password + CAPTCHA and Send/Resend SMS OTP
  const handleSendOrResendOtp = async () => {
    if (stepSubmitLockRef.current || loading || sendingOtp) return;
    setErrorBanner(null);
    setSuccessBanner(null);

    if (challengeId) {
      if (resendCooldown > 0) return;
      setSendingOtp(true);
      try {
        const res = await securityRequest<{
          challengeId?: string;
          resendCooldownSeconds: number;
          deliveryDetail: string;
          sandboxOtpPreview?: string;
        }>('/api/auth/resend-otp', {
          method: 'POST',
          body: JSON.stringify({ challengeId }),
        });
        if (res.data.challengeId) {
          setChallengeId(res.data.challengeId);
        }
        setResendCooldown(res.data.resendCooldownSeconds || 30);
        setSandboxOtp(res.data.sandboxOtpPreview || null);
        onShowToast('info', 'OTP Resent', 'A fresh 6-digit SMS OTP has been dispatched.');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unable to resend OTP.';
        setErrorBanner(msg);
        onShowToast('error', 'Resend Blocked', msg);
      } finally {
        setSendingOtp(false);
      }
      return;
    }

    const cleanId = userId.trim();
    const cleanPassword = password.trim();
    if (!cleanId) {
      setErrorBanner('Enter your assigned User ID or registered email.');
      return;
    }
    if (!cleanPassword) {
      setErrorBanner('Enter your password.');
      return;
    }
    const cleanedAnswer = captchaAnswer.replace(/\s+/g, '').toUpperCase();
    if (!cleanedAnswer) {
      setErrorBanner('Enter the verification characters shown in the CAPTCHA image before sending OTP.');
      return;
    }

    setSendingOtp(true);
    try {
      const res = await securityRequest<{
        challengeId: string;
        nextStep: 'SMS_OTP';
        maskedMobile: string;
        resendCooldownSeconds: number;
        deliveryDetail: string;
        sandboxOtpPreview?: string;
      }>('/api/auth/login-step1-send-otp', {
        method: 'POST',
        body: JSON.stringify({
          userId: cleanId,
          password: cleanPassword,
          rememberMe,
          captchaId: captchaData?.challengeId,
          captchaAnswer: cleanedAnswer,
        }),
      });

      setChallengeId(res.data.challengeId);
      setMaskedMobile(res.data.maskedMobile);
      setSandboxOtp(res.data.sandboxOtpPreview || null);
      setResendCooldown(res.data.resendCooldownSeconds || 30);
      setOtpCode('');
      onShowToast('info', 'OTP Sent', `SMS OTP dispatched to ${res.data.maskedMobile}`);
    } catch (err) {
      const eObj = err as Error & { data?: { captcha?: CaptchaData } };
      if (eObj.data?.captcha) {
        setCaptchaData(eObj.data.captcha);
        setCaptchaAnswer('');
      }
      const msg = err instanceof Error ? err.message : 'Unable to verify credentials and send OTP.';
      setErrorBanner(msg);
      onShowToast('error', 'Verification Failed', msg);
    } finally {
      setSendingOtp(false);
    }
  };

  // STEP 1B: Verify OTP -> Proceed to Step 2 (Google Authenticator)
  const handleStep1Submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (stepSubmitLockRef.current || loading || sendingOtp) return;
    setErrorBanner(null);
    setSuccessBanner(null);

    const cleanId = userId.trim();
    const cleanPassword = password.trim();
    if (!cleanId) {
      setErrorBanner('Enter your assigned User ID or registered email.');
      return;
    }
    if (!cleanPassword) {
      setErrorBanner('Enter your password.');
      return;
    }
    if (!challengeId) {
      setErrorBanner('Complete CAPTCHA and click "Send OTP" first.');
      return;
    }

    const cleanOtp = otpCode.trim();
    if (!/^\d{6}$/.test(cleanOtp)) {
      setErrorBanner('Enter the 6-digit SMS OTP sent to your registered mobile.');
      return;
    }

    stepSubmitLockRef.current = true;
    setLoading(true);
    try {
      const res = await securityRequest<{
        challengeId: string;
        nextStep: 'TOTP';
        requiresSetup: boolean;
        totpEnabled: boolean;
        accountLabel: string;
        qrCodeDataUrl?: string;
        manualSecret?: string;
      }>('/api/auth/verify-sms-otp', {
        method: 'POST',
        body: JSON.stringify({ challengeId, otp: cleanOtp }),
      });

      if (res.data.challengeId) {
        setChallengeId(res.data.challengeId);
      }
      setRequiresTotpSetup(Boolean(res.data.requiresSetup));
      setQrCodeDataUrl(res.data.qrCodeDataUrl || '');
      setManualSecret(res.data.manualSecret || '');
      setAccountLabel(res.data.accountLabel || userId);
      setTotpCode('');
      setRecoveryCodeInput('');
      setUseRecoveryMode(false);
      setStep('totp');
      onShowToast(
        'info',
        'Step 1 Verified',
        res.data.requiresSetup
          ? 'Scan the QR code in Google Authenticator to complete Step 2.'
          : 'Enter your 6-digit Google Authenticator code.'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'OTP verification failed.';
      setErrorBanner(msg);
      onShowToast('error', 'Step 1 Failed', msg);
    } finally {
      stepSubmitLockRef.current = false;
      setLoading(false);
    }
  };

  // STEP 2: Google Authenticator (TOTP) or Single-Use Recovery Code -> Issues Session Cookies
  const handleStep2Submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (stepSubmitLockRef.current || loading) return;
    setErrorBanner(null);

    if (useRecoveryMode) {
      if (!recoveryCodeInput.trim()) {
        setErrorBanner('Enter one of your unused 8-character recovery codes.');
        return;
      }
    } else if (!/^\d{6}$/.test(totpCode.trim())) {
      setErrorBanner('Enter the 6-digit verification code from Google Authenticator.');
      return;
    }

    stepSubmitLockRef.current = true;
    setLoading(true);
    try {
      const res = await securityRequest<{
        user: Omit<UserProfile, 'avatarInitials'>;
        permissions: Record<string, boolean>;
        csrfToken: string;
        accessToken?: string;
        recoveryCodes?: string[];
        session: {
          expiresAt: string;
          rememberMe?: boolean;
        };
      }>('/api/auth/verify-totp', {
        method: 'POST',
        body: JSON.stringify({
          challengeId,
          ...(useRecoveryMode
            ? { recoveryCode: recoveryCodeInput.trim() }
            : { code: totpCode.trim() }),
        }),
      });

      setCsrfToken(res.data.csrfToken);
      if (res.data.accessToken) {
        setAuthToken(res.data.accessToken);
      }
      const initials = res.data.user.fullName
        .split(' ')
        .map((p) => p[0])
        .slice(0, 2)
        .join('')
        .toUpperCase();
      const loadedUser: UserProfile = {
        ...res.data.user,
        avatarInitials: initials || 'MC',
      };

      const sessionPayload: PendingSessionPayload = {
        user: loadedUser,
        permissions: res.data.permissions,
        csrfToken: res.data.csrfToken,
        recoveryCodes: res.data.recoveryCodes,
        session: res.data.session,
      };

      if (res.data.recoveryCodes && res.data.recoveryCodes.length > 0) {
        setIssuedRecoveryCodes(res.data.recoveryCodes);
        setPendingFinalSession(sessionPayload);
        setStep('recovery-codes-backup');
        onShowToast(
          'success',
          'Authenticator Linked',
          'Download or save your 8 backup recovery codes before entering.'
        );
      } else {
        onShowToast('success', 'Welcome Back', `Signed in as ${loadedUser.fullName}`);
        onLoginSuccess(loadedUser, res.data.permissions, res.data.session);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Google Authenticator verification failed.';
      setErrorBanner(msg);
      onShowToast('error', 'Step 2 Failed', msg);
    } finally {
      stepSubmitLockRef.current = false;
      setLoading(false);
    }
  };

  const handleCopyManualSecret = async () => {
    if (!manualSecret) return;
    try {
      await navigator.clipboard.writeText(manualSecret);
      setSecretCopied(true);
      onShowToast('info', 'Setup Key Copied', 'Paste the Base32 secret into Google Authenticator.');
      setTimeout(() => setSecretCopied(false), 2000);
    } catch {
      onShowToast('info', 'Copy Key', 'Select the manual setup key text to copy.');
    }
  };

  const handleDownloadRecoveryCodes = () => {
    if (!issuedRecoveryCodes.length) return;
    const text = [
      'MUN COMPUTER ERP — SINGLE-USE TOTP RECOVERY CODES',
      `Account: ${pendingFinalSession?.user.userId || userId}`,
      `Generated: ${new Date().toISOString()}`,
      '',
      'Store these codes in a secure password manager or offline safe.',
      'Each code can only be used ONCE if you lose access to Google Authenticator:',
      '',
      ...issuedRecoveryCodes.map((c, idx) => `${idx + 1}. ${c}`),
    ].join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `MUN_Recovery_Codes_${pendingFinalSession?.user.userId || 'User'}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleFinishRecoveryBackup = () => {
    if (!pendingFinalSession) return;
    onShowToast(
      'success',
      'Authentication Complete',
      `Signed in as ${pendingFinalSession.user.fullName}`
    );
    onLoginSuccess(
      pendingFinalSession.user,
      pendingFinalSession.permissions,
      pendingFinalSession.session
    );
  };

  // FORGOT / RESET PASSWORD HANDLERS
  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorBanner(null);
    setSuccessBanner(null);
    if (!resetUserId.trim()) {
      setErrorBanner('Enter your MUN COMPUTER User ID or registered email.');
      return;
    }
    setLoading(true);
    try {
      const res = await securityRequest<{
        challengeId: string;
        maskedMobile: string;
        totpRequired: boolean;
        resendCooldownSeconds?: number;
        sandboxOtpPreview?: string;
      }>('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ userId: resetUserId.trim() }),
      });
      setResetChallengeId(res.data.challengeId);
      setResetMaskedMobile(res.data.maskedMobile);
      setResetTotpRequired(Boolean(res.data.totpRequired));
      setResetResendCooldown(res.data.resendCooldownSeconds || 30);
      setSandboxOtp(res.data.sandboxOtpPreview || null);
      setStep('reset-password');
      onShowToast('info', 'Reset OTP Sent', `OTP dispatched to ${res.data.maskedMobile}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to start password reset.';
      setErrorBanner(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleResendResetOtp = async () => {
    if (!resetChallengeId || resetResendCooldown > 0 || resendingResetOtp || loading) return;
    setErrorBanner(null);
    setResendingResetOtp(true);
    try {
      const res = await securityRequest<{
        challengeId?: string;
        maskedMobile?: string;
        resendCooldownSeconds?: number;
        sandboxOtpPreview?: string;
      }>('/api/auth/resend-otp', {
        method: 'POST',
        body: JSON.stringify({ challengeId: resetChallengeId }),
      });
      if (res.data.challengeId) {
        setResetChallengeId(res.data.challengeId);
      }
      if (res.data.maskedMobile) {
        setResetMaskedMobile(res.data.maskedMobile);
      }
      setResetResendCooldown(res.data.resendCooldownSeconds || 30);
      setSandboxOtp(res.data.sandboxOtpPreview || null);
      setResetOtp('');
      onShowToast('info', 'Reset OTP Resent', 'A fresh 6-digit password reset OTP has been sent.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to resend reset OTP.';
      setErrorBanner(msg);
      onShowToast('error', 'Resend Blocked', msg);
    } finally {
      setResendingResetOtp(false);
    }
  };

  const handleResetPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorBanner(null);
    setSuccessBanner(null);
    const cleanOtp = resetOtp.trim();
    const cleanTotp = resetTotpCode.trim();
    const cleanNewPassword = newPassword.trim();
    const cleanConfirmPassword = confirmNewPassword.trim();
    if (!/^\d{6}$/.test(cleanOtp)) {
      setErrorBanner('Enter the 6-digit SMS OTP sent to your registered mobile.');
      return;
    }
    if (resetTotpRequired && !cleanTotp) {
      setErrorBanner(
        'Enter your 6-digit Google Authenticator code or an unused recovery code.'
      );
      return;
    }
    if (
      cleanNewPassword.length < 12 ||
      !/[A-Z]/.test(cleanNewPassword) ||
      !/[a-z]/.test(cleanNewPassword) ||
      !/[0-9]/.test(cleanNewPassword) ||
      !/[^A-Za-z0-9]/.test(cleanNewPassword)
    ) {
      setErrorBanner(
        'Strong Password Policy requires at least 12 characters with uppercase, lowercase, number, and symbol.'
      );
      return;
    }
    if (cleanNewPassword !== cleanConfirmPassword) {
      setErrorBanner('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await securityRequest('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({
          challengeId: resetChallengeId,
          otp: cleanOtp,
          ...(resetTotpRequired ? { totpCode: cleanTotp } : {}),
          newPassword: cleanNewPassword,
          confirmPassword: cleanConfirmPassword,
        }),
      });
      const resetOkMsg =
        'Password Reset Successful. All prior sessions were signed out. Log in cleanly with your new password.';
      onShowToast('success', 'Password Reset Successful', resetOkMsg);
      setSuccessBanner(resetOkMsg);
      setUserId(resetUserId.trim());
      setPassword('');
      clearOtpChallengeState();
      setResetChallengeId('');
      setResetMaskedMobile('');
      setResetTotpRequired(false);
      setResetOtp('');
      setResetTotpCode('');
      setResetResendCooldown(0);
      setNewPassword('');
      setConfirmNewPassword('');
      setShowResetNewPassword(false);
      setShowResetConfirmPassword(false);
      setStep('step1');
      void fetchFreshCaptcha(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Password reset failed.';
      setErrorBanner(msg);
      onShowToast('error', 'Password Reset Failed', msg);
    } finally {
      setLoading(false);
    }
  };

  const currentStepNum =
    step === 'step1'
      ? 1
      : step === 'totp' || step === 'recovery-codes-backup'
        ? 2
        : 0;

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950 flex flex-col justify-center py-10 px-4 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center">
          <BrandLogo size="lg" className="justify-center" />
        </div>
        <h1 className="mt-5 text-center text-2xl font-bold tracking-tight text-neutral-950 dark:text-white">
          Authenticated Portal
        </h1>

        {currentStepNum > 0 && (
          <div className="mt-6 grid grid-cols-2 gap-2" aria-label="2-step authentication progress">
            {STEP_LABELS.map((item) => {
              const done = currentStepNum > item.num;
              const active = currentStepNum === item.num;
              return (
                <div
                  key={item.key}
                  className={`rounded-lg px-3 py-2 text-center border transition-colors ${
                    active
                      ? 'bg-neutral-950 text-white border-neutral-950 dark:bg-white dark:text-neutral-950 dark:border-white'
                      : done
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
                        : 'bg-white text-neutral-400 border-neutral-200 dark:bg-neutral-900 dark:text-neutral-500 dark:border-neutral-800'
                  }`}
                >
                  <div className="text-[10px] font-bold">
                    {done ? '✓' : `0${item.num}`}
                  </div>
                  <div className="text-[11px] font-medium truncate mt-0.5">{item.title}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-6 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl shadow-sm p-6 sm:p-8">
          {errorBanner && (
            <div
              role="alert"
              className="mb-5 p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300 flex items-start gap-2"
            >
              <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{errorBanner}</span>
            </div>
          )}

          {successBanner && step === 'step1' && (
            <div
              role="status"
              className="mb-5 p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-200 flex items-start gap-2"
            >
              <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{successBanner}</span>
            </div>
          )}

          {/* STEP 1: UNIFIED CREDENTIALS + CAPTCHA + OTP */}
          {step === 'step1' && (
            <form onSubmit={handleStep1Submit} className="space-y-4">
              <div>
                <h2 className="text-base font-semibold text-neutral-950 dark:text-white">
                  Step 1: Account Credentials
                </h2>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                  Verify your User ID, password, security CAPTCHA, and SMS OTP.
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1.5">
                  User ID or Registered Email
                </label>
                <div className="relative">
                  <User className="h-4 w-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    required
                    autoComplete="username"
                    value={userId}
                    onChange={(e) => {
                      setUserId(e.target.value);
                      if (challengeId) clearOtpChallengeState();
                    }}
                    placeholder="e.g. MC2627110001"
                    className="w-full h-10 pl-9 pr-3 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:border-neutral-950 dark:focus:border-white"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <Lock className="h-4 w-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (challengeId) clearOtpChallengeState();
                    }}
                    placeholder="Enter your password"
                    className="w-full h-10 pl-9 pr-10 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:border-neutral-950 dark:focus:border-white"
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 cursor-pointer"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {/* SVG CAPTCHA right below Password */}
              <div className="p-3.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                    SVG CAPTCHA
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loading || sendingOtp}
                    onClick={() => void handleRefreshCaptcha(false)}
                    icon={<RefreshCw className="h-3.5 w-3.5" />}
                  >
                    Refresh
                  </Button>
                </div>
                {captchaData ? (
                  <div
                    className="rounded border border-neutral-200 dark:border-neutral-700 overflow-hidden bg-white flex justify-center"
                    dangerouslySetInnerHTML={{ __html: captchaData.svg }}
                  />
                ) : (
                  <div className="h-12 rounded border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 flex items-center justify-center text-xs text-neutral-400">
                    Loading CAPTCHA...
                  </div>
                )}
                <input
                  type="text"
                  maxLength={8}
                  disabled={Boolean(challengeId)}
                  value={captchaAnswer}
                  onChange={(e) => setCaptchaAnswer(e.target.value.replace(/\s+/g, '').toUpperCase())}
                  placeholder={
                    challengeId
                      ? 'CAPTCHA verified for active OTP'
                      : captchaData?.questionHint || 'Enter verification code'
                  }
                  className="w-full h-10 px-3 text-center text-sm tracking-[0.25em] font-mono uppercase bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:border-neutral-950 dark:focus:border-white disabled:opacity-60"
                />
              </div>

              {/* OTP Verification right below CAPTCHA */}
              <div className="p-3.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300 block">
                      OTP Verification
                    </span>
                    {maskedMobile && (
                      <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                        Sent to <span className="font-mono font-medium">{maskedMobile}</span>
                      </span>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={sendingOtp}
                    disabled={loading || (Boolean(challengeId) && resendCooldown > 0)}
                    onClick={() => void handleSendOrResendOtp()}
                  >
                    {!challengeId
                      ? 'Send OTP'
                      : resendCooldown > 0
                        ? `Resend in ${resendCooldown}s`
                        : 'Resend OTP'}
                  </Button>
                </div>

                {sandboxOtp && (
                  <div className="p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-200">
                    Bootstrap OTP Preview (Fast2SMS key not configured yet):{' '}
                    <span className="font-mono font-bold tracking-widest">{sandboxOtp}</span>
                  </div>
                )}

                <div className="relative">
                  <Smartphone className="h-4 w-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    maxLength={6}
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="Enter 6-digit OTP code"
                    className="w-full h-10 pl-9 pr-3 text-center text-base tracking-[0.35em] font-mono bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:border-neutral-950 dark:focus:border-white"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between text-xs pt-1">
                <label className="inline-flex items-center gap-2 text-neutral-600 dark:text-neutral-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="rounded border-neutral-300 dark:border-neutral-700"
                  />
                  <span>Remember session (up to 4 hrs)</span>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setErrorBanner(null);
                    setSuccessBanner(null);
                    setResetUserId(userId.trim());
                    setResetChallengeId('');
                    setResetMaskedMobile('');
                    setResetTotpRequired(false);
                    setResetOtp('');
                    setResetTotpCode('');
                    setNewPassword('');
                    setConfirmNewPassword('');
                    setStep('forgot-password');
                  }}
                  className="font-medium text-neutral-700 dark:text-neutral-300 hover:underline cursor-pointer"
                >
                  Forgot Password?
                </button>
              </div>

              <Button
                type="submit"
                variant="primary"
                className="w-full justify-center"
                loading={loading}
                disabled={sendingOtp}
                iconRight={<ArrowRight className="h-4 w-4" />}
              >
                Verify &amp; Proceed to Step 2
              </Button>
            </form>
          )}

          {/* STEP 2: ACCOUNT CREDENTIALS — GOOGLE AUTHENTICATOR (TOTP) OR RECOVERY CODE */}
          {step === 'totp' && (
            <form onSubmit={handleStep2Submit} className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold text-neutral-950 dark:text-white">
                    Step 2: Account Credentials
                  </h2>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                    {requiresTotpSetup
                      ? 'Google Authenticator — first-time mandatory setup'
                      : 'Google Authenticator — enter your 6-digit verification code'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={resetToStep1}
                  className="text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-white inline-flex items-center gap-1 cursor-pointer"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </button>
              </div>

              {requiresTotpSetup && (
                <div className="p-4 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl space-y-3 text-center">
                  <p className="text-xs text-neutral-600 dark:text-neutral-300">
                    Scan with Google Authenticator (<span className="font-mono">{accountLabel}</span>):
                  </p>
                  {qrCodeDataUrl && (
                    <div className="inline-block p-2 bg-white rounded-lg border border-neutral-200">
                      <img
                        src={qrCodeDataUrl}
                        alt="Google Authenticator QR Code"
                        className="w-40 h-40 mx-auto"
                      />
                    </div>
                  )}
                  {manualSecret && (
                    <div className="space-y-1 text-left">
                      <span className="text-[11px] text-neutral-500 block">Manual Setup Key (Base32):</span>
                      <div className="flex items-center gap-1.5">
                        <div className="flex-1 font-mono text-[11px] font-bold bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded px-2.5 py-1.5 truncate select-all">
                          {manualSecret}
                        </div>
                        <button
                          type="button"
                          onClick={handleCopyManualSecret}
                          className="h-8 px-2.5 text-xs rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 hover:bg-neutral-100 inline-flex items-center gap-1 cursor-pointer"
                        >
                          {secretCopied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {!useRecoveryMode ? (
                <div>
                  <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1.5">
                    6-Digit Google Authenticator Code
                  </label>
                  <div className="relative">
                    <ShieldCheck className="h-4 w-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      required
                      autoFocus
                      maxLength={6}
                      value={totpCode}
                      onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="000000"
                      className="w-full h-11 pl-9 pr-3 text-center text-lg tracking-[0.4em] font-mono bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:border-neutral-950 dark:focus:border-white"
                    />
                  </div>
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1.5">
                    Single-Use Recovery Code
                  </label>
                  <div className="relative">
                    <KeyRound className="h-4 w-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      required
                      autoFocus
                      maxLength={12}
                      value={recoveryCodeInput}
                      onChange={(e) => setRecoveryCodeInput(e.target.value.toUpperCase())}
                      placeholder="XXXX-XXXX"
                      className="w-full h-11 pl-9 pr-3 text-center text-base tracking-[0.2em] font-mono uppercase bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:border-neutral-950 dark:focus:border-white"
                    />
                  </div>
                </div>
              )}

              {!requiresTotpSetup && (
                <div className="text-right">
                  <button
                    type="button"
                    onClick={() => {
                      setErrorBanner(null);
                      setUseRecoveryMode((prev) => !prev);
                    }}
                    className="text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:underline cursor-pointer"
                  >
                    {useRecoveryMode
                      ? 'Use 6-digit Authenticator Code instead'
                      : 'Lost device? Use a Recovery Code'}
                  </button>
                </div>
              )}

              <Button
                type="submit"
                variant="primary"
                className="w-full justify-center"
                loading={loading}
                iconRight={<CheckCircle2 className="h-4 w-4" />}
              >
                {requiresTotpSetup ? 'Activate Authenticator & Sign In' : 'Verify & Open Dashboard'}
              </Button>
            </form>
          )}

          {/* STEP 2B: RECOVERY CODES ONE-TIME DOWNLOAD SCREEN */}
          {step === 'recovery-codes-backup' && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-5 w-5 shrink-0" />
                <h2 className="text-base font-semibold">Save Your Single-Use Recovery Codes</h2>
              </div>
              <p className="text-xs text-neutral-600 dark:text-neutral-300">
                Google Authenticator is now linked. These 8 recovery codes are shown only once—download them in case you lose your authenticator phone.
              </p>

              <div className="grid grid-cols-2 gap-2 p-3 rounded-xl bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 font-mono text-xs font-semibold text-center">
                {issuedRecoveryCodes.map((code) => (
                  <div
                    key={code}
                    className="py-1.5 px-2 rounded bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 select-all"
                  >
                    {code}
                  </div>
                ))}
              </div>

              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1 justify-center"
                  onClick={handleDownloadRecoveryCodes}
                  icon={<Download className="h-4 w-4" />}
                >
                  Download .TXT
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  className="flex-1 justify-center"
                  onClick={handleFinishRecoveryBackup}
                  iconRight={<ArrowRight className="h-4 w-4" />}
                >
                  Continue to ERP
                </Button>
              </div>
            </div>
          )}

          {/* FORGOT PASSWORD */}
          {step === 'forgot-password' && (
            <form onSubmit={handleForgotSubmit} className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-neutral-950 dark:text-white">
                  Reset Password
                </h2>
                <button
                  type="button"
                  onClick={() => {
                    setErrorBanner(null);
                    setStep('step1');
                  }}
                  className="text-xs text-neutral-500 hover:underline inline-flex items-center gap-1 cursor-pointer"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </button>
              </div>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                Receive an SMS OTP on your registered mobile to reset your password.
              </p>
              <input
                type="text"
                required
                value={resetUserId}
                onChange={(e) => setResetUserId(e.target.value)}
                placeholder="Enter User ID or Email"
                className="w-full h-10 px-3 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-lg"
              />
              <Button type="submit" variant="primary" className="w-full justify-center" loading={loading}>
                Send Password Reset OTP
              </Button>
            </form>
          )}

          {/* RESET PASSWORD */}
          {step === 'reset-password' && (
            <form onSubmit={handleResetPasswordSubmit} className="space-y-3.5">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-neutral-950 dark:text-white">
                  Complete Password Reset
                </h2>
                <button
                  type="button"
                  onClick={() => {
                    setErrorBanner(null);
                    setSandboxOtp(null);
                    setResetResendCooldown(0);
                    setStep('step1');
                  }}
                  className="text-xs text-neutral-500 hover:underline cursor-pointer"
                >
                  Cancel
                </button>
              </div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  OTP sent to <span className="font-mono font-medium">{resetMaskedMobile}</span>
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  loading={resendingResetOtp}
                  disabled={loading || resetResendCooldown > 0}
                  onClick={() => void handleResendResetOtp()}
                >
                  {resetResendCooldown > 0 ? `Resend in ${resetResendCooldown}s` : 'Resend OTP'}
                </Button>
              </div>
              {sandboxOtp && (
                <div className="p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-200">
                  Sandbox OTP Preview: <span className="font-mono font-bold tracking-wider">{sandboxOtp}</span>
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  6-Digit SMS OTP
                </label>
                <input
                  type="text"
                  required
                  maxLength={6}
                  value={resetOtp}
                  onChange={(e) => setResetOtp(e.target.value.replace(/\D/g, ''))}
                  placeholder="Enter 6-digit SMS OTP"
                  className="w-full h-10 px-3 text-sm font-mono tracking-[0.25em] text-center bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:border-neutral-950 dark:focus:border-white"
                />
              </div>
              {resetTotpRequired && (
                <div>
                  <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                    Google Authenticator Code or Recovery Code (Required)
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={16}
                    value={resetTotpCode}
                    onChange={(e) => setResetTotpCode(e.target.value.trim().toUpperCase())}
                    placeholder="6-digit Authenticator Code or XXXX-XXXX"
                    className="w-full h-10 px-3 text-sm font-mono bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:border-neutral-950 dark:focus:border-white"
                  />
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  New Strong Password
                </label>
                <div className="relative">
                  <input
                    type={showResetNewPassword ? 'text' : 'password'}
                    required
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="12+ chars (A-Z, a-z, 0-9, symbol)"
                    className="w-full h-10 pl-3 pr-10 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:border-neutral-950 dark:focus:border-white"
                  />
                  <button
                    type="button"
                    aria-label={showResetNewPassword ? 'Hide new password' : 'Show new password'}
                    onClick={() => setShowResetNewPassword((prev) => !prev)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 cursor-pointer"
                  >
                    {showResetNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  Confirm New Password
                </label>
                <div className="relative">
                  <input
                    type={showResetConfirmPassword ? 'text' : 'password'}
                    required
                    value={confirmNewPassword}
                    onChange={(e) => setConfirmNewPassword(e.target.value)}
                    placeholder="Confirm new password"
                    className="w-full h-10 pl-3 pr-10 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:border-neutral-950 dark:focus:border-white"
                  />
                  <button
                    type="button"
                    aria-label={
                      showResetConfirmPassword ? 'Hide confirm password' : 'Show confirm password'
                    }
                    onClick={() => setShowResetConfirmPassword((prev) => !prev)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 cursor-pointer"
                  >
                    {showResetConfirmPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
              <div className="p-3 rounded-lg bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 space-y-1">
                <p className="text-[11px] font-semibold text-neutral-700 dark:text-neutral-300">
                  Strong Password Policy (Last 5 Passwords Blocked)
                </p>
                <div className="grid grid-cols-2 gap-1 text-[11px]">
                  {[
                    { label: '12+ characters', ok: newPassword.trim().length >= 12 },
                    { label: 'Uppercase (A-Z)', ok: /[A-Z]/.test(newPassword.trim()) },
                    { label: 'Lowercase (a-z)', ok: /[a-z]/.test(newPassword.trim()) },
                    { label: 'Number (0-9)', ok: /[0-9]/.test(newPassword.trim()) },
                    { label: 'Special symbol', ok: /[^A-Za-z0-9]/.test(newPassword.trim()) },
                    {
                      label: 'Passwords match',
                      ok:
                        newPassword.trim().length > 0 &&
                        newPassword.trim() === confirmNewPassword.trim(),
                    },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className={`flex items-center gap-1 ${
                        item.ok
                          ? 'text-emerald-700 dark:text-emerald-400 font-medium'
                          : 'text-neutral-500 dark:text-neutral-400'
                      }`}
                    >
                      <Check className={`h-3 w-3 shrink-0 ${item.ok ? 'opacity-100' : 'opacity-35'}`} />
                      <span>{item.label}</span>
                    </div>
                  ))}
                </div>
              </div>
              <Button type="submit" variant="primary" className="w-full justify-center" loading={loading}>
                Save Password &amp; Revoke Old Sessions
              </Button>
            </form>
          )}
        </div>

        <footer className="mt-6 text-center text-[11px] text-neutral-500 dark:text-neutral-400 space-y-1">
          <p>{BRAND.copyright} All rights reserved.</p>
          <p className="font-mono tabular-nums">
            v{BRAND.version} · Updated {BRAND.builtAtLabel}
          </p>
        </footer>
      </div>
    </div>
  );
};
