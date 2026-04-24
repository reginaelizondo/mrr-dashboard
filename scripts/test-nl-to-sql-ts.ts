/**
 * TS-based NL→SQL test that uses the REAL lib (not the mirrored JS).
 * Run: npx tsx scripts/test-nl-to-sql-ts.ts "cual fue el arpu sobre cac de ayer"
 */
import fs from 'fs';
import path from 'path';

function loadEnvLocal() {
  const p = path.join(__dirname, '..', '.env.local');
  for (const raw of fs.readFileSync(p, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnvLocal();

async function main() {
  const { nlToSql } = await import('../lib/kpi/nl-to-sql');
  const { validateAndHardenSql } = await import('../lib/kpi/sql-safety');
  const q = process.argv.slice(2).join(' ') || 'cual fue el arpu sobre cac de ayer';
  console.log(`Q: ${q}\n`);
  const nl = await nlToSql(q);
  console.log('Source:', nl.source);
  if ('sql' in nl && typeof nl.sql === 'string') {
    console.log('Title:', 'title' in nl ? nl.title : '(none)');
    console.log('SQL:\n' + nl.sql);
    const safe = validateAndHardenSql(nl.sql);
    console.log('\nSafety check:', safe.ok ? 'OK' : `FAIL — ${safe.error}`);
  } else {
    console.log(JSON.stringify(nl, null, 2));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
