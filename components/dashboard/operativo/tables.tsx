'use client';

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, Download, Palette, Check, Filter } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Definition, Grain, KpiValues } from '@/lib/kpi/replica';
import type { PeriodRow, GroupRow } from '../OperativoContent';
import { fmt, periodLabel, periodEnd, FINER, GRAIN_LABELS, GRAIN_SHORT, BREAKDOWN_COLS, downloadCsv, type Col } from './format';

type Sort = { key: string; dir: 'asc' | 'desc' };

/** Color de fondo tipo mapa de calor: verde = mejor extremo, rosa = peor; azul si el KPI no tiene dirección. */
function heatColor(v: number | null, min: number, max: number, col: Col): string | undefined {
  if (v === null || !Number.isFinite(v) || max === min) return undefined;
  const t = (v - min) / (max - min);
  if (col.higherIsBetter === undefined) return `rgba(0,134,216,${(t * 0.16).toFixed(3)})`;
  const g = col.higherIsBetter ? t : 1 - t;
  return g >= 0.5 ? `rgba(69,201,78,${((g - 0.5) * 2 * 0.22).toFixed(3)})` : `rgba(218,77,122,${((0.5 - g) * 2 * 0.16).toFixed(3)})`;
}

function useColumnRanges(values: KpiValues[], cols: Col[]) {
  return useMemo(() => Object.fromEntries(cols.map((c) => {
    const vs = values.map((v) => v[c.key] as number | null).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    return [c.key, vs.length ? { min: Math.min(...vs), max: Math.max(...vs) } : { min: 0, max: 0 }];
  })) as Record<string, { min: number; max: number }>, [values, cols]);
}

function SortHead({ label, k, sort, setSort, className }: { label: string; k: string; sort: Sort; setSort: (s: Sort) => void; className?: string }) {
  const active = sort.key === k;
  return (
    <th onClick={() => setSort({ key: k, dir: active && sort.dir === 'desc' ? 'asc' : 'desc' })}
      className={cn('sticky top-0 z-10 cursor-pointer select-none whitespace-nowrap border-b border-slate-200 bg-white px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500 transition-colors hover:text-[#0E3687]', active && 'text-[#0E3687]', className)}>
      <span className="inline-flex items-center gap-1">{label}{active ? (sort.dir === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />) : null}</span>
    </th>
  );
}

function ToolbarBtn({ on, onClick, children, title }: { on?: boolean; onClick: () => void; children: React.ReactNode; title: string }) {
  return (
    <button type="button" onClick={onClick} title={title}
      className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors', on ? 'border-[#0086D8]/40 bg-[#F0F7FF] text-[#0E3687]' : 'border-slate-200 bg-white text-slate-600 hover:border-[#0086D8]/40 hover:text-[#0E3687]')}>
      {children}
    </button>
  );
}

// ─── Tabla de KPIs por periodo ───────────────────────────────────────────────

export function KpiTable({ rows, grain, def, cols, total, rangeStart, rangeEnd, onDrill, name }: {
  rows: PeriodRow[]; grain: Grain; def: Definition; cols: Col[]; total: KpiValues; rangeStart: string; rangeEnd: string;
  onDrill?: (start: string, end: string, grain: Grain) => void; name: string;
}) {
  const [sort, setSort] = useState<Sort>({ key: 'period', dir: 'desc' });
  const [heat, setHeat] = useState(true);
  const ranges = useColumnRanges(useMemo(() => rows.map((r) => r[def]), [rows, def]), cols);
  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      const av = sort.key === 'period' ? a.period : (a[def][sort.key as keyof KpiValues] as number | null);
      const bv = sort.key === 'period' ? b.period : (b[def][sort.key as keyof KpiValues] as number | null);
      if (av === bv) return 0; if (av === null) return 1; if (bv === null) return -1;
      return (av < bv ? -1 : 1) * (sort.dir === 'asc' ? 1 : -1);
    });
    return out;
  }, [rows, sort, def]);
  const finer = FINER[grain];
  const drill = (p: string) => {
    if (!finer || !onDrill) return;
    const s = p < rangeStart ? rangeStart : p; const e0 = periodEnd(p, grain); const e = e0 > rangeEnd ? rangeEnd : e0;
    onDrill(s, e, finer);
  };
  const csv = () => downloadCsv(`operativo_${name}_${rangeStart}_${rangeEnd}.csv`, [GRAIN_LABELS[grain], ...cols.map((c) => c.label)],
    [...[...rows].reverse().map((r) => [r.period, ...cols.map((c) => r[def][c.key] as number | null)]), ['Total', ...cols.map((c) => total[c.key] as number | null)]]);

  return (
    <div className="rounded-xl border border-slate-200/80 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
        <p className="text-xs text-slate-500">
          {rows.length} {rows.length === 1 ? 'periodo' : 'periodos'} · clic en un encabezado para ordenar
          {finer && onDrill ? <> · clic en una fila para verla por {GRAIN_SHORT[finer]}</> : null}
        </p>
        <div className="flex items-center gap-1.5">
          <ToolbarBtn on={heat} onClick={() => setHeat((h) => !h)} title="Colorea cada columna: verde = mejor, rosa = peor dentro del periodo"><Palette className="h-3.5 w-3.5" />Mapa de calor</ToolbarBtn>
          <ToolbarBtn onClick={csv} title="Descargar la tabla en CSV"><Download className="h-3.5 w-3.5" />CSV</ToolbarBtn>
        </div>
      </div>
      <div className="max-h-[620px] overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <SortHead label={GRAIN_LABELS[grain]} k="period" sort={sort} setSort={setSort} className="left-0 z-20 text-left" />
              {cols.map((c) => <SortHead key={c.key} label={c.label} k={c.key} sort={sort} setSort={setSort} />)}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const est = def === 'fixed' && r.fixed.calibration.estimatedShare > 0.0005;
              return (
                <tr key={r.period} onClick={() => drill(r.period)} className={cn('group', finer && onDrill && 'cursor-pointer')}>
                  <td className="sticky left-0 z-[1] whitespace-nowrap border-b border-slate-100 bg-white px-3 py-2 font-medium text-slate-800 group-hover:bg-[#F0F7FF]"
                    title={est ? `${(r.fixed.calibration.estimatedShare * 100).toFixed(0)} % de las ventas de este periodo es estimado (tienda sin reporte definitivo)` : undefined}>
                    <span className="inline-flex items-center gap-1">
                      {est && <span className="text-amber-600">≈</span>}{periodLabel(r.period, grain)}
                      {finer && onDrill && <ChevronRight className="h-3 w-3 text-slate-300 opacity-0 transition-opacity group-hover:opacity-100" />}
                    </span>
                  </td>
                  {cols.map((c) => {
                    const v = r[def][c.key] as number | null;
                    return (
                      <td key={c.key} className="whitespace-nowrap border-b border-slate-100 px-3 py-2 text-right tabular-nums text-slate-700 group-hover:bg-[#F0F7FF]/70"
                        style={heat ? { backgroundColor: heatColor(v, ranges[c.key].min, ranges[c.key].max, c) } : undefined}>
                        {fmt(v, c.fmt)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td className="sticky bottom-0 left-0 z-20 border-t border-slate-200 bg-slate-50 px-3 py-2.5 font-semibold text-[#0E3687]">Total</td>
              {cols.map((c) => <td key={c.key} className="sticky bottom-0 z-10 whitespace-nowrap border-t border-slate-200 bg-slate-50 px-3 py-2.5 text-right font-semibold tabular-nums text-[#0E3687]">{fmt(total[c.key] as number | null, c.fmt)}</td>)}
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="border-t border-slate-100 px-4 py-2 text-[11px] text-muted-foreground">
        La fila Total recalcula cada KPI sobre las sumas del periodo completo (como el Looker), no promedia las filas.{def === 'fixed' ? ' ≈ = el periodo incluye ventas estimadas (la tienda aún no publica su reporte definitivo).' : ''}
      </p>
    </div>
  );
}

// ─── Tabla de desglose por dimensión (clic = filtrar) ────────────────────────

export function BreakdownTable({ title, rows, def, total, selected, onToggle }: {
  title: string; rows: GroupRow[]; def: Definition; total: KpiValues; selected: string[]; onToggle: (value: string) => void;
}) {
  const [sort, setSort] = useState<Sort>({ key: 'nsSales', dir: 'desc' });
  const [all, setAll] = useState(false);
  const [heat, setHeat] = useState(false);
  const ranges = useColumnRanges(useMemo(() => rows.map((r) => r[def]), [rows, def]), BREAKDOWN_COLS);
  const sorted = useMemo(() => {
    const key = sort.key === 'share' ? 'nsSales' : sort.key;
    const out = [...rows].sort((a, b) => {
      if (key === 'grp') return a.grp.localeCompare(b.grp) * (sort.dir === 'asc' ? 1 : -1);
      const av = a[def][key as keyof KpiValues] as number | null; const bv = b[def][key as keyof KpiValues] as number | null;
      if (av === bv) return 0; if (av === null) return 1; if (bv === null) return -1;
      return (av < bv ? -1 : 1) * (sort.dir === 'asc' ? 1 : -1);
    });
    return all ? out : out.slice(0, 15);
  }, [rows, sort, def, all]);
  const maxShare = Math.max(0.0001, ...rows.map((r) => (total.nsSales ? r[def].nsSales / total.nsSales : 0)));
  const csv = () => downloadCsv(`operativo_desglose_${title}.csv`, [title, 'share NS', ...BREAKDOWN_COLS.map((c) => c.label)],
    rows.map((r) => [r.grp, total.nsSales ? r[def].nsSales / total.nsSales : null, ...BREAKDOWN_COLS.map((c) => r[def][c.key] as number | null)]));

  return (
    <div className="rounded-xl border border-slate-200/80 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
        <div>
          <h3 className="text-sm font-semibold text-[#0E3687]">{title}</h3>
          <p className="text-[11px] text-slate-500 inline-flex items-center gap-1"><Filter className="h-3 w-3" />Clic en una fila para filtrar todo el dashboard por ese valor{selected.length ? ' (clic otra vez para quitarlo)' : ''}</p>
        </div>
        <div className="flex items-center gap-1.5">
          {rows.length > 15 && <ToolbarBtn on={all} onClick={() => setAll((a) => !a)} title="Mostrar todas las filas">{all ? 'Top 15' : `Ver las ${rows.length}`}</ToolbarBtn>}
          <ToolbarBtn on={heat} onClick={() => setHeat((h) => !h)} title="Colorea cada columna: verde = mejor, rosa = peor"><Palette className="h-3.5 w-3.5" />Mapa de calor</ToolbarBtn>
          <ToolbarBtn onClick={csv} title="Descargar en CSV"><Download className="h-3.5 w-3.5" />CSV</ToolbarBtn>
        </div>
      </div>
      <div className="max-h-[560px] overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <SortHead label={title} k="grp" sort={sort} setSort={setSort} className="left-0 z-20 text-left" />
              <SortHead label="share NS" k="share" sort={sort} setSort={setSort} className="min-w-[140px]" />
              {BREAKDOWN_COLS.map((c) => <SortHead key={c.key} label={c.label} k={c.key} sort={sort} setSort={setSort} />)}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const share = total.nsSales ? r[def].nsSales / total.nsSales : null;
              const isSel = selected.includes(r.grp);
              return (
                <tr key={r.grp} onClick={() => onToggle(r.grp)} className="group cursor-pointer" title={isSel ? 'Quitar este filtro' : `Filtrar por ${r.grp}`}>
                  <td className={cn('sticky left-0 z-[1] whitespace-nowrap border-b border-slate-100 px-3 py-2 font-medium text-slate-800 group-hover:bg-[#F0F7FF]', isSel ? 'bg-[#F0F7FF]' : 'bg-white')}>
                    <span className="inline-flex items-center gap-1.5">{isSel && <Check className="h-3.5 w-3.5 text-[#0086D8]" />}{r.grp}</span>
                  </td>
                  <td className="border-b border-slate-100 px-3 py-2 group-hover:bg-[#F0F7FF]/70">
                    <div className="flex items-center justify-end gap-2">
                      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-[#0086D8]" style={{ width: `${share !== null ? Math.max(2, (share / maxShare) * 100) : 0}%` }} /></div>
                      <span className="w-12 text-right tabular-nums text-slate-500">{share !== null ? fmt(share, 'pct') : '—'}</span>
                    </div>
                  </td>
                  {BREAKDOWN_COLS.map((c) => {
                    const v = r[def][c.key] as number | null;
                    return (
                      <td key={c.key} className="whitespace-nowrap border-b border-slate-100 px-3 py-2 text-right tabular-nums text-slate-700 group-hover:bg-[#F0F7FF]/70"
                        style={heat ? { backgroundColor: heatColor(v, ranges[c.key].min, ranges[c.key].max, c) } : undefined}>{fmt(v, c.fmt)}</td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
