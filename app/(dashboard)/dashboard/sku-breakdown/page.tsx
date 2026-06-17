export const dynamic = 'force-dynamic';

import { Suspense } from 'react';
import { format, subMonths } from 'date-fns';
import { getSkuBreakdown } from '@/lib/sku-breakdown';
import { SkuBreakdownContent } from '@/components/dashboard/SkuBreakdownContent';
import { ManualSyncButton } from '@/components/dashboard/ManualSyncButton';
import { Skeleton } from '@/components/ui/skeleton';

export default async function SkuBreakdownPage({
  searchParams,
}: {
  searchParams: Promise<{ start?: string; end?: string }>;
}) {
  const params = await searchParams;
  const now = new Date();
  const endMonth = params.end || format(now, 'yyyy-MM');
  const startMonth = params.start || format(subMonths(now, 17), 'yyyy-MM');

  const data = await getSkuBreakdown(startMonth, endMonth);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#0E3687]">Breakdown por SKU</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Ventas nuevas vs recurrentes y volumen por SKU — base devengada (cuadra con el MRR)
          </p>
        </div>
        <ManualSyncButton />
      </div>

      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <SkuBreakdownContent data={data} />
      </Suspense>
    </div>
  );
}
