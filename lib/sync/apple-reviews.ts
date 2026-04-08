import jwt from 'jsonwebtoken';
import { createServerClient } from '@/lib/supabase/server';
import { categorizeReview, detectLanguage } from '@/lib/sync/review-categorize';

/**
 * Apple Customer Reviews sync (server-side, used by cron route).
 * Mirrors the logic of scripts/backfill-apple-reviews.js but imports the
 * shared categorizer from lib/sync/review-categorize.ts and is safe to run
 * from a Next.js route handler on Vercel.
 *
 * Strategy:
 * - Sort by -createdDate, page forward with links.next.
 * - Stop when we see a review older than `sinceDays` ago (default 14).
 *   This keeps the incremental sync fast while still catching late-edited
 *   or delayed reviews (Apple sometimes surfaces reviews a few days after
 *   they were posted).
 * - Upsert on review_id so re-runs are idempotent.
 * - Also refreshes the per-country apple_ratings_summary snapshot by
 *   hitting the public iTunes Lookup endpoint — no auth needed.
 */

const APP_ID = process.env.APPLE_APP_ID || '741277284';

interface ApiReview {
  id: string;
  attributes: {
    rating: number;
    title: string | null;
    body: string | null;
    reviewerNickname: string | null;
    territory: string;
    createdDate: string;
  };
}

function generateAppleJWT(): string {
  const privateKey = Buffer.from(process.env.APPLE_PRIVATE_KEY_B64!, 'base64').toString('utf-8');
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: process.env.APPLE_ISSUER_ID!, iat: now, exp: now + 20 * 60, aud: 'appstoreconnect-v1' },
    privateKey,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: process.env.APPLE_KEY_ID!, typ: 'JWT' } }
  );
}

interface SyncReviewsResult {
  fetched: number;
  upserted: number;
  stoppedReason: 'window' | 'end_of_data' | 'error';
  oldestSeen: string | null;
  newestSeen: string | null;
}

export async function syncAppleReviewsRecent(sinceDays = 14): Promise<SyncReviewsResult> {
  const supabase = createServerClient();
  const token = generateAppleJWT();
  const headers = { Authorization: `Bearer ${token}` };

  const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  let nextUrl: string | null = (() => {
    const u = new URL(`https://api.appstoreconnect.apple.com/v1/apps/${APP_ID}/customerReviews`);
    u.searchParams.set('limit', '200');
    u.searchParams.set('sort', '-createdDate');
    return u.toString();
  })();

  let fetched = 0;
  let upserted = 0;
  let oldestSeen: string | null = null;
  let newestSeen: string | null = null;
  let stoppedReason: SyncReviewsResult['stoppedReason'] = 'end_of_data';
  let batch: Record<string, unknown>[] = [];

  while (nextUrl) {
    const res = await fetch(nextUrl, { headers });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`ASC customerReviews ${res.status}: ${txt.slice(0, 300)}`);
    }
    const j = (await res.json()) as { data: ApiReview[]; links?: { next?: string } };
    const rows = j.data || [];
    fetched += rows.length;

    for (const r of rows) {
      const a = r.attributes;
      const createdAt = new Date(a.createdDate);
      if (!newestSeen || a.createdDate > newestSeen) newestSeen = a.createdDate;
      oldestSeen = a.createdDate;

      if (createdAt < cutoff) {
        stoppedReason = 'window';
        break;
      }

      const { topics, primary } = categorizeReview(a.title, a.body, a.rating);
      const language = detectLanguage(`${a.title || ''} ${a.body || ''}`);
      batch.push({
        review_id: r.id,
        rating: a.rating,
        title: a.title || null,
        body: a.body || null,
        reviewer_nickname: a.reviewerNickname || null,
        territory: a.territory,
        created_at: a.createdDate,
        app_id: APP_ID,
        language,
        topics,
        primary_topic: primary,
        has_developer_reply: false,
      });

      if (batch.length >= 200) {
        const { error } = await supabase.from('apple_reviews').upsert(batch, { onConflict: 'review_id' });
        if (error) throw error;
        upserted += batch.length;
        batch = [];
      }
    }

    if (stoppedReason === 'window') break;
    nextUrl = j.links?.next || null;
  }

  if (batch.length) {
    const { error } = await supabase.from('apple_reviews').upsert(batch, { onConflict: 'review_id' });
    if (error) throw error;
    upserted += batch.length;
  }

  return { fetched, upserted, stoppedReason, oldestSeen, newestSeen };
}

// ─── iTunes Lookup snapshot (ratings totals per country) ───────────────────

const ITUNES_COUNTRIES = [
  'US', 'MX', 'ES', 'AR', 'CO', 'CL', 'PE', 'BR', 'VE', 'EC', 'UY', 'BO',
  'GT', 'CR', 'PA', 'DO', 'PY', 'HN', 'SV', 'NI',
  'CA', 'GB', 'FR', 'DE', 'IT', 'PT', 'NL', 'BE', 'IE', 'AT', 'CH',
  'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'HU', 'RO', 'GR',
  'AU', 'NZ', 'IN', 'JP', 'KR', 'CN', 'HK', 'TW', 'SG', 'PH', 'ID', 'MY', 'TH', 'VN',
  'ZA', 'TR', 'SA', 'AE', 'EG', 'IL', 'RU', 'UA',
];

interface SyncRatingsResult {
  countries: number;
  totalRatings: number;
  weightedAvg: number;
  snapshotDate: string;
}

export async function syncAppleRatingsSummary(): Promise<SyncRatingsResult> {
  const supabase = createServerClient();
  const today = new Date().toISOString().slice(0, 10);
  const rows: { snapshot_date: string; app_id: string; country_code: string; rating_count: number; avg_rating: number }[] = [];
  let totalRatings = 0;
  let weightedSum = 0;

  for (const c of ITUNES_COUNTRIES) {
    try {
      const r = await fetch(`https://itunes.apple.com/lookup?id=${APP_ID}&country=${c}`);
      if (!r.ok) continue;
      const j = (await r.json()) as { results?: { userRatingCount?: number; averageUserRating?: number }[] };
      const res = j.results?.[0];
      if (!res?.userRatingCount || res.averageUserRating == null) continue;
      rows.push({
        snapshot_date: today,
        app_id: APP_ID,
        country_code: c,
        rating_count: res.userRatingCount,
        avg_rating: Number(res.averageUserRating.toFixed(3)),
      });
      totalRatings += res.userRatingCount;
      weightedSum += res.userRatingCount * res.averageUserRating;
    } catch {
      // swallow individual-country failures; iTunes Lookup is best-effort
    }
    await new Promise((res) => setTimeout(res, 80));
  }

  if (rows.length === 0) {
    return { countries: 0, totalRatings: 0, weightedAvg: 0, snapshotDate: today };
  }

  const { error } = await supabase
    .from('apple_ratings_summary')
    .upsert(rows, { onConflict: 'snapshot_date,app_id,country_code' });
  if (error) throw error;

  return {
    countries: rows.length,
    totalRatings,
    weightedAvg: totalRatings > 0 ? weightedSum / totalRatings : 0,
    snapshotDate: today,
  };
}
