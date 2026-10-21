/**
 * Arma el brief de cohortes en local con los módulos reales y lo imprime.
 *
 * Run:
 *   npx tsx scripts/test-cohort-brief.ts                    # dry run, hoy (MX)
 *   npx tsx scripts/test-cohort-brief.ts --today 2026-10-20
 *   npx tsx scripts/test-cohort-brief.ts --facts            # también los datos de las comparaciones
 *   npx tsx scripts/test-cohort-brief.ts --png out.png      # guarda la gráfica
 *   npx tsx scripts/test-cohort-brief.ts --post             # publica en SLACK_COHORT_CHANNEL (vista previa)
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
  const { buildCohortBrief } = await import('../lib/kpi/cohort-brief');
  const t0 = Date.now();
  const result = await buildCohortBrief({ today: opt('--today'), preview: flag('--post') });
  console.error(`⏱  built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(result.text);
  if (flag('--facts')) console.log('\n=== FACTS ===\n' + JSON.stringify(result.facts, null, 2));
  const png = opt('--png');
  if (png && result.message.files?.[0]) { fs.writeFileSync(png, result.message.files[0].data); console.error(`🖼  ${png}`); }
  if (flag('--post')) {
    const channel = process.env.SLACK_COHORT_CHANNEL;
    if (!channel) throw new Error('SLACK_COHORT_CHANNEL no está en .env.local');
    const { postWithThread } = await import('../lib/slack/post');
    const via = await postWithThread({ main: result.message, thread: result.thread }, { channel, webhookFallback: false });
    console.error(`✅ posted via ${via.via}`);
  }
})().catch((e) => { console.error('❌', e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
