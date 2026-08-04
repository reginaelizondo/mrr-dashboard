'use client';

import { useState } from 'react';
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
import { formatCurrency } from '@/lib/constants';
import type { RefundCohortRow, RefundCohortBreakdowns } from '@/lib/refunds';
import { BreakdownTable } from '@/components/dashboard/RefundsContent';
import type { Source } from '@/types';

type CohortSource = 'all' | Source;

interface Props {
  cohorts: Record<CohortSource, RefundCohortRow[]>;
  breakdowns: Record<CohortSource, RefundCohortBreakdowns>;
  /** YYYY-MM of the newest month considered mature (refunds fully accrued). */
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
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${String(y).slice(2)}`;
}

export function RefundCohortsSection({ cohorts, breakdowns, matureThrough }: Props) {
  const [source, setSource] = useState<CohortSource>('all');
  const rows = cohorts[source] || [];
  const bd = breakdowns[source];

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
          &ldquo;of the charges made in month X, what % did we eventually refund?&rdquo;
        </span>{' '}
        — the quality of each month&apos;s sales. Refunds are linked to their exact original charge
        (backend sale ID). Months marked <span className="font-medium">*</span> are still accruing
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
                Cohort refund rate — % of each month&apos;s charges eventually refunded ({SOURCE_LABEL[source]})
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

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-[#0E3687]">Cohort detail</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="py-2 pr-3">Cohort (charge month)</th>
                    <th className="py-2 pr-3 text-right">Charges</th>
                    <th className="py-2 pr-3 text-right">Charged $</th>
                    <th className="py-2 pr-3 text-right">Refunded</th>
                    <th className="py-2 pr-3 text-right">Refunded $</th>
                    <th className="py-2 pr-3 text-right">Rate (units)</th>
                    <th className="py-2 pr-3 text-right">Rate ($)</th>
                    <th className="py-2 text-right">Avg days to refund</th>
                  </tr>
                </thead>
                <tbody>
                  {[...rows].reverse().map((r) => {
                    const immature = r.cohort_month > matureThrough;
                    return (
                      <tr key={r.cohort_month} className={`border-b last:border-0 ${immature ? 'text-muted-foreground' : ''}`}>
                        <td className="py-1.5 pr-3 font-medium">
                          {fmtMonth(r.cohort_month)}
                          {immature && <span title="Still accruing refunds"> *</span>}
                        </td>
                        <td className="py-1.5 pr-3 text-right">{r.charge_units.toLocaleString()}</td>
                        <td className="py-1.5 pr-3 text-right">{formatCurrency(r.charge_gross)}</td>
                        <td className="py-1.5 pr-3 text-right">{r.refunded_units.toLocaleString()}</td>
                        <td className="py-1.5 pr-3 text-right">{formatCurrency(r.refunded_gross)}</td>
                        <td className="py-1.5 pr-3 text-right">{(r.cohort_rate_units * 100).toFixed(1)}%</td>
                        <td className="py-1.5 pr-3 text-right font-semibold text-[#E15554]">
                          {(r.cohort_rate_amount * 100).toFixed(1)}%
                        </td>
                        <td className="py-1.5 text-right">
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
