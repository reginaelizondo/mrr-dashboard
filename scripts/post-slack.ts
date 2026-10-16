/**
 * Publica un texto en #datastudiobot con el webhook del KPI Bot. Lo usa la auditoría semanal del Looker.
 *   npx tsx scripts/post-slack.ts "🛡️ Auditoría semanal Looker: 232/234 columnas iguales ✅"
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
(async () => {
  const text = process.argv.slice(2).join(' ').trim();
  if (!text) throw new Error('uso: npx tsx scripts/post-slack.ts "<texto>"');
  const { postToSlack } = await import('../lib/slack/post');
  await postToSlack({ text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } }] });
  console.log('publicado');
})().catch((e) => { console.error('❌', e instanceof Error ? e.message : e); process.exit(1); });
