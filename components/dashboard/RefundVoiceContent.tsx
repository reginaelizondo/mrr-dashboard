'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter, usePathname } from 'next/navigation';
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
  ReferenceLine,
} from 'recharts';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { MultiSelect } from '@/components/ui/multi-select';
import { Lightbulb, MessageSquareWarning, TrendingUp } from 'lucide-react';
import type {
  RefundVoiceData,
  RefundVoiceMonthRow,
  TopicRefundCorrelationRow,
} from '@/lib/refund-voice';

type Preset = '3m' | '6m' | '12m' | 'ytd' | 'custom';
type Granularity = 'monthly' | 'weekly';

interface Props {
  data: RefundVoiceData;
  availableTerritories: string[];
  preset: Preset;
  granularity: Granularity;
  startMonth: string;
  endMonth: string;
  selectedTerritories: string[];
}

const PRESETS: { key: Preset; label: string }[] = [
  { key: '3m', label: '3M' },
  { key: '6m', label: '6M' },
  { key: '12m', label: '12M' },
  { key: 'ytd', label: 'YTD' },
];

const MONTHS_ES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

function formatMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS_ES[(m || 1) - 1]} ${String(y).slice(2)}`;
}

function formatWeek(weekStart: string, weekEnd?: string): string {
  // YYYY-MM-DD → "30 Mar – 5 Abr"
  const [, sm, sd] = weekStart.split('-').map(Number);
  if (!weekEnd) return `${sd} ${MONTHS_ES[(sm || 1) - 1]}`;
  const [, em, ed] = weekEnd.split('-').map(Number);
  if (sm === em) return `${sd}–${ed} ${MONTHS_ES[(sm || 1) - 1]}`;
  return `${sd} ${MONTHS_ES[(sm || 1) - 1]} – ${ed} ${MONTHS_ES[(em || 1) - 1]}`;
}

function formatPeriod(period: string, granularity: Granularity, weekEnd?: string): string {
  if (granularity === 'weekly') return formatWeek(period, weekEnd);
  // Monthly periods are YYYY-MM
  return formatMonth(period.length >= 7 ? period.slice(0, 7) : period);
}

function fmtPct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function RefundVoiceContent({
  data,
  availableTerritories,
  preset,
  granularity,
  selectedTerritories,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [, startTransition] = useTransition();
  const [focusMonth, setFocusMonth] = useState<string | null>(null);

  const nav = (url: string) => startTransition(() => router.push(url));

  function urlParams(overrides: Record<string, string | undefined>): string {
    const sp = new URLSearchParams();
    sp.set('preset', preset);
    if (granularity === 'weekly') sp.set('granularity', 'weekly');
    if (selectedTerritories.length > 0)
      sp.set('territories', selectedTerritories.join(','));
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined || v === '') sp.delete(k);
      else sp.set(k, v);
    }
    return sp.toString();
  }

  const setPreset = (next: Preset) =>
    nav(`${pathname}?${urlParams({ preset: next })}`);
  const setTerritories = (next: string[]) =>
    nav(
      `${pathname}?${urlParams({
        territories: next.length > 0 ? next.join(',') : undefined,
      })}`
    );
  const setGranularity = (next: Granularity) =>
    nav(
      `${pathname}?${urlParams({
        granularity: next === 'weekly' ? 'weekly' : undefined,
      })}`
    );

  // --- Chart data ---
  const chartData = useMemo(
    () =>
      data.monthly.map((r) => ({
        month: r.month,
        label: formatPeriod(r.month, granularity, r.week_end),
        refund_rate_pct: +(r.refund_rate * 100).toFixed(2),
        negative_reviews: r.negative_reviews,
        total_reviews: r.total_reviews,
        avg_rating: +r.avg_rating.toFixed(2),
      })),
    [data.monthly, granularity]
  );

  const topicChartData = useMemo(
    () =>
      data.topicCorrelation.slice(0, 8).map((r) => ({
        topic: r.topic,
        label: r.label,
        review_count: r.review_count,
        refund_rate_pct: +(r.weighted_refund_rate * 100).toFixed(2),
        lift: +r.lift_vs_baseline.toFixed(2),
      })),
    [data.topicCorrelation]
  );

  const selectedMonth =
    (focusMonth && data.monthly.find((m) => m.month === focusMonth)) ||
    data.monthly[data.monthly.length - 1] ||
    null;

  // --- Top insight: the topic with highest lift ---
  const topInsight: TopicRefundCorrelationRow | null =
    data.topicCorrelation.find((t) => t.lift_vs_baseline > 1.1) ||
    data.topicCorrelation[0] ||
    null;

  return (
    <div className="flex flex-col gap-6">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 bg-white rounded-lg border p-1">
          {PRESETS.map((p) => (
            <Button
              key={p.key}
              variant={preset === p.key ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setPreset(p.key)}
              className={
                preset === p.key ? 'bg-[#0E3687] hover:bg-[#0A2A6B]' : ''
              }
            >
              {p.label}
            </Button>
          ))}
        </div>

        <div className="flex gap-1 bg-white rounded-lg border p-1">
          {(['monthly', 'weekly'] as Granularity[]).map((g) => (
            <Button
              key={g}
              variant={granularity === g ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setGranularity(g)}
              className={
                granularity === g ? 'bg-[#0E3687] hover:bg-[#0A2A6B]' : ''
              }
            >
              {g === 'monthly' ? 'Mensual' : 'Semanal'}
            </Button>
          ))}
        </div>

        <MultiSelect
          options={availableTerritories.map((t) => ({ value: t, label: t }))}
          selected={selectedTerritories}
          onChange={setTerritories}
          placeholder="All territories"
          maxWidth="240px"
        />

        <div className="ml-auto text-xs text-muted-foreground">
          Baseline refund rate (ventana):{' '}
          <strong className="text-foreground">
            {fmtPct(data.baselineRefundRate)}
          </strong>
        </div>
      </div>

      {!data.hasData && (
        <Card>
          <CardContent className="pt-6 text-center text-muted-foreground">
            No hay datos suficientes en este rango. Prueba ampliar el período
            o quitar filtros de territorio.
          </CardContent>
        </Card>
      )}

      {data.hasData && (
        <>
          {/* Top insight banner */}
          {topInsight && (
            <Card className="border-l-4 border-l-amber-500 bg-amber-50/50">
              <CardContent className="pt-5 pb-5">
                <div className="flex items-start gap-3">
                  <Lightbulb className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
                  <div>
                    <div className="text-sm font-semibold text-foreground">
                      Señal más fuerte:{' '}
                      <span className="text-amber-800">
                        {topInsight.label}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      Las reviews negativas que mencionan{' '}
                      <strong>{topInsight.label.toLowerCase()}</strong>{' '}
                      coinciden con un refund rate de{' '}
                      <strong>
                        {fmtPct(topInsight.weighted_refund_rate)}
                      </strong>{' '}
                      en el mismo mes×país — {topInsight.lift_vs_baseline >= 1
                        ? `${((topInsight.lift_vs_baseline - 1) * 100).toFixed(0)}% por encima`
                        : `${((1 - topInsight.lift_vs_baseline) * 100).toFixed(0)}% por debajo`}{' '}
                      del baseline ({fmtPct(data.baselineRefundRate)}).
                      Basado en {topInsight.review_count} reviews negativas
                      del período.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Monthly correlation chart */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-[#0E3687]" />
                Refund rate vs. reviews negativas por mes
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Barras = refund rate (%). Línea = # reviews con rating ≤ 2.
                Haz clic en un mes para ver las quejas y verbatims de ese mes.
              </p>
            </CardHeader>
            <CardContent>
              <div className="h-80">
                <ResponsiveContainer>
                  <ComposedChart
                    data={chartData}
                    onClick={(e: unknown) => {
                      const ev = e as
                        | { activePayload?: { payload?: { month?: string } }[] }
                        | null;
                      const m = ev?.activePayload?.[0]?.payload?.month;
                      if (m) setFocusMonth(m);
                    }}
                    margin={{ top: 10, right: 20, left: 10, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                    <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                    <YAxis
                      yAxisId="left"
                      tickFormatter={(v) => `${v}%`}
                      tick={{ fontSize: 12 }}
                      label={{
                        value: 'Refund rate',
                        angle: -90,
                        position: 'insideLeft',
                        style: { fontSize: 11, fill: '#666' },
                      }}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      tick={{ fontSize: 12 }}
                      label={{
                        value: 'Reviews ≤2★',
                        angle: 90,
                        position: 'insideRight',
                        style: { fontSize: 11, fill: '#666' },
                      }}
                    />
                    <Tooltip
                      formatter={((val: unknown, name: unknown) => {
                        if (name === 'Refund rate')
                          return [`${val}%`, 'Refund rate'];
                        return [val as number | string, name as string];
                      }) as never}
                    />
                    <Legend />
                    <ReferenceLine
                      yAxisId="left"
                      y={+(data.baselineRefundRate * 100).toFixed(2)}
                      stroke="#999"
                      strokeDasharray="4 4"
                      label={{
                        value: 'Baseline',
                        position: 'insideTopRight',
                        fontSize: 10,
                        fill: '#666',
                      }}
                    />
                    <Bar
                      yAxisId="left"
                      dataKey="refund_rate_pct"
                      name="Refund rate"
                      fill="#DC2626"
                      cursor="pointer"
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="negative_reviews"
                      name="Reviews negativas"
                      stroke="#0E3687"
                      strokeWidth={2}
                      dot={{ r: 3 }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* Topic → Refund Rate bar chart */}
          {topicChartData.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MessageSquareWarning className="h-5 w-5 text-[#0E3687]" />
                  Refund rate por tipo de queja
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Para cada topic, el refund rate del mismo mes×país donde
                  apareció la queja (ponderado por volumen de reviews). Línea
                  punteada = baseline del período.
                </p>
              </CardHeader>
              <CardContent>
                <div className="h-72">
                  <ResponsiveContainer>
                    <ComposedChart
                      data={topicChartData}
                      margin={{ top: 10, right: 20, left: 10, bottom: 40 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 11 }}
                        angle={-25}
                        textAnchor="end"
                        interval={0}
                        height={60}
                      />
                      <YAxis
                        tickFormatter={(v) => `${v}%`}
                        tick={{ fontSize: 12 }}
                      />
                      <Tooltip
                        formatter={((val: unknown, name: unknown) => {
                          if (name === 'Refund rate')
                            return [`${val}%`, 'Refund rate'];
                          return [val as number | string, name as string];
                        }) as never}
                        labelFormatter={((label: unknown, payload: unknown) => {
                          const arr = payload as
                            | { payload?: (typeof topicChartData)[number] }[]
                            | undefined;
                          const p = arr?.[0]?.payload;
                          return p
                            ? `${label as string} — ${p.review_count} reviews · lift ×${p.lift}`
                            : (label as string);
                        }) as never}
                      />
                      <Legend />
                      <ReferenceLine
                        y={+(data.baselineRefundRate * 100).toFixed(2)}
                        stroke="#999"
                        strokeDasharray="4 4"
                      />
                      <Bar
                        dataKey="refund_rate_pct"
                        name="Refund rate"
                        fill="#0E3687"
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Monthly detail: top topics + verbatims */}
          <Card>
            <CardHeader>
              <CardTitle>
                Detalle{granularity === 'weekly' ? ' semanal' : ' mensual'}{' '}
                {selectedMonth && (
                  <span className="text-muted-foreground font-normal">
                    — {formatPeriod(selectedMonth.month, granularity, selectedMonth.week_end)}
                  </span>
                )}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Selecciona un {granularity === 'weekly' ? 'período' : 'mes'} en la gráfica superior para enfocar el
                detalle.
              </p>
            </CardHeader>
            <CardContent>
              {selectedMonth ? (
                <MonthDetail row={selectedMonth} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Sin datos para mostrar.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Full table */}
          <Card>
            <CardHeader>
              <CardTitle>Tabla mensual</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-4">{granularity === 'weekly' ? 'Semana' : 'Mes'}</th>
                    <th className="py-2 pr-4 text-right">Refunds</th>
                    <th className="py-2 pr-4 text-right">Charges</th>
                    <th className="py-2 pr-4 text-right">Refund rate</th>
                    <th className="py-2 pr-4 text-right">Total reviews</th>
                    <th className="py-2 pr-4 text-right">Negativas</th>
                    <th className="py-2 pr-4 text-right">★ prom</th>
                    <th className="py-2">Top 3 quejas</th>
                  </tr>
                </thead>
                <tbody>
                  {data.monthly.map((r) => (
                    <tr
                      key={r.month}
                      className={`border-b hover:bg-gray-50 cursor-pointer ${
                        focusMonth === r.month ? 'bg-blue-50/40' : ''
                      }`}
                      onClick={() => setFocusMonth(r.month)}
                    >
                      <td className="py-2 pr-4 font-medium">
                        {formatPeriod(r.month, granularity, r.week_end)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {r.refund_units.toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {r.charge_units.toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        <span
                          className={
                            r.refund_rate > data.baselineRefundRate * 1.1
                              ? 'text-red-700 font-semibold'
                              : ''
                          }
                        >
                          {fmtPct(r.refund_rate)}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {r.total_reviews.toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {r.negative_reviews.toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {r.avg_rating > 0 ? r.avg_rating.toFixed(2) : '—'}
                      </td>
                      <td className="py-2 text-xs">
                        {r.top_topics.length > 0
                          ? r.top_topics
                              .map((t) => `${t.label} (${t.count})`)
                              .join(' · ')
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function MonthDetail({ row }: { row: RefundVoiceMonthRow }) {
  if (row.negative_reviews === 0 && row.refund_units === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Sin reviews negativas ni refunds en este mes.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div>
        <h4 className="text-xs uppercase text-muted-foreground font-semibold mb-3">
          Top quejas en reviews ≤2★
        </h4>
        {row.top_topics.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No hubo reviews negativas este mes.
          </p>
        ) : (
          <ul className="space-y-2">
            {row.top_topics.map((t) => (
              <li
                key={t.topic}
                className="flex items-center justify-between text-sm"
              >
                <span>{t.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {t.count} {t.count === 1 ? 'review' : 'reviews'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="text-xs uppercase text-muted-foreground font-semibold mb-3">
          Verbatims recientes
        </h4>
        {row.samples.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin verbatims.</p>
        ) : (
          <ul className="space-y-3">
            {row.samples.map((s) => (
              <li
                key={s.review_id}
                className="border-l-2 border-red-300 pl-3 py-1"
              >
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="text-red-600 font-semibold">
                    {'★'.repeat(s.rating)}
                    {'☆'.repeat(5 - s.rating)}
                  </span>
                  <span>· {s.territory}</span>
                  <span>· {s.created_at.slice(0, 10)}</span>
                  {s.primary_topic && (
                    <span className="px-1.5 py-0.5 rounded bg-gray-100">
                      {s.primary_topic}
                    </span>
                  )}
                </div>
                {s.title && (
                  <div className="text-sm font-medium mt-1">{s.title}</div>
                )}
                {s.body && (
                  <p className="text-sm text-muted-foreground mt-1 line-clamp-3">
                    {s.body}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
