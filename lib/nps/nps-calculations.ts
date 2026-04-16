import { NpsResponse, NpsFilters, NpsStats, WeeklyNps, ScoreBucket, SegmentStat, PeriodKey } from './types';
import { format, parseISO, isValid, subDays, startOfWeek } from 'date-fns';

export function applySecondaryFilters(responses: NpsResponse[], filters: NpsFilters): NpsResponse[] {
  return responses.filter((r) => {
    if (filters.planType && r.highestPlanType !== filters.planType.toLowerCase()) return false;
    if (filters.locale && r.userLocale !== filters.locale.toLowerCase()) return false;
    if (filters.category && r.category !== filters.category) return false;
    if (filters.os && r.os !== filters.os) return false;
    return true;
  });
}

function periodDays(period: PeriodKey): number | null {
  switch (period) {
    case '7d': return 7;
    case '30d': return 30;
    case '90d': return 90;
    case 'all': return null;
  }
}

/**
 * Split responses into current period and prior-equivalent period for delta calc.
 * For 'all', returns everything as current and null as previous.
 */
export function splitByPeriod(
  responses: NpsResponse[],
  period: PeriodKey,
): { current: NpsResponse[]; previous: NpsResponse[] | null } {
  const days = periodDays(period);
  if (days === null) return { current: responses, previous: null };

  const now = new Date();
  const currentStart = subDays(now, days);
  const previousStart = subDays(now, days * 2);

  const current: NpsResponse[] = [];
  const previous: NpsResponse[] = [];

  responses.forEach((r) => {
    const d = toDate(r.date);
    if (!d) return;
    if (d >= currentStart && d <= now) current.push(r);
    else if (d >= previousStart && d < currentStart) previous.push(r);
  });

  return { current, previous };
}

function toDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  try {
    const parsed = parseISO(dateStr);
    if (isValid(parsed)) return parsed;
  } catch {
    // ignore
  }
  return null;
}

export function calculateStats(responses: NpsResponse[]): NpsStats {
  const total = responses.length;
  if (total === 0) {
    return {
      total: 0,
      npsScore: 0,
      promoters: 0,
      passives: 0,
      detractors: 0,
      promoterPct: 0,
      passivePct: 0,
      detractorPct: 0,
      avgScore: 0,
    };
  }

  const promoters = responses.filter((r) => r.category === 'Promoter').length;
  const passives = responses.filter((r) => r.category === 'Passive').length;
  const detractors = responses.filter((r) => r.category === 'Detractor').length;

  const npsScore = Math.round(((promoters - detractors) / total) * 100);
  const avgScore = responses.reduce((sum, r) => sum + r.score, 0) / total;

  return {
    total,
    npsScore,
    promoters,
    passives,
    detractors,
    promoterPct: Math.round((promoters / total) * 100),
    passivePct: Math.round((passives / total) * 100),
    detractorPct: Math.round((detractors / total) * 100),
    avgScore: Math.round(avgScore * 10) / 10,
  };
}

export type TrendGranularity = 'day' | 'week';

export function pickTrendGranularity(responses: NpsResponse[]): TrendGranularity {
  const days = new Set<string>();
  responses.forEach((r) => {
    const d = toDate(r.date);
    if (d) days.add(format(d, 'yyyy-MM-dd'));
  });
  // <= 14 distinct days → daily makes more sense than weekly
  return days.size <= 14 ? 'day' : 'week';
}

export function groupByTrend(responses: NpsResponse[], granularity: TrendGranularity): WeeklyNps[] {
  const groups: Record<string, NpsResponse[]> = {};

  responses.forEach((r) => {
    const d = toDate(r.date);
    if (!d) return;
    const bucketStart = granularity === 'day'
      ? format(d, 'yyyy-MM-dd')
      : format(startOfWeek(d, { weekStartsOn: 1 }), 'yyyy-MM-dd');
    if (!groups[bucketStart]) groups[bucketStart] = [];
    groups[bucketStart].push(r);
  });

  return Object.entries(groups)
    .map(([bucketStart, items]) => {
      const stats = calculateStats(items);
      const d = parseISO(bucketStart);
      return {
        weekStart: bucketStart,
        weekLabel: format(d, 'MMM d'),
        npsScore: stats.npsScore,
        total: stats.total,
      };
    })
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

// Kept for backward compatibility
export function groupByWeek(responses: NpsResponse[]): WeeklyNps[] {
  return groupByTrend(responses, 'week');
}

export function scoreDistribution(responses: NpsResponse[]): ScoreBucket[] {
  const counts: Record<number, number> = {};
  for (let i = 0; i <= 10; i++) counts[i] = 0;
  responses.forEach((r) => {
    if (r.score >= 0 && r.score <= 10) counts[r.score]++;
  });
  return Array.from({ length: 11 }, (_, score) => {
    let category: ScoreBucket['category'] = 'Passive';
    if (score <= 6) category = 'Detractor';
    else if (score >= 9) category = 'Promoter';
    return { score, count: counts[score], category };
  });
}

export type SegmentKey = 'plan' | 'os' | 'locale';

function segmentValue(r: NpsResponse, key: SegmentKey): string {
  switch (key) {
    case 'plan': return r.highestPlanType || 'unknown';
    case 'os': return r.os || 'unknown';
    case 'locale': return r.userLocale || 'unknown';
  }
}

export function groupBySegment(responses: NpsResponse[], key: SegmentKey, minSize = 5): SegmentStat[] {
  const groups: Record<string, NpsResponse[]> = {};

  responses.forEach((r) => {
    const val = segmentValue(r, key);
    if (!groups[val]) groups[val] = [];
    groups[val].push(r);
  });

  return Object.entries(groups)
    .filter(([, items]) => items.length >= minSize)
    .map(([segment, items]) => {
      const stats = calculateStats(items);
      return {
        segment: prettifySegment(segment, key),
        npsScore: stats.npsScore,
        total: stats.total,
        promoters: stats.promoters,
        passives: stats.passives,
        detractors: stats.detractors,
      };
    })
    .sort((a, b) => b.total - a.total);
}

function prettifySegment(val: string, key: SegmentKey): string {
  if (val === 'unknown') return 'Unknown';
  if (key === 'locale') return val.toUpperCase();
  if (key === 'plan') return val.charAt(0).toUpperCase() + val.slice(1);
  return val;
}

export function getUniqueValues(responses: NpsResponse[]) {
  const planTypes = [...new Set(responses.map((r) => r.highestPlanType).filter(Boolean))].sort();
  const locales = [...new Set(responses.map((r) => r.userLocale).filter(Boolean))].sort();
  const categories: string[] = ['Promoter', 'Passive', 'Detractor'];
  const osValues = [...new Set(responses.map((r) => r.os).filter(Boolean))].sort();
  return { planTypes, locales, categories, osValues };
}
