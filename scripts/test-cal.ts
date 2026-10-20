/**
 * Corre a Cal localmente.
 *   npx tsx scripts/test-cal.ts                    # hoy, sin publicar
 *   npx tsx scripts/test-cal.ts --today 2026-11-01
 *   npx tsx scripts/test-cal.ts --post             # publica en el canal
 */
import fs from 'fs';
import path from 'path';

const p = path.join(process.cwd(), '.env.local');
if (fs.existsSync(p)) {
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const today = args.includes('--today') ? args[args.indexOf('--today') + 1] : undefined;
  const { runCal, buildCalMessage, postCal } = await import('../lib/cal/cal');
  const run = await runCal(today);
  const msg = buildCalMessage(run);
  console.log(`Hoy ${run.today} · alertas ${run.alertasHoy.length} · vencidas ${run.vencidas.length} · próximas 45d ${run.proximas45.length} · lunes ${run.esLunes}`);
  if (!msg) { console.log('Nada que avisar hoy.'); return; }
  console.log('\n' + msg.text + '\n');
  if (args.includes('--post')) {
    const r = await postCal(msg);
    console.log(r.ok ? `Publicado (ts ${r.ts})` : `No se publicó: ${r.error}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
