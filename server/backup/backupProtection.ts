export interface RetryProtectionOptions {
  maxRetries: number;
  baseDelayMs: number;
  timeoutMs: number;
  onRetry?: (attempt: number, error: Error, nextDelayMs: number) => void | Promise<void>;
}

export interface RetryProtectionOutcome<T> {
  value: T;
  attempts: number;
}

export function isTransientBackupError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (
    msg.includes('permission denied') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('invalid argument') ||
    msg.includes('confirm restore') ||
    msg.includes('lock held') ||
    msg.includes('not configured')
  ) {
    return false;
  }
  return true;
}

export async function withTimeout<T>(
  promiseFactory: () => Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  const effectiveTimeout = Math.max(10, timeoutMs);
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promiseFactory(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timeout after ${effectiveTimeout}ms during ${label}`));
        }, effectiveTimeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function executeWithRetryBackoff<T>(
  label: string,
  operation: (attempt: number) => Promise<T>,
  options: RetryProtectionOptions
): Promise<RetryProtectionOutcome<T>> {
  const maxRetries = Math.max(0, options.maxRetries);
  const baseDelayMs = Math.max(1, options.baseDelayMs);
  let lastError: Error = new Error(`${label} failed`);

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    try {
      const value = await withTimeout(
        () => operation(attempt),
        options.timeoutMs,
        `${label} (attempt ${attempt})`
      );
      return { value, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const canRetry = attempt <= maxRetries && isTransientBackupError(lastError);
      if (!canRetry) {
        throw Object.assign(lastError, { attempts: attempt });
      }
      const jitterMs = Math.min(25, Math.floor(baseDelayMs * 0.2));
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1) + jitterMs;
      await options.onRetry?.(attempt, lastError, delayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export function formatIstParts(date: Date = new Date()): {
  year: string;
  month: string;
  day: string;
  timestampFolder: string;
  isoIst: string;
} {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value])
  );
  const year = parts.year || '2026';
  const month = parts.month || '01';
  const day = parts.day || '01';
  const hour = parts.hour === '24' ? '00' : parts.hour || '00';
  const minute = parts.minute || '00';
  const second = parts.second || '00';
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  const timestampFolder = `${year}${month}${day}T${hour}${minute}${second}${ms}IST`;
  const isoIst = `${year}-${month}-${day}T${hour}:${minute}:${second}+05:30`;
  return { year, month, day, timestampFolder, isoIst };
}

export function computeNextIstScheduleRun(hourIst: number, minuteIst: number, now: Date = new Date()): {
  nextRunIst: string;
  nextRunUtc: string;
} {
  // IST is fixed UTC+05:30
  const istOffsetMs = (5 * 60 + 30) * 60 * 1000;
  const nowIstMs = now.getTime() + istOffsetMs;
  const nowIstDate = new Date(nowIstMs);
  const targetIstMsToday = Date.UTC(
    nowIstDate.getUTCFullYear(),
    nowIstDate.getUTCMonth(),
    nowIstDate.getUTCDate(),
    hourIst,
    minuteIst,
    0,
    0
  );
  const targetIstMs =
    targetIstMsToday > nowIstMs ? targetIstMsToday : targetIstMsToday + 24 * 60 * 60 * 1000;
  const targetUtcDate = new Date(targetIstMs - istOffsetMs);
  const targetIstParts = formatIstParts(targetUtcDate);
  const hh = String(hourIst).padStart(2, '0');
  const mm = String(minuteIst).padStart(2, '0');
  return {
    nextRunIst: `${targetIstParts.year}-${targetIstParts.month}-${targetIstParts.day} ${hh}:${mm}:00 IST`,
    nextRunUtc: targetUtcDate.toISOString(),
  };
}
