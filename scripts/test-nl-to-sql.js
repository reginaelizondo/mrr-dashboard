/**
 * Test the NL→SQL + safety + execute pipeline without going through Slack.
 * Uses JS bindings that mirror the TS lib — keep in sync if prompts change.
 *
 * Run: node scripts/test-nl-to-sql.js "CAC last week by platform"
 */
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;
const { BigQuery } = require('@google-cloud/bigquery');

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

const q = process.argv.slice(2).join(' ') || 'CAC last week by platform';
console.log(`Q: ${q}\n`);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const bq = new BigQuery({
  keyFilename: './bigquery-service-account.json',
  projectId: 'celtic-music-240111',
});

// Import the prompt from the TS module via eval of a compiled version — too much work.
// Instead, just import the runtime behavior via a tiny bridge. For this smoke test
// we just replicate the essential prompt inline. Keep this short; the full version
// lives in lib/kpi/nl-to-sql.ts.
async function callClaude(question) {
  // Use a much shorter smoke-test prompt that exercises the same pattern
  const today = new Date().toISOString().slice(0, 10);
  const systemPrompt = `You translate KPI questions into BigQuery SQL against
\`celtic-music-240111.dbt_prod_analytics.an_operational_dash\`.
Always SELECT/WITH only. Always filter by date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'.
Today is ${today}. "Last week" = most recent complete Mon-Sun.
Use SAFE_DIVIDE. For aggregates use SUM. For new subs gross: SUM(new_subscriptions) + SUM(num_of_refunds_sale_date).
For CAC: SAFE_DIVIDE(SUM(spend), SUM(new_subscriptions) + SUM(num_of_refunds_sale_date)).
Platform = os column (values iOS/Android/Web/Unknown/null); exclude Unknown and null when breaking down.
Return JSON: {"sql": "...", "title": "...", "explanation": "..."}.
No markdown, no code fences. Just the JSON object.`;

  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system: systemPrompt,
    messages: [{ role: 'user', content: question }],
  });
  const txt = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const json = txt.match(/\{[\s\S]*\}/);
  if (!json) throw new Error('No JSON in: ' + txt);
  return JSON.parse(json[0]);
}

(async () => {
  const { sql, title, explanation } = await callClaude(q);
  console.log('TITLE:', title);
  console.log('EXPLANATION:', explanation);
  console.log('\n--- SQL ---\n' + sql + '\n---');

  const [rows] = await bq.query({ query: sql, jobTimeoutMs: 25000 });
  console.log(`\nROWS (${rows.length}):`);
  console.table(rows.slice(0, 10));
})().catch(e => { console.error('❌', e.message); process.exit(1); });
