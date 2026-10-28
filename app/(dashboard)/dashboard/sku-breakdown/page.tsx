export const dynamic = 'force-dynamic';
// Headroom for the legacy (pre-migration-045) path, which still pulls every
// charge of the window; the RPC path answers in a few seconds.
export const maxDuration = 120;

import { Suspense } from 'react';
import { getSkuBreakdown } from '@/lib/sku-breakdown';
import { getSkuDims, getSkuMix } from '@/lib/sku-mix';
import { parseSkuFilters, resolveSkuGrain, resolveSkuRange } from '@/lib/sku-filters';
import { SkuBreakdownContent } from '@/components/dashboard/SkuBreakdownContent';
import { SkuMixByStore } from '@/components/dashboard/SkuMixByStore';
import { SkuFilterBar } from '@/components/dashboard/SkuFilterBar';
import { ManualSyncButton } from '@/components/dashboard/ManualSyncButton';
import { Skeleton } from '@/components/ui/skeleton';

export default async function SkuBreakdownPage({
  searchParams,
}: {
  searchParams: Promise<{
    preset?: string; start?: string; end?: string; grain?: string;
    sources?: string; regions?: string; countries?: string;
  }>;
}) {
  const params = await searchParams;
  const range = resolveSkuRange(params);
  const grain = resolveSkuGrain(params.grain);
  const filters = parseSkuFilters(params);

  const [data, mix, dimsRpc] = await Promise.all([
    getSkuBreakdown(range.start, range.end, filters),
    getSkuMix(range.start, range.end, filters),
    getSkuDims(),
  ]);
  // Dropdown values: from the RPC (migration 045); before that, from whatever
  // the legacy mix fetch saw in the window.
  const dims = dimsRpc ?? mix.dims ?? null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#0E3687]">SKU Breakdown</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            New vs recurring sales and volume by SKU — accrual basis (matches MRR)
          </p>
          <p className="text-xs text-amber-600 mt-1">
            Note: on intro-priced SKUs (ht_c, mt_c, ht_d) &quot;recurring&quot; includes intro→full-price
            conversions (~1 month after the $3.99 entry) — not only true renewals.
          </p>
        </div>
        <ManualSyncButton />
      </div>

      <SkuFilterBar preset={range.preset} start={range.start} end={range.end} grain={grain} filters={filters} dims={dims} monthCount={data.months.length} />

      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <SkuMixByStore data={mix} grain={grain} />
        <div className="h-6" />
        <SkuBreakdownContent key={`${range.start}-${range.end}-${JSON.stringify(filters)}`} data={data} grain={grain} />
      </Suspense>
    </div>
  );
}
