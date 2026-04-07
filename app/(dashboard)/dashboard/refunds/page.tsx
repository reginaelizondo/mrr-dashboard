export const dynamic = 'force-dynamic';

import { Suspense } from 'react';
import {
  getRefundsByMonth,
  getAppleRefundsByWeek,
  getAppleRefundBreakdowns,
  getLastAppleSalesSync,
} from '@/lib/refunds';
import { RefundsContent } from '@/components/dashboard/RefundsContent';
import { Skeleton } from '@/components/ui/skeleton';
import type { Source } from '@/types';

type Preset = '3m' | '6m' | '12m' | 'ytd' | 'all' | 'custom';
type Granularity = 'monthly' | 'weekly';

interface PageParams {
  preset?: string;
  start?: string; // YYYY-MM-DD
  end?: string;   // YYYY-MM-DD
  granularity?: string;
}

function resolveDateRange(params: PageParams): {
  startDate: string;
  endDate: string;
  startMonth: string;
  endMonth: string;
  preset: Preset;
} {
  const preset = (params.preset as Preset) || '12m';

  // End = today (or user-supplied end) by default
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
      case 'all':
        // Apple SUBSCRIPTION_EVENT and SALES retain ~365 days, so cap at 13 months
        start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 12, 1));
        break;
      default:
        start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1));
    }
  }

  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  const startMonth = startDate.slice(0, 7);
  const endMonth = endDate.slice(0, 7);

  return { startDate, endDate, startMonth, endMonth, preset };
}

export default async function RefundsPage({
  searchParams,
}: {
  searchParams: Promise<PageParams>;
}) {
  const params = await searchParams;
  const range = resolveDateRange(params);
  const granularity: Granularity = params.granularity === 'weekly' ? 'weekly' : 'monthly';

  const [apple, google, stripe, appleWeekly, appleBreakdowns, lastSync] = await Promise.all([
    getRefundsByMonth('apple', range.startMonth, range.endMonth),
    getRefundsByMonth('google', range.startMonth, range.endMonth),
    getRefundsByMonth('stripe', range.startMonth, range.endMonth),
    granularity === 'weekly'
      ? getAppleRefundsByWeek(range.startDate, range.endDate)
      : Promise.resolve([]),
    getAppleRefundBreakdowns(range.startDate, range.endDate).catch((err) => {
      console.error('[refunds] apple breakdowns failed:', err);
      return null;
    }),
    getLastAppleSalesSync(),
  ]);

  const data: Record<Source, Awaited<ReturnType<typeof getRefundsByMonth>>> = {
    apple,
    google,
    stripe,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#0E3687]">Refunds</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Refund rate monitoring — required for App Review Guideline 5.6.4 compliance
        </p>
      </div>

      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <RefundsContent
          data={data}
          appleWeekly={appleWeekly}
          appleBreakdowns={appleBreakdowns}
          lastSync={lastSync}
          preset={range.preset}
          startDate={range.startDate}
          endDate={range.endDate}
          granularity={granularity}
        />
      </Suspense>
    </div>
  );
}
