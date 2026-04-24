/**
 * End-to-end test: run the full Mixpanel flow including bookmark creation.
 * Usage: npx tsx scripts/test-mixpanel-bookmark.ts "<question>"
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
  const q = process.argv.slice(2).join(' ') || 'conversiones de free trial por plan';
  console.log(`Q: ${q}\n`);

  const { nlToSql } = await import('../lib/kpi/nl-to-sql');
  const { createBotBookmark } = await import('../lib/mixpanel/insights');

  const nl = await nlToSql(q);
  if (nl.source !== 'mixpanel') {
    console.log('Not a Mixpanel question. source=', nl.source);
    return;
  }
  console.log(`Event: ${nl.event}  measure: ${nl.measure}  unit: ${nl.unit}`);
  console.log(`Range: ${nl.fromDate} → ${nl.toDate}`);
  console.log(`Breakdown: ${nl.breakdown ?? '(none)'}\n`);

  const bm = await createBotBookmark({
    query: {
      event: nl.event,
      measure: nl.measure,
      fromDate: nl.fromDate,
      toDate: nl.toDate,
      unit: nl.unit,
      breakdown: nl.breakdown,
    },
    title: nl.title,
    question: q,
  });
  console.log('✅ Bookmark created:');
  console.log('  id:', bm.bookmarkId);
  console.log('  url:', bm.url);
  console.log('\nClick the URL above and verify the report opens correctly in Mixpanel.');
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
