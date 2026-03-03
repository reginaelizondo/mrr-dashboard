import { NextRequest, NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { gunzipSync } from 'zlib';

export const maxDuration = 60;

const APPLE_REGIONS = ['US', 'CA', 'MX', 'BR', 'GB', 'EU', 'AU', 'JP', 'CN', 'WW', 'ZZ'];

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

/**
 * GET /api/sync/apple-diagnose?month=2026-01
 *
 * Fetches Apple Finance Report for a given month and returns raw statistics:
 * - Total rows per region
 * - Product type breakdown (IAY vs others)
 * - Unique SKU list with counts
 * - What's being INCLUDED vs EXCLUDED by the subscription filter
 */
export async function GET(request: NextRequest) {
  const month = request.nextUrl.searchParams.get('month') || '2026-01';
  const token = generateAppleJWT();

  const regionStats: Record<string, {
    totalRows: number;
    byProductType: Record<string, number>;
    totalUnits: number;
    totalPartnerShare: number;
    totalCustomerPrice: number;
    sampleSkus: string[];
  }> = {};

  let allRows: Record<string, string>[] = [];

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

      if (!response.ok) {
        regionStats[regionCode] = {
          totalRows: 0,
          byProductType: { [`HTTP_${response.status}`]: 1 },
          totalUnits: 0,
          totalPartnerShare: 0,
          totalCustomerPrice: 0,
          sampleSkus: [],
        };
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      let tsvContent: string;
      try {
        tsvContent = gunzipSync(buffer).toString('utf-8');
      } catch {
        tsvContent = buffer.toString('utf-8');
      }

      const lines = tsvContent.trim().split('\n');
      if (lines.length < 2) {
        regionStats[regionCode] = {
          totalRows: 0,
          byProductType: {},
          totalUnits: 0,
          totalPartnerShare: 0,
          totalCustomerPrice: 0,
          sampleSkus: [],
        };
        continue;
      }

      const headers = lines[0].split('\t');
      const rows: Record<string, string>[] = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split('\t');
        const row: Record<string, string> = {};
        for (let j = 0; j < headers.length; j++) {
          row[headers[j]?.trim()] = cols[j]?.trim() || '';
        }
        rows.push(row);
      }

      allRows.push(...rows.map(r => ({ ...r, _region: regionCode })));

      const byProductType: Record<string, number> = {};
      let totalUnits = 0;
      let totalPartnerShare = 0;
      let totalCustomerPrice = 0;
      const skuSet = new Set<string>();

      for (const row of rows) {
        const pti = row['Product Type Identifier'] || 'unknown';
        byProductType[pti] = (byProductType[pti] || 0) + 1;
        totalUnits += Math.abs(parseInt(row['Quantity']) || 0);
        totalPartnerShare += Math.abs(parseFloat(row['Extended Partner Share']) || 0);
        totalCustomerPrice += Math.abs(parseFloat(row['Customer Price']) || 0) * Math.abs(parseInt(row['Quantity']) || 0);
        skuSet.add(row['Vendor Identifier'] || 'unknown');
      }

      regionStats[regionCode] = {
        totalRows: rows.length,
        byProductType,
        totalUnits,
        totalPartnerShare,
        totalCustomerPrice,
        sampleSkus: Array.from(skuSet).slice(0, 20),
      };
    } catch (err) {
      regionStats[regionCode] = {
        totalRows: 0,
        byProductType: { error: 1 },
        totalUnits: 0,
        totalPartnerShare: 0,
        totalCustomerPrice: 0,
        sampleSkus: [(err as Error).message],
      };
    }
  }

  // Aggregate across all rows
  const productTypes: Record<string, { count: number; units: number; partnerShare: number; customerTotal: number }> = {};
  const skuCounts: Record<string, { count: number; units: number; amount: number }> = {};

  // Track what current filter would include/exclude
  let includedRows = 0;
  let excludedRows = 0;
  let includedUnits = 0;
  let excludedUnits = 0;
  let includedAmount = 0;
  let excludedAmount = 0;
  const excludedSkus: Record<string, { count: number; units: number; amount: number; productType: string }> = {};

  for (const row of allRows) {
    const pti = row['Product Type Identifier'] || 'unknown';
    const qty = Math.abs(parseInt(row['Quantity']) || 0);
    const ps = Math.abs(parseFloat(row['Extended Partner Share']) || 0);
    const cp = Math.abs(parseFloat(row['Customer Price']) || 0) * qty;
    const sku = row['Vendor Identifier'] || 'unknown';

    if (!productTypes[pti]) productTypes[pti] = { count: 0, units: 0, partnerShare: 0, customerTotal: 0 };
    productTypes[pti].count++;
    productTypes[pti].units += qty;
    productTypes[pti].partnerShare += ps;
    productTypes[pti].customerTotal += cp;

    if (!skuCounts[sku]) skuCounts[sku] = { count: 0, units: 0, amount: 0 };
    skuCounts[sku].count++;
    skuCounts[sku].units += qty;
    skuCounts[sku].amount += cp;

    // Apply current filter logic
    const isSubscription = pti === 'IAY' ||
      sku.toLowerCase().includes('premium') ||
      sku.toLowerCase().includes('learn') ||
      sku.toLowerCase().includes('play');

    const isReturn = row['Sales or Return'] === 'R' || qty < 0;

    if (isSubscription && qty > 0 && !isReturn) {
      includedRows++;
      includedUnits += qty;
      includedAmount += cp;
    } else if (!isSubscription && qty > 0 && !isReturn) {
      excludedRows++;
      excludedUnits += qty;
      excludedAmount += cp;
      if (!excludedSkus[sku]) excludedSkus[sku] = { count: 0, units: 0, amount: 0, productType: pti };
      excludedSkus[sku].count++;
      excludedSkus[sku].units += qty;
      excludedSkus[sku].amount += cp;
    }
  }

  return NextResponse.json({
    month,
    totalRows: allRows.length,
    regionStats,
    productTypes,
    topSkus: Object.entries(skuCounts)
      .sort((a, b) => b[1].amount - a[1].amount)
      .slice(0, 30)
      .map(([sku, data]) => ({ sku, ...data })),
    filterAnalysis: {
      includedRows,
      includedUnits,
      includedAmount,
      excludedRows,
      excludedUnits,
      excludedAmount,
      excludedSkus: Object.entries(excludedSkus)
        .sort((a, b) => b[1].amount - a[1].amount)
        .map(([sku, data]) => ({ sku, ...data })),
    },
  });
}
