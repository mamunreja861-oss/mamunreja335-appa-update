export function formatINR(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(safe);
}

export function formatDateIST(input: string | Date | null | undefined): string {
  if (!input) return '—';
  // If already DD/MM/YYYY
  if (typeof input === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(input.trim())) {
    return input.trim();
  }
  const date = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return String(input);

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(date);

  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const y = parts.find((p) => p.type === 'year')?.value ?? '2026';
  return `${d}/${m}/${y}`;
}

export function formatDateTimeIST(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const date = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return String(input);

  const dateStr = formatDateIST(date);
  const timeStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);

  return `${dateStr} ${timeStr} IST`;
}

export function getTodayIsoIST(offsetDays = 0): string {
  const target = new Date(Date.now() + offsetDays * 86_400_000);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(target);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    // Fallback to UTC ISO
  }
  return target.toISOString().slice(0, 10);
}

export function getCurrentFyLabelIST(date = new Date()): string {
  const iso = getTodayIsoIST(0);
  const [yStr, mStr] = iso.split('-');
  const y = Number(yStr) || date.getFullYear();
  const m = Number(mStr) || date.getMonth() + 1;
  const startYear = m >= 4 ? y : y - 1;
  const endShort = String(startYear + 1).slice(-2);
  return `FY ${startYear}–${endShort}`;
}

