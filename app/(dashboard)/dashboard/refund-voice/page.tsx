export const dynamic = 'force-dynamic';

import { Suspense } from 'react';
import { getRefundVoice } from '@/lib/refund-voice';
import { getAvailableTerritories } from '@/lib/reviews';
import { RefundVoiceContent } from '@/components/dashboard/RefundVoiceContent';
import { Skeleton } from '@/components/ui/skeleton';

type Preset = '3m' | '6m' | '12m' | 'ytd' | 'custom';
type Granularity = 'monthly' | 'weekly';

interface PageParams {
  preset?: string;
  start?: string;
  end?: string;
  territories?: string;
  granularity?: string;
}

function resolveMonthRange(params: PageParams): {
  startMonth: string;
  endMonth: string;
  preset: Preset;
} {
  const preset = (params.preset as Preset) || '6m';
  const today = new Date();
  let end = today;
  if (preset === 'custom' && params.end) end = new Date(params.end + 'T00:00:00Z');

  let start: Date;
  if (preset === 'custom' && params.start) {
    start = new Date(params.start + 'T00:00:00Z');
  } else {
    switch (preset) {
      case '3m':
        start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 2, 1));
        break;
      case '6m':
        start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 5, 1));
        break;
      case '12m':
        start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1));
        break;
      case 'ytd':
        start = new Date(Date.UTC(end.getUTCFullYear(), 0, 1));
        break;
      default:
        start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 5, 1));
    }
  }

  return {
    startMonth: start.toISOString().slice(0, 7),
    endMonth: end.toISOString().slice(0, 7),
    preset,
  };
}

async function RefundVoiceData({
  startMonth,
  endMonth,
  preset,
  granularity,
  selectedTerritories,
}: {
  startMonth: string;
  endMonth: string;
  preset: Preset;
  granularity: Granularity;
  selectedTerritories: string[];
}) {
  const territoriesFilter =
    selectedTerritories.length > 0 ? selectedTerritories : undefined;

  const [data, availableTerritories] = await Promise.all([
    getRefundVoice(startMonth, endMonth, territoriesFilter, granularity),
    getAvailableTerritories(),
  ]);

  return (
    <RefundVoiceContent
      data={data}
      availableTerritories={availableTerritories}
      preset={preset}
      granularity={granularity}
      startMonth={startMonth}
      endMonth={endMonth}
      selectedTerritories={selectedTerritories}
    />
  );
}

export default async function RefundVoicePage({
  searchParams,
}: {
  searchParams: Promise<PageParams>;
}) {
  const params = await searchParams;
  const range = resolveMonthRange(params);
  const granularity: Granularity =
    params.granularity === 'weekly' ? 'weekly' : 'monthly';
  const selectedTerritories = params.territories
    ? params.territories
        .split(',')
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean)
    : [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold text-[#0E3687]">Voice of Refund</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Correlación entre <strong>reviews negativas</strong> y{' '}
          <strong>refunds</strong> a nivel mes × país. Apple no expone un
          identificador común entre reviews y refunds, así que esta vista
          agrega la señal estadística: ¿qué quejas coinciden con los picos de
          refund?
        </p>
      </div>

      <Suspense fallback={<VoiceSkeleton />}>
        <RefundVoiceData
          startMonth={range.startMonth}
          endMonth={range.endMonth}
          preset={range.preset}
          granularity={granularity}
          selectedTerritories={selectedTerritories}
        />
      </Suspense>
    </div>
  );
}

function VoiceSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-20 w-full" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Skeleton className="h-96" />
        <Skeleton className="h-96" />
      </div>
      <Skeleton className="h-80 w-full" />
    </div>
  );
}
