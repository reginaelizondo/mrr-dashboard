'use client';

import { useMemo, useState } from 'react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency, SOURCE_COLORS, SOURCE_LABELS } from '@/lib/constants';
import { ChartExportButton } from '@/components/charts/ChartExportButton';
import { MIX_STORES, type MixCell, type MixFamily, type MixStore, type SkuMix } from '@/lib/sku-mix';
import { bucketKey, bucketize, currentYM, fmtPeriod, type SkuGrain } from '@/lib/sku-filters';

const fmtMonth = fmtPeriod;

/** Re-bucket monthly cells by period grain (cash counts and gross simply add up). */
function aggregateByGrain(data: SkuMix, grain: SkuGrain): SkuMix {
  if (grain === 'month') return data;
  const { keys, idxOf } = bucketize(data.months, grain);
  const bucketOfMonth: Record<string, string> = {};
  data.months.forEach((m, i) => (bucketOfMonth[m] = keys[idxOf[i]]));
  const map = new Map<string, MixCell>();
  for (const c of data.cells) {
    const b = bucketOfMonth[c.month];
    if (!b) continue;
    const key = `${b}|${c.source}|${c.family}|${c.kind}`;
    let cell = map.get(key);
    if (!cell) {
      cell = { ...c, month: b, n: 0, gross: 0 };
      map.set(key, cell);
    }
    cell.n += c.n;
    cell.gross += c.gross;
  }
  return { months: keys, cells: [...map.values()] };
}

const FAMILIES: MixFamily[] = ['anual', 'mensual', 'otro'];
const FAMILY_LABEL: Record<MixFamily, string> = { anual: 'Yearly', mensual: 'Monthly', otro: 'Other' };
const FAMILY_COLOR: Record<MixFamily, string> = { anual: '#0086D8', mensual: '#45C94E', otro: '#CBD5E1' };

type Scope = 'new' | 'all';
type Metric = 'n' | 'gross';

type Agg = Record<MixStore, Record<MixFamily, number>>;
const emptyAgg = (): Agg => ({
  apple: { anual: 0, mensual: 0, otro: 0 },
  google: { anual: 0, mensual: 0, otro: 0 },
  stripe: { anual: 0, mensual: 0, otro: 0 },
});

const pct = (part: number, total: number) => (total > 0 ? (100 * part) / total : 0);

export function SkuMixByStore({ data, grain = 'month' }: { data: SkuMix; grain?: SkuGrain }) {
  const { months, cells } = useMemo(() => aggregateByGrain(data, grain), [data, grain]);
  const [scope, setScope] = useState<Scope>('new');
  const [metric, setMetric] = useState<Metric>('n');

  // byMonth[month][store][family] = value for the current scope/metric
  const byMonth = useMemo(() => {
    const out: Record<string, Agg> = {};
    for (const m of months) out[m] = emptyAgg();
    for (const c of cells) {
      if (scope === 'new' && c.kind !== 'new') continue;
      const row = out[c.month];
      if (!row || !(c.source in row)) continue;
      row[c.source as MixStore][c.family] += metric === 'n' ? c.n : c.gross;
    }
    return out;
  }, [months, cells, scope, metric]);

  const windowAgg = useMemo(() => {
    const a = emptyAgg();
    for (const m of months) for (const s of MIX_STORES) for (const f of FAMILIES) a[s][f] += byMonth[m][s][f];
    return a;
  }, [months, byMonth]);

  // With a store filter active the other stores are all zeros: hide them.
  const stores = useMemo(() => {
    const withData = MIX_STORES.filter((s) => FAMILIES.some((f) => windowAgg[s][f] > 0));
    return withData.length ? withData : MIX_STORES;
  }, [windowAgg]);

  // Latest period usually contains the current (partial) month; headline the last full one too.
  const currentBucket = bucketKey(`${currentYM()}-01`, grain);
  const fullMonths = months.filter((m) => m !== currentBucket);
  const lastFull = fullMonths[fullMonths.length - 1] || months[months.length - 1];

  const fmtVal = (v: number) => (metric === 'gross' ? formatCurrency(v) : Math.round(v).toLocaleString());

  // Rows for the per-store 100% stacked charts and the yearly-share line chart.
  const rows = months.map((m) => {
    const r: Record<string, number | string> = { month: m };
    for (const s of MIX_STORES) {
      const a = byMonth[m][s];
      const tot = a.anual + a.mensual + a.otro;
      for (const f of FAMILIES) r[`${s}_${f}`] = a[f];
      r[`${s}_pctYearly`] = Math.round(pct(a.anual, tot) * 10) / 10;
      r[`${s}_total`] = tot;
    }
    return r;
  });

  const exportRows = rows.map((r) => {
    const o: Record<string, unknown> = { Period: r.month };
    for (const s of MIX_STORES) {
      o[`${s} yearly`] = r[`${s}_anual`];
      o[`${s} monthly`] = r[`${s}_mensual`];
      o[`${s} other`] = r[`${s}_otro`];
      o[`${s} % yearly`] = r[`${s}_pctYearly`];
    }
    return o;
  });

  const seg = (active: boolean) =>
    `px-2.5 py-1 rounded-md text-xs font-medium transition-all ${active ? 'bg-white text-[#0E3687] shadow-sm' : 'text-slate-500 hover:text-[#0E3687]'}`;

  return (
    <Card className="overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-[#0086D8] via-[#45C94E] to-[#0E3687]" />
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <CardTitle className="text-base font-semibold text-[#0E3687]">Yearly vs monthly mix by store</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Charges dated in the month (cash basis, not accrual). Family comes from the SKU name
              (<code>_12</code> = yearly, <code>_1</code> = monthly): Apple&apos;s $3.99 intro month of yearly SKUs is
              stored as a monthly plan, so plan_type would overstate monthly on iOS.
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="inline-flex rounded-lg bg-slate-100 p-0.5">
              <button type="button" onClick={() => setScope('new')} className={seg(scope === 'new')}>New sales</button>
              <button type="button" onClick={() => setScope('all')} className={seg(scope === 'all')}>All charges</button>
            </div>
            <div className="inline-flex rounded-lg bg-slate-100 p-0.5">
              <button type="button" onClick={() => setMetric('n')} className={seg(metric === 'n')}>Count</button>
              <button type="button" onClick={() => setMetric('gross')} className={seg(metric === 'gross')}>Gross $</button>
            </div>
            <ChartExportButton data={exportRows} filename={`sku-mix-${scope}-${metric}`} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Headline tiles */}
        <div className={`grid grid-cols-1 gap-4 ${stores.length === 3 ? 'md:grid-cols-3' : stores.length === 2 ? 'md:grid-cols-2' : ''}`}>
          {stores.map((s) => {
            const w = windowAgg[s];
            const wTot = w.anual + w.mensual + w.otro;
            const l = byMonth[lastFull]?.[s] || { anual: 0, mensual: 0, otro: 0 };
            const lTot = l.anual + l.mensual + l.otro;
            return (
              <div key={s} className="rounded-lg border border-border/60 p-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: SOURCE_COLORS[s] }} />
                  <span className="text-xs font-semibold text-[#0E3687]">{SOURCE_LABELS[s]}</span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-[#0086D8] tabular-nums">{pct(w.anual, wTot).toFixed(1)}%</span>
                  <span className="text-xs text-muted-foreground">yearly</span>
                  <span className="text-lg font-semibold text-[#45C94E] tabular-nums ml-2">{pct(w.mensual, wTot).toFixed(1)}%</span>
                  <span className="text-xs text-muted-foreground">monthly</span>
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {fmtMonth(months[0])} – {fmtMonth(months[months.length - 1])} · {fmtVal(wTot)} {metric === 'n' ? (scope === 'new' ? 'new sales' : 'charges') : 'gross'}
                  {pct(w.otro, wTot) >= 0.5 && ` · other ${pct(w.otro, wTot).toFixed(1)}%`}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {fmtMonth(lastFull)}: <span className="font-medium text-[#0E3687]">{pct(l.anual, lTot).toFixed(1)}% yearly</span> · {pct(l.mensual, lTot).toFixed(1)}% monthly · {fmtVal(lTot)}
                </p>
              </div>
            );
          })}
        </div>

        {/* 100% stacked bars per store */}
        <div className={`grid grid-cols-1 gap-4 ${stores.length === 3 ? 'xl:grid-cols-3' : stores.length === 2 ? 'xl:grid-cols-2' : ''}`}>
          {stores.map((s) => (
            <div key={s}>
              <p className="text-xs font-semibold text-[#0E3687] mb-1">{SOURCE_LABELS[s]} — share by family</p>
              <div className="h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={rows} stackOffset="expand" margin={{ top: 5, right: 8, left: -10, bottom: 0 }}>
                    <CartesianGrid stroke="#E2E8F0" strokeOpacity={0.6} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#64748B' }} stroke="#94A3B8" tickFormatter={fmtMonth} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 10, fill: '#64748B' }} stroke="#94A3B8" tickFormatter={(v) => `${Math.round(Number(v) * 100)}%`} />
                    <Tooltip
                      content={(p) => {
                        const pp = p as unknown as { active?: boolean; label?: string };
                        if (!pp.active || !pp.label) return null;
                        const r = rows.find((x) => x.month === pp.label);
                        if (!r) return null;
                        const tot = Number(r[`${s}_total`]) || 0;
                        return (
                          <div className="rounded-xl border border-border/50 bg-white p-3 shadow-xl text-xs">
                            <p className="font-medium text-muted-foreground mb-1.5">{fmtMonth(pp.label)} · {SOURCE_LABELS[s]}</p>
                            {FAMILIES.map((f) => {
                              const v = Number(r[`${s}_${f}`]) || 0;
                              if (v === 0) return null;
                              return (
                                <div key={f} className="flex items-center gap-2">
                                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: FAMILY_COLOR[f] }} />
                                  <span className="text-muted-foreground flex-1">{FAMILY_LABEL[f]}</span>
                                  <span className="font-semibold text-[#0E3687] tabular-nums">{pct(v, tot).toFixed(1)}%</span>
                                  <span className="text-muted-foreground tabular-nums">({fmtVal(v)})</span>
                                </div>
                              );
                            })}
                            <div className="mt-1.5 pt-1.5 border-t border-border/30 font-semibold text-[#0E3687]">Total: {fmtVal(tot)}</div>
                          </div>
                        );
                      }}
                    />
                    {FAMILIES.map((f) => (
                      <Bar key={f} dataKey={`${s}_${f}`} name={FAMILY_LABEL[f]} stackId="fam" fill={FAMILY_COLOR[f]} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          ))}
        </div>

        {/* Yearly share trend, one line per store */}
        <div>
          <p className="text-xs font-semibold text-[#0E3687] mb-1">% yearly over time, by store</p>
          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 5, right: 20, left: -10, bottom: 0 }}>
                <CartesianGrid stroke="#E2E8F0" strokeOpacity={0.6} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748B' }} stroke="#94A3B8" tickFormatter={fmtMonth} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#64748B' }} stroke="#94A3B8" tickFormatter={(v) => `${v}%`} />
                <Tooltip
                  formatter={(v, name) => [`${Number(v).toFixed(1)}%`, String(name)]}
                  labelFormatter={(l) => fmtMonth(String(l))}
                  contentStyle={{ borderRadius: 12, border: '1px solid #E2E8F0', fontSize: 12 }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {stores.map((s) => (
                  <Line key={s} type="monotone" dataKey={`${s}_pctYearly`} name={SOURCE_LABELS[s]} stroke={SOURCE_COLORS[s]} strokeWidth={2} dot={{ r: 2.5 }} activeDot={{ r: 4 }} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
