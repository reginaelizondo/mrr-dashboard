'use client';

import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine } from 'recharts';
import { WeeklyNps } from '@/lib/nps/types';
import type { TrendGranularity } from '@/lib/nps/nps-calculations';

interface NpsTrendChartProps {
  data: WeeklyNps[];
  granularity: TrendGranularity;
}

interface TooltipEntry {
  payload?: WeeklyNps;
  value?: number;
}

function Tip({ active, payload, granularity }: { active?: boolean; payload?: TooltipEntry[]; granularity: TrendGranularity }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const prefix = granularity === 'day' ? '' : 'Week of ';
  return (
    <div className="rounded-xl border border-border/50 bg-white p-3 shadow-xl">
      <p className="text-xs font-medium text-muted-foreground mb-2">{prefix}{row.weekLabel}</p>
      <div className="flex items-center gap-2 text-sm">
        <span className="h-2.5 w-2.5 rounded-full flex-shrink-0 bg-[#0086D8]" />
        <span className="text-muted-foreground">NPS:</span>
        <span className="font-semibold text-[#0E3687]">{row.npsScore}</span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {row.total.toLocaleString()} response{row.total === 1 ? '' : 's'}
      </div>
    </div>
  );
}

export default function NpsTrendChart({ data, granularity }: NpsTrendChartProps) {
  const descSuffix = granularity === 'day' ? 'Daily NPS score.' : 'Weekly NPS score.';
  const notEnough = data.length < 2;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-[#0E3687]">NPS trend</CardTitle>
          <CardDescription>{descSuffix} Green line at 50 is the &ldquo;great&rdquo; threshold.</CardDescription>
        </div>
        <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground bg-muted px-2 py-1 rounded">
          {granularity === 'day' ? 'Daily' : 'Weekly'}
        </span>
      </CardHeader>
      <CardContent>
        <div className="h-72">
          {data.length === 0 ? (
            <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
              Not enough data in this period
            </div>
          ) : notEnough ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-6">
              <p className="text-4xl font-bold text-[#0E3687]">{data[0].npsScore}</p>
              <p className="text-xs text-muted-foreground mt-1">NPS score</p>
              <p className="text-xs text-muted-foreground mt-3">
                Only {data.length} {granularity === 'day' ? 'day' : 'week'} of data in this period.<br />
                Pick a wider range to see a trend.
              </p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 10, right: 12, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="weekLabel" tick={{ fontSize: 12, fill: '#888' }} axisLine={{ stroke: '#e0e0e0' }} />
                <YAxis
                  domain={[-100, 100]}
                  ticks={[-100, -50, 0, 50, 100]}
                  tick={{ fontSize: 12, fill: '#888' }}
                  axisLine={{ stroke: '#e0e0e0' }}
                />
                <Tooltip content={<Tip granularity={granularity} />} />
                <ReferenceLine y={50} stroke="#45C94E" strokeDasharray="4 4" />
                <ReferenceLine y={0} stroke="#ccc" strokeDasharray="3 3" />
                <Line
                  type="monotone"
                  dataKey="npsScore"
                  stroke="#0086D8"
                  strokeWidth={3}
                  dot={{ fill: '#0086D8', strokeWidth: 2, r: 4 }}
                  activeDot={{ r: 6, fill: '#0E3687' }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
