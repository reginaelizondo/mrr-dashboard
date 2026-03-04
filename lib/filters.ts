import type { MrrDailySnapshot, Source, Region, PlanType, DatePreset } from '@/types';
import { subMonths, format } from 'date-fns';

// ─── Active Filters ──────────────────────────────────────────────
export interface ActiveFilters {
  sources: Source[];
  regions: Region[];
  plans: PlanType[];
}

// Field mappings for each dimension
const SOURCE_GROSS_FIELDS: Record<Source, keyof MrrDailySnapshot> = {
  apple: 'mrr_apple_gross',
  google: 'mrr_google_gross',
  stripe: 'mrr_stripe_gross',
};

const SOURCE_NET_FIELDS: Record<Source, keyof MrrDailySnapshot> = {
  apple: 'mrr_apple_net',
  google: 'mrr_google_net',
  stripe: 'mrr_stripe_net',
};

const REGION_FIELDS: Record<Region, keyof MrrDailySnapshot> = {
  us_canada: 'mrr_us_canada',
  mexico: 'mrr_mexico',
  brazil: 'mrr_brazil',
  rest_of_world: 'mrr_rest_of_world',
};

const PLAN_FIELDS: Record<PlanType, keyof MrrDailySnapshot> = {
  monthly: 'mrr_monthly',
  yearly: 'mrr_yearly',
  semesterly: 'mrr_semesterly',
  quarterly: 'mrr_quarterly',
  weekly: 'mrr_weekly',
  lifetime: 'mrr_lifetime',
  other: 'mrr_other',
};

const ALL_SOURCES: Source[] = ['apple', 'google', 'stripe'];
const ALL_REGIONS: Region[] = ['us_canada', 'mexico', 'brazil', 'rest_of_world'];
const ALL_PLANS: PlanType[] = ['monthly', 'yearly', 'semesterly', 'quarterly', 'weekly', 'lifetime', 'other'];

/**
 * Apply dimension filters to snapshot data.
 * Empty array = "all selected" (no filtering for that dimension).
 * Source filter recomputes mrr_gross/mrr_net from selected sub-fields.
 * Region/Plan filters zero-out non-selected sub-fields.
 */
export function applyFilters(
  snapshots: MrrDailySnapshot[],
  filters: ActiveFilters
): MrrDailySnapshot[] {
  const { sources, regions, plans } = filters;

  // No filters active — return data unchanged
  if (sources.length === 0 && regions.length === 0 && plans.length === 0) {
    return snapshots;
  }

  return snapshots.map((snapshot) => {
    const filtered = { ...snapshot };

    // Recompute gross/net from selected sources
    if (sources.length > 0) {
      filtered.mrr_gross = sources.reduce(
        (sum, s) => sum + Number(snapshot[SOURCE_GROSS_FIELDS[s]] || 0), 0
      );
      filtered.mrr_net = sources.reduce(
        (sum, s) => sum + Number(snapshot[SOURCE_NET_FIELDS[s]] || 0), 0
      );
      filtered.total_commissions = filtered.mrr_gross - filtered.mrr_net;

      // Zero out excluded source fields
      for (const src of ALL_SOURCES) {
        if (!sources.includes(src)) {
          (filtered as Record<string, unknown>)[SOURCE_GROSS_FIELDS[src]] = 0;
          (filtered as Record<string, unknown>)[SOURCE_NET_FIELDS[src]] = 0;
        }
      }
    }

    // Zero out excluded region fields
    if (regions.length > 0) {
      for (const reg of ALL_REGIONS) {
        if (!regions.includes(reg)) {
          (filtered as Record<string, unknown>)[REGION_FIELDS[reg]] = 0;
        }
      }
    }

    // Zero out excluded plan fields
    if (plans.length > 0) {
      for (const plan of ALL_PLANS) {
        if (!plans.includes(plan)) {
          (filtered as Record<string, unknown>)[PLAN_FIELDS[plan]] = 0;
        }
      }
    }

    return filtered;
  });
}

// ─── Parse URL params ────────────────────────────────────────────

function parseCommaSeparated<T extends string>(value: string | null): T[] {
  if (!value) return [];
  return value.split(',').filter(Boolean) as T[];
}

export function parseFiltersFromParams(searchParams: URLSearchParams): ActiveFilters {
  return {
    sources: parseCommaSeparated<Source>(searchParams.get('sources')),
    regions: parseCommaSeparated<Region>(searchParams.get('regions')),
    plans: parseCommaSeparated<PlanType>(searchParams.get('plans')),
  };
}

// ─── Date Preset Utilities ───────────────────────────────────────

export function getPresetDates(preset: DatePreset): { start: string; end: string } {
  const today = new Date();
  const end = format(today, 'yyyy-MM-dd');
  const year = today.getFullYear();
  const month = today.getMonth(); // 0-indexed

  switch (preset) {
    case 'this_month':
      return { start: format(new Date(year, month, 1), 'yyyy-MM-dd'), end };
    case 'last_month': {
      const lastMonth = subMonths(today, 1);
      return {
        start: format(new Date(lastMonth.getFullYear(), lastMonth.getMonth(), 1), 'yyyy-MM-dd'),
        end: format(new Date(year, month, 0), 'yyyy-MM-dd'), // last day of prev month
      };
    }
    case '3m':
      return { start: format(subMonths(today, 3), 'yyyy-MM-dd'), end };
    case '6m':
      return { start: format(subMonths(today, 6), 'yyyy-MM-dd'), end };
    case '12m':
      return { start: format(subMonths(today, 12), 'yyyy-MM-dd'), end };
    case 'ytd':
      return { start: `${year}-01-01`, end };
    case 'all':
      return { start: '2024-01-01', end };
    case 'custom':
      // Custom doesn't compute — caller provides start/end
      return { start: format(subMonths(today, 12), 'yyyy-MM-dd'), end };
  }
}

// ─── Compute Totals (pure function) ─────────────────────────────

function sumField(snapshots: MrrDailySnapshot[], field: keyof MrrDailySnapshot): number {
  return snapshots.reduce((sum, s) => sum + Number(s[field] || 0), 0);
}

/**
 * Compute display totals from monthly snapshots.
 * SUMS all months in the range (accumulated totals).
 */
export function computeTotals(snapshots: MrrDailySnapshot[]) {
  if (snapshots.length === 0) {
    return {
      gross: 0,
      net: 0,
      commissions: 0,
      taxes: 0,
      refunds: 0,
      disputes: 0,
      newSubs: 0,
      renewals: 0,
      refundCount: 0,
      activeSubs: 0,
      lostSubs: 0,
    };
  }

  // Calculate lost subscriptions from month-over-month active sub changes
  let totalLost = 0;
  for (let i = 1; i < snapshots.length; i++) {
    const prevActive = Number(snapshots[i - 1].active_subscriptions || 0);
    const currActive = Number(snapshots[i].active_subscriptions || 0);
    const currNew = Number(snapshots[i].new_subscriptions || 0);
    // Lost = previous active + new this month - current active
    // (if you had 1000 active, got 200 new, but now have 1050, you lost 150)
    const lost = Math.max(0, prevActive + currNew - currActive);
    totalLost += lost;
  }

  // Latest month's active subs
  const latestActive = Number(snapshots[snapshots.length - 1].active_subscriptions || 0);

  return {
    gross: sumField(snapshots, 'mrr_gross'),
    net: sumField(snapshots, 'mrr_net'),
    commissions: sumField(snapshots, 'total_commissions'),
    taxes: sumField(snapshots, 'total_taxes'),
    refunds: sumField(snapshots, 'total_refunds'),
    disputes: sumField(snapshots, 'total_disputes'),
    newSubs: sumField(snapshots, 'new_subscriptions'),
    renewals: sumField(snapshots, 'renewals'),
    refundCount: sumField(snapshots, 'refund_count'),
    activeSubs: latestActive,
    lostSubs: totalLost,
  };
}

// ─── Period Label ────────────────────────────────────────────────

/**
 * Generate a human-readable label describing the date range.
 * e.g. "Nov 2025 – Jan 2026" or "Jan 2026" if single month.
 */
export function getPeriodLabel(snapshots: MrrDailySnapshot[]): string {
  if (snapshots.length === 0) return '';
  const first = snapshots[0].snapshot_date;
  const last = snapshots[snapshots.length - 1].snapshot_date;

  const fmtMonth = (dateStr: string) => {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  };

  if (first === last) return fmtMonth(first);
  return `${fmtMonth(first)} – ${fmtMonth(last)}`;
}
