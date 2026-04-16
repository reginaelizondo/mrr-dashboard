'use client';

import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { SegmentStat } from '@/lib/nps/types';
import { cn } from '@/lib/utils';

interface NpsBySegmentChartProps {
  title: string;
  description?: string;
  data: SegmentStat[];
}

function scoreColor(score: number): string {
  if (score >= 50) return 'bg-[#45C94E]';
  if (score >= 0) return 'bg-[#0086D8]';
  return 'bg-[#E53E3E]';
}

function scoreTextColor(score: number): string {
  if (score >= 50) return 'text-[#2f8b35]';
  if (score >= 0) return 'text-[#0086D8]';
  return 'text-[#E53E3E]';
}

export default function NpsBySegmentChart({ title, description, data }: NpsBySegmentChartProps) {
  const hasNegative = data.some((d) => d.npsScore < 0);

  // Map NPS → % position on the bar
  // - If all positive: 0..100 maps to 0..100% (bar grows from left)
  // - If any negative: -100..100 maps to 0..100% (zero sits at center, bar grows from center)
  const toPct = (value: number): number =>
    hasNegative ? ((value + 100) / 200) * 100 : Math.max(0, Math.min(100, value));
  const zeroPos = hasNegative ? 50 : 0;
  const greatPos = toPct(50);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[#0E3687] text-base">{title}</CardTitle>
        {description && <CardDescription className="text-xs">{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            Not enough data to segment
          </p>
        ) : (
          <>
            {/* Scale header */}
            <div className="mb-3">
              <div className="relative h-5 text-[10px] text-muted-foreground">
                {hasNegative ? (
                  <>
                    <span className="absolute left-0">-100</span>
                    <span className="absolute" style={{ left: '25%', transform: 'translateX(-50%)' }}>-50</span>
                    <span className="absolute font-medium" style={{ left: '50%', transform: 'translateX(-50%)' }}>0</span>
                    <span className="absolute text-[#45C94E] font-medium" style={{ left: '75%', transform: 'translateX(-50%)' }}>50</span>
                    <span className="absolute right-0">100</span>
                  </>
                ) : (
                  <>
                    <span className="absolute left-0 font-medium">0</span>
                    <span className="absolute" style={{ left: '25%', transform: 'translateX(-50%)' }}>25</span>
                    <span className="absolute text-[#45C94E] font-medium" style={{ left: '50%', transform: 'translateX(-50%)' }}>50</span>
                    <span className="absolute" style={{ left: '75%', transform: 'translateX(-50%)' }}>75</span>
                    <span className="absolute right-0">100</span>
                  </>
                )}
              </div>
            </div>

            <div className="space-y-4">
              {data.map((row) => {
                const barPct = toPct(row.npsScore);

                return (
                  <div key={row.segment}>
                    {/* Segment label + NPS value */}
                    <div className="flex items-baseline justify-between mb-1.5">
                      <span className="text-sm font-medium text-[#0E3687]">{row.segment}</span>
                      <div className="text-right flex items-baseline gap-2">
                        <span className={cn('text-lg font-bold tabular-nums', scoreTextColor(row.npsScore))}>
                          {row.npsScore > 0 ? `+${row.npsScore}` : row.npsScore}
                        </span>
                        <span className="text-[10px] text-muted-foreground">NPS</span>
                      </div>
                    </div>

                    {/* Bar */}
                    <div className="relative h-6 bg-muted rounded-md overflow-hidden">
                      {/* Great-threshold dashed line at 50 */}
                      <div
                        className="absolute top-0 bottom-0 border-l border-dashed border-[#45C94E]/70"
                        style={{ left: `${greatPos}%` }}
                      />
                      {/* Zero reference line (only when we have negatives) */}
                      {hasNegative && (
                        <div
                          className="absolute top-0 bottom-0 w-px bg-border"
                          style={{ left: `${zeroPos}%` }}
                        />
                      )}
                      {/* Actual filled bar */}
                      <div
                        className={cn('absolute top-0 bottom-0 rounded-sm', scoreColor(row.npsScore))}
                        style={
                          row.npsScore >= 0
                            ? { left: `${zeroPos}%`, width: `${barPct - zeroPos}%` }
                            : { left: `${barPct}%`, width: `${zeroPos - barPct}%` }
                        }
                      />
                    </div>

                    {/* Sample size */}
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      Based on <span className="font-medium text-[#0E3687]">{row.total.toLocaleString()}</span> responses
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Color legend */}
            <div className="mt-4 pt-3 border-t border-border/60 flex items-center justify-center gap-3 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#E53E3E]" /> &lt; 0</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#0086D8]" /> 0–49</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#45C94E]" /> ≥ 50 (great)</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
