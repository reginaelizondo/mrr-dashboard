import jwt from 'jsonwebtoken';
import { gunzipSync } from 'zlib';
import { createServerClient } from '@/lib/supabase/server';

/**
 * Apple SALES report (DAILY) sync. This is what App Store Connect → Trends
 * shows: calendar-day rows with $ amounts. Refunds are rows with negative
 * Units / negative Customer Price.
 *
 * Apple retains DAILY sales reports for 365 days.
 */

interface SalesRow {
  begin_date: string;
  end_date: string;
  sku: string | null;
  title: string | null;
  product_type_identifier: string | null;
  apple_identifier: string | null;
  parent_identifier: string | null;
  subscription: string | null;
  period: string | null;
  units: number;
  developer_proceeds: number;
  customer_price: number;
  customer_currency: string | null;
  currency_of_proceeds: string | null;
  country_code: string | null;
  promo_code: string | null;
  category: string | null;
  device: string | null;
  client: string | null;
  order_type: string | null;
  proceeds_reason: string | null;
  raw_data: Record<string, string>;
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

// Sales Report v1_0 column order (28 columns)
const COLS = [
  'Provider', 'Provider Country', 'SKU', 'Developer', 'Title', 'Version',
  'Product Type Identifier', 'Units', 'Developer Proceeds', 'Begin Date', 'End Date',
  'Customer Currency', 'Country Code', 'Currency of Proceeds', 'Apple Identifier',
  'Customer Price', 'Promo Code', 'Parent Identifier', 'Subscription', 'Period',
  'Category', 'CMB', 'Device', 'Supported Platforms', 'Proceeds Reason',
  'Preserved Pricing', 'Client', 'Order Type',
];

function parseAppleDate(s: string): string | null {
  // Apple format: MM/DD/YYYY → YYYY-MM-DD
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

function parseTSV(tsv: string): SalesRow[] {
  const lines = tsv.replace(/\r/g, '').trim().split('\n');
  if (lines.length < 2) return [];

  const out: SalesRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t').map((c) => c.trim());
    if (cols.length < COLS.length) continue;

    const beginDate = parseAppleDate(cols[9]);
    const endDate = parseAppleDate(cols[10]);
    if (!beginDate || !endDate) continue;

    const raw: Record<string, string> = {};
    for (let j = 0; j < COLS.length; j++) raw[COLS[j]] = cols[j];

    out.push({
      begin_date: beginDate,
      end_date: endDate,
      sku: cols[2] || null,
      title: cols[4] || null,
      product_type_identifier: cols[6] || null,
      apple_identifier: cols[14] || null,
      parent_identifier: cols[17] || null,
      subscription: cols[18] || null,
      period: cols[19] || null,
      units: parseInt(cols[7]) || 0,
      developer_proceeds: parseFloat(cols[8]) || 0,
      customer_price: parseFloat(cols[15]) || 0,
      customer_currency: cols[11] || null,
      currency_of_proceeds: cols[13] || null,
      country_code: cols[12] || null,
      promo_code: cols[16] || null,
      category: cols[20] || null,
      device: cols[22] || null,
      client: cols[26] || null,
      order_type: cols[27] || null,
      proceeds_reason: cols[24] || null,
      raw_data: raw,
    });
  }
  return out;
}

async function fetchSalesForDay(token: string, date: string): Promise<SalesRow[] | null> {
  const url = new URL('https://api.appstoreconnect.apple.com/v1/salesReports');
  url.searchParams.set('filter[reportType]', 'SALES');
  url.searchParams.set('filter[reportSubType]', 'SUMMARY');
  url.searchParams.set('filter[frequency]', 'DAILY');
  url.searchParams.set('filter[reportDate]', date);
  url.searchParams.set('filter[vendorNumber]', process.env.APPLE_VENDOR_NUMBER!);
  url.searchParams.set('filter[version]', '1_0');

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    if (response.status === 404) return null; // out of retention or no report
    console.warn(`[apple-sales] ${date} HTTP ${response.status}`);
    return null;
  }

  const buf = Buffer.from(await response.arrayBuffer());
  let tsv: string;
  try {
    tsv = gunzipSync(buf).toString('utf-8');
  } catch {
    tsv = buf.toString('utf-8');
  }

  return parseTSV(tsv);
}

/**
 * Sync Apple SALES report for one calendar day.
 * Idempotent: deletes any existing rows for `date` and re-inserts.
 * Returns the number of rows inserted, or null if Apple has no report for that date.
 */
export async function syncAppleSalesDay(date: string): Promise<number | null> {
  const token = generateAppleJWT();
  const rows = await fetchSalesForDay(token, date);
  if (rows === null) return null;
  if (rows.length === 0) return 0;

  const supabase = createServerClient();

  // Delete-then-insert for idempotency
  const { error: delErr } = await supabase
    .from('apple_sales_daily')
    .delete()
    .eq('begin_date', date);
  if (delErr) {
    console.error(`[apple-sales] delete error for ${date}:`, delErr);
    throw new Error(delErr.message);
  }

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from('apple_sales_daily').insert(batch);
    if (error) {
      console.error(`[apple-sales] insert error for ${date}:`, error);
      throw new Error(error.message);
    }
    inserted += batch.length;
  }
  return inserted;
}

/**
 * Sync the most recent N days of Apple SALES reports.
 * Used by the daily cron — Apple publishes reports with ~1 day lag,
 * so we re-sync the trailing window to catch any late updates.
 */
export async function syncAppleSalesRecent(daysBack = 5): Promise<{
  days: number;
  rows: number;
  errors: string[];
}> {
  const today = new Date();
  let days = 0;
  let rows = 0;
  const errors: string[] = [];

  for (let i = 1; i <= daysBack; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    try {
      const n = await syncAppleSalesDay(dateStr);
      if (n != null) {
        days++;
        rows += n;
      }
    } catch (err) {
      errors.push(`${dateStr}: ${(err as Error).message}`);
    }
  }
  return { days, rows, errors };
}
