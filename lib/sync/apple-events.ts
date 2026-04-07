import jwt from 'jsonwebtoken';
import { gunzipSync } from 'zlib';
import { createServerClient } from '@/lib/supabase/server';

/**
 * Apple Sales & Trends — SUBSCRIPTION_EVENT (DAILY) sync.
 *
 * Provides per-event granularity that the FINANCIAL report does not:
 *   - event type (Refund, Renew, Subscribe, Cancel, ...)
 *   - consecutive_paid_periods (1 = initial, 2 = first renewal, ...)
 *   - days_before_canceling
 *   - subscription_offer_type (Free Trial, Pay As You Go, ...)
 *   - country, device, client, etc.
 *
 * NOTE: Apple makes daily reports available the day AFTER the event date,
 * and only retains them for ~365 days. We must sync incrementally.
 */

const SALES_REPORTS_URL = 'https://api.appstoreconnect.apple.com/v1/salesReports';
const REPORT_VERSION = '1_4'; // current SUBSCRIPTION_EVENT version

function generateAppleJWT(): string {
  const privateKey = Buffer.from(
    process.env.APPLE_PRIVATE_KEY_B64!,
    'base64'
  ).toString('utf-8');

  const now = Math.floor(Date.now() / 1000);

  return jwt.sign(
    {
      iss: process.env.APPLE_ISSUER_ID!,
      iat: now,
      exp: now + 20 * 60,
      aud: 'appstoreconnect-v1',
    },
    privateKey,
    {
      algorithm: 'ES256',
      header: {
        alg: 'ES256',
        kid: process.env.APPLE_KEY_ID!,
        typ: 'JWT',
      },
    }
  );
}

async function fetchSubscriptionEventReport(
  token: string,
  date: string // YYYY-MM-DD
): Promise<string | null> {
  const url = new URL(SALES_REPORTS_URL);
  url.searchParams.set('filter[reportType]', 'SUBSCRIPTION_EVENT');
  url.searchParams.set('filter[reportSubType]', 'SUMMARY');
  url.searchParams.set('filter[frequency]', 'DAILY');
  url.searchParams.set('filter[reportDate]', date);
  url.searchParams.set('filter[vendorNumber]', process.env.APPLE_VENDOR_NUMBER!);
  url.searchParams.set('filter[version]', REPORT_VERSION);

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    if (response.status === 404 || response.status === 410) {
      // No data for this date yet (too recent or out of retention window)
      return null;
    }
    const text = await response.text().catch(() => '');
    console.warn(`[apple-events] ${date} returned ${response.status}: ${text.slice(0, 200)}`);
    return null;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  try {
    return gunzipSync(buffer).toString('utf-8');
  } catch {
    return buffer.toString('utf-8');
  }
}

interface ParsedEvent {
  event_date: string;
  event: string;
  app_apple_id: string | null;
  subscription_name: string | null;
  subscription_apple_id: string | null;
  subscription_group_id: string | null;
  standard_subscription_duration: string | null;
  promotional_offer_name: string | null;
  promotional_offer_id: string | null;
  subscription_offer_type: string | null;
  subscription_offer_duration: string | null;
  marketing_opt_in: string | null;
  preserved_pricing: string | null;
  proceeds_reason: string | null;
  consecutive_paid_periods: number | null;
  original_start_date: string | null;
  client: string | null;
  device: string | null;
  state: string | null;
  country: string | null;
  previous_subscription_name: string | null;
  previous_subscription_apple_id: string | null;
  days_before_canceling: number | null;
  cancellation_reason: string | null;
  days_canceled: number | null;
  quantity: number;
  raw_data: Record<string, string>;
}

function toIntOrNull(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function nullIfEmpty(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t === '' ? null : t;
}

function parseAppleDate(s: string | undefined): string | null {
  // Apple uses MM/DD/YYYY in sales reports
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return null;
}

function parseTSV(tsv: string): ParsedEvent[] {
  const lines = tsv.replace(/\r/g, '').trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split('\t').map((h) => h.trim());
  const idx = (name: string) => headers.indexOf(name);

  const cEventDate = idx('Event Date');
  const cEvent = idx('Event');
  const cAppId = idx('App Apple ID');
  const cSubName = idx('Subscription Name');
  const cSubId = idx('Subscription Apple ID');
  const cGroupId = idx('Subscription Group ID');
  const cStdDur = idx('Standard Subscription Duration');
  const cPromoName = idx('Promotional Offer Name');
  const cPromoId = idx('Promotional Offer ID');
  const cOfferType = idx('Subscription Offer Type');
  const cOfferDur = idx('Subscription Offer Duration');
  const cMktOptIn = idx('Marketing Opt-In');
  const cPreserved = idx('Preserved Pricing');
  const cProceeds = idx('Proceeds Reason');
  const cCpp = idx('Consecutive Paid Periods');
  const cOrigStart = idx('Original Start Date');
  const cClient = idx('Client');
  const cDevice = idx('Device');
  const cState = idx('State');
  const cCountry = idx('Country');
  const cPrevSubName = idx('Previous Subscription Name');
  const cPrevSubId = idx('Previous Subscription Apple ID');
  const cDaysBefore = idx('Days Before Canceling');
  const cCancelReason = idx('Cancellation Reason');
  const cDaysCanceled = idx('Days Canceled');
  const cQty = idx('Quantity');

  const out: ParsedEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 5) continue;

    const raw: Record<string, string> = {};
    headers.forEach((h, k) => {
      raw[h] = cols[k] || '';
    });

    out.push({
      event_date: parseAppleDate(cols[cEventDate]) || '',
      event: nullIfEmpty(cols[cEvent]) || '',
      app_apple_id: nullIfEmpty(cols[cAppId]),
      subscription_name: nullIfEmpty(cols[cSubName]),
      subscription_apple_id: nullIfEmpty(cols[cSubId]),
      subscription_group_id: nullIfEmpty(cols[cGroupId]),
      standard_subscription_duration: nullIfEmpty(cols[cStdDur]),
      promotional_offer_name: nullIfEmpty(cols[cPromoName]),
      promotional_offer_id: nullIfEmpty(cols[cPromoId]),
      subscription_offer_type: nullIfEmpty(cols[cOfferType]),
      subscription_offer_duration: nullIfEmpty(cols[cOfferDur]),
      marketing_opt_in: nullIfEmpty(cols[cMktOptIn]),
      preserved_pricing: nullIfEmpty(cols[cPreserved]),
      proceeds_reason: nullIfEmpty(cols[cProceeds]),
      consecutive_paid_periods: toIntOrNull(cols[cCpp]),
      original_start_date: parseAppleDate(cols[cOrigStart]),
      client: nullIfEmpty(cols[cClient]),
      device: nullIfEmpty(cols[cDevice]),
      state: nullIfEmpty(cols[cState]),
      country: (nullIfEmpty(cols[cCountry]) || '').slice(0, 2) || null,
      previous_subscription_name: nullIfEmpty(cols[cPrevSubName]),
      previous_subscription_apple_id: nullIfEmpty(cols[cPrevSubId]),
      days_before_canceling: toIntOrNull(cols[cDaysBefore]),
      cancellation_reason: nullIfEmpty(cols[cCancelReason]),
      days_canceled: toIntOrNull(cols[cDaysCanceled]),
      quantity: toIntOrNull(cols[cQty]) ?? 0,
      raw_data: raw,
    });
  }

  return out.filter((e) => e.event_date && e.event);
}

/**
 * Sync a single day's SUBSCRIPTION_EVENT report.
 * Strategy: delete-by-date then bulk insert (Apple may correct prior days).
 */
export async function syncAppleEvents(date: string): Promise<{ rows: number; skipped: boolean }> {
  const token = generateAppleJWT();
  const tsv = await fetchSubscriptionEventReport(token, date);

  if (!tsv) {
    return { rows: 0, skipped: true };
  }

  const rows = parseTSV(tsv);
  if (rows.length === 0) {
    return { rows: 0, skipped: false };
  }

  const supabase = createServerClient();

  // Replace any existing rows for this date
  const { error: delErr } = await supabase
    .from('apple_subscription_events')
    .delete()
    .eq('event_date', date);
  if (delErr) {
    throw new Error(`apple-events delete error: ${delErr.message}`);
  }

  // Insert in batches of 500
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from('apple_subscription_events').insert(batch);
    if (error) {
      throw new Error(`apple-events insert error: ${error.message}`);
    }
  }

  return { rows: rows.length, skipped: false };
}

/**
 * Sync a date range (inclusive). Useful for backfill.
 * Apple retains daily reports for ~365 days only.
 */
export async function syncAppleEventsRange(
  startDate: string,
  endDate: string
): Promise<{ totalRows: number; days: number; skippedDays: number }> {
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  let totalRows = 0;
  let days = 0;
  let skippedDays = 0;

  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    const result = await syncAppleEvents(dateStr);
    totalRows += result.rows;
    days += 1;
    if (result.skipped) skippedDays += 1;
  }

  return { totalRows, days, skippedDays };
}
