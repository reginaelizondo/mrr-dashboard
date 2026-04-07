export const dynamic = 'force-dynamic';

import { Suspense } from 'react';
import { getRefundsByMonth, getAppleRefundBreakdowns } from '@/lib/refunds';
import { RefundsContent } from '@/components/dashboard/RefundsContent';
import { Skeleton } from '@/components/ui/skeleton';
import type { Source } from '@/types';

export default async function RefundsPage() {
  const [apple, google, stripe, appleBreakdowns] = await Promise.all([
    getRefundsByMonth('apple', 24),
    getRefundsByMonth('google', 24),
    getRefundsByMonth('stripe', 24),
    getAppleRefundBreakdowns(90).catch((err) => {
      console.error('[refunds] apple breakdowns failed:', err);
      return null;
    }),
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
        <RefundsContent data={data} appleBreakdowns={appleBreakdowns} />
      </Suspense>
    </div>
  );
}
