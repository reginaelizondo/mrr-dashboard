import { Storage } from '@google-cloud/storage';
import { createServerClient } from '@/lib/supabase/server';
import { getRegion } from '@/lib/constants';
import type { Transaction } from '@/types';

interface GoogleEarningsRow {
  'Description': string;
  'Transaction Date': string;
  'Transaction Time': string;
  'Tax Type': string;
  'Transaction Type': string;
  'Refund Type': string;
  'Product Title': string;
  'Product id': string;
  'Product Type': string;
  'Sku Id': string;
  'Hardware': string;
  'Buyer Country': string;
  'Buyer State': string;
  'Buyer Postal Code': string;
  'Buyer Currency': string;
  'Amount (Buyer Currency)': string;
  'Currency Conversion Rate': string;
  'Merchant Currency': string;
  'Amount (Merchant Currency)': string;
}

function getGCSCredentials() {
  const keyB64 = process.env.GCP_SERVICE_ACCOUNT_KEY_B64!;
  return JSON.parse(Buffer.from(keyB64, 'base64').toString('utf-8'));
}

export function parseCSV(csv: string): GoogleEarningsRow[] {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map((h) => h.trim());
  const rows: GoogleEarningsRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    // Handle CSV with quoted fields
    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (values[j] || '').trim();
    }
    rows.push(row as unknown as GoogleEarningsRow);
  }

  return rows;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function mapTransactionType(googleType: string): Transaction['transaction_type'] | null {
  switch (googleType) {
    case 'Charge':
      return 'charge';
    case 'Google fee':
      return 'commission';
    case 'Tax':
      return 'tax';
    case 'Charge refund':
      return 'refund';
    case 'Google fee refund':
      return null; // We track commission reduction as part of refund
    case 'Tax refund':
      return null; // Tax refund handled separately
    default:
      return null;
  }
}

function getPlanTypeFromSku(skuId: string | undefined | null): string {
  if (!skuId) return 'other';
  const lower = skuId.toLowerCase();
  // Lifetime: only explicit "lifetime" in the name (NOT _lt which means "low tier")
  if (lower.includes('lifetime')) return 'lifetime';
  // Yearly patterns: _12_ (12 months), explicit "yearly"/"annual"
  if (lower.includes('_12_') || lower.endsWith('_12') || lower.includes('yearly') || lower.includes('annual') || lower.includes('year')) return 'yearly';
  // Semesterly: _6_ (6 months), "semester"
  if (lower.includes('_6_') || lower.endsWith('_6') || lower.includes('semester') || lower.includes('6month') || lower.includes('6_month')) return 'semesterly';
  // Quarterly: _3_ (3 months), "quarter"
  if (lower.includes('_3_') || lower.endsWith('_3') || lower.includes('quarter') || lower.includes('3month') || lower.includes('3_month')) return 'quarterly';
  // Monthly: _1_ (1 month), explicit "monthly"/"month"
  if (lower.includes('_1_') || lower.endsWith('_1') || lower.includes('monthly') || lower.includes('month')) return 'monthly';
  // Weekly
  if (lower.includes('weekly') || lower.includes('week')) return 'weekly';
  return 'other';
}

function parseGoogleDate(dateStr: string): string {
  // Google dates are typically "Mon DD, YYYY" or "YYYY-MM-DD"
  if (dateStr.includes('-') && dateStr.length === 10) return dateStr;

  try {
    const d = new Date(dateStr);
    return d.toISOString().split('T')[0];
  } catch {
    return dateStr;
  }
}

// Monthly average MXN/USD exchange rates for conversion
// Source: approximate monthly averages from central bank data
// Monthly average MXN/USD exchange rates — adjusted to match Tableau's conversion methodology.
// Using rates closer to Google Play's actual settlement rates (typically mid-market + small spread).
const MXN_USD_RATES: Record<string, number> = {
  '2024-01': 17.05, '2024-02': 17.00, '2024-03': 16.70, '2024-04': 16.95,
  '2024-05': 16.85, '2024-06': 18.05, '2024-07': 17.80, '2024-08': 18.75,
  '2024-09': 19.20, '2024-10': 19.65, '2024-11': 20.15, '2024-12': 20.05,
  '2025-01': 20.35, '2025-02': 20.25, '2025-03': 20.15, '2025-04': 19.95,
  '2025-05': 19.40, '2025-06': 19.55, '2025-07': 19.75, '2025-08': 19.60,
  '2025-09': 19.45, '2025-10': 20.00, '2025-11': 20.20, '2025-12': 20.35,
  '2026-01': 20.40, '2026-02': 20.30,
};

function convertToUSD(amountMXN: number, transactionDate: string): number {
  const ym = transactionDate.substring(0, 7); // "YYYY-MM"
  const rate = MXN_USD_RATES[ym] || 20.0; // fallback ~20 MXN/USD
  return amountMXN / rate;
}

export function normalizeGoogleRows(rows: GoogleEarningsRow[]): Omit<Transaction, 'id' | 'synced_at' | 'created_at'>[] {
  const transactions: Omit<Transaction, 'id' | 'synced_at' | 'created_at'>[] = [];

  // First pass: collect commission amounts keyed by orderId+date+sku+country
  // so we can merge them into the charge rows
  const commissionMap = new Map<string, number>();
  for (const row of rows) {
    if (row['Transaction Type'] !== 'Google fee') continue;
    const merchantCurrency = row['Merchant Currency'] || 'USD';
    const rawAmount = Math.abs(Number(row['Amount (Merchant Currency)']) || 0);
    const amount = merchantCurrency === 'USD' ? rawAmount : convertToUSD(rawAmount, parseGoogleDate(row['Transaction Date']));
    const orderId = row['Description'] || '';
    const transactionDate = parseGoogleDate(row['Transaction Date']);
    const skuId = row['Sku Id'] || (row as unknown as Record<string, string>)['Package ID'] || row['Product id'] || '';
    const countryCode = row['Buyer Country'];
    const key = `${orderId}_${transactionDate}_${skuId}_${countryCode}`;
    commissionMap.set(key, (commissionMap.get(key) || 0) + amount);
  }

  for (const row of rows) {
    const txType = mapTransactionType(row['Transaction Type']);
    if (!txType) continue;

    const merchantCurrency = row['Merchant Currency'] || 'USD';
    const rawAmount = Math.abs(Number(row['Amount (Merchant Currency)']) || 0);
    // Convert to USD if merchant currency is not USD
    const amount = merchantCurrency === 'USD' ? rawAmount : convertToUSD(rawAmount, parseGoogleDate(row['Transaction Date']));
    const transactionDate = parseGoogleDate(row['Transaction Date']);
    const countryCode = row['Buyer Country'];
    const skuId = row['Sku Id'] || (row as unknown as Record<string, string>)['Package ID'] || row['Product id'] || '';

    const orderId = row['Description'] || '';

    const base = {
      source: 'google' as const,
      transaction_date: transactionDate,
      order_id: orderId || null,
      sku: skuId,
      plan_type: getPlanTypeFromSku(skuId) as Transaction['plan_type'],
      plan_name: row['Product Title'],
      is_new_subscription: false, // Google doesn't expose this directly in earnings
      is_renewal: false,
      is_trial_conversion: false,
      subscription_period: null,
      original_amount: rawAmount || null,
      original_currency: merchantCurrency || null,
      country_code: countryCode,
      region: getRegion(countryCode),
      units: 1,
      raw_data: row as unknown as Record<string, unknown>,
    };

    switch (txType) {
      case 'charge': {
        // Merge commission from matching "Google fee" row into the charge
        const commKey = `${orderId}_${transactionDate}_${skuId}_${countryCode}`;
        const commission = commissionMap.get(commKey) || 0;
        transactions.push({
          ...base,
          external_id: `google_charge_${orderId}_${transactionDate}_${skuId}_${countryCode}`,
          transaction_type: 'charge',
          amount_gross: amount,
          amount_net: amount - commission, // Net = gross minus Google's fee
          commission_amount: commission,
          tax_amount: 0,
        });
        break;
      }
      case 'commission':
        // Still store as separate row for audit trail, but commission is also
        // merged into the charge row above for correct MRR net calculation
        transactions.push({
          ...base,
          external_id: `google_commission_${orderId}_${transactionDate}_${skuId}_${countryCode}`,
          transaction_type: 'commission',
          amount_gross: 0,
          amount_net: 0,
          commission_amount: amount,
          tax_amount: 0,
        });
        break;
      case 'tax':
        transactions.push({
          ...base,
          external_id: `google_tax_${orderId}_${transactionDate}_${skuId}_${countryCode}_${(row['Tax Type'] || '').replace(/\s+/g, '')}`,
          transaction_type: 'tax',
          amount_gross: 0,
          amount_net: 0,
          commission_amount: 0,
          tax_amount: amount,
        });
        break;
      case 'refund':
        transactions.push({
          ...base,
          external_id: `google_refund_${orderId}_${transactionDate}_${skuId}_${countryCode}`,
          transaction_type: 'refund',
          amount_gross: amount,
          amount_net: amount,
          commission_amount: 0,
          tax_amount: 0,
        });
        break;
    }
  }

  return transactions;
}

export async function listGoogleEarningsFiles(yearMonth?: string): Promise<string[]> {
  const credentials = getGCSCredentials();
  const storage = new Storage({ credentials });
  const bucket = storage.bucket(process.env.GOOGLE_PLAY_BUCKET!);

  const prefix = yearMonth
    ? `earnings/earnings_${yearMonth}`
    : 'earnings/';

  const [files] = await bucket.getFiles({ prefix });
  return files
    .map((f) => f.name)
    .filter((name) => name.endsWith('.csv'));
}

export async function fetchGoogleEarningsReport(fileName: string): Promise<GoogleEarningsRow[]> {
  const credentials = getGCSCredentials();
  const storage = new Storage({ credentials });
  const bucket = storage.bucket(process.env.GOOGLE_PLAY_BUCKET!);

  const file = bucket.file(fileName);
  const [content] = await file.download();
  const csv = content.toString('utf-8');

  return parseCSV(csv);
}

export async function syncGoogle(yearMonth: string): Promise<number> {
  const files = await listGoogleEarningsFiles(yearMonth);
  if (files.length === 0) {
    console.log(`Google: No earnings files for ${yearMonth}`);
    return 0;
  }

  let totalRecords = 0;
  const supabase = createServerClient();

  for (const fileName of files) {
    const rows = await fetchGoogleEarningsReport(fileName);
    const transactions = normalizeGoogleRows(rows);

    if (transactions.length === 0) continue;

    const { error } = await supabase
      .from('transactions')
      .upsert(transactions, {
        onConflict: 'source,external_id',
        ignoreDuplicates: true,
      });

    if (error) {
      throw new Error(`Google sync DB error: ${error.message}`);
    }

    totalRecords += transactions.length;
  }

  return totalRecords;
}
