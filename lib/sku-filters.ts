/**
 * Filters, date presets and period grain for the SKU Breakdown tab. Pure helpers
 * (no server imports) so both the page and the client components can use them.
 */

export type SkuPreset = '3m' | '6m' | '12m' | 'ytd' | '18m' | '24m' | 'all' | 'custom';
export type SkuGrain = 'month' | 'quarter' | 'year';

export type SkuFilters = {
  sources: string[]; // apple | google | stripe
  regions: string[]; // us_canada | mexico | brazil | rest_of_world
  countries: string[]; // ISO-2 country_code
};

export type SkuDimOption = { value: string; n: number };
export type SkuDims = { regions: SkuDimOption[]; countries: SkuDimOption[] };

export const SKU_PRESETS: { v: Exclude<SkuPreset, 'custom'>; label: string }[] = [
  { v: '3m', label: '3m' },
  { v: '6m', label: '6m' },
  { v: '12m', label: '12m' },
  { v: 'ytd', label: 'YTD' },
  { v: '18m', label: '18m' },
  { v: '24m', label: '24m' },
  { v: 'all', label: 'All' },
];
export const SKU_GRAINS: { v: SkuGrain; label: string }[] = [
  { v: 'month', label: 'Month' },
  { v: 'quarter', label: 'Quarter' },
  { v: 'year', label: 'Year' },
];

const FIRST_MONTH = '2024-01';

/** 'YYYY-MM' + delta months, string-based (timezone-safe). */
export function addMonthsYM(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

export function currentYM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Resolve the month window ('YYYY-MM' inclusive) from URL params. Default: 18 months ending now. */
export function resolveSkuRange(params: { preset?: string; start?: string; end?: string }): {
  preset: SkuPreset;
  start: string;
  end: string;
} {
  const now = currentYM();
  const isYM = (s?: string) => !!s && /^\d{4}-\d{2}$/.test(s);
  if (params.preset === 'custom' && isYM(params.start) && isYM(params.end) && params.start! <= params.end!) {
    return { preset: 'custom', start: params.start!, end: params.end! };
  }
  const preset = (['3m', '6m', '12m', 'ytd', '18m', '24m', 'all'].includes(params.preset || '') ? params.preset : '18m') as Exclude<SkuPreset, 'custom'>;
  let start: string;
  switch (preset) {
    case '3m': start = addMonthsYM(now, -2); break;
    case '6m': start = addMonthsYM(now, -5); break;
    case '12m': start = addMonthsYM(now, -11); break;
    case 'ytd': start = `${now.slice(0, 4)}-01`; break;
    case '24m': start = addMonthsYM(now, -23); break;
    case 'all': start = FIRST_MONTH; break;
    default: start = addMonthsYM(now, -17);
  }
  if (start < FIRST_MONTH) start = FIRST_MONTH;
  return { preset, start, end: now };
}

export function resolveSkuGrain(g?: string): SkuGrain {
  return g === 'quarter' || g === 'year' ? g : 'month';
}

function list(v?: string): string[] {
  return (v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function parseSkuFilters(params: { sources?: string; regions?: string; countries?: string }): SkuFilters {
  return { sources: list(params.sources), regions: list(params.regions), countries: list(params.countries) };
}

export function hasSkuFilters(f: SkuFilters): boolean {
  return f.sources.length + f.regions.length + f.countries.length > 0;
}

// ─── Period buckets (client-side aggregation of monthly series) ──────────────

/** Bucket key for a 'YYYY-MM-01' month: the month itself, 'YYYY-Qn' or 'YYYY'. */
export function bucketKey(month: string, grain: SkuGrain): string {
  if (grain === 'month') return month;
  const y = month.slice(0, 4);
  if (grain === 'year') return y;
  const m = Number(month.slice(5, 7));
  return `${y}-Q${Math.ceil(m / 3)}`;
}

/** Ordered bucket keys for a month list, plus each month's bucket index. */
export function bucketize(months: string[], grain: SkuGrain): { keys: string[]; idxOf: number[] } {
  const keys: string[] = [];
  const idxOf: number[] = [];
  for (const m of months) {
    const k = bucketKey(m, grain);
    if (keys[keys.length - 1] !== k) keys.push(k);
    idxOf.push(keys.length - 1);
  }
  return { keys, idxOf };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Axis label for a bucket key or month ('Oct 26', 'Q4 26', '2026'). */
export function fmtPeriod(key: string): string {
  if (/^\d{4}$/.test(key)) return key;
  if (/^\d{4}-Q\d$/.test(key)) return `${key.slice(5)} ${key.slice(2, 4)}`;
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[(m || 1) - 1]} ${String(y).slice(2)}`;
}

/** Human label for a country code via the browser's Intl (falls back to the code on the server). */
export function countryLabel(code: string): string {
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'region' });
    return dn.of(code) || code;
  } catch {
    return code;
  }
}
