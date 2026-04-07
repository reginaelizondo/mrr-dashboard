import { createServerClient } from '@/lib/supabase/server';

export type ReviewTopic =
  | 'pricing'
  | 'paywall'
  | 'free_trial'
  | 'refund'
  | 'subscription_mgmt'
  | 'bugs_crashes'
  | 'performance'
  | 'account_login'
  | 'content_quality'
  | 'content_repetitive'
  | 'content_age_fit'
  | 'ux_ui'
  | 'ads'
  | 'support'
  | 'language_localization'
  | 'praise';

export const TOPIC_LABELS: Record<ReviewTopic, string> = {
  free_trial: 'Free Trial (cobro sorpresa)',
  refund: 'Reembolsos',
  subscription_mgmt: 'Cancelación / Renovación',
  pricing: 'Precio (caro)',
  paywall: 'Paywall (todo de pago)',
  bugs_crashes: 'Bugs / Crashes',
  performance: 'Lentitud / Performance',
  account_login: 'Login / Cuenta',
  content_repetitive: 'Contenido repetitivo',
  content_age_fit: 'Edad no adecuada',
  content_quality: 'Calidad del contenido',
  ads: 'Anuncios',
  ux_ui: 'UX / Interfaz',
  support: 'Soporte al cliente',
  language_localization: 'Idioma / Traducción',
  praise: 'Elogios',
};

// Topics considered "complaints" (used for complaint-only aggregations).
// `praise` is NOT a complaint. content_quality is vague enough we keep it.
export const COMPLAINT_TOPICS: ReviewTopic[] = [
  'free_trial',
  'refund',
  'subscription_mgmt',
  'pricing',
  'paywall',
  'bugs_crashes',
  'performance',
  'account_login',
  'content_repetitive',
  'content_age_fit',
  'content_quality',
  'ads',
  'ux_ui',
  'support',
  'language_localization',
];

export interface ReviewRow {
  review_id: string;
  rating: number;
  title: string | null;
  body: string | null;
  reviewer_nickname: string | null;
  territory: string;
  created_at: string;
  language: string | null;
  topics: string[];
  primary_topic: string | null;
}

export interface MonthlyReviewRow {
  month: string; // YYYY-MM
  total: number;
  avg_rating: number;
  r1: number;
  r2: number;
  r3: number;
  r4: number;
  r5: number;
  negative: number; // rating <= 2
  positive: number; // rating >= 4
}

export interface TopicCountRow {
  topic: string;
  label: string;
  count: number;
  pct_of_negative: number;
}

export interface TerritoryRow {
  territory: string;
  total: number;
  avg_rating: number;
  negative: number;
  negative_rate: number;
}

interface RawReview {
  rating: number;
  created_at: string;
  territory: string;
  primary_topic: string | null;
  topics: string[];
}

function applyTerritoryFilter<T>(q: T, territories?: string[]): T {
  if (!territories || territories.length === 0) return q;
  // @ts-expect-error Supabase query builder supports .in at runtime
  return q.in('territory', territories);
}

async function fetchReviewsInRange(
  startDate: string,
  endDate: string,
  territories?: string[],
  extraFilter?: (q: any) => any
): Promise<RawReview[]> {
  const supabase = createServerClient();
  const pageSize = 1000;
  const out: RawReview[] = [];

  for (let from = 0; ; from += pageSize) {
    let q = supabase
      .from('apple_reviews')
      .select('rating, created_at, territory, primary_topic, topics')
      .gte('created_at', startDate)
      .lte('created_at', `${endDate}T23:59:59Z`)
      .range(from, from + pageSize - 1);

    q = applyTerritoryFilter(q, territories);
    if (extraFilter) q = extraFilter(q);

    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...(data as RawReview[]));
    if (data.length < pageSize) break;
  }
  return out;
}

function monthKey(isoTs: string): string {
  return isoTs.slice(0, 7);
}

export async function getReviewsByMonth(
  startDate: string,
  endDate: string,
  territories?: string[]
): Promise<MonthlyReviewRow[]> {
  const rows = await fetchReviewsInRange(startDate, endDate, territories);

  const byMonth = new Map<string, MonthlyReviewRow>();
  for (const r of rows) {
    const m = monthKey(r.created_at);
    let cell = byMonth.get(m);
    if (!cell) {
      cell = {
        month: m,
        total: 0,
        avg_rating: 0,
        r1: 0, r2: 0, r3: 0, r4: 0, r5: 0,
        negative: 0,
        positive: 0,
      };
      byMonth.set(m, cell);
    }
    cell.total++;
    (cell as any)[`r${r.rating}`]++;
    if (r.rating <= 2) cell.negative++;
    if (r.rating >= 4) cell.positive++;
  }

  // avg rating per month
  for (const cell of byMonth.values()) {
    const sum =
      cell.r1 * 1 + cell.r2 * 2 + cell.r3 * 3 + cell.r4 * 4 + cell.r5 * 5;
    cell.avg_rating = cell.total > 0 ? sum / cell.total : 0;
  }

  return Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month));
}

export async function getTopComplaintTopics(
  startDate: string,
  endDate: string,
  options: { onlyNegative?: boolean; territories?: string[] } = { onlyNegative: true }
): Promise<TopicCountRow[]> {
  const supabase = createServerClient();
  const pageSize = 1000;
  const rows: { topics: string[]; rating: number }[] = [];

  for (let from = 0; ; from += pageSize) {
    let q = supabase
      .from('apple_reviews')
      .select('topics, rating')
      .gte('created_at', startDate)
      .lte('created_at', `${endDate}T23:59:59Z`)
      .range(from, from + pageSize - 1);
    if (options.onlyNegative) q = q.lte('rating', 2);
    if (options.territories && options.territories.length > 0) q = q.in('territory', options.territories);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...(data as any));
    if (data.length < pageSize) break;
  }

  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of r.topics || []) {
      if (t === 'praise') continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }

  const total = rows.length || 1;
  const out: TopicCountRow[] = Array.from(counts.entries())
    .map(([topic, count]) => ({
      topic,
      label: TOPIC_LABELS[topic as ReviewTopic] || topic,
      count,
      pct_of_negative: count / total,
    }))
    .sort((a, b) => b.count - a.count);

  return out;
}

export async function getTopComplaintTopicsByMonth(
  startDate: string,
  endDate: string,
  territories?: string[]
): Promise<Record<string, Record<string, number>>> {
  // Returns { 'YYYY-MM': { topic: count } } for negative reviews only
  const supabase = createServerClient();
  const pageSize = 1000;
  const rows: { topics: string[]; created_at: string }[] = [];

  for (let from = 0; ; from += pageSize) {
    let q = supabase
      .from('apple_reviews')
      .select('topics, created_at')
      .gte('created_at', startDate)
      .lte('created_at', `${endDate}T23:59:59Z`)
      .lte('rating', 2)
      .range(from, from + pageSize - 1);
    if (territories && territories.length > 0) q = q.in('territory', territories);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...(data as any));
    if (data.length < pageSize) break;
  }

  const result: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const m = monthKey(r.created_at);
    if (!result[m]) result[m] = {};
    for (const t of r.topics || []) {
      if (t === 'praise') continue;
      result[m][t] = (result[m][t] || 0) + 1;
    }
  }
  return result;
}

export async function getReviewsByTerritory(
  startDate: string,
  endDate: string,
  minReviews = 5,
  territories?: string[]
): Promise<TerritoryRow[]> {
  const rows = await fetchReviewsInRange(startDate, endDate, territories);

  const byT = new Map<string, { total: number; sum: number; neg: number }>();
  for (const r of rows) {
    const cell = byT.get(r.territory) || { total: 0, sum: 0, neg: 0 };
    cell.total++;
    cell.sum += r.rating;
    if (r.rating <= 2) cell.neg++;
    byT.set(r.territory, cell);
  }

  return Array.from(byT.entries())
    .filter(([, v]) => v.total >= minReviews)
    .map(([territory, v]) => ({
      territory,
      total: v.total,
      avg_rating: v.sum / v.total,
      negative: v.neg,
      negative_rate: v.neg / v.total,
    }))
    .sort((a, b) => b.negative_rate - a.negative_rate);
}

export async function getRecentNegativeReviews(
  startDate: string,
  endDate: string,
  topic?: string,
  limit = 100,
  territories?: string[]
): Promise<ReviewRow[]> {
  const supabase = createServerClient();
  let q = supabase
    .from('apple_reviews')
    .select('review_id, rating, title, body, reviewer_nickname, territory, created_at, language, topics, primary_topic')
    .gte('created_at', startDate)
    .lte('created_at', `${endDate}T23:59:59Z`)
    .lte('rating', 2)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (topic) q = q.contains('topics', [topic]);
  if (territories && territories.length > 0) q = q.in('territory', territories);

  const { data, error } = await q;
  if (error) throw error;
  return (data as ReviewRow[]) || [];
}

export interface RatingsSummary {
  total_ratings: number;
  weighted_avg: number;
  countries: number;
  snapshot_date: string | null;
  by_country: { country_code: string; rating_count: number; avg_rating: number }[];
}

/**
 * Latest per-country snapshot of Apple total ratings (from iTunes Lookup).
 * These are ALL ratings (star-taps with or without text), the same numbers
 * ASC shows in "Valoraciones y reseñas". Much larger universe than the
 * written-review table because most users just tap stars.
 */
export async function getLatestRatingsSummary(): Promise<RatingsSummary> {
  const supabase = createServerClient();

  // Find the most recent snapshot date
  const { data: latest, error: e1 } = await supabase
    .from('apple_ratings_summary')
    .select('snapshot_date')
    .order('snapshot_date', { ascending: false })
    .limit(1);
  if (e1) throw e1;

  if (!latest || latest.length === 0) {
    return { total_ratings: 0, weighted_avg: 0, countries: 0, snapshot_date: null, by_country: [] };
  }

  const snap = latest[0].snapshot_date;
  const { data, error } = await supabase
    .from('apple_ratings_summary')
    .select('country_code, rating_count, avg_rating')
    .eq('snapshot_date', snap)
    .order('rating_count', { ascending: false });
  if (error) throw error;

  let total = 0, weighted = 0;
  for (const r of data || []) {
    total += r.rating_count;
    weighted += r.rating_count * Number(r.avg_rating);
  }

  return {
    total_ratings: total,
    weighted_avg: total > 0 ? weighted / total : 0,
    countries: data?.length || 0,
    snapshot_date: snap,
    by_country: (data || []).map((r) => ({
      country_code: r.country_code,
      rating_count: r.rating_count,
      avg_rating: Number(r.avg_rating),
    })),
  };
}

/** Territories present in apple_reviews ordered by review count desc. */
export async function getAvailableTerritories(): Promise<string[]> {
  const supabase = createServerClient();
  const counts = new Map<string, number>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('apple_reviews')
      .select('territory')
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) counts.set(r.territory, (counts.get(r.territory) || 0) + 1);
    if (data.length < pageSize) break;
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);
}

export async function getReviewsSummary(startDate: string, endDate: string, territories?: string[]) {
  const rows = await fetchReviewsInRange(startDate, endDate, territories);
  const total = rows.length;
  if (total === 0) {
    return {
      total: 0,
      avg_rating: 0,
      negative: 0,
      negative_rate: 0,
      positive: 0,
      positive_rate: 0,
      territories: 0,
    };
  }
  let sum = 0, neg = 0, pos = 0;
  const ts = new Set<string>();
  for (const r of rows) {
    sum += r.rating;
    if (r.rating <= 2) neg++;
    if (r.rating >= 4) pos++;
    ts.add(r.territory);
  }
  return {
    total,
    avg_rating: sum / total,
    negative: neg,
    negative_rate: neg / total,
    positive: pos,
    positive_rate: pos / total,
    territories: ts.size,
  };
}
