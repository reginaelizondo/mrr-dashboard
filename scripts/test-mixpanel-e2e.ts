/**
 * End-to-end test for the Mixpanel branch of the KPI bot.
 *
 * Runs the real modules:
 *   nlToSql(question)  →  if source='mixpanel', queryMixpanel(...) and print rows.
 *   if source='bigquery', just prints the generated SQL (no exec — save quota).
 *
 * Run:
 *   npx tsx scripts/test-mixpanel-e2e.ts "¿cuántos usuarios vieron una actividad ayer?"
 *   npx tsx scripts/test-mixpanel-e2e.ts "CAC last week by platform"   (should route to BigQuery)
 */
import fs from 'fs';
import path from 'path';

function loadEnvLocal() {
  const p = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(p)) return;
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
  const q = process.argv.slice(2).join(' ') || '¿cuántos usuarios vieron una actividad ayer?';
  console.log(`Q: ${q}\n`);

  const { nlToSql } = await import('../lib/kpi/nl-to-sql');
  const { queryMixpanel } = await import('../lib/mixpanel/client');

  const nl = await nlToSql(q);
  console.log('SOURCE:', nl.source);
  console.log('TITLE:', nl.title);
  console.log('EXPLANATION:', nl.explanation);

  if (nl.source === 'bigquery') {
    console.log('\n--- SQL ---');
    console.log(nl.sql);
    console.log('--- (not executing BQ query in smoke test) ---');
    return;
  }

  console.log('\nEVENT:', nl.event);
  console.log('MEASURE:', nl.measure);
  console.log('UNIT:', nl.unit);
  console.log('RANGE:', nl.fromDate, '→', nl.toDate);
  if (nl.breakdown) console.log('BREAKDOWN:', nl.breakdown);

  const rows = await queryMixpanel({
    event: nl.event,
    measure: nl.measure,
    fromDate: nl.fromDate,
    toDate: nl.toDate,
    unit: nl.unit,
    breakdown: nl.breakdown,
  });
  console.log(`\nROWS (${rows.length}):`);
  console.table(rows.slice(0, 15));
  const total = rows.reduce((a, r) => a + (typeof r.value === 'number' ? r.value : 0), 0);
  console.log(`\nTOTAL ${nl.measure === 'unique' ? 'unique users' : 'events'}: ${total.toLocaleString()}`);
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
