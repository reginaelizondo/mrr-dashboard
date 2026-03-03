import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { readdirSync, existsSync } from 'fs';
import path from 'path';
import { parseCSV, normalizeGoogleRows } from '@/lib/sync/google';
import { computeDailySnapshot } from '@/lib/sync/snapshots';
import { createServerClient } from '@/lib/supabase/server';
import { format, eachDayOfInterval, parseISO, lastDayOfMonth } from 'date-fns';

export const maxDuration = 300;

const BASE_PATH = '/Users/pepisavalos/Desktop/Reportes Google Play Console SAPI - 28 enero 2025/Financieros/Ingresos';

// Map folder names to YYYYMM format
const MONTH_MAP: Record<string, string> = {
  '1. Jan': '01', '2. Feb': '02', '3. Mar': '03', '4. Apr': '04',
  '5. May': '05', '6. June': '06', '7. July': '07', '8. Aug': '08',
  '9. Sept': '09', '10. Oct': '10', '11. Nov': '11', '12. Dic': '12',
};

export async function POST(request: NextRequest) {
  const { startYear = 2024, endYear = 2025, endMonth = 1 } = await request.json();

  const supabase = createServerClient();
  const results: { month: string; records: number; error?: string }[] = [];
  let totalRecords = 0;

  // Iterate through years and months
  for (let year = startYear; year <= endYear; year++) {
    const yearPath = path.join(BASE_PATH, String(year));
    if (!existsSync(yearPath)) {
      results.push({ month: `${year}`, records: 0, error: 'Year folder not found' });
      continue;
    }

    const monthFolders = readdirSync(yearPath);

    for (const monthFolder of monthFolders) {
      const monthNum = MONTH_MAP[monthFolder];
      if (!monthNum) continue;

      const yearMonth = `${year}-${monthNum}`;
      const monthInt = parseInt(monthNum);

      // Skip months outside our range
      if (year === endYear && monthInt > endMonth) continue;
      if (year < startYear) continue;

      const monthPath = path.join(yearPath, monthFolder);
      const zipFiles = readdirSync(monthPath).filter((f) => f.endsWith('.zip'));

      if (zipFiles.length === 0) {
        results.push({ month: yearMonth, records: 0, error: 'No ZIP files' });
        continue;
      }

      try {
        let monthRecords = 0;

        for (const zipFile of zipFiles) {
          const zipPath = path.join(monthPath, zipFile);
          const tmpDir = `/tmp/google_import_${yearMonth}`;

          // Extract ZIP
          execSync(`rm -rf "${tmpDir}" && mkdir -p "${tmpDir}" && unzip -o "${zipPath}" -d "${tmpDir}"`, {
            stdio: 'pipe',
          });

          // Find CSV files
          const csvFiles = readdirSync(tmpDir).filter((f) => f.endsWith('.csv'));

          for (const csvFile of csvFiles) {
            const csvContent = readFileSync(path.join(tmpDir, csvFile), 'utf-8');
            const rows = parseCSV(csvContent);
            const transactions = normalizeGoogleRows(rows);

            if (transactions.length === 0) continue;

            // Deduplicate by external_id to avoid "ON CONFLICT cannot affect row a second time"
            const deduped = new Map<string, (typeof transactions)[0]>();
            for (const tx of transactions) {
              deduped.set(tx.external_id!, tx);
            }
            const uniqueTransactions = Array.from(deduped.values());

            // Upsert in batches of 500
            for (let i = 0; i < uniqueTransactions.length; i += 500) {
              const batch = uniqueTransactions.slice(i, i + 500);
              const { error } = await supabase
                .from('transactions')
                .upsert(batch, {
                  onConflict: 'source,external_id',
                  ignoreDuplicates: false,
                });

              if (error) {
                throw new Error(`DB error: ${error.message}`);
              }
            }

            monthRecords += uniqueTransactions.length;
          }

          // Cleanup
          execSync(`rm -rf "${tmpDir}"`, { stdio: 'pipe' });
        }

        totalRecords += monthRecords;
        results.push({ month: yearMonth, records: monthRecords });

        // Compute snapshot for last day of month (where Google data lands)
        const lastDay = lastDayOfMonth(parseISO(`${yearMonth}-01`));
        const snapshotDate = format(lastDay, 'yyyy-MM-dd');
        await computeDailySnapshot(snapshotDate);

      } catch (err) {
        results.push({ month: yearMonth, records: 0, error: (err as Error).message });
      }
    }
  }

  return NextResponse.json({
    success: true,
    totalRecords,
    months: results,
  });
}
