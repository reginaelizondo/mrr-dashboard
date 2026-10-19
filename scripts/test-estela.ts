/**
 * Corre a Estela localmente con los módulos reales y muestra el resultado.
 *
 *   npx tsx scripts/test-estela.ts                  # dry run: hechos + propuestas (Claude), no publica ni guarda
 *   npx tsx scripts/test-estela.ts --no-llm         # solo hechos
 *   npx tsx scripts/test-estela.ts --facts          # imprime el JSON de hechos que recibe el redactor
 *   npx tsx scripts/test-estela.ts --today 2026-10-19
 *   npx tsx scripts/test-estela.ts --post           # publica en el canal de Estela y guarda las propuestas
 */
import fs from 'fs';
import path from 'path';

function loadEnvLocal() {
  const p = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvLocal();

async function main() {
  const args = process.argv.slice(2);
  const today = args.includes('--today') ? args[args.indexOf('--today') + 1] : undefined;
  const llm = !args.includes('--no-llm');
  const post = args.includes('--post');
  const { buildEstela, postEstela } = await import('../lib/estela/estela');
  const result = await buildEstela({ today, llm, save: post });
  if (args.includes('--facts')) console.log(JSON.stringify(result.facts, null, 2));
  console.log('\n' + result.text + '\n');
  if (post) {
    const r = await postEstela(result);
    console.log(r.ok ? `Publicado (ts ${r.ts}) · propuestas guardadas: ${result.saved.map((s) => s.id).join(', ')}` : `No se publicó: ${r.error}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
