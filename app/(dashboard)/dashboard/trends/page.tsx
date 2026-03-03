export const dynamic = 'force-dynamic';

import { Suspense } from 'react';
import { getSnapshots } from '@/lib/dashboard';
import { getPresetDates } from '@/lib/filters';
import { FilterBar } from '@/components/dashboard/FilterBar';
import { TrendsContent } from '@/components/dashboard/TrendsContent';
import { Skeleton } from '@/components/ui/skeleton';
import type { DatePreset } from '@/types';

export default async function TrendsPage({
  searchParams,
}: {
  searchParams: Promise<{
    preset?: string;
    start?: string;
    end?: string;
    sources?: string;
    regions?: string;
    plans?: string;
  }>;
}) {
  const params = await searchParams;
  const preset = (params.preset as DatePreset) || '12m';

  // Resolve date range from preset or custom params
  let start = params.start;
  let end = params.end;
  if (preset !== 'custom' || !start || !end) {
    const dates = getPresetDates(preset);
    start = start || dates.start;
    end = end || dates.end;
  }

  const snapshots = await getSnapshots(start, end);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#0E3687]">Trends</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Month-over-month revenue growth analysis</p>
      </div>

      <Suspense fallback={<Skeleton className="h-8 w-full" />}>
        <FilterBar />
      </Suspense>

      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <TrendsContent snapshots={snapshots} />
      </Suspense>
    </div>
  );
}
