import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { formatCurrency, formatPercent } from '@/lib/constants';
import { TrendingUp, TrendingDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type AccentColor = 'teal' | 'green' | 'navy' | 'rose' | 'red';

interface MetricCardProps {
  label: string;
  value: number;
  previousValue?: number;
  prefix?: string;
  /** 'currency' formats as $X, 'number' formats as plain number with commas, 'percent' formats as X.X% */
  format?: 'currency' | 'number' | 'percent';
  className?: string;
  icon?: LucideIcon;
  accentColor?: AccentColor;
  subtitle?: string;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

const accentStyles: Record<AccentColor, { border: string; bg: string; iconBg: string }> = {
  teal: {
    border: 'border-l-4 border-l-[#0086D8]',
    bg: 'bg-[#0086D8]/[0.04]',
    iconBg: 'bg-[#0086D8]',
  },
  green: {
    border: 'border-l-4 border-l-[#45C94E]',
    bg: 'bg-[#45C94E]/[0.04]',
    iconBg: 'bg-[#45C94E]',
  },
  navy: {
    border: 'border-l-4 border-l-[#0E3687]',
    bg: 'bg-[#0E3687]/[0.04]',
    iconBg: 'bg-[#0E3687]',
  },
  rose: {
    border: 'border-l-4 border-l-[#DA4D7A]',
    bg: 'bg-[#DA4D7A]/[0.04]',
    iconBg: 'bg-[#DA4D7A]',
  },
  red: {
    border: 'border-l-4 border-l-[#E53E3E]',
    bg: 'bg-[#E53E3E]/[0.04]',
    iconBg: 'bg-[#E53E3E]',
  },
};

export function MetricCard({
  label,
  value,
  previousValue,
  format = 'currency',
  className,
  icon: Icon,
  accentColor = 'teal',
  subtitle,
}: MetricCardProps) {
  const delta = previousValue && previousValue !== 0
    ? ((value - previousValue) / previousValue) * 100
    : null;

  let displayValue: string;
  if (format === 'currency') {
    displayValue = formatCurrency(value);
  } else if (format === 'percent') {
    displayValue = `${value.toFixed(1)}%`;
  } else {
    displayValue = formatNumber(value);
  }

  const styles = accentStyles[accentColor];

  return (
    <Card className={cn(
      styles.border,
      styles.bg,
      'relative overflow-hidden card-hover',
      className
    )}>
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-wider font-medium text-muted-foreground mb-1">
              {label}
            </p>
            <p className="text-3xl font-bold text-[#0E3687] truncate">{displayValue}</p>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
            )}
            {delta !== null && (
              <div className={cn(
                'flex items-center gap-1 mt-2 text-sm font-medium',
                delta >= 0 ? 'text-[#45C94E]' : 'text-[#DA4D7A]'
              )}>
                {delta >= 0
                  ? <TrendingUp className="h-3.5 w-3.5" />
                  : <TrendingDown className="h-3.5 w-3.5" />
                }
                <span>{formatPercent(delta)}</span>
                <span className="text-xs font-normal text-muted-foreground">vs prior</span>
              </div>
            )}
          </div>
          {Icon && (
            <div className={cn(
              'h-10 w-10 rounded-lg flex items-center justify-center flex-shrink-0 ml-3',
              styles.iconBg
            )}>
              <Icon className="h-5 w-5 text-white" />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
