'use client';

import { useState, useMemo } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { NpsResponse } from '@/lib/nps/types';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { format, parseISO, isValid } from 'date-fns';
import { cn } from '@/lib/utils';

interface RecentResponsesProps {
  responses: NpsResponse[];
}

const categoryBadge = {
  Promoter: 'bg-[#45C94E]/10 text-[#2f8b35] border-[#45C94E]/20',
  Passive: 'bg-[#E09400]/10 text-[#B07200] border-[#E09400]/20',
  Detractor: 'bg-[#E53E3E]/10 text-[#B52828] border-[#E53E3E]/20',
};

export default function RecentResponses({ responses }: RecentResponsesProps) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const pageSize = 25;

  const sorted = useMemo(
    () => [...responses].sort((a, b) => b.date.localeCompare(a.date)),
    [responses],
  );

  const totalPages = Math.ceil(sorted.length / pageSize);
  const paged = sorted.slice(page * pageSize, (page + 1) * pageSize);

  const formatDate = (dateStr: string) => {
    try {
      const parsed = parseISO(dateStr);
      if (isValid(parsed)) return format(parsed, 'MMM d, yyyy HH:mm');
    } catch { /* ignore */ }
    return dateStr;
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-[#0E3687]">Recent responses</CardTitle>
          <CardDescription>{responses.length.toLocaleString()} responses in current filter</CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronUp className="h-4 w-4 mr-1.5" /> : <ChevronDown className="h-4 w-4 mr-1.5" />}
          {open ? 'Hide' : 'Show'}
        </Button>
      </CardHeader>
      {open && (
        <CardContent>
          <div className="overflow-x-auto -mx-6 px-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-border">
                  <th className="px-3 py-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">Date</th>
                  <th className="px-3 py-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">Score</th>
                  <th className="px-3 py-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">Category</th>
                  <th className="px-3 py-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">Plan</th>
                  <th className="px-3 py-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">Locale</th>
                  <th className="px-3 py-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">OS</th>
                  <th className="px-3 py-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">Comment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {paged.map((r, i) => (
                  <tr key={`${r.dedupKey}-${i}`} className="hover:bg-muted/40 transition-colors">
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{formatDate(r.date)}</td>
                    <td className="px-3 py-2 font-semibold text-[#0E3687]">{r.score}</td>
                    <td className="px-3 py-2">
                      <span className={cn(
                        'inline-block px-2 py-0.5 rounded-full text-xs font-medium border',
                        categoryBadge[r.category]
                      )}>
                        {r.category}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground capitalize">{r.highestPlanType || '—'}</td>
                    <td className="px-3 py-2 text-muted-foreground uppercase">{r.userLocale || '—'}</td>
                    <td className="px-3 py-2 text-muted-foreground">{r.os || '—'}</td>
                    <td className="px-3 py-2 text-muted-foreground max-w-[360px]">
                      {r.comment
                        ? <span className="line-clamp-2 text-xs leading-relaxed" title={r.comment}>{r.comment}</span>
                        : <span className="text-muted-foreground/50">—</span>}
                    </td>
                  </tr>
                ))}
                {paged.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                      No responses match the current filters
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-3 border-t border-border/60">
              <span className="text-xs text-muted-foreground">
                Page {page + 1} of {totalPages}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}>Previous</Button>
                <Button variant="outline" size="sm" onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1}>Next</Button>
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
