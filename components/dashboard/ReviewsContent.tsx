'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { MultiSelect } from '@/components/ui/multi-select';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ComposedChart,
  Line,
  Cell,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MetricCard } from '@/components/dashboard/MetricCard';
import {
  Star,
  MessageSquare,
  AlertTriangle,
  TrendingDown,
  Globe,
  Filter,
  Info,
  Users,
  Clock,
} from 'lucide-react';
import {
  TOPIC_LABELS,
  type ReviewTopic,
  type MonthlyReviewRow,
  type TopicCountRow,
  type TerritoryRow,
  type ReviewRow,
  type RatingsSummary,
} from '@/lib/reviews';
import type { Insight, InsightSeverity } from '@/lib/review-insights';
import { Lightbulb, CheckCircle2, AlertCircle } from 'lucide-react';

type Preset = '3m' | '6m' | '12m' | 'ytd' | 'since2025' | 'all' | 'custom';

interface Summary {
  total: number;
  avg_rating: number;
  negative: number;
  negative_rate: number;
  positive: number;
  positive_rate: number;
  territories: number;
}

interface LastSyncInfo {
  completedAt: string | null;
  records: number;
  status: string | null;
  latestReviewDate: string | null;
  latestRatingsSnapshot: string | null;
}

interface Props {
  monthly: MonthlyReviewRow[];
  topics: TopicCountRow[];
  topicsByMonth: Record<string, Record<string, number>>;
  territories: TerritoryRow[];
  recent: ReviewRow[];
  summary: Summary;
  ratingsSummary: RatingsSummary;
  insights: Insight[];
  availableTerritories: string[];
  lastSync: LastSyncInfo;
  preset: Preset;
  startDate: string;
  endDate: string;
  selectedTopic?: string;
  selectedTerritories: string[];
}

function formatTimeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const PRESETS: { key: Preset; label: string }[] = [
  { key: '3m', label: '3M' },
  { key: '6m', label: '6M' },
  { key: '12m', label: '12M' },
  { key: 'ytd', label: 'YTD' },
  { key: 'since2025', label: 'Desde Ene 2025' },
  { key: 'all', label: 'Todo' },
];

const MONTHS_ES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

function formatMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS_ES[(m || 1) - 1]} ${String(y).slice(2)}`;
}

// Territory ISO-3 → flag emoji
function territoryFlag(iso3: string): string {
  const map: Record<string, string> = {
    MEX: '🇲🇽', USA: '🇺🇸', ESP: '🇪🇸', ARG: '🇦🇷', COL: '🇨🇴', CHL: '🇨🇱',
    PER: '🇵🇪', BRA: '🇧🇷', VEN: '🇻🇪', ECU: '🇪🇨', URY: '🇺🇾', BOL: '🇧🇴',
    GTM: '🇬🇹', CRI: '🇨🇷', PAN: '🇵🇦', DOM: '🇩🇴', PRY: '🇵🇾', HND: '🇭🇳',
    SLV: '🇸🇻', NIC: '🇳🇮', CAN: '🇨🇦', GBR: '🇬🇧', FRA: '🇫🇷', DEU: '🇩🇪',
    ITA: '🇮🇹', PRT: '🇵🇹', AUS: '🇦🇺', NZL: '🇳🇿', IND: '🇮🇳', JPN: '🇯🇵',
    KOR: '🇰🇷', CHN: '🇨🇳', RUS: '🇷🇺', TUR: '🇹🇷', NLD: '🇳🇱', BEL: '🇧🇪',
  };
  return map[iso3] || '🌐';
}

const COMPLAINT_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
  '#8b5cf6', '#a855f7', '#d946ef',
];

export function ReviewsContent({
  monthly,
  topics,
  topicsByMonth,
  territories,
  recent,
  summary,
  ratingsSummary,
  insights,
  availableTerritories,
  lastSync,
  preset,
  startDate,
  endDate,
  selectedTopic,
  selectedTerritories,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [expandedReview, setExpandedReview] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const nav = (url: string) => startTransition(() => router.push(url));

  function urlParams(overrides: Record<string, string | undefined>): string {
    const sp = new URLSearchParams();
    sp.set('preset', preset);
    if (preset === 'custom') {
      sp.set('start', startDate);
      sp.set('end', endDate);
    }
    if (selectedTopic) sp.set('topic', selectedTopic);
    if (selectedTerritories.length > 0) sp.set('territories', selectedTerritories.join(','));
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined || v === '') sp.delete(k);
      else sp.set(k, v);
    }
    return sp.toString();
  }

  function setPreset(next: Preset) {
    nav(`${pathname}?${urlParams({ preset: next, start: undefined, end: undefined })}`);
  }
  function setCustomRange(start: string, end: string) {
    nav(`${pathname}?${urlParams({ preset: 'custom', start, end })}`);
  }
  function setTopic(next: string | undefined) {
    nav(`${pathname}?${urlParams({ topic: next })}`);
  }
  function setTerritories(next: string[]) {
    nav(`${pathname}?${urlParams({ territories: next.length > 0 ? next.join(',') : undefined })}`);
  }

  // Monthly stacked rating chart
  const monthlyChartData = useMemo(
    () =>
      monthly.map((m) => ({
        month: formatMonth(m.month),
        '★1': m.r1,
        '★2': m.r2,
        '★3': m.r3,
        '★4': m.r4,
        '★5': m.r5,
        avg: Number(m.avg_rating.toFixed(2)),
        negRate: Number(((m.negative / (m.total || 1)) * 100).toFixed(1)),
      })),
    [monthly]
  );

  // Top 8 complaint topics for the trend chart
  const top8Topics = useMemo(() => topics.slice(0, 8).map((t) => t.topic), [topics]);

  const topicsTrendData = useMemo(() => {
    const sortedMonths = Object.keys(topicsByMonth).sort();
    return sortedMonths.map((m) => {
      const row: Record<string, number | string> = { month: formatMonth(m) };
      for (const t of top8Topics) row[TOPIC_LABELS[t as ReviewTopic] || t] = topicsByMonth[m][t] || 0;
      return row;
    });
  }, [topicsByMonth, top8Topics]);

  const negativeReviewsCount =
    recent.length > 0 && selectedTopic
      ? recent.length
      : recent.length;

  // Filtered topics for topic filter chips
  const topicChips = useMemo(
    () => topics.slice(0, 12),
    [topics]
  );

  return (
    <>
      {isPending && (
        <div className="fixed top-0 left-0 right-0 z-50 h-0.5 bg-[#0086D8] animate-pulse" />
      )}
      <div className={`flex flex-col gap-6 ${isPending ? 'opacity-60 transition-opacity pointer-events-none' : 'transition-opacity'}`}>
      {/* Date range + Country filter */}
      <Card className="border border-border/60">
        <CardContent className="py-4 space-y-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs uppercase tracking-wider text-muted-foreground mr-1">
                Período
              </span>
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => setPreset(p.key)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    preset === p.key
                      ? 'bg-[#0086D8] text-white'
                      : 'bg-white border border-border text-muted-foreground hover:bg-[#F0F4FF]'
                  }`}
                >
                  {p.label}
                </button>
              ))}
              <div className="flex items-center gap-1.5 ml-1">
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setCustomRange(e.target.value, endDate)}
                  className="text-xs border border-border rounded px-2 py-1 bg-white"
                />
                <span className="text-xs text-muted-foreground">→</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setCustomRange(startDate, e.target.value)}
                  className="text-xs border border-border rounded px-2 py-1 bg-white"
                />
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              iOS · App Store Connect · {summary.total.toLocaleString()} reviews
            </div>
          </div>
          {/* Country dropdown */}
          {availableTerritories.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-border/40">
              <MultiSelect
                label="País"
                options={availableTerritories.map((iso3) => ({
                  value: iso3,
                  label: iso3,
                  hint: territoryFlag(iso3),
                }))}
                selected={selectedTerritories}
                onChange={setTerritories}
                allLabel="Todos los países"
              />
            </div>
          )}

          {/* Sync status row */}
          <div className="flex items-center gap-2 pt-3 border-t border-border/40 flex-wrap">
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              Last App Store Connect sync:{' '}
              <span className="font-medium text-[#0E3687]">
                {formatTimeAgo(lastSync.completedAt)}
              </span>
              {lastSync.completedAt && (
                <>
                  {' '}· {new Date(lastSync.completedAt).toLocaleString()}
                </>
              )}
              {lastSync.latestReviewDate && (
                <>
                  {' '}· newest review{' '}
                  <span className="font-medium text-[#0E3687]">
                    {lastSync.latestReviewDate.slice(0, 10)}
                  </span>
                </>
              )}
              {lastSync.latestRatingsSnapshot && (
                <>
                  {' '}· ratings snapshot{' '}
                  <span className="font-medium text-[#0E3687]">
                    {lastSync.latestRatingsSnapshot}
                  </span>
                </>
              )}
              {lastSync.status === 'error' && (
                <span className="ml-2 text-red-600 font-medium">⚠️ last sync errored</span>
              )}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Insights & Recommendations — shown up top so user sees key findings first */}
      <InsightsSection insights={insights} />

      {/* Disclaimer banner — critical context on the two datasets */}
      <Card className="border-l-4 border-l-[#0086D8] bg-[#0086D8]/[0.04]">
        <CardContent className="py-4">
          <div className="flex gap-3">
            <Info className="h-5 w-5 text-[#0086D8] flex-shrink-0 mt-0.5" />
            <div className="text-sm space-y-1">
              <p className="font-semibold text-[#0E3687]">
                Importante: Apple expone dos datasets distintos
              </p>
              <p className="text-muted-foreground leading-relaxed">
                <strong>1. Ratings totales</strong> ({ratingsSummary.total_ratings.toLocaleString()} con avg {ratingsSummary.weighted_avg.toFixed(2)}⭐):
                usuarios que tocaron 1-5 estrellas, con o sin escribir. Coincide con el panel ASC "Valoraciones y reseñas".
                Solo contamos el <em>total</em> y <em>promedio</em> — Apple no da acceso al contenido ni ratings individuales.
              </p>
              <p className="text-muted-foreground leading-relaxed">
                <strong>2. Reviews escritas</strong> ({summary.total.toLocaleString()} con avg {summary.avg_rating.toFixed(2)}⭐):
                subconjunto donde el usuario escribió título+texto. Solo esta capa permite análisis de contenido, categorización de quejas y tendencias de temas.
                Este grupo tiene un sesgo fuerte: los usuarios solo escriben cuando están muy enojados (1⭐) o muy contentos (5⭐), por eso el promedio se ve mucho más bajo.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* GLOBAL KPIs — all ratings (ASC-matching) */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Ratings totales (star-taps con y sin texto) · snapshot {ratingsSummary.snapshot_date}
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard
            label="Total Ratings (Global)"
            value={ratingsSummary.total_ratings}
            format="number"
            icon={Users}
            accentColor="navy"
            subtitle="incluye tappers sin texto"
          />
          <MetricCard
            label="Rating Promedio Global"
            value={Number(ratingsSummary.weighted_avg.toFixed(2))}
            format="number"
            icon={Star}
            accentColor="green"
            subtitle="ponderado por país"
          />
          <MetricCard
            label="Países con Ratings"
            value={ratingsSummary.countries}
            format="number"
            icon={Globe}
            accentColor="teal"
          />
          <MetricCard
            label="Top País"
            value={ratingsSummary.by_country[0]?.rating_count || 0}
            format="number"
            icon={Globe}
            accentColor="rose"
            subtitle={`${ratingsSummary.by_country[0]?.country_code || '—'} · ${ratingsSummary.by_country[0]?.avg_rating.toFixed(2) || '—'}⭐`}
          />
        </div>
      </div>

      {/* Per-country rating totals table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Ratings Totales por País</CardTitle>
          <p className="text-xs text-muted-foreground">
            Volumen y promedio reales de App Store (todos los tap-ratings, no solo reseñas escritas).
            Fuente: iTunes Lookup API · snapshot {ratingsSummary.snapshot_date}
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b">
                <tr className="text-left text-muted-foreground text-xs uppercase">
                  <th className="py-2 px-2">País</th>
                  <th className="py-2 px-2 text-right">Ratings</th>
                  <th className="py-2 px-2 text-right">% del total</th>
                  <th className="py-2 px-2 text-right">Avg ⭐</th>
                  <th className="py-2 px-2 text-right">vs Global ({ratingsSummary.weighted_avg.toFixed(2)})</th>
                </tr>
              </thead>
              <tbody>
                {ratingsSummary.by_country.slice(0, 25).map((c) => {
                  const delta = c.avg_rating - ratingsSummary.weighted_avg;
                  const deltaColor =
                    delta >= 0.1
                      ? 'text-green-700 bg-green-100'
                      : delta <= -0.2
                      ? 'text-red-700 bg-red-100'
                      : delta <= -0.05
                      ? 'text-amber-700 bg-amber-100'
                      : 'text-gray-600 bg-gray-100';
                  return (
                    <tr key={c.country_code} className="border-b hover:bg-gray-50">
                      <td className="py-2 px-2 font-medium">
                        {c.country_code}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {c.rating_count.toLocaleString()}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-muted-foreground">
                        {((c.rating_count / ratingsSummary.total_ratings) * 100).toFixed(1)}%
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {c.avg_rating.toFixed(2)}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        <span className={`px-2 py-0.5 rounded text-xs ${deltaColor}`}>
                          {delta >= 0 ? '+' : ''}{delta.toFixed(2)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Separator to visually group the "written reviews" section */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Análisis de Reviews Escritas (las que tienen título + texto)
        </h2>
        <p className="text-xs text-muted-foreground mb-4">
          Desde aquí hacia abajo solo se analizan reviews con texto. Esta es la única capa donde podemos entender
          <em> qué </em> están diciendo los usuarios. Recuerda que tiene sesgo hacia extremos.
        </p>
      </div>

      {/* KPI Cards — WRITTEN REVIEWS ONLY */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <MetricCard
          label="Reviews Escritas"
          value={summary.total}
          format="number"
          icon={MessageSquare}
          accentColor="navy"
          subtitle="en el período seleccionado"
        />
        <MetricCard
          label="Avg Rating (escritas)"
          value={Number(summary.avg_rating.toFixed(2))}
          format="number"
          subtitle="solo reviews con texto"
          icon={Star}
          accentColor="teal"
        />
        <MetricCard
          label="Reviews Negativas (≤2⭐)"
          value={summary.negative}
          format="number"
          subtitle={`${(summary.negative_rate * 100).toFixed(1)}% del total`}
          icon={TrendingDown}
          accentColor="red"
        />
        <MetricCard
          label="Reviews Positivas (≥4⭐)"
          value={summary.positive}
          format="number"
          subtitle={`${(summary.positive_rate * 100).toFixed(1)}% del total`}
          icon={Star}
          accentColor="green"
        />
        <MetricCard
          label="Países"
          value={summary.territories}
          format="number"
          subtitle="con reviews"
          icon={Globe}
          accentColor="rose"
        />
      </div>

      {/* Monthly rating chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Distribución de Ratings por Mes</CardTitle>
          <p className="text-xs text-muted-foreground">
            Barras apiladas = cantidad por estrellas. Línea = rating promedio.
          </p>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={monthlyChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="month" tick={{ fontSize: 12 }} />
              <YAxis yAxisId="left" tick={{ fontSize: 12 }} />
              <YAxis
                yAxisId="right"
                orientation="right"
                domain={[0, 5]}
                tick={{ fontSize: 12 }}
              />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar yAxisId="left" dataKey="★1" stackId="a" fill="#dc2626" />
              <Bar yAxisId="left" dataKey="★2" stackId="a" fill="#f97316" />
              <Bar yAxisId="left" dataKey="★3" stackId="a" fill="#f59e0b" />
              <Bar yAxisId="left" dataKey="★4" stackId="a" fill="#84cc16" />
              <Bar yAxisId="left" dataKey="★5" stackId="a" fill="#16a34a" />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="avg"
                stroke="#0E3687"
                strokeWidth={2}
                dot={{ r: 4 }}
                name="Avg Rating"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Top complaints + trend */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-500" />
              Quejas Principales
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Categorización automática sobre reviews de 1-2 ⭐ · % = del total de reviews negativas
            </p>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {topics.slice(0, 12).map((t, i) => (
                <button
                  key={t.topic}
                  onClick={() => setTopic(selectedTopic === t.topic ? undefined : t.topic)}
                  className={`w-full text-left rounded-md p-2 transition-colors ${
                    selectedTopic === t.topic
                      ? 'bg-[#0E3687]/10 border border-[#0E3687]'
                      : 'hover:bg-gray-50 border border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium">{t.label}</span>
                    <span className="text-sm text-muted-foreground tabular-nums">
                      {t.count} · {(t.pct_of_negative * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, t.pct_of_negative * 100 * 1.5)}%`,
                        backgroundColor: COMPLAINT_COLORS[i % COMPLAINT_COLORS.length],
                      }}
                    />
                  </div>
                </button>
              ))}
              {topics.length === 0 && (
                <div className="text-sm text-muted-foreground text-center py-8">
                  No hay reviews negativas en este período
                </div>
              )}
            </div>
            {selectedTopic && (
              <div className="mt-3 text-xs">
                <button
                  onClick={() => setTopic(undefined)}
                  className="text-[#0086D8] hover:underline"
                >
                  ← limpiar filtro
                </button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Tendencia de Quejas (Top 8)</CardTitle>
            <p className="text-xs text-muted-foreground">
              Reviews negativas (≤2⭐) por tipo de queja y mes
            </p>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={360}>
              <BarChart data={topicsTrendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                {top8Topics.map((t, i) => (
                  <Bar
                    key={t}
                    dataKey={TOPIC_LABELS[t as ReviewTopic] || t}
                    stackId="a"
                    fill={COMPLAINT_COLORS[i % COMPLAINT_COLORS.length]}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Territories table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Países con Más Quejas</CardTitle>
          <p className="text-xs text-muted-foreground">
            Ordenado por tasa de reviews negativas (mín. 5 reviews)
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b">
                <tr className="text-left text-muted-foreground text-xs uppercase">
                  <th className="py-2 px-2">País</th>
                  <th className="py-2 px-2 text-right">Reviews</th>
                  <th className="py-2 px-2 text-right">Rating Prom.</th>
                  <th className="py-2 px-2 text-right">Negativas</th>
                  <th className="py-2 px-2 text-right">% Negativas</th>
                </tr>
              </thead>
              <tbody>
                {territories.slice(0, 20).map((t) => (
                  <tr key={t.territory} className="border-b hover:bg-gray-50">
                    <td className="py-2 px-2">
                      <span className="mr-2">{territoryFlag(t.territory)}</span>
                      {t.territory}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums">{t.total}</td>
                    <td className="py-2 px-2 text-right tabular-nums">
                      {t.avg_rating.toFixed(2)} ⭐
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums">{t.negative}</td>
                    <td className="py-2 px-2 text-right tabular-nums">
                      <span
                        className={`px-2 py-0.5 rounded ${
                          t.negative_rate >= 0.3
                            ? 'bg-red-100 text-red-700'
                            : t.negative_rate >= 0.15
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-green-100 text-green-700'
                        }`}
                      >
                        {(t.negative_rate * 100).toFixed(0)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Recent negative reviews */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Filter className="h-5 w-5" />
            Reviews Negativas Recientes
            {selectedTopic && (
              <span className="text-sm font-normal text-muted-foreground">
                · filtro: {TOPIC_LABELS[selectedTopic as ReviewTopic] || selectedTopic}
              </span>
            )}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {negativeReviewsCount} reviews. Click en una queja arriba para filtrar. Click en una review para expandir.
          </p>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 max-h-[600px] overflow-y-auto">
            {recent.map((r) => {
              const isExpanded = expandedReview === r.review_id;
              const bodyShort =
                r.body && r.body.length > 180 && !isExpanded
                  ? r.body.slice(0, 180) + '…'
                  : r.body;
              return (
                <div
                  key={r.review_id}
                  onClick={() => setExpandedReview(isExpanded ? null : r.review_id)}
                  className="border rounded-md p-3 hover:bg-gray-50 cursor-pointer"
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-amber-500">
                        {'★'.repeat(r.rating)}
                        <span className="text-gray-300">{'★'.repeat(5 - r.rating)}</span>
                      </span>
                      <span className="text-sm font-medium">{r.title || '(sin título)'}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{territoryFlag(r.territory)} {r.territory}</span>
                      <span>·</span>
                      <span>{r.created_at.slice(0, 10)}</span>
                    </div>
                  </div>
                  {bodyShort && (
                    <p className="text-sm text-gray-700 mt-1">{bodyShort}</p>
                  )}
                  {r.topics && r.topics.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {r.topics.filter((t) => t !== 'praise').map((t) => (
                        <span
                          key={t}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-[#0E3687]/10 text-[#0E3687]"
                        >
                          {TOPIC_LABELS[t as ReviewTopic] || t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {recent.length === 0 && (
              <div className="text-sm text-muted-foreground text-center py-8">
                No hay reviews negativas para este filtro
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      </div>
    </>
  );
}

const SEVERITY_STYLES: Record<InsightSeverity, { border: string; bg: string; icon: React.ReactNode; label: string }> = {
  critical: {
    border: 'border-l-red-600',
    bg: 'bg-red-50',
    icon: <AlertCircle className="h-5 w-5 text-red-600" />,
    label: 'CRÍTICO',
  },
  high: {
    border: 'border-l-amber-500',
    bg: 'bg-amber-50',
    icon: <AlertCircle className="h-5 w-5 text-amber-600" />,
    label: 'ALTO',
  },
  medium: {
    border: 'border-l-[#0086D8]',
    bg: 'bg-[#0086D8]/[0.05]',
    icon: <Lightbulb className="h-5 w-5 text-[#0086D8]" />,
    label: 'MEDIO',
  },
  info: {
    border: 'border-l-[#45C94E]',
    bg: 'bg-green-50',
    icon: <CheckCircle2 className="h-5 w-5 text-green-600" />,
    label: 'INFO',
  },
};

function InsightsSection({ insights }: { insights: Insight[] }) {
  if (insights.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Lightbulb className="h-5 w-5 text-amber-500" />
          Insights & Recomendaciones
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Hallazgos automáticos derivados del análisis de este período. Ordenados por severidad.
          Cada uno incluye el dato soportante y un próximo paso concreto.
        </p>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {insights.map((ins) => {
            const style = SEVERITY_STYLES[ins.severity];
            return (
              <div
                key={ins.id}
                className={`border-l-4 ${style.border} ${style.bg} rounded-r-md p-4`}
              >
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 mt-0.5">{style.icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-bold tracking-wider text-gray-600">
                        {style.label}
                      </span>
                      {ins.metric && (
                        <span className="text-[10px] font-mono bg-white border border-border px-1.5 py-0.5 rounded text-gray-700">
                          {ins.metric}
                        </span>
                      )}
                    </div>
                    <h4 className="text-sm font-semibold text-[#0E3687] mb-1">{ins.title}</h4>
                    <p className="text-xs text-gray-700 mb-2 leading-relaxed">{ins.description}</p>
                    <div className="flex items-start gap-1.5 text-xs">
                      <span className="font-semibold text-gray-600 flex-shrink-0">→ Próximo paso:</span>
                      <span className="text-gray-700 leading-relaxed">{ins.recommendation}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
