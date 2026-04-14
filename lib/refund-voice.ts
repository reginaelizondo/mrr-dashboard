/**
 * Refund Voice — correlaciona refunds (apple_sales_daily) con reviews negativas
 * (apple_reviews) a nivel mes/territorio. NO existe un identificador común entre
 * reviews y refunds (Apple no expone customer_id en ninguno de los dos feeds),
 * así que no podemos hacer join 1:1 usuario→refund→review. En su lugar construimos
 * correlación agregada por ventana temporal (mes) + territorio, que es el nivel
 * de granularidad que permite ambos feeds.
 *
 * Dos salidas:
 *   1) getRefundVoiceByMonth:  por mes, refund_rate vs top quejas verbatim
 *   2) getTopicRefundCorrelation:  por topic, refund_rate del contexto donde
 *      esas reviews ocurrieron (intensidad de correlación topic↔refund)
 */
import { createServerClient } from '@/lib/supabase/server';
import { TOPIC_LABELS, type ReviewTopic } from '@/lib/reviews';
import { iso3ToIso2, iso2ToIso3 } from '@/lib/country-codes';

export type Granularity = 'monthly' | 'weekly';

export interface RefundVoiceMonthRow {
  /** YYYY-MM for monthly, YYYY-MM-DD (ISO week start, Monday) for weekly */
  month: string;
  /** Only set for weekly granularity — YYYY-MM-DD week end (Sunday) */
  week_end?: string;
  // Refunds side (apple_sales_daily via v_apple_sales_monthly)
  charge_units: number;
  refund_units: number;
  refund_rate: number; // 0..1, net-basis
  // Reviews side (apple_reviews)
  total_reviews: number;
  negative_reviews: number; // rating <= 2
  avg_rating: number;
  // Top 3 complaint topics in this period (counts among negative reviews)
  top_topics: { topic: string; label: string; count: number }[];
  // Sample verbatims (top 3 most recent negative reviews this period)
  samples: {
    review_id: string;
    rating: number;
    title: string | null;
    body: string | null;
    territory: string;
    created_at: string;
    primary_topic: string | null;
  }[];
}

export interface TopicRefundCorrelationRow {
  topic: string;
  label: string;
  review_count: number; // # negative reviews mentioning this topic in range
  weighted_refund_rate: number; // refund rate of the month×territory buckets where those reviews landed (weighted by review_count)
  // How much higher/lower vs overall refund rate, e.g. 1.3 means 30% above baseline
  lift_vs_baseline: number;
}

export interface RefundVoiceData {
  /** Period rows (monthly or weekly depending on granularity passed in) */
  monthly: RefundVoiceMonthRow[];
  granularity: Granularity;
  topicCorrelation: TopicRefundCorrelationRow[];
  baselineRefundRate: number; // overall refund rate in the range
  hasData: boolean;
  startMonth: string;
  endMonth: string;
}

interface ReviewRaw {
  review_id: string;
  rating: number;
  title: string | null;
  body: string | null;
  territory: string; // ISO-3
  created_at: string;
  topics: string[];
  primary_topic: string | null;
}

interface SalesMonthly {
  month: string;
  charge_units: number;
  refund_units: number;
}

interface SalesMonthlyByCountry {
  month: string;
  country_code: string; // ISO-2
  charge_units: number;
  refund_units: number;
}

/**
 * Bucket key for a given timestamp (UTC). Monday-anchored ISO week for weekly,
 * YYYY-MM for monthly. Mirrors the same convention used in lib/reviews.ts and
 * the Refunds page so the chart axes align.
 */
function bucketKey(isoTs: string, granularity: Granularity): string {
  if (granularity === 'monthly') return isoTs.slice(0, 10).slice(0, 7);
  const d = new Date(isoTs);
  const day = d.getUTCDay();
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

function weekEnd(weekStart: string): string {
  const d = new Date(weekStart + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

/**
 * Main entry. Computes both outputs in a single set of queries.
 * `territories` filters BOTH reviews (ISO-3) and refunds (ISO-2 mapped).
 */
export async function getRefundVoice(
  startMonth: string,
  endMonth: string,
  territoriesIso3?: string[],
  granularity: Granularity = 'monthly'
): Promise<RefundVoiceData> {
  const supabase = createServerClient();

  // Date bounds: first day of startMonth to last day of endMonth (UTC)
  const startDate = `${startMonth}-01`;
  const [ey, em] = endMonth.split('-').map(Number);
  const endDate = new Date(Date.UTC(ey, em, 0)).toISOString().slice(0, 10);

  // --- Reviews side ------------------------------------------------------
  const reviews = await fetchReviewsInRange(startDate, endDate, territoriesIso3);

  // --- Refunds side ------------------------------------------------------
  // For weekly granularity we always go through the per-country aggregation
  // (it has begin_date down to the day) and bucket client-side. For monthly
  // we use the existing v_apple_sales_monthly view as a fast path for totals.
  const iso2Filter = territoriesIso3
    ? territoriesIso3.map((t) => iso3ToIso2(t)).filter(Boolean) as string[]
    : undefined;

  // Period totals: use the existing weekly/monthly RPCs (push aggregation into
  // Postgres so we don't paginate ~600k apple_sales_daily rows client-side).
  // Per month×country aggregation (for topic correlation) goes through a
  // dedicated RPC added in migration 013.
  const [monthlyTotals, weeklyTotals, monthlyByCountry] = await Promise.all([
    granularity === 'monthly'
      ? fetchSalesMonthly(supabase, startMonth, endMonth, iso2Filter)
      : Promise.resolve([]),
    granularity === 'weekly'
      ? fetchSalesWeekly(supabase, startDate, endDate, iso2Filter)
      : Promise.resolve([]),
    fetchSalesMonthlyByCountry(supabase, startDate, endDate, iso2Filter),
  ]);

  if (reviews.length === 0 && monthlyByCountry.length === 0) {
    return {
      monthly: [],
      granularity,
      topicCorrelation: [],
      baselineRefundRate: 0,
      hasData: false,
      startMonth,
      endMonth,
    };
  }

  // --- Build period correlation rows ------------------------------------
  const reviewsByPeriod = new Map<string, ReviewRaw[]>();
  for (const r of reviews) {
    const m = bucketKey(r.created_at, granularity);
    const arr = reviewsByPeriod.get(m) ?? [];
    arr.push(r);
    reviewsByPeriod.set(m, arr);
  }

  const refundsByPeriod = new Map<string, SalesMonthly>();
  if (granularity === 'monthly') {
    for (const r of monthlyTotals) refundsByPeriod.set(r.month, r);
  } else {
    // Weekly totals from apple_sales_weekly_range (week_start = Monday)
    for (const r of weeklyTotals) {
      refundsByPeriod.set(r.week_start, {
        month: r.week_start,
        charge_units: r.charge_units,
        refund_units: r.refund_units,
      });
    }
  }

  // Union of all periods we have data for
  const allPeriods = new Set<string>([
    ...reviewsByPeriod.keys(),
    ...refundsByPeriod.keys(),
  ]);

  const monthly: RefundVoiceMonthRow[] = [];
  for (const period of Array.from(allPeriods).sort()) {
    const revs = reviewsByPeriod.get(period) ?? [];
    const sales = refundsByPeriod.get(period);

    const charge_units = Number(sales?.charge_units ?? 0);
    const refund_units = Number(sales?.refund_units ?? 0);
    const net = charge_units - refund_units;
    const refund_rate = net > 0 ? refund_units / net : 0;

    // Review counts / avg rating
    const total_reviews = revs.length;
    const negatives = revs.filter((r) => r.rating <= 2);
    const negative_reviews = negatives.length;
    const avg_rating =
      total_reviews > 0
        ? revs.reduce((a, r) => a + r.rating, 0) / total_reviews
        : 0;

    // Top topics among negative reviews this month
    const topicCounts = new Map<string, number>();
    for (const r of negatives) {
      for (const t of r.topics || []) {
        if (t === 'praise') continue;
        topicCounts.set(t, (topicCounts.get(t) || 0) + 1);
      }
    }
    const top_topics = Array.from(topicCounts.entries())
      .map(([topic, count]) => ({
        topic,
        label: TOPIC_LABELS[topic as ReviewTopic] || topic,
        count,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    // Top 3 most recent negative reviews as samples
    const samples = negatives
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 3)
      .map((r) => ({
        review_id: r.review_id,
        rating: r.rating,
        title: r.title,
        body: r.body,
        territory: r.territory,
        created_at: r.created_at,
        primary_topic: r.primary_topic,
      }));

    monthly.push({
      month: period,
      ...(granularity === 'weekly' ? { week_end: weekEnd(period) } : {}),
      charge_units,
      refund_units,
      refund_rate,
      total_reviews,
      negative_reviews,
      avg_rating,
      top_topics,
      samples,
    });
  }

  // --- Topic → refund-rate correlation (Option C) -----------------------
  // For each complaint topic, we want: "in the same month×country where these
  // reviews appeared, what was the refund rate?" — weighted by review volume.
  const byMonthCountry = new Map<string, { charge: number; refund: number }>();
  for (const r of monthlyByCountry) {
    const key = `${r.month}|${r.country_code}`;
    byMonthCountry.set(key, {
      charge: Number(r.charge_units),
      refund: Number(r.refund_units),
    });
  }

  // Overall baseline in the window (net-basis)
  const totalCharge = monthlyByCountry.reduce(
    (a, r) => a + Number(r.charge_units),
    0
  );
  const totalRefund = monthlyByCountry.reduce(
    (a, r) => a + Number(r.refund_units),
    0
  );
  const baselineNet = totalCharge - totalRefund;
  const baselineRefundRate =
    baselineNet > 0 ? totalRefund / baselineNet : 0;

  const topicBuckets = new Map<
    string,
    { reviews: number; charge: number; refund: number }
  >();
  for (const r of reviews) {
    if (r.rating > 2) continue; // only negative reviews drive correlation
    const month = r.created_at.slice(0, 7);
    const iso2 = iso3ToIso2(r.territory);
    if (!iso2) continue;
    const key = `${month}|${iso2}`;
    const ctx = byMonthCountry.get(key);
    if (!ctx) continue; // no sales data for that bucket; skip
    for (const t of r.topics || []) {
      if (t === 'praise') continue;
      const cell = topicBuckets.get(t) ?? { reviews: 0, charge: 0, refund: 0 };
      cell.reviews += 1;
      cell.charge += ctx.charge;
      cell.refund += ctx.refund;
      topicBuckets.set(t, cell);
    }
  }

  const topicCorrelation: TopicRefundCorrelationRow[] = Array.from(
    topicBuckets.entries()
  )
    .map(([topic, cell]) => {
      const net = cell.charge - cell.refund;
      const weighted = net > 0 ? cell.refund / net : 0;
      return {
        topic,
        label: TOPIC_LABELS[topic as ReviewTopic] || topic,
        review_count: cell.reviews,
        weighted_refund_rate: weighted,
        lift_vs_baseline:
          baselineRefundRate > 0 ? weighted / baselineRefundRate : 0,
      };
    })
    .filter((r) => r.review_count >= 3) // need some signal
    .sort((a, b) => b.lift_vs_baseline - a.lift_vs_baseline);

  return {
    monthly,
    granularity,
    topicCorrelation,
    baselineRefundRate,
    hasData: monthly.length > 0 || topicCorrelation.length > 0,
    startMonth,
    endMonth,
  };
}

// ---------------------------------------------------------------------------
// Helpers — pagination & RPCs
// ---------------------------------------------------------------------------

async function fetchReviewsInRange(
  startDate: string,
  endDate: string,
  territoriesIso3?: string[]
): Promise<ReviewRaw[]> {
  const supabase = createServerClient();
  const pageSize = 1000;
  const out: ReviewRaw[] = [];
  for (let from = 0; ; from += pageSize) {
    let q = supabase
      .from('apple_reviews')
      .select(
        'review_id, rating, title, body, territory, created_at, topics, primary_topic'
      )
      .gte('created_at', startDate)
      .lte('created_at', `${endDate}T23:59:59Z`)
      .range(from, from + pageSize - 1);
    if (territoriesIso3 && territoriesIso3.length > 0) {
      q = q.in('territory', territoriesIso3);
    }
    const { data, error } = await q;
    if (error) {
      console.error('[refund-voice] reviews fetch error:', error);
      break;
    }
    if (!data || data.length === 0) break;
    out.push(...(data as ReviewRaw[]));
    if (data.length < pageSize) break;
  }
  return out;
}

type SupabaseClient = ReturnType<typeof createServerClient>;

async function fetchSalesMonthly(
  supabase: SupabaseClient,
  startMonth: string,
  endMonth: string,
  iso2Filter?: string[]
): Promise<SalesMonthly[]> {
  if (iso2Filter && iso2Filter.length > 0) {
    const startDate = `${startMonth}-01`;
    const [ey, em] = endMonth.split('-').map(Number);
    const endDate = new Date(Date.UTC(ey, em, 0)).toISOString().slice(0, 10);
    const { data, error } = await supabase.rpc('apple_sales_monthly_range', {
      start_date: startDate,
      end_date: endDate,
      country_codes: iso2Filter,
    });
    if (error) {
      console.error('[refund-voice] apple_sales_monthly_range error:', error);
      return [];
    }
    return (data || []).map((r: { month: string; charge_units: number; refund_units: number }) => ({
      month: r.month,
      charge_units: Number(r.charge_units || 0),
      refund_units: Number(r.refund_units || 0),
    }));
  }

  const { data, error } = await supabase
    .from('v_apple_sales_monthly')
    .select('month, charge_units, refund_units')
    .gte('month', startMonth)
    .lte('month', endMonth)
    .order('month', { ascending: true });
  if (error) {
    console.error('[refund-voice] v_apple_sales_monthly error:', error);
    return [];
  }
  return (data || []).map((r: { month: string; charge_units: number; refund_units: number }) => ({
    month: r.month,
    charge_units: Number(r.charge_units || 0),
    refund_units: Number(r.refund_units || 0),
  }));
}

/**
 * Per month×country aggregation. We pull raw apple_sales_daily and aggregate
 * client-side: the existing RPCs don't expose per-country×month shape. Volume
 * is manageable (~200 countries × 12 months max = 2400 rows) but we page in
 * case of a wide date range.
 */
/**
 * Per month×country aggregation via the apple_sales_monthly_by_country_range
 * RPC (migration 013). Postgres-side aggregation drops a 600k-row scan to
 * <500ms by using the begin_date index for predicate pushdown.
 */
async function fetchSalesMonthlyByCountry(
  supabase: SupabaseClient,
  startDate: string,
  endDate: string,
  iso2Filter?: string[]
): Promise<SalesMonthlyByCountry[]> {
  const { data, error } = await supabase.rpc(
    'apple_sales_monthly_by_country_range',
    {
      start_date: startDate,
      end_date: endDate,
      country_codes: iso2Filter && iso2Filter.length > 0 ? iso2Filter : null,
    }
  );
  if (error) {
    console.error(
      '[refund-voice] apple_sales_monthly_by_country_range error:',
      JSON.stringify(error)
    );
    return [];
  }
  return (data || []).map(
    (r: { month: string; country_code: string; charge_units: number; refund_units: number }) => ({
      month: r.month,
      country_code: r.country_code,
      charge_units: Number(r.charge_units || 0),
      refund_units: Number(r.refund_units || 0),
    })
  );
}

/**
 * Weekly totals via the existing apple_sales_weekly_range RPC (migration 012).
 */
async function fetchSalesWeekly(
  supabase: SupabaseClient,
  startDate: string,
  endDate: string,
  iso2Filter?: string[]
): Promise<{ week_start: string; charge_units: number; refund_units: number }[]> {
  const { data, error } = await supabase.rpc('apple_sales_weekly_range', {
    start_date: startDate,
    end_date: endDate,
    country_codes: iso2Filter && iso2Filter.length > 0 ? iso2Filter : null,
  });
  if (error) {
    console.error(
      '[refund-voice] apple_sales_weekly_range error:',
      JSON.stringify(error)
    );
    return [];
  }
  return (data || []).map(
    (r: { week_start: string; charge_units: number; refund_units: number }) => ({
      week_start: r.week_start,
      charge_units: Number(r.charge_units || 0),
      refund_units: Number(r.refund_units || 0),
    })
  );
}

// Re-export so pages can avoid a second import
export { iso2ToIso3 };
