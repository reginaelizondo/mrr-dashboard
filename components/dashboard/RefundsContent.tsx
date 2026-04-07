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
import { MetricCard } from '@/components/dashboard/MetricCard';
import { RotateCcw, TrendingDown, AlertTriangle, DollarSign } from 'lucide-react';
import { formatCurrency } from '@/lib/constants';
import type { RefundMonthlyRow, AppleRefundBreakdowns, BreakdownRow } from '@/lib/refunds';
import type { Source } from '@/types';

interface Props {
  data: Record<Source, RefundMonthlyRow[]>;
  appleBreakdowns: AppleRefundBreakdowns | null;
}

const SOURCES: { key: Source; label: string }[] = [
  { key: 'apple', label: 'iOS (Apple)' },
  { key: 'google', label: 'Android (Google)' },
  { key: 'stripe', label: 'Web (Stripe)' },
];

function formatMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[(m || 1) - 1]} ${y}`;
}

function rateColor(ratePct: number): string {
  if (ratePct >= 5) return 'bg-red-100 text-red-700';
  if (ratePct >= 2) return 'bg-amber-100 text-amber-700';
  return 'bg-green-100 text-green-700';
}

export function RefundsContent({ data, appleBreakdowns }: Props) {
  const [source, setSource] = useState<Source>('apple');
  const rows = data[source] || [];

  // KPI computations for the selected source
  const stats = useMemo(() => {
    const totalCharges = rows.reduce((a, r) => a + r.charge_units, 0);
    const totalRefunds = rows.reduce((a, r) => a + r.refund_units, 0);
    const totalChargeGross = rows.reduce((a, r) => a + r.charge_gross, 0);
    const totalRefundGross = rows.reduce((a, r) => a + r.refund_gross, 0);

    // Trailing 12-month window
    const last12 = rows.slice(-12);
    const t12Charges = last12.reduce((a, r) => a + r.charge_units, 0);
    const t12Refunds = last12.reduce((a, r) => a + r.refund_units, 0);
    const t12ChargeGross = last12.reduce((a, r) => a + r.charge_gross, 0);
    const t12RefundGross = last12.reduce((a, r) => a + r.refund_gross, 0);

    const current = rows[rows.length - 1];
    const prior = rows[rows.length - 2];

    return {
      totalCharges,
      totalRefunds,
      totalChargeGross,
      totalRefundGross,
      lifetimeRateUnits: totalCharges > 0 ? (totalRefunds / totalCharges) * 100 : 0,
      lifetimeRateAmount: totalChargeGross > 0 ? (totalRefundGross / totalChargeGross) * 100 : 0,
      t12RateUnits: t12Charges > 0 ? (t12Refunds / t12Charges) * 100 : 0,
      t12RateAmount: t12ChargeGross > 0 ? (t12RefundGross / t12ChargeGross) * 100 : 0,
      t12RefundGross,
      currentMonthRate: current && current.charge_units > 0
        ? (current.refund_units / current.charge_units) * 100
        : 0,
      priorMonthRate: prior && prior.charge_units > 0
        ? (prior.refund_units / prior.charge_units) * 100
        : 0,
    };
  }, [rows]);

  const chartData = rows.map((r) => ({
    date: formatMonth(r.month),
    rateUnits: Number((r.refund_rate_units * 100).toFixed(2)),
    rateAmount: Number((r.refund_rate_amount * 100).toFixed(2)),
    refunds: r.refund_units,
    charges: r.charge_units,
  }));

  return (
    <>
      {/* Source selector */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-muted-foreground mr-1">Source:</span>
        {SOURCES.map((s) => (
          <button
            key={s.key}
            onClick={() => setSource(s.key)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              source === s.key
                ? 'bg-[#0E3687] text-white'
                : 'bg-white border border-border text-muted-foreground hover:bg-[#F0F4FF]'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Apple context banner */}
      {source === 'apple' && (
        <Card className="border-l-4 border-l-amber-500 bg-amber-50/40">
          <CardContent className="py-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-amber-900">
                <p className="font-semibold mb-0.5">Apple Guideline 5.6.4 — Refund Rate Monitoring</p>
                <p className="text-amber-800">
                  Apple flags accounts with excessive refund requests. There is no published threshold,
                  but industry norm is under 2%. Rate here = refunded units / charged units from Apple
                  Finance Reports (source of truth).
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Refund Rate (T12M, units)"
          value={stats.t12RateUnits}
          previousValue={stats.priorMonthRate}
          format="percent"
          icon={RotateCcw}
          accentColor={stats.t12RateUnits >= 5 ? 'red' : stats.t12RateUnits >= 2 ? 'rose' : 'green'}
          subtitle="Last 12 months, refunded/charged units"
        />
        <MetricCard
          label="Refund Rate (T12M, $)"
          value={stats.t12RateAmount}
          format="percent"
          icon={DollarSign}
          accentColor={stats.t12RateAmount >= 5 ? 'red' : stats.t12RateAmount >= 2 ? 'rose' : 'green'}
          subtitle="Last 12 months, refunded/charged gross"
        />
        <MetricCard
          label="Refunds (T12M)"
          value={rows.slice(-12).reduce((a, r) => a + r.refund_units, 0)}
          format="number"
          icon={TrendingDown}
          accentColor="rose"
          subtitle={`${formatCurrency(stats.t12RefundGross)} refunded`}
        />
        <MetricCard
          label="Current Month Rate"
          value={stats.currentMonthRate}
          previousValue={stats.priorMonthRate}
          format="percent"
          icon={RotateCcw}
          accentColor={stats.currentMonthRate >= 5 ? 'red' : stats.currentMonthRate >= 2 ? 'rose' : 'green'}
          subtitle={rows.length > 0 ? formatMonth(rows[rows.length - 1].month) : ''}
        />
      </div>

      {/* Chart */}
      <Card className="overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-[#45C94E] via-[#F59E0B] to-[#E53E3E]" />
        <CardHeader>
          <CardTitle className="text-base font-semibold text-[#0E3687]">
            Monthly Refund Rate — {SOURCES.find((s) => s.key === source)?.label}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Bars = refund rate by units • Line = refund rate by $ gross
          </p>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis
                tickFormatter={(v) => `${v}%`}
                tick={{ fontSize: 11 }}
                domain={[0, (dataMax: number) => Math.max(5, Math.ceil(dataMax + 1))]}
              />
              <Tooltip
                formatter={(v) => `${v}%`}
              />
              <Legend />
              <Bar dataKey="rateUnits" name="Rate (units)" fill="#E53E3E" radius={[4, 4, 0, 0]} />
              <Line
                type="monotone"
                dataKey="rateAmount"
                name="Rate ($)"
                stroke="#0E3687"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Detail table */}
      <Card className="overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-[#0E3687] to-[#0086D8]" />
        <CardHeader>
          <CardTitle className="text-base font-semibold text-[#0E3687]">Monthly Detail</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 bg-[#F8F9FB]">
                  <th className="text-left py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Month</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Charges</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Refunds</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Rate (units)</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Charge $</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Refund $</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Rate ($)</th>
                </tr>
              </thead>
              <tbody>
                {[...rows].reverse().map((r, i) => {
                  const rateU = r.refund_rate_units * 100;
                  const rateA = r.refund_rate_amount * 100;
                  return (
                    <tr key={r.month} className={`border-b border-border/30 last:border-0 hover:bg-[#F0F4FF]/50 transition-colors ${i % 2 === 0 ? '' : 'bg-[#F8F9FB]/50'}`}>
                      <td className="py-2.5 px-3 font-medium">{formatMonth(r.month)}</td>
                      <td className="text-right py-2.5 px-3 tabular-nums text-[#0086D8]">{r.charge_units.toLocaleString()}</td>
                      <td className="text-right py-2.5 px-3 tabular-nums text-[#E53E3E] font-medium">{r.refund_units.toLocaleString()}</td>
                      <td className="text-right py-2.5 px-3 tabular-nums">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${rateColor(rateU)}`}>
                          {rateU.toFixed(2)}%
                        </span>
                      </td>
                      <td className="text-right py-2.5 px-3 tabular-nums text-[#0E3687]">{formatCurrency(r.charge_gross)}</td>
                      <td className="text-right py-2.5 px-3 tabular-nums text-[#E53E3E]">{formatCurrency(r.refund_gross)}</td>
                      <td className="text-right py-2.5 px-3 tabular-nums">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${rateColor(rateA)}`}>
                          {rateA.toFixed(2)}%
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-center py-6 text-muted-foreground">
                      No refund data for this source. Run a sync to populate.
                    </td>
                  </tr>
                )}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 border-border bg-[#F8F9FB] font-semibold">
                    <td className="py-2.5 px-3 text-[#0E3687]">Total ({rows.length} mo)</td>
                    <td className="text-right py-2.5 px-3 tabular-nums text-[#0086D8]">{stats.totalCharges.toLocaleString()}</td>
                    <td className="text-right py-2.5 px-3 tabular-nums text-[#E53E3E]">{stats.totalRefunds.toLocaleString()}</td>
                    <td className="text-right py-2.5 px-3 tabular-nums">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${rateColor(stats.lifetimeRateUnits)}`}>
                        {stats.lifetimeRateUnits.toFixed(2)}%
                      </span>
                    </td>
                    <td className="text-right py-2.5 px-3 tabular-nums text-[#0E3687]">{formatCurrency(stats.totalChargeGross)}</td>
                    <td className="text-right py-2.5 px-3 tabular-nums text-[#E53E3E]">{formatCurrency(stats.totalRefundGross)}</td>
                    <td className="text-right py-2.5 px-3 tabular-nums">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${rateColor(stats.lifetimeRateAmount)}`}>
                        {stats.lifetimeRateAmount.toFixed(2)}%
                      </span>
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Apple-only segmentation from SUBSCRIPTION_EVENT report */}
      {source === 'apple' && (
        <AppleBreakdownSections breakdowns={appleBreakdowns} />
      )}
    </>
  );
}

// ============================================================================
// Apple SUBSCRIPTION_EVENT-based segmentation
// ============================================================================

function AppleBreakdownSections({ breakdowns }: { breakdowns: AppleRefundBreakdowns | null }) {
  if (!breakdowns || !breakdowns.hasData) {
    return (
      <Card className="border-l-4 border-l-[#0086D8] bg-[#0086D8]/[0.04]">
        <CardContent className="py-5">
          <p className="text-sm text-[#0E3687] font-semibold mb-1">
            Granular Apple breakdowns not yet available
          </p>
          <p className="text-xs text-muted-foreground">
            The <code className="bg-white px-1 rounded">apple_subscription_events</code> table is empty.
            Run the daily cron <code className="bg-white px-1 rounded">/api/cron/apple-events</code> or
            backfill manually with{' '}
            <code className="bg-white px-1 rounded">
              POST /api/sync/apple-events {'{ "startDate":"YYYY-MM-DD", "endDate":"YYYY-MM-DD" }'}
            </code>
            . Apple retains daily reports for ~365 days.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div className="pt-2 border-t border-border/40">
        <h2 className="text-lg font-bold text-[#0E3687]">
          iOS Refund Segmentation
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          From Apple SUBSCRIPTION_EVENT daily reports • last {breakdowns.lookbackDays} days •{' '}
          {breakdowns.totalRefunds.toLocaleString()} refunds /{' '}
          {breakdowns.totalPaid.toLocaleString()} paid events •{' '}
          overall rate {(breakdowns.overallRate * 100).toFixed(2)}%
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BreakdownTable
          title="By renewal stage (Consecutive Paid Periods)"
          subtitle="1 = first paid charge, 2 = first renewal, etc. — identifies if pain is at conversion or retention"
          rows={breakdowns.byConsecutivePaidPeriod}
        />
        <BreakdownTable
          title="By days from purchase to refund"
          subtitle="Distribution of refunds (computed: refund date − original start date). <48h = buyer remorse, 7–30d = forgotten renewal."
          rows={breakdowns.byDaysBeforeCanceling}
          rateAsShare
        />
        <BreakdownTable
          title="By plan duration"
          subtitle="Annual refunds hurt more financially; monthly often signal trial-conversion friction"
          rows={breakdowns.byPlanDuration}
        />
        <BreakdownTable
          title="By offer type"
          subtitle="Free Trial vs Pay As You Go vs Pay Up Front etc."
          rows={breakdowns.byOfferType}
        />
        <BreakdownTable
          title="By SKU (top 15)"
          subtitle="Concentrate fixes on the worst offenders"
          rows={breakdowns.bySku}
        />
        <BreakdownTable
          title="By country (top 15)"
          subtitle="Region-specific issues (payment friction, localization, etc.)"
          rows={breakdowns.byCountry}
        />
      </div>
    </>
  );
}

function BreakdownTable({
  title,
  subtitle,
  rows,
  rateAsShare = false,
}: {
  title: string;
  subtitle?: string;
  rows: BreakdownRow[];
  rateAsShare?: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-[#0E3687] to-[#0086D8]" />
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold text-[#0E3687]">{title}</CardTitle>
        {subtitle && <p className="text-[11px] text-muted-foreground">{subtitle}</p>}
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/50 bg-[#F8F9FB]">
                <th className="text-left py-2 px-2 font-semibold text-[#0E3687] uppercase tracking-wider">Bucket</th>
                <th className="text-right py-2 px-2 font-semibold text-[#0E3687] uppercase tracking-wider">Refunds</th>
                <th className="text-right py-2 px-2 font-semibold text-[#0E3687] uppercase tracking-wider">{rateAsShare ? 'Total' : 'Paid'}</th>
                <th className="text-right py-2 px-2 font-semibold text-[#0E3687] uppercase tracking-wider">{rateAsShare ? 'Share' : 'Rate'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-center py-4 text-muted-foreground">
                    No data
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => {
                  const ratePct = r.refund_rate * 100;
                  return (
                    <tr
                      key={r.bucket}
                      className={`border-b border-border/30 last:border-0 ${i % 2 === 0 ? '' : 'bg-[#F8F9FB]/50'}`}
                    >
                      <td className="py-1.5 px-2 font-medium">{r.bucket}</td>
                      <td className="text-right py-1.5 px-2 tabular-nums text-[#E53E3E]">
                        {r.refunds.toLocaleString()}
                      </td>
                      <td className="text-right py-1.5 px-2 tabular-nums text-[#0086D8]">
                        {r.paid_events.toLocaleString()}
                      </td>
                      <td className="text-right py-1.5 px-2 tabular-nums">
                        <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${rateAsShare ? 'bg-[#0E3687]/10 text-[#0E3687]' : rateColor(ratePct)}`}>
                          {r.paid_events > 0 ? `${ratePct.toFixed(2)}%` : '—'}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
