'use client';

import { useMemo, useState } from 'react';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { formatCurrency } from '@/lib/constants';
import type { RefundCohortRow, RefundCohortBreakdowns } from '@/lib/refunds';
import { BreakdownTable, heatStyle } from '@/components/dashboard/RefundsContent';
import type { Source } from '@/types';

type CohortSource = 'all' | Source;

type SortKey =
  | 'cohort_month'
  | 'charge_units'
  | 'charge_gross'
  | 'refunded_units'
  | 'refunded_gross'
  | 'cohort_rate_units'
  | 'cohort_rate_amount'
  | 'avg_days_to_refund';

interface Props {
  cohorts: Record<CohortSource, RefundCohortRow[]>;
  granularity: 'monthly' | 'weekly';
  breakdowns: Record<CohortSource, RefundCohortBreakdowns>;
  /** Newest fully-accrued cohort key: YYYY-MM (monthly) or YYYY-MM-DD (weekly). */
  matureThrough: string;
}

const SOURCE_LABEL: Record<CohortSource, string> = {
  all: 'All stores',
  apple: 'iOS (Apple)',
  google: 'Android (Google)',
  stripe: 'Web (Stripe)',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtMonth(ym: string): string {
  const parts = ym.split('-').map(Number);
  // Weekly cohorts arrive as YYYY-MM-DD (week start) → "3 Mar"
  if (parts.length === 3) return `${parts[2]} ${MONTHS[parts[1] - 1]}`;
  return `${MONTHS[parts[1] - 1]} ${String(parts[0]).slice(2)}`;
}

export function RefundCohortsSection({ cohorts, breakdowns, granularity, matureThrough }: Props) {
  const [source, setSource] = useState<CohortSource>('all');
  const rows = useMemo(() => cohorts[source] || [], [cohorts, source]);
  const bd = breakdowns[source];
  const [sortKey, setSortKey] = useState<SortKey>('cohort_month');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === 'asc' ? Number(av ?? 0) - Number(bv ?? 0) : Number(bv ?? 0) - Number(av ?? 0);
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  // Heat-map bounds over the rows on screen (each rate column scales on its own)
  const heat = useMemo(() => {
    const u = rows.map((r) => r.cohort_rate_units * 100);
    const a = rows.map((r) => r.cohort_rate_amount * 100);
    return {
      uMin: u.length ? Math.min(...u) : 0,
      uMax: u.length ? Math.max(...u) : 0,
      aMin: a.length ? Math.min(...a) : 0,
      aMax: a.length ? Math.max(...a) : 0,
    };
  }, [rows]);

  function header(label: string, key: SortKey, align: 'left' | 'right') {
    const active = sortKey === key;
    return (
      <th
        onClick={() => {
          if (active) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
          else {
            setSortKey(key);
            setSortDir('desc');
          }
        }}
        className={`${
          align === 'left' ? 'text-left' : 'text-right'
        } py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider cursor-pointer select-none hover:bg-[#F0F4FF]`}
      >
        <span className="inline-flex items-center gap-1">
          {label}
          {active ? (
            sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
          ) : (
            <ArrowUpDown className="h-3 w-3 opacity-30" />
          )}
        </span>
      </th>
    );
  }

  const hasData = Object.values(cohorts).some((r) => r.length > 0 && r.some((x) => x.refunded_units > 0));

  const chartData = rows.map((r) => ({
    month: fmtMonth(r.cohort_month) + (r.cohort_month > matureThrough ? ' *' : ''),
    ratePct: +(r.cohort_rate_amount * 100).toFixed(2),
    rateUnitsPct: +(r.cohort_rate_units * 100).toFixed(2),
    immature: r.cohort_month > matureThrough,
  }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-bold text-[#0E3687]">Refunds by Cohort</h2>
        <span className="rounded-full bg-[#0086D8]/10 px-2.5 py-0.5 text-xs font-medium text-[#0086D8]">
          charge-date attribution
        </span>
        <div className="ml-auto flex gap-1.5">
          {(Object.keys(SOURCE_LABEL) as CohortSource[]).map((s) => (
            <button
              key={s}
              onClick={() => setSource(s)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                source === s
                  ? 'bg-[#0E3687] text-white'
                  : 'border border-border bg-white text-muted-foreground hover:bg-muted/50'
              }`}
            >
              {SOURCE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Unlike the calendar view above (refunds that <em>happened</em> in a period), this view answers:{' '}
        <span className="font-medium text-[#0E3687]">
          {granularity === 'weekly' ? '\u201Cof the charges made in week X, what % did we eventually refund?\u201D' : '\u201Cof the charges made in month X, what % did we eventually refund?\u201D'}
        </span>{' '}
        — the quality of each {granularity === 'weekly' ? 'week' : 'month'}&apos;s sales. Refunds are linked to their exact original charge
        (backend sale ID). {granularity === 'weekly' ? 'Weeks' : 'Months'} marked{' '}
        <span className="font-medium">*</span> are still accruing
        refunds (refunds arrive up to ~45 days after the charge) — their rate will rise.
      </p>

      {!hasData ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No cohort data yet. Apply migration <code>019_refund_cohorts_v2.sql</code> in Supabase and run{' '}
            <code>node scripts/backfill-kinedu-refunds.js</code> to populate the charge↔refund linkage.
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-[#0E3687]">
                Cohort refund rate — % of each {granularity === 'weekly' ? 'week' : 'month'}&apos;s charges eventually refunded ({SOURCE_LABEL[source]})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E5EAF2" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} unit="%" />
                    <Tooltip
                      formatter={(v, name) => [
                        `${Number(v ?? 0).toFixed(1)}%`,
                        name === 'ratePct' ? 'Refunded ($ basis)' : 'Refunded (units basis)',
                      ]}
                    />
                    <Legend
                      formatter={(value: string) =>
                        value === 'ratePct' ? 'Refunded % ($)' : 'Refunded % (units)'
                      }
                    />
                    <Bar dataKey="ratePct" fill="#E15554" radius={[3, 3, 0, 0]} />
                    <Line dataKey="rateUnitsPct" stroke="#0086D8" strokeWidth={2} dot={{ r: 2.5 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card className="overflow-hidden">
            <div className="h-1 bg-gradient-to-r from-[#0E3687] to-[#0086D8]" />
            <CardHeader>
              <CardTitle className="text-base font-semibold text-[#0E3687]">Cohort Detail</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Rate cells are heat-mapped: the darker the red, the higher that cohort&apos;s rate
                relative to the rest on screen. Click any column header to sort.
              </p>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 bg-[#F8F9FB]">
                    {header(`Cohort (charge ${granularity === 'weekly' ? 'week' : 'month'})`, 'cohort_month', 'left')}
                    {header('Charges', 'charge_units', 'right')}
                    {header('Charged $', 'charge_gross', 'right')}
                    {header('Refunded', 'refunded_units', 'right')}
                    {header('Refunded $', 'refunded_gross', 'right')}
                    {header('Rate (units)', 'cohort_rate_units', 'right')}
                    {header('Rate ($)', 'cohort_rate_amount', 'right')}
                    {header('Avg days to refund', 'avg_days_to_refund', 'right')}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => {
                    const immature = r.cohort_month > matureThrough;
                    return (
                      <tr key={r.cohort_month} className="border-b border-border/30 last:border-0 hover:bg-[#F0F4FF]/50 transition-colors">
                        <td className={`py-2 px-3 font-medium ${immature ? 'text-muted-foreground' : ''}`}>
                          {fmtMonth(r.cohort_month)}
                          {immature && <span title="Still accruing refunds"> *</span>}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums">{r.charge_units.toLocaleString()}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(r.charge_gross)}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{r.refunded_units.toLocaleString()}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(r.refunded_gross)}</td>
                        <td className="py-2 px-3 text-right tabular-nums font-semibold" style={heatStyle(r.cohort_rate_units * 100, heat.uMin, heat.uMax)}>
                          {(r.cohort_rate_units * 100).toFixed(1)}%
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums font-semibold" style={heatStyle(r.cohort_rate_amount * 100, heat.aMin, heat.aMax)}>
                          {(r.cohort_rate_amount * 100).toFixed(1)}%
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums">
                          {r.avg_days_to_refund === null ? '—' : Math.round(r.avg_days_to_refund)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-muted-foreground">
                Refunded $ assumes full-charge refunds (the backend records a refund against the whole
                sale). Note: &ldquo;Charges&rdquo; here includes refunded charges in the denominator
                (gross basis) — the rest of the dashboard drops refunded charges entirely, so this
                Charged $ will read slightly higher than the MRR tab. May also differ from the App
                Store Connect calendar view above, which uses Apple&apos;s own aggregate reports.
              </p>
            </CardContent>
          </Card>

          {bd?.hasData && (
            <>
              <div className="pt-1">
                <h3 className="text-base font-bold text-[#0E3687]">
                  Cohort Segmentation — {SOURCE_LABEL[source]}
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Same dimensions as the calendar-basis segmentation above, but attributed to the
                  ORIGINAL CHARGE: of the charges made in the window, % eventually refunded.
                  Rate = refunded ÷ charged (gross). Country is approximated from the charge
                  currency. The event-only dimensions (renewal stage, days-to-refund, offer type)
                  exist only calendar-basis above.
                </p>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <BreakdownTable
                  title="By SKU (top 15, cohort basis)"
                  subtitle="Of charges in window: % eventually refunded"
                  rows={bd.bySku}
                />
                <BreakdownTable
                  title="By country (top 15, cohort basis)"
                  subtitle="Country ≈ from charge currency (USD groups several countries)"
                  rows={bd.byCountry}
                />
                <BreakdownTable
                  title="By plan duration (cohort basis)"
                  subtitle="Of charges in window: % eventually refunded"
                  rows={bd.byPlanDuration}
                />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
