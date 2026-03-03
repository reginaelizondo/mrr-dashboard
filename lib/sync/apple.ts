import jwt from 'jsonwebtoken';
import { gunzipSync } from 'zlib';
import { createServerClient } from '@/lib/supabase/server';
import { getRegion } from '@/lib/constants';
import type { Transaction } from '@/types';

// Apple Finance Report regions
// ZZ = "All Territories" — contains complete data for ALL countries.
// We use ZZ as the sole source to avoid cross-region deduplication issues.
// WW = "Worldwide" — fallback if ZZ returns empty for a given month.
const APPLE_PRIMARY_REGION = 'ZZ';
const APPLE_FALLBACK_REGION = 'WW';

// Keep full list for diagnostic endpoints only
const APPLE_ALL_REGIONS = ['US', 'CA', 'MX', 'BR', 'GB', 'EU', 'AU', 'JP', 'CN', 'WW', 'ZZ'];

interface AppleFinanceRow {
  startDate: string;
  endDate: string;
  upc: string;
  isrc: string;
  vendorIdentifier: string; // SKU
  quantity: number;
  partnerShare: number;
  extendedPartnerShare: number;
  partnerShareCurrency: string;
  salesOrReturn: string; // S or R
  appleIdentifier: string;
  artist: string;
  title: string;
  label: string;
  grid: string;
  productTypeIdentifier: string; // IAY = auto-renewable subscription
  isan: string;
  countryOfSale: string;
  preOrderFlag: string;
  promoCode: string;
  customerPrice: number;
  customerCurrency: string;
}

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

function parseTSV(tsv: string): AppleFinanceRow[] {
  const lines = tsv.trim().split('\n');
  if (lines.length < 2) return [];

  const rows: AppleFinanceRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 22) continue;

    rows.push({
      startDate: cols[0]?.trim() || '',
      endDate: cols[1]?.trim() || '',
      upc: cols[2]?.trim() || '',
      isrc: cols[3]?.trim() || '',
      vendorIdentifier: cols[4]?.trim() || '',
      quantity: parseInt(cols[5]?.trim()) || 0,
      partnerShare: parseFloat(cols[6]?.trim()) || 0,
      extendedPartnerShare: parseFloat(cols[7]?.trim()) || 0,
      partnerShareCurrency: cols[8]?.trim() || '',
      salesOrReturn: cols[9]?.trim() || '',
      appleIdentifier: cols[10]?.trim() || '',
      artist: cols[11]?.trim() || '',
      title: cols[12]?.trim() || '',
      label: cols[13]?.trim() || '',
      grid: cols[14]?.trim() || '',
      productTypeIdentifier: cols[15]?.trim() || '',
      isan: cols[16]?.trim() || '',
      countryOfSale: cols[17]?.trim() || '',
      preOrderFlag: cols[18]?.trim() || '',
      promoCode: cols[19]?.trim() || '',
      customerPrice: parseFloat(cols[20]?.trim()) || 0,
      customerCurrency: cols[21]?.trim() || '',
    });
  }

  return rows;
}

function getPlanTypeFromSku(sku: string): import('@/types').PlanType {
  const s = sku.toLowerCase();
  // Lifetime: only explicit "lifetime" in the name
  // NOTE: _lt in Kinedu SKUs means "low tier", NOT lifetime!
  if (s.includes('lifetime')) return 'lifetime';
  // Yearly patterns: _12_ or _12
  if (s.includes('_12_') || s.endsWith('_12') || s.includes('annual') || s.includes('yearly')) return 'yearly';
  // Semesterly patterns: _6_ or _6
  if (s.includes('_6_') || s.endsWith('_6') || s.includes('semester')) return 'semesterly';
  // Quarterly patterns: _3_ or _3
  if (s.includes('_3_') || s.endsWith('_3') || s.includes('quarter')) return 'quarterly';
  // Monthly patterns: _1_ or _1 or month
  if (s.includes('_1_') || s.endsWith('_1') || s.match(/_1[^0-9]/) || s.includes('month')) return 'monthly';
  // Weekly patterns: _w_ or _week or weekly
  if (s.includes('weekly') || s.includes('_week') || s.includes('_w_') || s.includes('weekfree')) return 'weekly';
  return 'other';
}

function getLastDayOfMonth(yearMonth: string): string {
  // yearMonth format: "YYYY-MM"
  const [year, month] = yearMonth.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return `${yearMonth}-${String(lastDay).padStart(2, '0')}`;
}

async function fetchFinanceReportForRegion(
  token: string,
  regionCode: string,
  reportDate: string // YYYY-MM format
): Promise<AppleFinanceRow[]> {
  const url = new URL('https://api.appstoreconnect.apple.com/v1/financeReports');
  url.searchParams.set('filter[regionCode]', regionCode);
  url.searchParams.set('filter[reportType]', 'FINANCIAL');
  url.searchParams.set('filter[reportDate]', reportDate);
  url.searchParams.set('filter[vendorNumber]', process.env.APPLE_VENDOR_NUMBER!);

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    if (response.status === 404 || response.status === 410) {
      return [];
    }
    // 403 or other errors - skip this region silently
    console.log(`Apple Finance: ${regionCode} returned ${response.status}`);
    return [];
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  let tsvContent: string;
  try {
    tsvContent = gunzipSync(buffer).toString('utf-8');
  } catch {
    tsvContent = buffer.toString('utf-8');
  }

  return parseTSV(tsvContent);
}

// Approximate monthly USD exchange rates for Apple's ~40 settlement currencies.
// Values are units of local currency per 1 USD (e.g., MXN 20 = $1 USD).
// Source: approximate monthly averages from xe.com / central bank data.
// We use a single "average" rate per currency (updated periodically) since Apple
// reports are monthly aggregates and exact daily rates aren't critical.
const CURRENCY_TO_USD: Record<string, number> = {
  USD: 1,
  // Major currencies
  EUR: 0.92, GBP: 0.79, CAD: 1.36, AUD: 1.55, JPY: 150.0, CHF: 0.88,
  // Latin America
  MXN: 20.0, BRL: 5.0, CLP: 930.0, COP: 4200.0, PEN: 3.75,
  // Asia
  CNY: 7.25, HKD: 7.82, KRW: 1330.0, INR: 83.5, IDR: 15700.0,
  MYR: 4.70, PHP: 56.0, SGD: 1.34, THB: 35.5, TWD: 31.5, VND: 25000.0,
  KZT: 460.0, PKR: 280.0,
  // Middle East & Africa
  AED: 3.67, SAR: 3.75, QAR: 3.64, ILS: 3.65, NGN: 1500.0,
  TZS: 2500.0, ZAR: 18.5, EGP: 50.0,
  // Europe (non-EUR)
  SEK: 10.5, NOK: 10.7, DKK: 6.88, PLN: 4.05, CZK: 23.5,
  HUF: 370.0, RON: 4.60, TRY: 32.0, RUB: 92.0,
  // Other
  NZD: 1.67, BGN: 1.80,
};

// Optional: monthly overrides for currencies with high volatility
// Key format: "YYYY-MM:CUR" → rate
const MONTHLY_RATE_OVERRIDES: Record<string, number> = {
  // MXN had significant movement 2024-2025
  '2024-01:MXN': 17.15, '2024-02:MXN': 17.10, '2024-03:MXN': 16.80,
  '2024-04:MXN': 17.05, '2024-05:MXN': 16.95, '2024-06:MXN': 18.15,
  '2024-07:MXN': 17.90, '2024-08:MXN': 18.85, '2024-09:MXN': 19.30,
  '2024-10:MXN': 19.75, '2024-11:MXN': 20.25, '2024-12:MXN': 20.15,
  '2025-01:MXN': 20.45, '2025-02:MXN': 20.35, '2025-03:MXN': 20.25,
  '2025-04:MXN': 20.05, '2025-05:MXN': 19.50, '2025-06:MXN': 19.65,
  '2025-07:MXN': 19.85, '2025-08:MXN': 19.70, '2025-09:MXN': 19.55,
  '2025-10:MXN': 20.10, '2025-11:MXN': 20.30, '2025-12:MXN': 20.45,
  '2026-01:MXN': 20.55, '2026-02:MXN': 20.40,
  // BRL
  '2024-01:BRL': 4.92, '2024-06:BRL': 5.35, '2024-12:BRL': 6.10,
  '2025-01:BRL': 6.05, '2025-06:BRL': 5.60, '2025-12:BRL': 5.80,
  '2026-01:BRL': 5.90, '2026-02:BRL': 5.75,
  // COP
  '2024-01:COP': 3920, '2024-06:COP': 4050, '2024-12:COP': 4400,
  '2025-01:COP': 4380, '2025-06:COP': 4200, '2025-12:COP': 4350,
  '2026-01:COP': 4300, '2026-02:COP': 4250,
};

function convertLocalToUSD(amount: number, currency: string, yearMonth: string): number {
  if (currency === 'USD') return amount;

  // Check monthly overrides first
  const overrideKey = `${yearMonth}:${currency}`;
  const rate = MONTHLY_RATE_OVERRIDES[overrideKey] ?? CURRENCY_TO_USD[currency];

  if (!rate) {
    console.warn(`Apple: Unknown currency ${currency}, treating as USD`);
    return amount; // unknown currency — treat as USD (safe fallback)
  }

  return amount / rate;
}

function normalizeFinanceRows(
  rows: AppleFinanceRow[],
  reportMonth: string // YYYY-MM
): Omit<Transaction, 'id' | 'synced_at' | 'created_at'>[] {
  const transactionDate = getLastDayOfMonth(reportMonth);

  // Apple Finance Reports have ALL amounts in LOCAL currency:
  // - customerPrice is in customer's local currency
  // - partnerShare / extendedPartnerShare is ALSO in local currency (same as customerCurrency)
  // - partnerShareCurrency ALWAYS equals customerCurrency
  //
  // TWO-PASS APPROACH:
  // Pass 1: Build per-SKU commission rate from same-currency rows
  //         commission_rate = 1 - (partnerShare / customerPrice)
  // Pass 2: Convert local amounts to USD using exchange rate table,
  //         then use commission rate to calculate gross vs net

  // --- PASS 1: Build commission rate map ---
  const skuCommissionRates = new Map<string, number>();
  const allRates: number[] = [];

  for (const row of rows) {
    if (row.quantity === 0 || row.partnerShare <= 0 || row.customerPrice <= 0) continue;
    // partnerShareCurrency always === customerCurrency for Apple
    const rate = 1 - (row.partnerShare / row.customerPrice);
    if (rate > 0.05 && rate < 0.60) { // Sanity: between 5% and 60%
      skuCommissionRates.set(row.vendorIdentifier, rate);
      allRates.push(rate);
    }
  }

  // Compute average commission rate
  const avgCommissionRate = allRates.length > 0
    ? allRates.reduce((a, b) => a + b, 0) / allRates.length
    : 0.30; // last resort fallback

  // --- Build USD price tier map ---
  // Apple sets local prices that correspond to specific USD price tiers.
  // For accurate USD conversion, use the actual USD customer price for each SKU
  // rather than converting from local currency with potentially stale FX rates.
  // Use the HIGHEST USD price seen for each SKU to avoid promotional/sale prices
  // overwriting the standard tier price (e.g., $79.99 vs $77.99).
  const usdPriceTier = new Map<string, number>(); // sku → USD customerPrice per unit
  for (const row of rows) {
    if (row.customerCurrency === 'USD' && row.customerPrice > 0) {
      const existing = usdPriceTier.get(row.vendorIdentifier) || 0;
      if (row.customerPrice > existing) {
        usdPriceTier.set(row.vendorIdentifier, row.customerPrice);
      }
    }
  }

  // --- PASS 2: Aggregate and normalize ---
  // Since we now fetch ONLY the ZZ region (All Territories), there's no cross-region
  // duplication to worry about. We just need to sum same-key rows within ZZ,
  // because Apple splits data by billing period (same SKU+country+price can appear
  // in multiple rows with different quantities for different billing periods).

  interface AggData {
    sku: string;
    country: string;
    title: string;
    productTypeIdentifier: string;
    customerCurrency: string;
    isRefund: boolean;
    customerPriceLocal: number;
    partnerSharePerUnit: number;
    sampleRow: AppleFinanceRow;
    totalQty: number;
    totalNetLocal: number;
  }

  const aggregatedFinal = new Map<string, AggData>();

  for (const row of rows) {
    if (row.quantity === 0 && row.extendedPartnerShare === 0) continue;

    const isSubscription = row.productTypeIdentifier === 'IAY' ||
      row.vendorIdentifier.includes('premium') ||
      row.vendorIdentifier.includes('learn') ||
      row.vendorIdentifier.includes('play');

    if (!isSubscription) continue;

    const isRefund = row.salesOrReturn === 'R' || row.quantity < 0;
    const key = `${row.vendorIdentifier}_${row.countryOfSale}_${isRefund ? 'R' : 'S'}_${row.customerPrice}`;
    const absQty = Math.abs(row.quantity);
    const absNet = Math.abs(row.extendedPartnerShare);

    const existing = aggregatedFinal.get(key);
    if (existing) {
      // Sum billing period splits within the same region
      existing.totalQty += absQty;
      existing.totalNetLocal += absNet;
    } else {
      aggregatedFinal.set(key, {
        sku: row.vendorIdentifier,
        country: row.countryOfSale,
        title: row.title || row.vendorIdentifier,
        productTypeIdentifier: row.productTypeIdentifier,
        customerCurrency: row.customerCurrency,
        isRefund,
        customerPriceLocal: row.customerPrice,
        partnerSharePerUnit: row.partnerShare,
        sampleRow: row,
        totalQty: absQty,
        totalNetLocal: absNet,
      });
    }
  }

  const transactions: Omit<Transaction, 'id' | 'synced_at' | 'created_at'>[] = [];

  for (const [, agg] of aggregatedFinal) {
    const planType = getPlanTypeFromSku(agg.sku);
    const currency = agg.customerCurrency;

    // Convert local amounts to USD
    // Prefer USD price tier (Apple's official USD equivalent) over FX conversion
    const grossLocalTotal = agg.customerPriceLocal * agg.totalQty;
    let grossUSD: number;
    let netUSD: number;

    const usdPrice = usdPriceTier.get(agg.sku);
    if (currency === 'USD') {
      grossUSD = grossLocalTotal;
      netUSD = agg.totalNetLocal; // already in USD
    } else if (usdPrice) {
      // Use Apple's USD price tier for accurate conversion
      grossUSD = usdPrice * agg.totalQty;
      // For net: apply the same commission rate as the local currency version
      const localCommissionRate = grossLocalTotal > 0
        ? 1 - (agg.totalNetLocal / grossLocalTotal)
        : avgCommissionRate;
      netUSD = grossUSD * (1 - localCommissionRate);
    } else {
      // Fallback: FX rate conversion for SKUs without USD pricing
      grossUSD = convertLocalToUSD(grossLocalTotal, currency, reportMonth);
      netUSD = convertLocalToUSD(agg.totalNetLocal, currency, reportMonth);
    }

    const commissionUSD = Math.max(0, grossUSD - netUSD);

    const externalId = agg.isRefund
      ? `apple_fin_refund_${reportMonth}_${agg.sku}_${agg.country}_${agg.sampleRow.customerPrice}`
      : `apple_fin_charge_${reportMonth}_${agg.sku}_${agg.country}_${agg.sampleRow.customerPrice}`;

    if (agg.isRefund) {
      transactions.push({
        source: 'apple',
        transaction_date: transactionDate,
        external_id: externalId,
        sku: agg.sku,
        plan_type: planType,
        plan_name: agg.title,
        transaction_type: 'refund',
        is_new_subscription: false,
        is_renewal: false,
        is_trial_conversion: false,
        subscription_period: null,
        amount_gross: grossUSD,
        amount_net: netUSD,
        commission_amount: 0,
        tax_amount: 0,
        original_amount: grossLocalTotal,
        original_currency: currency,
        country_code: agg.country,
        region: getRegion(agg.country),
        units: agg.totalQty,
        raw_data: agg.sampleRow as unknown as Record<string, unknown>,
        order_id: null,
      });
    } else {
      transactions.push({
        source: 'apple',
        transaction_date: transactionDate,
        external_id: externalId,
        sku: agg.sku,
        plan_type: planType,
        plan_name: agg.title,
        transaction_type: 'charge',
        is_new_subscription: false,
        is_renewal: true,
        is_trial_conversion: false,
        subscription_period: null,
        amount_gross: grossUSD,
        amount_net: netUSD,
        commission_amount: commissionUSD,
        tax_amount: 0,
        original_amount: grossLocalTotal,
        original_currency: currency,
        country_code: agg.country,
        region: getRegion(agg.country),
        units: agg.totalQty,
        raw_data: agg.sampleRow as unknown as Record<string, unknown>,
        order_id: null,
      });
    }
  }

  return transactions;
}

/**
 * Sync Apple Finance Reports for a given month.
 * @param month - Month in YYYY-MM format (e.g., "2025-01")
 * @returns Number of transaction records synced
 */
export async function syncApple(month: string): Promise<number> {
  const token = generateAppleJWT();

  // Fetch ZZ region (All Territories) — contains complete data for all countries.
  // This eliminates cross-region deduplication issues entirely.
  let allRows = await fetchFinanceReportForRegion(token, APPLE_PRIMARY_REGION, month);

  if (allRows.length === 0) {
    // Fallback to WW if ZZ returns nothing
    console.log(`Apple: ZZ region empty for ${month}, trying WW fallback...`);
    allRows = await fetchFinanceReportForRegion(token, APPLE_FALLBACK_REGION, month);
  }

  if (allRows.length === 0) {
    console.log(`Apple: No finance report data for ${month}`);
    return 0;
  }

  console.log(`Apple: ${allRows.length} rows from ZZ region for ${month}`);
  const transactions = normalizeFinanceRows(allRows, month);
  if (transactions.length === 0) return 0;

  const supabase = createServerClient();

  // Upsert in batches of 500
  let totalInserted = 0;
  for (let i = 0; i < transactions.length; i += 500) {
    const batch = transactions.slice(i, i + 500);
    const { error } = await supabase
      .from('transactions')
      .upsert(batch, {
        onConflict: 'source,external_id',
        ignoreDuplicates: false,
      });

    if (error) {
      throw new Error(`Apple sync DB error: ${error.message}`);
    }
    totalInserted += batch.length;
  }

  return totalInserted;
}

// Keep backward compat - date param now treated as month
export async function fetchAppleSalesReport(date: string): Promise<never[]> {
  console.log(`Apple Sales Reports are not available. Use syncApple(month) with Finance Reports instead. Date: ${date}`);
  return [];
}
