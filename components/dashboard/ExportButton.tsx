'use client';

import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';
import type { MrrDailySnapshot } from '@/types';
import { exportToExcel } from '@/lib/export';
import { computeTotals } from '@/lib/filters';

interface ExportButtonProps {
  snapshots: MrrDailySnapshot[];
}

export function ExportButton({ snapshots }: ExportButtonProps) {
  function handleExport() {
    if (snapshots.length === 0) return;
    const totals = computeTotals(snapshots);
    exportToExcel(snapshots, totals);
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleExport}
      disabled={snapshots.length === 0}
      className="h-8 text-xs gap-1.5 text-[#0086D8] border-[#0086D8]/30 hover:bg-[#0086D8]/5 hover:border-[#0086D8]/50"
    >
      <Download className="h-3.5 w-3.5" />
      Export
    </Button>
  );
}
