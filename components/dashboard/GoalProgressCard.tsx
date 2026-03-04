'use client';

import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/constants';
import { Target } from 'lucide-react';

interface GoalProgressCardProps {
  label: string;
  current: number;
  goal: number;
  format?: 'currency' | 'number';
}

export function GoalProgressCard({ label, current, goal, format = 'currency' }: GoalProgressCardProps) {
  const pct = goal > 0 ? (current / goal) * 100 : 0;
  const clampedPct = Math.min(pct, 100);
  const exceeded = pct > 100;

  const currentDisplay = format === 'currency' ? formatCurrency(current) : current.toLocaleString();
  const goalDisplay = format === 'currency' ? formatCurrency(goal) : goal.toLocaleString();

  return (
    <Card className="border-l-4 border-l-[#45C94E] bg-[#45C94E]/[0.04] relative overflow-hidden card-hover">
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-wider font-medium text-muted-foreground mb-1">
              {label}
            </p>
            <div className="flex items-baseline gap-2">
              <p className="text-3xl font-bold text-[#0E3687]">{pct.toFixed(1)}%</p>
              <p className="text-xs text-muted-foreground truncate">
                {currentDisplay} of {goalDisplay}
              </p>
            </div>
            {/* Progress bar */}
            <div className="mt-3 h-2.5 w-full rounded-full bg-gray-200 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 ${
                  exceeded ? 'bg-[#45C94E]' : 'bg-[#0086D8]'
                }`}
                style={{ width: `${clampedPct}%` }}
              />
            </div>
          </div>
          <div className="h-10 w-10 rounded-lg flex items-center justify-center flex-shrink-0 ml-3 bg-[#45C94E]">
            <Target className="h-5 w-5 text-white" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
