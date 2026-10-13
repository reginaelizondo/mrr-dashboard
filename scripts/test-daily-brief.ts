/**
 * Build the daily KPI brief locally with the real modules and print it.
 *
 * Run:
 *   npx tsx scripts/test-daily-brief.ts                 # dry run, today (MX), Claude narrative
 *   npx tsx scripts/test-daily-brief.ts --no-llm        # rule-based narrative only (no Anthropic call)
 *   npx tsx scripts/test-daily-brief.ts --weekly        # force the Monday weekly section
 *   npx tsx scripts/test-daily-brief.ts --today 2026-10-12
 *   npx tsx scripts/test-daily-brief.ts --facts         # also dump the facts JSON handed to the writer
 *   npx tsx scripts/test-daily-brief.ts --post          # POST to the Slack webhook (#datastudiobot)
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

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

(async () => {
  const { buildDailyBrief } = await import('../lib/kpi/daily-brief');
  const t0 = Date.now();
  const result = await buildDailyBrief({
    today: opt('--today'),
    weekly: flag('--weekly') ? true : flag('--no-weekly') ? false : undefined,
    skipNarrative: flag('--no-llm'),
    preview: flag('--preview'),
  });
  console.error(`⏱  built in ${((Date.now() - t0) / 1000).toFixed(1)}s · narrative: ${result.narrativeSource}`);
  console.log(result.text);
  if (flag('--facts')) {
    console.log('\n=== FACTS ===');
    console.log(JSON.stringify(result.facts, null, 2));
  }
  if (flag('--post')) {
    const { postToSlack } = await import('../lib/slack/post');
    await postToSlack(result.message);
    console.error('✅ posted to Slack webhook');
  }
})().catch((e) => { console.error('❌', e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
