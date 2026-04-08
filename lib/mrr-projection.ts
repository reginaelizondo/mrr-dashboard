import type { MrrDailySnapshot } from '@/types';

/**
 * MRR projection for "stale" month snapshots.
 *
 * Problem: `mrr_daily_snapshots` stores one row per month, computed once and
 * rarely re-run. For the current month and the last month or two, the stored
 * value undercounts because Apple/Google/Stripe transactions land late.
 * Example seen in production: Mar 2026 snapshot was computed 2026-03-03 with
 * just 2 days of data ($418k), while the settled value (seen in Tableau)
 * is ~$493k. The mature months (computed 20+ days after their month end)
 * are reliable.
 *
 * Approach: detect which months are mature vs stale by comparing
 * `computed_at` against month_end, then project the stale months forward
 * from the most recent mature month using the trailing MoM growth rate.
 *
 * This is intentionally simple (no data-arrival-curve fitting). It assumes
 * the business keeps compounding at a similar rate to the recent past.
 * Reported as a separate "projected" value so the user always sees both.
 */

const MATURE_BUFFER_DAYS = 20;       // a month is "settled" 20 wall-clock days after month end
const TREND_WINDOW_MONTHS = 3;       // compute avg MoM growth over last N mature months

export interface ProjectedMonth {
  snapshot_date: string;             // YYYY-MM-01
  mrr_gross_actual: number;          // the stored snapshot value
  mrr_net_actual: number;
  mrr_gross_projected: number;       // our estimate of the true final
  mrr_net_projected: number;
  is_stale: boolean;                 // true if the snapshot is not yet mature
  maturity_reason: string;           // human explanation
  computed_at: string | null;
}

export interface ProjectionResult {
  months: ProjectedMonth[];
  latestMatureMonth: string | null;  // e.g. "2026-01"
  avgMoMGrowthGross: number;         // decimal, e.g. 0.084 = +8.4%
  avgMoMGrowthNet: number;
  sampleSize: number;
}

function addMonths(ym: string, n: number): string {
  // ym = YYYY-MM-DD (we always use the 1st)
  const d = new Date(ym + 'T00:00:00Z');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
    .toISOString()
    .slice(0, 10);
}

function isMature(snap: MrrDailySnapshot): boolean {
  // The snapshot_date is the 1st of the target month.
  const [y, m] = snap.snapshot_date.split('-').map(Number);
  const monthEnd = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of target
  const now = new Date();
  const diffDays = (now.getTime() - monthEnd.getTime()) / (1000 * 60 * 60 * 24);
  // Wall-clock based: a month is considered mature if enough calendar time
  // has passed since month end for Apple/Google/Stripe to have reported all
  // of its transactions. We use `now` (not `computed_at`) because a stale
  // snapshot file can be on disk for weeks — what matters is that the
  // calendar has moved past the reporting window for that month.
  return diffDays >= MATURE_BUFFER_DAYS;
}

export function projectMrr(snapshots: MrrDailySnapshot[]): ProjectionResult {
  if (snapshots.length === 0) {
    return {
      months: [],
      latestMatureMonth: null,
      avgMoMGrowthGross: 0,
      avgMoMGrowthNet: 0,
      sampleSize: 0,
    };
  }

  const sorted = [...snapshots].sort((a, b) =>
    a.snapshot_date.localeCompare(b.snapshot_date)
  );

  // Find the latest mature month
  let latestMatureIdx = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (isMature(sorted[i])) {
      latestMatureIdx = i;
      break;
    }
  }

  // Compute avg MoM growth over the last TREND_WINDOW_MONTHS mature months
  // (geometric mean of ratios).
  let avgMoMGross = 0, avgMoMNet = 0, sampleSize = 0;
  if (latestMatureIdx >= 1) {
    const mature = sorted.slice(0, latestMatureIdx + 1).filter(isMature);
    const window = mature.slice(-Math.min(TREND_WINDOW_MONTHS + 1, mature.length));
    let grossProduct = 1, netProduct = 1, count = 0;
    for (let i = 1; i < window.length; i++) {
      const prevG = Number(window[i - 1].mrr_gross);
      const currG = Number(window[i].mrr_gross);
      const prevN = Number(window[i - 1].mrr_net);
      const currN = Number(window[i].mrr_net);
      if (prevG > 0) { grossProduct *= currG / prevG; count++; }
      if (prevN > 0) netProduct *= currN / prevN;
    }
    if (count > 0) {
      avgMoMGross = Math.pow(grossProduct, 1 / count) - 1;
      avgMoMNet = Math.pow(netProduct, 1 / count) - 1;
      sampleSize = count;
    }
  }

  const latestMature = latestMatureIdx >= 0 ? sorted[latestMatureIdx] : null;

  const months: ProjectedMonth[] = sorted.map((s, idx) => {
    const mature = isMature(s);
    let projectedG = Number(s.mrr_gross);
    let projectedN = Number(s.mrr_net);
    let reason = 'Snapshot matured (datos completos)';

    if (!mature) {
      if (latestMature && avgMoMGross > 0) {
        const monthsFromMature = idx - latestMatureIdx;
        // projected = mature_value * (1 + growth)^monthsFromMature
        const factor = Math.pow(1 + avgMoMGross, monthsFromMature);
        projectedG = Number(latestMature.mrr_gross) * factor;
        const factorNet = Math.pow(1 + avgMoMNet, monthsFromMature);
        projectedN = Number(latestMature.mrr_net) * factorNet;
        reason = `Proyectado desde ${latestMature.snapshot_date.slice(0, 7)} aplicando ${(avgMoMGross * 100).toFixed(1)}% MoM (prom. de ${sampleSize} meses maduros)`;
      } else {
        reason = 'Snapshot stale pero no hay suficiente historia madura para proyectar';
      }
    }

    return {
      snapshot_date: s.snapshot_date,
      mrr_gross_actual: Number(s.mrr_gross),
      mrr_net_actual: Number(s.mrr_net),
      mrr_gross_projected: projectedG,
      mrr_net_projected: projectedN,
      is_stale: !mature,
      maturity_reason: reason,
      computed_at: s.computed_at || null,
    };
  });

  return {
    months,
    latestMatureMonth: latestMature ? latestMature.snapshot_date.slice(0, 7) : null,
    avgMoMGrowthGross: avgMoMGross,
    avgMoMGrowthNet: avgMoMNet,
    sampleSize,
  };
}

/** Human-formatted label for a YYYY-MM-DD → "Mar 2026" style month */
export function formatYm(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  return `${months[(m || 1) - 1]} ${y}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Generic per-field projection — used by the secondary charts so every
// metric (MRR per source, per plan, per region, subscription counts, etc.)
// gets a hatched overlay for stale months.
// ───────────────────────────────────────────────────────────────────────────

export const PROJECTED_FIELDS: (keyof MrrDailySnapshot)[] = [
  'mrr_gross',
  'mrr_net',
  'total_commissions',
  'total_refunds',
  'mrr_apple_gross',
  'mrr_apple_net',
  'mrr_google_gross',
  'mrr_google_net',
  'mrr_stripe_gross',
  'mrr_stripe_net',
  'mrr_monthly',
  'mrr_yearly',
  'mrr_semesterly',
  'mrr_quarterly',
  'mrr_weekly',
  'mrr_lifetime',
  'mrr_other',
  'mrr_us_canada',
  'mrr_mexico',
  'mrr_brazil',
  'mrr_rest_of_world',
  'new_subscriptions',
  'renewals',
  'trial_conversions',
  'active_subscriptions',
];

export interface ProjectedField {
  actual: number;
  projected: number;
}

export interface ProjectedRow {
  snapshot_date: string;
  is_stale: boolean;
  fields: Record<string, ProjectedField>;
}

export interface ProjectionBundle {
  rows: Map<string, ProjectedRow>;
  latestMatureMonth: string | null;
  sampleSize: number;
  avgGrowthByField: Record<string, number>;
}

/**
 * Build a per-month projection for every field in PROJECTED_FIELDS.
 * Returns a Map keyed by snapshot_date ("YYYY-MM-01") so charts can
 * overlay "projected extra" on top of the actual bar in O(1) lookups.
 *
 * The projection for each field uses its OWN MoM growth rate computed
 * from the last TREND_WINDOW_MONTHS mature months. This is important
 * because mrr_apple_gross grows differently from active_subscriptions.
 */
export function buildProjectionBundle(snapshots: MrrDailySnapshot[]): ProjectionBundle {
  const empty: ProjectionBundle = {
    rows: new Map(),
    latestMatureMonth: null,
    sampleSize: 0,
    avgGrowthByField: {},
  };
  if (snapshots.length === 0) return empty;

  const sorted = [...snapshots].sort((a, b) =>
    a.snapshot_date.localeCompare(b.snapshot_date)
  );

  // Latest mature month
  let latestMatureIdx = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (isMature(sorted[i])) {
      latestMatureIdx = i;
      break;
    }
  }
  const latestMature = latestMatureIdx >= 0 ? sorted[latestMatureIdx] : null;

  // Per-field MoM growth over the last TREND_WINDOW_MONTHS mature months
  const avgGrowthByField: Record<string, number> = {};
  let sampleSize = 0;
  if (latestMatureIdx >= 1) {
    const mature = sorted.slice(0, latestMatureIdx + 1).filter(isMature);
    const window = mature.slice(-Math.min(TREND_WINDOW_MONTHS + 1, mature.length));
    sampleSize = Math.max(0, window.length - 1);
    for (const field of PROJECTED_FIELDS) {
      let product = 1;
      let count = 0;
      for (let i = 1; i < window.length; i++) {
        const prev = Number(window[i - 1][field] || 0);
        const curr = Number(window[i][field] || 0);
        if (prev > 0) {
          product *= curr / prev;
          count++;
        }
      }
      avgGrowthByField[field as string] = count > 0 ? Math.pow(product, 1 / count) - 1 : 0;
    }
  }

  const rows = new Map<string, ProjectedRow>();
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const mature = isMature(s);
    const fields: Record<string, ProjectedField> = {};
    for (const field of PROJECTED_FIELDS) {
      const actual = Number(s[field] || 0);
      let projected = actual;
      if (!mature && latestMature && latestMatureIdx >= 0) {
        const monthsAhead = i - latestMatureIdx;
        const factor = Math.pow(1 + (avgGrowthByField[field as string] || 0), monthsAhead);
        projected = Number(latestMature[field] || 0) * factor;
      }
      fields[field as string] = { actual, projected };
    }
    rows.set(s.snapshot_date, {
      snapshot_date: s.snapshot_date,
      is_stale: !mature,
      fields,
    });
  }

  return {
    rows,
    latestMatureMonth: latestMature ? latestMature.snapshot_date.slice(0, 7) : null,
    sampleSize,
    avgGrowthByField,
  };
}

/**
 * Convenience helper used by charts that render a single numeric field
 * (e.g. NetNewMrrChart, source breakdowns). Returns the "projected extra"
 * to stack on top of the actual bar for each month — zero for mature months.
 */
export function projectedExtraFor(
  bundle: ProjectionBundle,
  snapshotDate: string,
  field: string
): { actual: number; extra: number; projected: number; is_stale: boolean } {
  const row = bundle.rows.get(snapshotDate);
  if (!row) {
    return { actual: 0, extra: 0, projected: 0, is_stale: false };
  }
  const f = row.fields[field] || { actual: 0, projected: 0 };
  const extra = row.is_stale ? Math.max(0, f.projected - f.actual) : 0;
  return { actual: f.actual, extra, projected: f.projected, is_stale: row.is_stale };
}
