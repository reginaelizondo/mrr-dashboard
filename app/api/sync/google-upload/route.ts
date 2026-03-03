import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { parseCSV, normalizeGoogleRows } from '@/lib/sync/google';
import { createServerClient } from '@/lib/supabase/server';

export const maxDuration = 300; // 5 minutes

/**
 * POST /api/sync/google-upload
 *
 * Imports Google Play earnings CSV files from a local directory.
 * Expects a JSON body with:
 *   - dir: path to directory containing .zip or .csv files
 *
 * The directory can contain:
 *   - ZIP files (will be extracted, CSVs inside will be parsed)
 *   - CSV files directly
 *
 * Example usage:
 *   curl -X POST http://localhost:3001/api/sync/google-upload \
 *     -H "Content-Type: application/json" \
 *     -d '{"dir":"/Users/pepisavalos/Downloads/google-earnings"}'
 */
export async function POST(request: NextRequest) {
  const { dir } = await request.json();

  if (!dir) {
    return NextResponse.json(
      { error: 'dir is required — path to directory with ZIP/CSV files' },
      { status: 400 }
    );
  }

  if (!existsSync(dir)) {
    return NextResponse.json(
      { error: `Directory not found: ${dir}` },
      { status: 400 }
    );
  }

  const supabase = createServerClient();
  const results: { file: string; records: number; error?: string }[] = [];
  let totalRecords = 0;

  // Find all ZIP and CSV files in the directory (including subdirectories 1 level deep)
  const allFiles: string[] = [];

  function scanDir(dirPath: string, depth = 0) {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile() && (entry.name.endsWith('.zip') || entry.name.endsWith('.csv'))) {
        allFiles.push(fullPath);
      } else if (entry.isDirectory() && depth < 2) {
        scanDir(fullPath, depth + 1);
      }
    }
  }
  scanDir(dir);

  console.log(`[Google Upload] Found ${allFiles.length} files in ${dir}`);

  for (const filePath of allFiles) {
    const fileName = path.basename(filePath);

    try {
      let csvFiles: { name: string; content: string }[] = [];

      if (filePath.endsWith('.zip')) {
        // Extract ZIP to temp dir
        const tmpDir = `/tmp/google_upload_${Date.now()}`;
        execSync(`rm -rf "${tmpDir}" && mkdir -p "${tmpDir}" && unzip -o "${filePath}" -d "${tmpDir}"`, {
          stdio: 'pipe',
        });

        const extracted = readdirSync(tmpDir).filter((f) => f.endsWith('.csv'));
        for (const csvName of extracted) {
          csvFiles.push({
            name: csvName,
            content: readFileSync(path.join(tmpDir, csvName), 'utf-8'),
          });
        }

        execSync(`rm -rf "${tmpDir}"`, { stdio: 'pipe' });
      } else {
        // Direct CSV
        csvFiles.push({
          name: fileName,
          content: readFileSync(filePath, 'utf-8'),
        });
      }

      let fileRecords = 0;

      for (const csv of csvFiles) {
        const rows = parseCSV(csv.content);
        const transactions = normalizeGoogleRows(rows);

        if (transactions.length === 0) {
          console.log(`[Google Upload] ${csv.name}: 0 transactions (empty or non-matching types)`);
          continue;
        }

        // Deduplicate by external_id (keep last occurrence to aggregate amounts)
        const deduped = new Map<string, (typeof transactions)[0]>();
        for (const tx of transactions) {
          deduped.set(tx.external_id!, tx);
        }
        const uniqueTransactions = Array.from(deduped.values());
        console.log(`[Google Upload] ${csv.name}: ${transactions.length} raw → ${uniqueTransactions.length} unique`);

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
            throw new Error(`DB error on batch ${i}: ${error.message}`);
          }
        }

        fileRecords += uniqueTransactions.length;
        console.log(`[Google Upload] ${csv.name}: ${uniqueTransactions.length} transactions imported`);
      }

      totalRecords += fileRecords;
      results.push({ file: fileName, records: fileRecords });
    } catch (err) {
      results.push({ file: fileName, records: 0, error: (err as Error).message });
      console.error(`[Google Upload] Error with ${fileName}:`, (err as Error).message);
    }
  }

  return NextResponse.json({
    success: true,
    totalRecords,
    filesProcessed: results.length,
    results,
  });
}
