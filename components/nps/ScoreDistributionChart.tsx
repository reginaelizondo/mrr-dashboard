'use client';

import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from 'recharts';
import { ScoreBucket } from '@/lib/nps/types';

interface ScoreDistributionChartProps {
  data: ScoreBucket[];
}

const COLORS = {
  Detractor: '#E53E3E',
  Passive: '#E09400',
  Promoter: '#45C94E',
};

interface TooltipEntry {
  payload?: ScoreBucket;
  value?: number;
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: TooltipEntry[] }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="rounded-xl border border-border/50 bg-white p-3 shadow-xl">
      <p className="text-xs font-medium text-muted-foreground mb-1">Score {row.score}</p>
      <div className="flex items-center gap-2 text-sm">
        <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: COLORS[row.category] }} />
        <span className="text-muted-foreground">{row.category}:</span>
        <span className="font-semibold text-[#0E3687]">{row.count.toLocaleString()}</span>
      </div>
    </div>
  );
}

export default function ScoreDistributionChart({ data }: ScoreDistributionChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[#0E3687]">Score distribution</CardTitle>
        <CardDescription>How responses split across the 0–10 scale.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="score" tick={{ fontSize: 12, fill: '#888' }} axisLine={{ stroke: '#e0e0e0' }} />
              <YAxis tick={{ fontSize: 12, fill: '#888' }} axisLine={{ stroke: '#e0e0e0' }} />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                {data.map((entry) => (
                  <Cell key={entry.score} fill={COLORS[entry.category]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="flex items-center justify-center gap-4 mt-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#E53E3E]" /> Detractor (0–6)</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#E09400]" /> Passive (7–8)</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#45C94E]" /> Promoter (9–10)</span>
        </div>
      </CardContent>
    </Card>
  );
}
