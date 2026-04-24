/**
 * Direct test of createBotBookmark — bypasses LLM (nl-to-sql) by passing
 * pre-built query params. Useful when Anthropic API is unavailable or to
 * avoid using LLM credits while debugging the Mixpanel side.
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
  const { createBotBookmark } = await import('../lib/mixpanel/insights');
  const bm = await createBotBookmark({
    query: {
      event: 'FreeTrialConverted',
      measure: 'unique',
      fromDate: '2026-03-25',
      toDate: '2026-04-24',
      unit: 'month',
      breakdown: 'planType',
    },
    title: 'Free trial conversions by plan',
    question: 'conversiones de free trial por plan',
  });
  console.log('OK');
  console.log('  bookmarkId (clone on board):', bm.bookmarkId);
  console.log('  url:', bm.url);
}
main().catch((e) => { console.error('ERR', e instanceof Error ? e.message : e); process.exit(1); });
