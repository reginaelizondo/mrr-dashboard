'use client';

import { useState, useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency } from '@/lib/constants';
import { ChartExportButton } from '@/components/charts/ChartExportButton';
import type { SkuBreakdown } from '@/lib/sku-breakdown';

const MONTHS_ES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const fmtMonth = (val: string) => {
  const d = new Date(val + 'T00:00:00Z');
  return `${MONTHS_ES[d.getUTCMonth()]} ${d.getUTCFullYear().toString().slice(2)}`;
};

type Family = 'yearly' | 'monthly' | 'other';

// Blue / green / neutral-gray palette (no amber).
const FAMILY_BASE: Record<Family, string> = {
  yearly: '#0086D8', // Kinedu blue
  monthly: '#45C94E', // Kinedu green
  other: '#64748B', // slate gray
};
const FAMILY_LABEL: Record<Family, string> = {
  yearly: 'Yearly (anuales)',
  monthly: 'Monthly (mensuales)',
  other: 'Otros planes',
};
const OTHERS_COLOR = '#CBD5E1';
const OTHERS_KEY = '__otros__';

function familyOf(planType: string): Family {
  if (planType === 'yearly') return 'yearly';
  if (planType === 'monthly') return 'monthly';
  return 'other';
}

// Lighten (f>0) / darken (f<0) a hex color.
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  if (f >= 0) {
    r += (255 - r) * f;
    g += (255 - g) * f;
    b += (255 - b) * f;
  } else {
    r *= 1 + f;
    g *= 1 + f;
    b *= 1 + f;
  }
  return `#${[r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
}

type Metric = 'total' | 'vol' | 'new' | 'rec';

export function SkuBreakdownContent({ data }: { data: SkuBreakdown }) {
  const { months, skus, series, totals } = data;

  // Default broken-out set: top 15 SKUs by revenue.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(skus.slice(0, 15).map((s) => s.sku))
  );
  // "Completar al 100%": when on, the rest of the SKUs are grouped into an
  // "Otros" bar so every bar's height equals the full MRR. OFF by default so
  // that filtering simply shows the SKUs you picked (intuitive).
  const [completeTo100, setCompleteTo100] = useState(false);

  const skusByFamily = useMemo(() => {
    const g: Record<Family, typeof skus> = { yearly: [], monthly: [], other: [] };
    for (const s of skus) g[familyOf(s.planType)].push(s);
    return g;
  }, [skus]);

  // Color per selected SKU: spread shades within its family.
  const orderedSelected = useMemo(() => {
    const fams: Family[] = ['yearly', 'monthly', 'other'];
    const out: { sku: string; family: Family; color: string }[] = [];
    for (const fam of fams) {
      const inFam = skus.filter((s) => familyOf(s.planType) === fam && selected.has(s.sku));
      const base = FAMILY_BASE[fam];
      inFam.forEach((s, i) => {
        const f = inFam.length === 1 ? 0 : -0.3 + (0.75 * i) / (inFam.length - 1);
        out.push({ sku: s.sku, family: fam, color: shade(base, f) });
      });
    }
    return out;
  }, [skus, selected]);

  const colorBySku = useMemo(() => {
    const m: Record<string, string> = {};
    orderedSelected.forEach((o) => (m[o.sku] = o.color));
    return m;
  }, [orderedSelected]);

  function toggle(sku: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }
  const selectAll = () => setSelected(new Set(skus.map((s) => s.sku)));
  const clearAll = () => setSelected(new Set());
  const onlyFamily = (fam: Family) =>
    setSelected(new Set(skus.filter((s) => familyOf(s.planType) === fam).map((s) => s.sku)));
  const onlyTop = (n: number) => setSelected(new Set(skus.slice(0, n).map((s) => s.sku)));

  // ── Reconciliation banner (latest month) ────────────────────────────────
  const lastIdx = months.length - 1;
  const lastTotal = totals.rev[lastIdx] || 0;
  const lastVol = totals.vol[lastIdx] || 0;
  const selectedRevShare = useMemo(() => {
    let sel = 0;
    for (const o of orderedSelected) {
      const s = series[o.sku];
      sel += (s.newRev[lastIdx] || 0) + (s.recRev[lastIdx] || 0);
    }
    return lastTotal > 0 ? (sel / lastTotal) * 100 : 0;
  }, [orderedSelected, series, lastIdx, lastTotal]);

  const chipBtn = 'px-2.5 py-1 rounded-full text-xs font-medium transition-colors';

  return (
    <div className="space-y-6">
      {/* Reconciliation banner */}
      <div className="rounded-xl border border-[#45C94E]/40 bg-[#45C94E]/5 px-4 py-3 text-sm">
        <span className="font-semibold text-[#0E3687]">
          MRR total ({fmtMonth(months[lastIdx])}): {formatCurrency(lastTotal)}
        </span>
        <span className="text-muted-foreground">
          {' '}· {lastVol.toLocaleString()} subs activas · suma de los {skus.length} SKUs ={' '}
          <span className="text-[#45C94E] font-medium">cuadra con la pestaña MRR ✓</span>
        </span>
        <p className="text-xs text-muted-foreground mt-1">
          {completeTo100
            ? `Cada barra suma el MRR completo: los ${orderedSelected.length} SKUs elegidos van desglosados y el resto se agrupa en "Otros".`
            : `Mostrando ${orderedSelected.length} de ${skus.length} SKUs = ${selectedRevShare.toFixed(0)}% del MRR. Pulsa "Todos" o activa "Completar al 100%" para ver el MRR entero.`}
        </p>
      </div>

      {/* Filter panel */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base font-semibold text-[#0E3687] mr-1">Filtrar SKUs</CardTitle>
            <button onClick={() => onlyTop(15)} className={`${chipBtn} bg-[#0E3687] text-white`}>Top 15</button>
            <button onClick={selectAll} className={`${chipBtn} border border-border bg-white hover:bg-muted/50`}>Todos</button>
            <span className="mx-1 h-4 w-px bg-border" />
            <button onClick={() => onlyFamily('yearly')} className={`${chipBtn} text-white`} style={{ backgroundColor: FAMILY_BASE.yearly }}>Solo Yearly</button>
            <button onClick={() => onlyFamily('monthly')} className={`${chipBtn} text-white`} style={{ backgroundColor: FAMILY_BASE.monthly }}>Solo Monthly</button>
            <button onClick={() => onlyFamily('other')} className={`${chipBtn} text-white`} style={{ backgroundColor: FAMILY_BASE.other }}>Solo Otros</button>
            <span className="mx-1 h-4 w-px bg-border" />
            <button onClick={clearAll} className={`${chipBtn} border border-border bg-white hover:bg-muted/50 text-muted-foreground`}>Limpiar</button>
            <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <input type="checkbox" checked={completeTo100} onChange={(e) => setCompleteTo100(e.target.checked)} />
              Completar al 100% (resto en &quot;Otros&quot;)
            </label>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {(['yearly', 'monthly', 'other'] as Family[]).map((fam) => {
              const list = skusByFamily[fam];
              const selCount = list.filter((s) => selected.has(s.sku)).length;
              const allSel = selCount === list.length && list.length > 0;
              return (
                <div key={fam} className="rounded-lg border border-border/60 p-2.5">
                  <button
                    onClick={() => {
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (allSel) list.forEach((s) => next.delete(s.sku));
                        else list.forEach((s) => next.add(s.sku));
                        return next;
                      });
                    }}
                    className="flex items-center gap-1.5 mb-1.5 w-full text-left group"
                  >
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: FAMILY_BASE[fam] }} />
                    <span className="text-xs font-semibold text-[#0E3687] group-hover:underline">{FAMILY_LABEL[fam]}</span>
                    <span className="text-[10px] text-muted-foreground ml-auto">{selCount}/{list.length}</span>
                  </button>
                  <div className="max-h-44 overflow-y-auto pr-1 space-y-0.5">
                    {list.map((s) => {
                      const isSel = selected.has(s.sku);
                      return (
                        <label key={s.sku} className="flex items-center gap-1.5 text-xs cursor-pointer py-0.5 hover:bg-muted/40 rounded px-1">
                          <input type="checkbox" checked={isSel} onChange={() => toggle(s.sku)} className="flex-shrink-0" />
                          <span className="h-2 w-2 rounded-sm flex-shrink-0" style={{ backgroundColor: isSel ? colorBySku[s.sku] : '#E2E8F0' }} />
                          <span className="truncate flex-1" title={s.sku}>{s.sku}</span>
                          <span className="text-[10px] text-muted-foreground tabular-nums">{formatCurrency(s.totalRev)}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Charts */}
      <SkuStackChart title="Ventas por SKU — Revenue total (nuevas + recurrentes)" metric="total" isCurrency {...{ months, series, orderedSelected, completeTo100, totals, colorBySku }} />
      <SkuStackChart title="Volumen por SKU — suscripciones activas" metric="vol" isCurrency={false} {...{ months, series, orderedSelected, completeTo100, totals, colorBySku }} />
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <SkuStackChart title="Solo ventas NUEVAS por SKU (revenue)" metric="new" isCurrency {...{ months, series, orderedSelected, completeTo100, totals, colorBySku }} />
        <SkuStackChart title="Solo ventas RECURRENTES por SKU (revenue)" metric="rec" isCurrency {...{ months, series, orderedSelected, completeTo100, totals, colorBySku }} />
      </div>
    </div>
  );
}

// ── Inner stacked chart ────────────────────────────────────────────────────
function SkuStackChart({
  title,
  metric,
  isCurrency,
  months,
  series,
  orderedSelected,
  completeTo100,
  totals,
}: {
  title: string;
  metric: Metric;
  isCurrency: boolean;
  months: string[];
  series: Record<string, { newRev: number[]; recRev: number[]; vol: number[] }>;
  orderedSelected: { sku: string; family: Family; color: string }[];
  completeTo100: boolean;
  totals: { rev: number[]; vol: number[] };
}) {
  const valueAt = (sku: string, i: number): number => {
    const s = series[sku];
    if (!s) return 0;
    if (metric === 'vol') return s.vol[i] || 0;
    if (metric === 'new') return s.newRev[i] || 0;
    if (metric === 'rec') return s.recRev[i] || 0;
    return (s.newRev[i] || 0) + (s.recRev[i] || 0);
  };
  const grandAt = (i: number): number => {
    if (metric === 'vol') return totals.vol[i] || 0;
    if (metric === 'total') return totals.rev[i] || 0;
    let g = 0;
    for (const k of Object.keys(series)) g += valueAt(k, i);
    return g;
  };

  const selectedKeys = orderedSelected.map((o) => o.sku);
  const rows = months.map((m, i) => {
    const row: Record<string, number | string> = { month: m };
    let selSum = 0;
    for (const o of orderedSelected) {
      const v = valueAt(o.sku, i);
      row[o.sku] = isCurrency ? Math.round(v) : v;
      selSum += v;
    }
    if (completeTo100) {
      const others = Math.max(0, grandAt(i) - selSum);
      row[OTHERS_KEY] = isCurrency ? Math.round(others) : others;
    }
    return row;
  });

  const fmtVal = (v: number) => (isCurrency ? formatCurrency(v) : v.toLocaleString());

  const exportRows = rows.map((r) => {
    const o: Record<string, unknown> = { Period: r.month };
    for (const k of selectedKeys) o[k] = r[k];
    if (completeTo100) o['Otros'] = r[OTHERS_KEY];
    return o;
  });

  const empty = orderedSelected.length === 0 && !completeTo100;

  return (
    <Card className="overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-[#0086D8] via-[#45C94E] to-[#0E3687]" />
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base font-semibold text-[#0E3687]">{title}</CardTitle>
          <ChartExportButton data={exportRows} filename={`sku-${metric}`} />
        </div>
      </CardHeader>
      <CardContent>
        {empty ? (
          <div className="h-[340px] flex items-center justify-center text-sm text-muted-foreground">
            Selecciona al menos un SKU (o pulsa &quot;Todos&quot;) para ver la gráfica.
          </div>
        ) : (
          <div className="h-[340px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid stroke="#E2E8F0" strokeOpacity={0.6} strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748B' }} stroke="#94A3B8" tickFormatter={fmtMonth} />
                <YAxis tick={{ fontSize: 11, fill: '#64748B' }} stroke="#94A3B8" tickFormatter={(v) => (isCurrency ? formatCurrency(v) : v.toLocaleString())} />
                <Tooltip content={(p) => {
                  const pp = p as unknown as { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string };
                  return <SkuTooltip active={pp.active} payload={pp.payload} label={pp.label as string | undefined} fmtVal={fmtVal} />;
                }} />
                {orderedSelected.map((o) => (
                  <Bar key={o.sku} dataKey={o.sku} name={o.sku} stackId="sku" fill={o.color} />
                ))}
                {completeTo100 && <Bar dataKey={OTHERS_KEY} name="Otros" stackId="sku" fill={OTHERS_COLOR} radius={[3, 3, 0, 0]} />}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SkuTooltip({
  active,
  payload,
  label,
  fmtVal,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
  fmtVal: (v: number) => string;
}) {
  if (!active || !payload || !payload.length) return null;
  const total = payload.reduce((a, e) => a + (e.value || 0), 0);
  const sorted = [...payload].filter((e) => e.value > 0).sort((a, b) => b.value - a.value);
  const shown = sorted.slice(0, 12);
  const restCount = sorted.length - shown.length;
  return (
    <div className="rounded-xl border border-border/50 bg-white p-3 shadow-xl max-w-[280px]">
      <p className="text-xs font-medium text-muted-foreground mb-2">{label ? fmtMonth(String(label)) : ''}</p>
      {shown.map((e, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: e.color }} />
          <span className="text-muted-foreground truncate flex-1">{e.name}:</span>
          <span className="font-semibold text-[#0E3687] tabular-nums">{fmtVal(e.value)}</span>
        </div>
      ))}
      {restCount > 0 && <p className="text-[10px] text-muted-foreground mt-1">+{restCount} SKUs más…</p>}
      <div className="mt-1.5 pt-1.5 border-t border-border/30 text-sm font-semibold text-[#0E3687]">Total: {fmtVal(total)}</div>
    </div>
  );
}
