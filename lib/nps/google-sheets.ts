import { NpsResponse } from './types';

const CSV_URL = process.env.NPS_SHEET_CSV_URL;

export async function fetchNpsData(): Promise<NpsResponse[]> {
  if (!CSV_URL) {
    throw new Error('Missing NPS_SHEET_CSV_URL environment variable');
  }

  const res = await fetch(CSV_URL, {
    next: { revalidate: 30 },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to fetch NPS CSV: ${res.status} - ${errorText.slice(0, 200)}`);
  }

  const csvText = await res.text();
  const rows = parseCsv(csvText);

  if (rows.length <= 1) {
    return [];
  }

  return rows.slice(1).map(parseRow).filter(Boolean) as NpsResponse[];
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        currentField += '"';
        i++; // skip escaped quote
      } else if (char === '"') {
        inQuotes = false;
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        currentRow.push(currentField);
        currentField = '';
      } else if (char === '\n') {
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
      } else if (char === '\r') {
        // ignore CR
      } else {
        currentField += char;
      }
    }
  }

  // flush last field/row
  if (currentField !== '' || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  return rows;
}

function parseRow(row: string[]): NpsResponse | null {
  if (!row || row.length < 3) return null;

  const score = parseInt(row[2], 10);
  if (isNaN(score)) return null;

  let category = (row[3] || '').trim() as NpsResponse['category'];
  if (!category || !['Promoter', 'Passive', 'Detractor'].includes(category)) {
    if (score >= 9) category = 'Promoter';
    else if (score >= 7) category = 'Passive';
    else category = 'Detractor';
  }

  return {
    identity: (row[0] || '').trim(),
    date: (row[1] || '').trim(),
    score,
    category,
    comment: (row[4] || '').trim(),
    dedupKey: (row[5] || '').trim(),
    highestPlanType: (row[6] || '').trim().toLowerCase(),
    userLocale: (row[7] || '').trim().toLowerCase(),
    os: (row[8] || '').trim(),
  };
}
