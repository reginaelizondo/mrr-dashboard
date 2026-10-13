/**
 * Run the daily store audit locally.
 *   npx tsx scripts/test-store-audit.ts            # dry run, prints the Slack text + checks
 *   npx tsx scripts/test-store-audit.ts --today 2026-10-13
 *   npx tsx scripts/test-store-audit.ts --post     # post to the Slack webhook (#datastudiobot)
 */
import fs from 'fs';
import path from 'path';
(function loadEnv() {
  const p = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf-8').split('\n')) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); if (eq === -1) continue;
    const k = line.slice(0, eq).trim(); let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
})();
const args = process.argv.slice(2);
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
(async () => {
  const { runStoreAudit } = await import('../lib/audit/store-audit');
  const t0 = Date.now();
  const r = await runStoreAudit({ today: opt('--today') });
  console.error(`⏱  ${((Date.now() - t0) / 1000).toFixed(1)}s · status=${r.status} · ventana ${r.window.start} → ${r.window.end}`);
  console.log(r.text);
  if (args.includes('--post')) { const { postToSlack } = await import('../lib/slack/post'); await postToSlack(r.message); console.error('✅ posted'); }
})().catch((e) => { console.error('❌', e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
