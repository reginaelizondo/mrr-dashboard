'use client';

import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Gauge, MessageCircle, ThumbsUp, ThumbsDown, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { NpsStats } from '@/lib/nps/types';

type AccentColor = 'teal' | 'green' | 'navy' | 'rose' | 'red';

const accentStyles: Record<AccentColor, { border: string; bg: string; iconBg: string }> = {
  teal:  { border: 'border-l-4 border-l-[#0086D8]', bg: 'bg-[#0086D8]/[0.04]', iconBg: 'bg-[#0086D8]' },
  green: { border: 'border-l-4 border-l-[#45C94E]', bg: 'bg-[#45C94E]/[0.04]', iconBg: 'bg-[#45C94E]' },
  navy:  { border: 'border-l-4 border-l-[#0E3687]', bg: 'bg-[#0E3687]/[0.04]', iconBg: 'bg-[#0E3687]' },
  rose:  { border: 'border-l-4 border-l-[#DA4D7A]', bg: 'bg-[#DA4D7A]/[0.04]', iconBg: 'bg-[#DA4D7A]' },
  red:   { border: 'border-l-4 border-l-[#E53E3E]', bg: 'bg-[#E53E3E]/[0.04]', iconBg: 'bg-[#E53E3E]' },
};

interface NpsMetricCardsProps {
  current: NpsStats;
  previous: NpsStats | null;
  hasComparison: boolean;
}

export default function NpsMetricCards({ current, previous, hasComparison }: NpsMetricCardsProps) {
  const npsAccent: AccentColor = current.npsScore >= 50 ? 'green' : current.npsScore >= 0 ? 'teal' : 'red';

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <KpiCard
        label="NPS Score"
        value={String(current.npsScore)}
        icon={Gauge}
        accentColor={npsAccent}
        subtitle={scoreLabel(current.npsScore)}
        deltaPts={hasComparison && previous ? current.npsScore - previous.npsScore : null}
        deltaUnit="pts"
        deltaInvert={false}
      />
      <KpiCard
        label="Responses"
        value={current.total.toLocaleString()}
        icon={MessageCircle}
        accentColor="navy"
        deltaPts={hasComparison && previous ? current.total - previous.total : null}
        deltaUnit="vs prior"
        formatDelta={(n) => (n >= 0 ? `+${n.toLocaleString()}` : `-${Math.abs(n).toLocaleString()}`)}
      />
      <KpiCard
        label="Promoters"
        value={`${current.promoterPct}%`}
        icon={ThumbsUp}
        accentColor="green"
        subtitle={`${current.promoters.toLocaleString()} responses`}
        deltaPts={hasComparison && previous ? current.promoterPct - previous.promoterPct : null}
        deltaUnit="pp"
      />
      <KpiCard
        label="Detractors"
        value={`${current.detractorPct}%`}
        icon={ThumbsDown}
        accentColor="rose"
        subtitle={`${current.detractors.toLocaleString()} responses`}
        deltaPts={hasComparison && previous ? current.detractorPct - previous.detractorPct : null}
        deltaUnit="pp"
        deltaInvert={true}
      />
    </div>
  );
}

function scoreLabel(score: number): string {
  if (score >= 70) return 'Excellent';
  if (score >= 50) return 'Great';
  if (score >= 30) return 'Good';
  if (score >= 0) return 'Needs work';
  return 'Critical';
}

interface KpiCardProps {
  label: string;
  value: string;
  icon: LucideIcon;
  accentColor: AccentColor;
  subtitle?: string;
  deltaPts: number | null;
  deltaUnit: string;
  deltaInvert?: boolean; // for metrics where lower is better (e.g. detractors)
  formatDelta?: (n: number) => string;
}

function KpiCard({ label, value, icon: Icon, accentColor, subtitle, deltaPts, deltaUnit, deltaInvert, formatDelta }: KpiCardProps) {
  const styles = accentStyles[accentColor];
  const deltaColor = deltaPts === null || deltaPts === 0
    ? 'text-muted-foreground'
    : (deltaPts > 0) !== !!deltaInvert
      ? 'text-[#45C94E]'
      : 'text-[#DA4D7A]';
  const DeltaIcon = deltaPts === null || deltaPts === 0 ? Minus : deltaPts > 0 ? TrendingUp : TrendingDown;
  const defaultFormat = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

  return (
    <Card className={cn(styles.border, styles.bg, 'relative overflow-hidden')}>
      <CardContent className="pt-1 pb-1">
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-wider font-medium text-muted-foreground mb-1">
              {label}
            </p>
            <p className="text-3xl font-bold text-[#0E3687] truncate">{value}</p>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
            )}
            {deltaPts !== null && (
              <div className={cn('flex items-center gap-1 mt-2 text-sm font-medium', deltaColor)}>
                <DeltaIcon className="h-3.5 w-3.5" />
                <span>{(formatDelta || defaultFormat)(deltaPts)} {deltaUnit}</span>
              </div>
            )}
          </div>
          <div className={cn('h-10 w-10 rounded-lg flex items-center justify-center flex-shrink-0 ml-3', styles.iconBg)}>
            <Icon className="h-5 w-5 text-white" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
