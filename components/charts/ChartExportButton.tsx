'use client';

import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';

interface ChartExportButtonProps {
  data: Record<string, unknown>[];
  filename: string;
}

export function ChartExportButton({ data, filename }: ChartExportButtonProps) {
  function handleExport() {
    if (data.length === 0) return;

    const headers = Object.keys(data[0]);
    const csvRows = [
      headers.join(','),
      ...data.map((row) =>
        headers.map((h) => {
          const val = row[h];
          if (typeof val === 'string' && val.includes(',')) return `"${val}"`;
          if (typeof val === 'number') return val.toFixed(2);
          return String(val ?? '');
        }).join(',')
      ),
    ];
    const csv = csvRows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleExport}
      disabled={data.length === 0}
      className="h-7 text-xs gap-1 text-muted-foreground hover:text-[#0086D8]"
    >
      <Download className="h-3 w-3" />
      CSV
    </Button>
  );
}
