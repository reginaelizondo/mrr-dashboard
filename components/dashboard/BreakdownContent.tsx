'use client';

import { useSearchParams } from 'next/navigation';
import { parseFiltersFromParams, applyFilters } from '@/lib/filters';
import { SourceBreakdownChart } from '@/components/charts/SourceBreakdownChart';
import { RegionBreakdownChart } from '@/components/charts/RegionBreakdownChart';
import { PlanBreakdownChart } from '@/components/charts/PlanBreakdownChart';
import { ExportButton } from '@/components/dashboard/ExportButton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { MrrDailySnapshot } from '@/types';

export function BreakdownContent({
  snapshots,
  defaultTab = 'source',
}: {
  snapshots: MrrDailySnapshot[];
  defaultTab?: string;
}) {
  const searchParams = useSearchParams();
  const filters = parseFiltersFromParams(new URLSearchParams(searchParams.toString()));
  const filtered = applyFilters(snapshots, filters);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <ExportButton snapshots={filtered} />
      </div>
      <Tabs defaultValue={defaultTab}>
        <TabsList className="bg-white border border-border/50 shadow-sm">
          <TabsTrigger
            value="source"
            className="data-[state=active]:bg-[#0086D8] data-[state=active]:text-white data-[state=active]:shadow-sm"
          >
            By Source
          </TabsTrigger>
          <TabsTrigger
            value="region"
            className="data-[state=active]:bg-[#0086D8] data-[state=active]:text-white data-[state=active]:shadow-sm"
          >
            By Region
          </TabsTrigger>
          <TabsTrigger
            value="plan"
            className="data-[state=active]:bg-[#0086D8] data-[state=active]:text-white data-[state=active]:shadow-sm"
          >
            By Plan
          </TabsTrigger>
        </TabsList>
        <TabsContent value="source" className="mt-4">
          <SourceBreakdownChart data={filtered} />
        </TabsContent>
        <TabsContent value="region" className="mt-4">
          <RegionBreakdownChart data={filtered} />
        </TabsContent>
        <TabsContent value="plan" className="mt-4">
          <PlanBreakdownChart data={filtered} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
