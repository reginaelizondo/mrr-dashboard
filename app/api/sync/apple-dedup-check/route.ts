import { NextRequest, NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { gunzipSync } from 'zlib';

export const maxDuration = 120;

const APPLE_REGIONS = ['US', 'CA', 'MX', 'BR', 'GB', 'EU', 'AU', 'JP', 'CN', 'WW', 'ZZ'];

function generateAppleJWT(): string {
  const privateKey = Buffer.from(
    process.env.APPLE_PRIVATE_KEY_B64!,
    'base64'
  ).toString('utf-8');
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: process.env.APPLE_ISSUER_ID!, iat: now, exp: now + 20 * 60, aud: 'appstoreconnect-v1' },
    privateKey,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: process.env.APPLE_KEY_ID!, typ: 'JWT' } }
  );
}

interface RawRow {
  vendorIdentifier: string;
  countryOfSale: string;
  customerPrice: number;
  customerCurrency: string;
  partnerShare: number;
  partnerShareCurrency: string;
  extendedPartnerShare: number;
  quantity: number;
  salesOrReturn: string;
  productTypeIdentifier: string;
  title: string;
  _region: string;
}

/**
 * GET /api/sync/apple-dedup-check?month=2026-01
 *
 * Fetches Apple data and simulates the dedup process, showing exactly what happens.
 */
export async function GET(request: NextRequest) {
  const month = request.nextUrl.searchParams.get('month') || '2026-01';
  const token = generateAppleJWT();

  const allRows: RawRow[] = [];

  for (const regionCode of APPLE_REGIONS) {
    try {
      const url = new URL('https://api.appstoreconnect.apple.com/v1/financeReports');
      url.searchParams.set('filter[regionCode]', regionCode);
      url.searchParams.set('filter[reportType]', 'FINANCIAL');
      url.searchParams.set('filter[reportDate]', month);
      url.searchParams.set('filter[vendorNumber]', process.env.APPLE_VENDOR_NUMBER!);

      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) continue;

      const buffer = Buffer.from(await response.arrayBuffer());
      let tsvContent: string;
      try {
        tsvContent = gunzipSync(buffer).toString('utf-8');
      } catch {
        tsvContent = buffer.toString('utf-8');
      }

      const lines = tsvContent.trim().split('\n');
      if (lines.length < 2) continue;

      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split('\t');
        if (cols.length < 22) continue;
        allRows.push({
          vendorIdentifier: cols[4]?.trim() || '',
          countryOfSale: cols[17]?.trim() || '',
          customerPrice: parseFloat(cols[20]?.trim()) || 0,
          customerCurrency: cols[21]?.trim() || '',
          partnerShare: parseFloat(cols[6]?.trim()) || 0,
          partnerShareCurrency: cols[8]?.trim() || '',
          extendedPartnerShare: parseFloat(cols[7]?.trim()) || 0,
          quantity: parseInt(cols[5]?.trim()) || 0,
          salesOrReturn: cols[9]?.trim() || '',
          productTypeIdentifier: cols[15]?.trim() || '',
          title: cols[12]?.trim() || '',
          _region: regionCode,
        });
      }
    } catch (err) {
      console.error(`Error fetching ${regionCode}:`, err);
    }
  }

  // Simulate the exact dedup logic from apple.ts
  const aggregated = new Map<string, RawRow & { firstRegion: string; duplicateRegions: string[] }>();
  const skippedByFilter: RawRow[] = [];
  const skippedByDedup: (RawRow & { existingRegion: string })[] = [];

  for (const row of allRows) {
    if (row.quantity === 0 && row.extendedPartnerShare === 0) continue;

    const isSubscription = row.productTypeIdentifier === 'IAY' ||
      row.vendorIdentifier.includes('premium') ||
      row.vendorIdentifier.includes('learn') ||
      row.vendorIdentifier.includes('play');

    if (!isSubscription) {
      skippedByFilter.push(row);
      continue;
    }

    const isRefund = row.salesOrReturn === 'R' || row.quantity < 0;
    if (isRefund) continue; // Skip refunds for this analysis

    const key = `${row.vendorIdentifier}_${row.countryOfSale}_S_${row.customerPrice}`;
    const existing = aggregated.get(key);

    if (existing) {
      existing.duplicateRegions.push(row._region);
      skippedByDedup.push({ ...row, existingRegion: existing.firstRegion });
    } else {
      aggregated.set(key, {
        ...row,
        firstRegion: row._region,
        duplicateRegions: [],
      });
    }
  }

  // Calculate totals
  let keptUnits = 0;
  let keptAmount = 0; // In local currencies (for raw comparison)
  const keptByRegion: Record<string, { rows: number; units: number }> = {};

  for (const [, agg] of aggregated) {
    const qty = Math.abs(agg.quantity);
    keptUnits += qty;
    keptAmount += agg.customerPrice * qty;

    if (!keptByRegion[agg.firstRegion]) keptByRegion[agg.firstRegion] = { rows: 0, units: 0 };
    keptByRegion[agg.firstRegion].rows++;
    keptByRegion[agg.firstRegion].units += qty;
  }

  let skippedUnits = 0;
  let skippedAmount = 0;
  const skippedByRegion: Record<string, { rows: number; units: number }> = {};

  for (const row of skippedByDedup) {
    const qty = Math.abs(row.quantity);
    skippedUnits += qty;
    skippedAmount += row.customerPrice * qty;

    if (!skippedByRegion[row._region]) skippedByRegion[row._region] = { rows: 0, units: 0 };
    skippedByRegion[row._region].rows++;
    skippedByRegion[row._region].units += qty;
  }

  // Check for quantity mismatches between kept and skipped
  const quantityMismatches: { key: string; keptQty: number; keptRegion: string; skippedQty: number; skippedRegion: string }[] = [];

  for (const row of skippedByDedup) {
    const key = `${row.vendorIdentifier}_${row.countryOfSale}_S_${row.customerPrice}`;
    const kept = aggregated.get(key)!;
    if (Math.abs(row.quantity) !== Math.abs(kept.quantity)) {
      quantityMismatches.push({
        key,
        keptQty: Math.abs(kept.quantity),
        keptRegion: kept.firstRegion,
        skippedQty: Math.abs(row.quantity),
        skippedRegion: row._region,
      });
    }
  }

  // Country analysis: which countries are in ZZ but NOT in specific regions?
  const countriesInSpecific = new Set<string>();
  const countriesInZZ = new Set<string>();

  for (const row of allRows) {
    if (row._region !== 'ZZ' && row._region !== 'WW') {
      countriesInSpecific.add(row.countryOfSale);
    }
    if (row._region === 'ZZ') {
      countriesInZZ.add(row.countryOfSale);
    }
  }

  const zzOnlyCountries = [...countriesInZZ].filter(c => !countriesInSpecific.has(c));

  return NextResponse.json({
    month,
    totalRawRows: allRows.length,
    totalKept: { rows: aggregated.size, units: keptUnits, localAmount: keptAmount },
    totalSkippedByDedup: { rows: skippedByDedup.length, units: skippedUnits, localAmount: skippedAmount },
    totalSkippedByFilter: skippedByFilter.length,
    keptByRegion,
    skippedByRegion,
    quantityMismatchCount: quantityMismatches.length,
    quantityMismatches: quantityMismatches.slice(0, 50),
    countriesInSpecificRegions: countriesInSpecific.size,
    countriesInZZ: countriesInZZ.size,
    zzOnlyCountries,
    zzOnlyCountryCount: zzOnlyCountries.length,
  });
}
