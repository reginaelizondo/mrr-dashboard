'use client';

import { useState, useMemo } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { NpsResponse } from '@/lib/nps/types';
import { bucketize, NEGATIVE_TOPICS, POSITIVE_TOPICS, TopicBucket } from '@/lib/nps/comment-topics';
import { ThumbsDown, ThumbsUp, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { format, parseISO, isValid } from 'date-fns';

interface VoiceOfCustomerProps {
  responses: NpsResponse[];
}

export default function VoiceOfCustomer({ responses }: VoiceOfCustomerProps) {
  const negative = useMemo(() => {
    const pool = responses.filter((r) => r.category !== 'Promoter');
    return bucketize(pool, NEGATIVE_TOPICS);
  }, [responses]);

  const positive = useMemo(() => {
    const pool = responses.filter((r) => r.category === 'Promoter');
    return bucketize(pool, POSITIVE_TOPICS);
  }, [responses]);

  const totalNegativeWithComments = responses.filter((r) => r.category !== 'Promoter' && r.comment?.trim()).length;
  const totalPositiveWithComments = responses.filter((r) => r.category === 'Promoter' && r.comment?.trim()).length;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <TopicPanel
        title="Why detractors complain"
        description={`Top themes in ${totalNegativeWithComments.toLocaleString()} comments from detractors & passives`}
        icon={ThumbsDown}
        iconBg="bg-[#DA4D7A]"
        accent="bg-[#DA4D7A]/[0.04] border-l-4 border-l-[#DA4D7A]"
        buckets={negative}
        emptyLabel="No detractor/passive comments match any theme"
        tone="negative"
      />
      <TopicPanel
        title="Why promoters love it"
        description={`Top themes in ${totalPositiveWithComments.toLocaleString()} comments from promoters`}
        icon={ThumbsUp}
        iconBg="bg-[#45C94E]"
        accent="bg-[#45C94E]/[0.04] border-l-4 border-l-[#45C94E]"
        buckets={positive}
        emptyLabel="No promoter comments match any theme"
        tone="positive"
      />
    </div>
  );
}

interface TopicPanelProps {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  iconBg: string;
  accent: string;
  buckets: TopicBucket[];
  emptyLabel: string;
  tone: 'negative' | 'positive';
}

function TopicPanel({ title, description, icon: Icon, iconBg, accent, buckets, emptyLabel, tone }: TopicPanelProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <Card className={cn(accent)}>
      <CardHeader className="flex flex-row items-start gap-3">
        <div className={cn('h-9 w-9 rounded-lg flex items-center justify-center flex-shrink-0', iconBg)}>
          <Icon className="h-5 w-5 text-white" />
        </div>
        <div>
          <CardTitle className="text-[#0E3687]">{title}</CardTitle>
          <CardDescription className="text-xs mt-0.5">{description}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {buckets.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">{emptyLabel}</p>
        ) : (
          <div className="space-y-1.5">
            {buckets.map((b) => (
              <div
                key={b.key}
                className={cn(
                  'border rounded-md bg-white',
                  b.isOther ? 'border-dashed border-border/80' : 'border-border',
                )}
              >
                <button
                  onClick={() => setExpanded(expanded === b.key ? null : b.key)}
                  className="w-full flex items-center justify-between p-3 hover:bg-muted/40 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      'text-sm font-medium',
                      b.isOther ? 'text-muted-foreground italic' : 'text-[#0E3687]',
                    )}>
                      {b.label}
                    </span>
                    <span className={cn(
                      'inline-flex items-center justify-center min-w-[24px] h-5 px-1.5 rounded-full text-[11px] font-bold text-white',
                      b.isOther
                        ? 'bg-muted-foreground/70'
                        : tone === 'negative' ? 'bg-[#DA4D7A]' : 'bg-[#45C94E]',
                    )}>
                      {b.count}
                    </span>
                  </div>
                  {expanded === b.key
                    ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                    : <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  }
                </button>
                {expanded === b.key && (
                  <div className="border-t border-border divide-y divide-border/60 max-h-[480px] overflow-y-auto">
                    {b.examples.map((r, i) => (
                      <div key={`${r.dedupKey}-${i}`} className="p-3 flex items-start gap-3 text-sm">
                        <div className={cn(
                          'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white',
                          r.score >= 9 ? 'bg-[#45C94E]' : r.score >= 7 ? 'bg-[#E09400]' : 'bg-[#E53E3E]'
                        )}>
                          {r.score}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-[#0E3687] leading-relaxed">{r.comment}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                            <span>{formatRelDate(r.date)}</span>
                            {r.highestPlanType && <><span>·</span><span className="capitalize">{r.highestPlanType}</span></>}
                            {r.userLocale && <><span>·</span><span className="uppercase">{r.userLocale}</span></>}
                            {r.os && <><span>·</span><span>{r.os}</span></>}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function formatRelDate(dateStr: string): string {
  try {
    const d = parseISO(dateStr);
    if (isValid(d)) return format(d, 'MMM d, yyyy');
  } catch {
    // ignore
  }
  return dateStr;
}
