'use client';

import { CalendarClock, TrendingUp, TrendingDown } from 'lucide-react';
import type { Definition, KpiValues } from '@/lib/kpi/replica';
import type { TodayBlock } from '@/components/dashboard/OperativoContent';
import { dayLabelEs, isoWeekday } from '@/lib/kpi/period';
import { cn } from '@/lib/utils';
import { fmt, type Fmt } from './format';

// ─── Franja "Hoy": cómo va el día y hacia dónde pinta (estimado de cierre) ────
//
// Por KPI: el estimado de cierre (lo que va ÷ fracción del día ya transcurrida al corte de los
// datos) como número grande, "lo que va" debajo, y el delta vs el promedio del mismo día de
// semana (últimos N). Los KPIs que son razones (CAC) no se proyectan: son invariantes a la escala
// —numerador y denominador crecen parejo—, así que su valor "a ritmo de hoy" ya es el estimado.

type Key = Exclude<keyof KpiValues, 'calibration'>;
interface Card { key: Key; label: string; fmt: Fmt; higherIsBetter: boolean; project: boolean }

const CARDS: Card[] = [
  { key: 'signups', label: 'Signups', fmt: 'int', higherIsBetter: true, project: true },
  { key: 'newSubs', label: 'New Subs', fmt: 'int', higherIsBetter: true, project: true },
  { key: 'nsSales', label: 'NS Sales', fmt: 'usd', higherIsBetter: true, project: true },
  { key: 'totalContribution', label: 'Total Contribution', fmt: 'usd', higherIsBetter: true, project: true },
  { key: 'spend', label: 'Spend', fmt: 'usd', higherIsBetter: false, project: true },
  { key: 'cac', label: 'CAC', fmt: 'usd2', higherIsBetter: false, project: false },
];

const DOW = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (w: string) => (w.endsWith('s') ? w : w + 's'); // lunes→lunes, sábado→sábados

function baselineNote(t: TodayBlock): string {
  if (!t.baselineDays) return 'Sin base del mismo día de semana para comparar.';
  return `Comparado vs el promedio de los últimos ${t.baselineDays} ${plural(DOW[isoWeekday(t.date)])}.`;
}

function Header({ today, pct }: { today: TodayBlock; pct: number | null }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
      <div className="flex items-center gap-2">
        <CalendarClock className="h-4 w-4 text-[#0E3687]" />
        <h2 className="text-sm font-semibold text-[#0E3687]">Hoy · {cap(dayLabelEs(today.date))}</h2>
      </div>
      <p className="text-[11px] text-slate-500 tabular-nums">
        {today.cutoffLabel ? `corte ${today.cutoffLabel}` : 'sin corte'}
        {pct !== null ? ` · ${pct}% del día` : ''}
        {today.tooEarly ? ' · muy temprano para estimar' : ''}
      </p>
    </div>
  );
}

export function TodayStrip({ today, def }: { today: TodayBlock; def: Definition }) {
  const pct = today.fraction !== null ? Math.round(today.fraction * 100) : null;

  if (today.stale || !today.hasData) {
    return (
      <section className="rounded-xl border border-slate-200/80 bg-white px-4 py-3 shadow-sm">
        <Header today={today} pct={pct} />
        <p className="mt-2 text-xs text-slate-500">
          {today.stale
            ? `Aún no hay sync de hoy${today.cutoffLabel ? ` (último corte ${today.cutoffLabel})` : ''}. La franja se llena en cuanto el dato de hoy llega a la réplica.`
            : 'Aún no hay movimiento registrado hoy.'}
        </p>
      </section>
    );
  }

  const run = today.running[def];
  const proj = today.projected?.[def] ?? null;
  const base = today.baseline?.[def] ?? null;

  return (
    <section className="rounded-xl border border-[#0E3687]/15 bg-gradient-to-br from-[#0E3687]/[0.04] to-transparent px-4 py-3.5 shadow-sm">
      <Header today={today} pct={pct} />
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {CARDS.map((c) => {
          const running = run[c.key] as number | null;
          const projected = c.project && proj ? (proj[c.key] as number | null) : null;
          // Para una razón (CAC) el valor "a ritmo de hoy" ya es el estimado; para montos/conteos,
          // el estimado es la proyección si existe, si no cae a lo que va (temprano, sin proyectar).
          const headline = c.project ? (projected ?? running) : running;
          const estimated = c.project && projected !== null;
          // El delta solo es justo cuando se compara día completo contra día completo: proyección
          // (montos) o razón (invariante). Lo que va a medio día vs un día entero no es comparable.
          const comparable = c.project ? estimated : true;
          const baseVal = base ? (base[c.key] as number | null) : null;
          const delta = comparable && headline !== null && baseVal !== null && baseVal !== 0 ? (headline - baseVal) / Math.abs(baseVal) : null;
          const good = delta === null ? null : c.higherIsBetter ? delta >= 0 : delta <= 0;
          return (
            <div key={c.key} className="rounded-lg border border-slate-200/70 bg-white px-3 pb-2 pt-2.5">
              <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{c.label}</p>
              <div className="mt-0.5 flex items-baseline gap-1">
                <span className="text-xl font-bold tracking-tight text-[#0E3687] tabular-nums">{fmt(headline, c.fmt)}</span>
                {estimated && <span className="text-[10px] font-semibold text-amber-600" title="Estimado de cierre a ritmo lineal">est.</span>}
              </div>
              <p className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
                {c.project ? `van ${fmt(running, c.fmt)}` : 'al ritmo de hoy'}
              </p>
              <div className="mt-1 text-[11px]">
                {delta === null ? <span className="text-slate-300">—</span> : (
                  <span className={cn('inline-flex items-center gap-0.5 font-semibold', good ? 'text-emerald-600' : 'text-rose-600')}>
                    {delta >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                    {delta >= 0 ? '+' : ''}{(delta * 100).toFixed(0)}% <span className="font-normal text-slate-400">vs prom.</span>
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-slate-400">
        {baselineNote(today)} El estimado proyecta el cierre a ritmo lineal (lo que va ÷ fracción del día al corte); el <b>spend</b> suele llegar con retraso, así que temprano puede quedar corto y el CAC inflado.
      </p>
    </section>
  );
}
