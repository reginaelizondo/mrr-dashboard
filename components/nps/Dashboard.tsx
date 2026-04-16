'use client';

import { useMemo } from 'react';
import { useNpsData } from '@/lib/hooks/useNpsData';
import {
  applySecondaryFilters,
  calculateStats,
  splitByPeriod,
  groupByTrend,
  pickTrendGranularity,
  scoreDistribution,
  groupBySegment,
  getUniqueValues,
} from '@/lib/nps/nps-calculations';
import { Button } from '@/components/ui/button';
import { RotateCw, AlertTriangle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import PeriodSelector from './PeriodSelector';
import NpsMetricCards from './NpsMetricCards';
import NpsTrendChart from './NpsTrendChart';
import ScoreDistributionChart from './ScoreDistributionChart';
import NpsBySegmentChart from './NpsBySegmentChart';
import VoiceOfCustomer from './VoiceOfCustomer';
import RecentResponses from './RecentResponses';

export default function Dashboard() {
  const { responses, filters, setFilters, loading, error, lastUpdated, refresh } = useNpsData();

  const uniques = useMemo(() => getUniqueValues(responses), [responses]);

  // Apply secondary filters first (plan/locale/os/category), then split by period
  const filtered = useMemo(() => applySecondaryFilters(responses, filters), [responses, filters]);
  const { current, previous } = useMemo(() => splitByPeriod(filtered, filters.period), [filtered, filters.period]);

  const currentStats = useMemo(() => calculateStats(current), [current]);
  const previousStats = useMemo(() => (previous ? calculateStats(previous) : null), [previous]);
  const granularity = useMemo(() => pickTrendGranularity(current), [current]);
  const trendData = useMemo(() => groupByTrend(current, granularity), [current, granularity]);
  const distribution = useMemo(() => scoreDistribution(current), [current]);
  const byPlan = useMemo(() => groupBySegment(current, 'plan'), [current]);
  const byOs = useMemo(() => groupBySegment(current, 'os'), [current]);
  const byLocale = useMemo(() => groupBySegment(current, 'locale'), [current]);

  const timeSinceUpdate = useMemo(() => {
    if (!lastUpdated) return null;
    const diff = Math.floor((Date.now() - new Date(lastUpdated).getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  }, [lastUpdated]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-[#0086D8] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground text-sm">Loading NPS data…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="bg-white rounded-xl border border-[#E53E3E]/30 p-8 max-w-md text-center shadow-sm">
          <div className="w-12 h-12 bg-[#E53E3E]/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertTriangle className="w-6 h-6 text-[#E53E3E]" />
          </div>
          <h2 className="text-lg font-semibold text-[#0E3687] mb-2">Failed to load data</h2>
          <p className="text-sm text-muted-foreground mb-4">{error}</p>
          <Button onClick={refresh}>Retry</Button>
        </div>
      </div>
    );
  }

  const hasComparison = filters.period !== 'all';
  const activeFilters: { key: keyof typeof filters; label: string; value: string; display: string }[] = [];
  if (filters.planType) activeFilters.push({ key: 'planType', label: 'Plan', value: filters.planType, display: filters.planType.charAt(0).toUpperCase() + filters.planType.slice(1) });
  if (filters.locale) activeFilters.push({ key: 'locale', label: 'Locale', value: filters.locale, display: filters.locale.toUpperCase() });
  if (filters.category) activeFilters.push({ key: 'category', label: 'Category', value: filters.category, display: filters.category });
  if (filters.os) activeFilters.push({ key: 'os', label: 'OS', value: filters.os, display: filters.os });

  const clearFilter = (key: keyof typeof filters) => {
    setFilters({ ...filters, [key]: '' });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[#0E3687]">NPS</h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-[#0E3687]">{current.length.toLocaleString()}</span>
            <span className="text-muted-foreground"> of {responses.length.toLocaleString()} total responses shown</span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          {timeSinceUpdate && (
            <span className="text-xs text-muted-foreground">Updated {timeSinceUpdate}</span>
          )}
          <Button variant="outline" size="sm" onClick={refresh}>
            <RotateCw className="h-3.5 w-3.5 mr-1.5" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Period selector + secondary filters */}
      <PeriodSelector
        filters={filters}
        onChange={setFilters}
        planTypes={uniques.planTypes}
        locales={uniques.locales}
        categories={uniques.categories}
        osValues={uniques.osValues}
      />

      {/* Active filter chips */}
      {activeFilters.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground font-medium">Active filters:</span>
          {activeFilters.map((f) => (
            <button
              key={f.key}
              onClick={() => clearFilter(f.key)}
              className={cn(
                'group inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
                'bg-[#0086D8]/10 text-[#0086D8] border border-[#0086D8]/20',
                'hover:bg-[#0086D8]/15 transition-colors',
              )}
              title={`Remove ${f.label} filter`}
            >
              <span className="text-[#0086D8]/70">{f.label}:</span>
              <span>{f.display}</span>
              <X className="h-3 w-3 opacity-60 group-hover:opacity-100" />
            </button>
          ))}
          <button
            onClick={() => setFilters({ ...filters, planType: '', locale: '', category: '', os: '' })}
            className="text-xs text-muted-foreground hover:text-[#0E3687] underline underline-offset-2"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Row 1: Key KPIs with delta */}
      <NpsMetricCards current={currentStats} previous={previousStats} hasComparison={hasComparison} />

      {/* Row 2: Trend (2/3) + Distribution (1/3) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <NpsTrendChart data={trendData} granularity={granularity} />
        </div>
        <div>
          <ScoreDistributionChart data={distribution} />
        </div>
      </div>

      {/* Row 3: Segmentation */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <NpsBySegmentChart title="NPS by plan" description="Free vs paid engagement" data={byPlan} />
        <NpsBySegmentChart title="NPS by OS" description="Platform differences" data={byOs} />
        <NpsBySegmentChart title="NPS by locale" description="Market differences" data={byLocale} />
      </div>

      {/* Row 4: Voice of Customer */}
      <VoiceOfCustomer responses={current} />

      {/* Row 5: Recent responses (collapsible) */}
      <RecentResponses responses={current} />
    </div>
  );
}
