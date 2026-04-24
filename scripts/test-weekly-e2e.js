/**
 * End-to-end test: build the weekly KPI report using the same logic as
 * lib/kpi/weekly-report.ts and POST it to the real Slack webhook.
 *
 * Mirrors lib/kpi/{formulas,period,queries,weekly-report}.ts + lib/slack/post.ts.
 * Keep in sync if formulas.ts / weekly-report.ts change.
 *
 * Run: node scripts/test-weekly-e2e.js
 *   --dry       print the Slack payload to stdout; don't POST
 *   --week YYYY-MM-DD  override the reference date (default: today in MX)
 */

const { BigQuery } = require('@google-cloud/bigquery');
const fs = require('fs');
const path = require('path');

// --- Load .env.local manually (no dotenv dep) -------------------------------
function loadEnvLocal() {
  const p = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(p)) return;
  const txt = fs.readFileSync(p, 'utf-8');
  for (const raw of txt.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnvLocal();

// --- CLI args ---------------------------------------------------------------
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const weekIdx = args.indexOf('--week');
const WEEK_OVERRIDE = weekIdx >= 0 ? args[weekIdx + 1] : null;

// --- Period logic (mirror lib/kpi/period.ts) --------------------------------
const MX_TZ_OFFSET_HOURS = -6;
function nowInMx() {
  return new Date(Date.now() + MX_TZ_OFFSET_HOURS * 3600 * 1000);
}
function fmtDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function lastCompleteWeek(reference) {
  const ref = new Date(Date.UTC(reference.getFullYear(), reference.getMonth(), reference.getDate()));
  const dayOfWeek = ref.getUTCDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const lastSunday = new Date(ref);
  lastSunday.setUTCDate(ref.getUTCDate() - daysSinceMonday - 1);
  const lastMonday = new Date(lastSunday);
  lastMonday.setUTCDate(lastSunday.getUTCDate() - 6);
  return { start: fmtDate(lastMonday), end: fmtDate(lastSunday), label: `${fmtDate(lastMonday)} → ${fmtDate(lastSunday)}` };
}
function priorWeek(period) {
  const start = new Date(period.start + 'T00:00:00Z');
  const prevSunday = new Date(start);
  prevSunday.setUTCDate(start.getUTCDate() - 1);
  const prevMonday = new Date(prevSunday);
  prevMonday.setUTCDate(prevSunday.getUTCDate() - 6);
  return { start: fmtDate(prevMonday), end: fmtDate(prevSunday), label: `${fmtDate(prevMonday)} → ${fmtDate(prevSunday)}` };
}

// --- KPI SQL (mirror lib/kpi/formulas.ts) -----------------------------------
const KPI_SQL = {
  newSubs: `(SUM(new_subscriptions) + SUM(num_of_refunds_sale_date))`,
  nsSales: `(SUM(new_subscriptions_sales) + SUM(refunds_total_amount_sale_date))`,
  cac: `SAFE_DIVIDE(SUM(spend), SUM(new_subscriptions) + SUM(num_of_refunds_sale_date))`,
  conversionRate: `SAFE_DIVIDE(SUM(new_subscriptions) + SUM(num_of_refunds_sale_date), SUM(signups))`,
  totalRenewalSales: `(SUM(renewals_sales_yearly_ios) + SUM(renewals_sales))`,
  totalSales: `(
    SUM(renewals_sales) + SUM(renewals_sales_yearly_ios) + SUM(new_subscriptions_sales)
    + SUM(other_sales) + SUM(refunds_total_amount_sale_date) - SUM(refunds_total_amount_refund_date)
  )`,
  arpu: `SAFE_DIVIDE(
    SUM(new_subscriptions_sales) + SUM(refunds_total_amount_sale_date) + SUM(other_sales),
    SUM(new_subscriptions) + SUM(num_of_refunds_sale_date) + SUM(other_purchases)
  )`,
  netSales: `(
    SUM(IF(network = "stripe", other_sales, 0)) * 0.97
    + SUM(IF(network = "shopify", other_sales, 0)) * 0.98
    + ((SUM(IF(os = "iOS", renewals_sales, 0)) + SUM(IF(os = "iOS", new_subscriptions_sales, 0))
        + SUM(IF(os = "iOS", refunds_total_amount_sale_date, 0))) * 0.7)
    + (SUM(renewals_sales_yearly_ios) * 0.85)
    + ((SUM(IF(os = "Android", renewals_sales, 0)) + SUM(IF(os = "Android", new_subscriptions_sales, 0))
        + SUM(IF(os = "Android", refunds_total_amount_sale_date, 0))) * 0.85)
    + ((SUM(IF(os = "Unknown", renewals_sales, 0)) + SUM(IF(os = "Unknown", new_subscriptions_sales, 0))
        + SUM(IF(os = "Unknown", refunds_total_amount_sale_date, 0))) * 0.98)
    + ((SUM(IF(os = "Web", renewals_sales, 0)) + SUM(IF(os = "Web", new_subscriptions_sales, 0))
        + SUM(IF(os = "Web", refunds_total_amount_sale_date, 0))) * 0.98)
    - ((SUM(IF(os = "Android" OR os = "iOS", renewals_sales, 0)) + SUM(renewals_sales_yearly_ios)
        + SUM(IF(os = "Android" OR os = "iOS", new_subscriptions_sales, 0))
        + SUM(IF(os = "Android" OR os = "iOS", refunds_total_amount_sale_date, 0))) * 0.06)
    - SUM(refunds_total_amount_refund_date) * SAFE_DIVIDE(
        SUM(IF(network = "stripe", other_sales, 0)) * 0.97
        + SUM(IF(network = "shopify", other_sales, 0)) * 0.98
        + ((SUM(IF(os = "iOS", renewals_sales, 0)) + SUM(IF(os = "iOS", new_subscriptions_sales, 0))) * 0.7)
        + (SUM(renewals_sales_yearly_ios) * 0.85)
        + ((SUM(IF(os = "Android", renewals_sales, 0)) + SUM(IF(os = "Android", new_subscriptions_sales, 0))) * 0.85)
        + ((SUM(IF(os = "Unknown", renewals_sales, 0)) + SUM(IF(os = "Unknown", new_subscriptions_sales, 0))) * 0.98)
        + ((SUM(IF(os = "Web", renewals_sales, 0)) + SUM(IF(os = "Web", new_subscriptions_sales, 0))) * 0.98)
        - ((SUM(IF(os = "Android" OR os = "iOS", renewals_sales, 0)) + SUM(renewals_sales_yearly_ios)
            + SUM(IF(os = "Android" OR os = "iOS", new_subscriptions_sales, 0))) * 0.06),
        SUM(renewals_sales) + SUM(renewals_sales_yearly_ios) + SUM(new_subscriptions_sales) + SUM(other_sales)
      )
  )`,
  spend: `SUM(spend)`,
  signups: `SUM(signups)`,
  firstTicketCac: `SAFE_DIVIDE(
    SAFE_DIVIDE(
      SUM(new_subscriptions_sales) + SUM(refunds_total_amount_sale_date) + SUM(other_sales),
      SUM(new_subscriptions) + SUM(num_of_refunds_sale_date) + SUM(other_purchases)
    ),
    SAFE_DIVIDE(SUM(spend), SUM(new_subscriptions) + SUM(num_of_refunds_sale_date))
  )`,
};

const KPI_LABELS = {
  newSubs: 'New Subscriptions',
  nsSales: 'New Subs Sales',
  cac: 'CAC',
  conversionRate: 'Conversion Rate',
  totalRenewalSales: 'Total Renewal Sales',
  totalSales: 'Total Sales',
  arpu: 'ARPU',
  netSales: 'Net Sales',
  spend: 'Spend',
  signups: 'Signups',
  firstTicketCac: '1st Ticket / CAC',
};

const TABLE = '`celtic-music-240111.dbt_prod_analytics.an_operational_dash`';

const CURRENCY_KEYS = new Set(['nsSales', 'totalRenewalSales', 'totalSales', 'netSales', 'spend', 'cac', 'arpu']);
const PERCENT_KEYS = new Set(['conversionRate']);
const RATIO_KEYS = new Set(['firstTicketCac']);
const INVERTED_KEYS = new Set(['cac']);
const KPI_DISPLAY_ORDER = [
  'spend', 'signups', 'newSubs', 'conversionRate', 'cac',
  'nsSales', 'arpu', 'firstTicketCac',
  'totalRenewalSales', 'totalSales', 'netSales',
];
const OS_CANONICAL = new Set(['iOS', 'Android', 'Web']);

// --- BigQuery helpers -------------------------------------------------------
function getClient() {
  return new BigQuery({
    keyFilename: process.env.BIGQUERY_KEY_FILE || './bigquery-service-account.json',
    projectId: process.env.BIGQUERY_PROJECT_ID || 'celtic-music-240111',
  });
}

async function fetchKPIs(bq, period) {
  const selectClause = Object.entries(KPI_SQL).map(([k, sql]) => `  ${sql} AS ${k}`).join(',\n');
  const query = `
    SELECT
${selectClause}
    FROM ${TABLE}
    WHERE date BETWEEN @start AND @end
  `;
  const [rows] = await bq.query({ query, params: { start: period.start, end: period.end } });
  return rows[0];
}

async function fetchBreakdown(bq, period, dimensionColumn) {
  const selectClause = Object.entries(KPI_SQL).map(([k, sql]) => `  ${sql} AS ${k}`).join(',\n');
  const query = `
    SELECT
      COALESCE(CAST(\`${dimensionColumn}\` AS STRING), '(null)') AS dimension,
${selectClause}
    FROM ${TABLE}
    WHERE date BETWEEN @start AND @end
    GROUP BY dimension
    ORDER BY nsSales DESC
  `;
  const [rows] = await bq.query({ query, params: { start: period.start, end: period.end } });
  return rows;
}

function filterBreakdown(column, rows) {
  if (column === 'os') return rows.filter(r => OS_CANONICAL.has(r.dimension));
  return rows.filter(r => r.dimension !== '(null)');
}

// --- Formatting -------------------------------------------------------------
function fmtValue(key, v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return 'n/a';
  const n = Number(v);
  if (CURRENCY_KEYS.has(key)) {
    if (key === 'cac' || key === 'arpu') return `$${n.toFixed(2)}`;
    return `$${Math.round(n).toLocaleString('en-US')}`;
  }
  if (PERCENT_KEYS.has(key)) return `${(n * 100).toFixed(2)}%`;
  if (RATIO_KEYS.has(key)) return `${n.toFixed(2)}x`;
  return Math.round(n).toLocaleString('en-US');
}
function pctChange(curr, prev) {
  if (curr === null || prev === null || curr === undefined || prev === undefined) return null;
  const c = Number(curr), p = Number(prev);
  if (p === 0 || Number.isNaN(p)) return null;
  return ((c - p) / p) * 100;
}
function arrowFor(key, change) {
  if (change === null) return '·';
  const inverted = INVERTED_KEYS.has(key);
  const isGood = inverted ? change < 0 : change > 0;
  if (Math.abs(change) < 0.5) return '→';
  return isGood ? '🟢' : '🔴';
}
function fmtPctChange(change) {
  if (change === null) return 'n/a';
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(1)}%`;
}

// --- Explanations -----------------------------------------------------------
async function buildExplanations(bq, current, prior, topKpis) {
  const dims = [['os', 'Platform'], ['kinedu_region', 'Region'], ['kinedu_language', 'Language']];
  const out = [];
  for (const kpi of topKpis) {
    let best = null;
    let bestSpread = -Infinity;
    for (const [col, label] of dims) {
      const [rawCurr, rawPrior] = await Promise.all([
        fetchBreakdown(bq, current, col),
        fetchBreakdown(bq, prior, col),
      ]);
      const currRows = filterBreakdown(col, rawCurr);
      const priorRows = filterBreakdown(col, rawPrior);
      const priorMap = new Map(priorRows.map(r => [r.dimension, r]));
      const moves = currRows.map(r => {
        const p = priorMap.get(r.dimension);
        const c = Number(r[kpi] ?? 0);
        const pv = Number(p?.[kpi] ?? 0);
        return { dim: r.dimension, delta: c - pv, pct: pctChange(c, pv) };
      }).filter(m => isFinite(m.delta));
      if (moves.length === 0) continue;
      moves.sort((a, b) => b.delta - a.delta);
      const top = moves[0];
      const worst = moves[moves.length - 1];
      const spread = Math.abs(top.delta - worst.delta);
      if (spread > bestSpread) {
        bestSpread = spread;
        best = {
          dimension: label,
          topMover: `${top.dim}: ${top.delta >= 0 ? '+' : ''}${fmtValue(kpi, top.delta)} (${fmtPctChange(top.pct)})`,
          worstMover: `${worst.dim}: ${worst.delta >= 0 ? '+' : ''}${fmtValue(kpi, worst.delta)} (${fmtPctChange(worst.pct)})`,
        };
      }
    }
    if (best) out.push({ kpi, ...best });
  }
  return out;
}

// --- Executive Summary ------------------------------------------------------
function classifyWoW(key, curr, prev) {
  const pct = pctChange(curr, prev);
  if (pct === null) return null;
  const inverted = INVERTED_KEYS.has(key);
  const isGood = inverted ? pct < 0 : pct > 0;
  const mag = Math.abs(pct);
  if (isGood && mag >= 5) return 'strength';
  if (!isGood && mag >= 10) return 'critical';
  if (!isGood && mag >= 2) return 'watch';
  return null;
}

function buildExecSummary(curr, prev) {
  const summary = { strengths: [], watch: [], critical: [] };

  // 1st Ticket / CAC — absolute threshold
  const ftCac = curr.firstTicketCac;
  if (ftCac !== null && ftCac !== undefined && !Number.isNaN(Number(ftCac))) {
    const v = Number(ftCac);
    const ftPct = pctChange(curr.firstTicketCac, prev.firstTicketCac);
    const wowSub = ftPct === null ? '' : ` · WoW ${fmtPctChange(ftPct)}`;
    if (v >= 1.0) {
      summary.strengths.push({ label: '1st Ticket / CAC', value: `${v.toFixed(2)}x`, sub: `above breakeven${wowSub}` });
    } else if (v >= 0.5) {
      summary.watch.push({ label: '1st Ticket / CAC', value: `${v.toFixed(2)}x`, sub: `below breakeven — relies on renewals${wowSub}` });
    } else {
      summary.critical.push({ label: '1st Ticket / CAC', value: `${v.toFixed(2)}x`, sub: `< 0.5x — losing money per new sub${wowSub}` });
    }
  }

  // Classify every other KPI by WoW magnitude
  for (const k of KPI_DISPLAY_ORDER) {
    if (k === 'firstTicketCac') continue;
    const cls = classifyWoW(k, curr[k], prev[k]);
    if (!cls) continue;
    const pct = pctChange(curr[k], prev[k]);
    const item = {
      label: KPI_LABELS[k],
      value: fmtValue(k, curr[k]),
      sub: `WoW ${fmtPctChange(pct)} vs ${fmtValue(k, prev[k])}`,
    };
    summary[cls === 'strength' ? 'strengths' : cls === 'watch' ? 'watch' : 'critical'].push(item);
  }

  // ROAS — Net Sales / Spend
  const netSales = Number(curr.netSales ?? 0);
  const spend = Number(curr.spend ?? 0);
  if (spend > 0) {
    const roas = netSales / spend;
    const base = {
      label: 'Net Sales / Spend',
      value: `${roas.toFixed(2)}x`,
      sub: `$${Math.round(netSales).toLocaleString('en-US')} net on $${Math.round(spend).toLocaleString('en-US')} spend`,
    };
    if (roas >= 1.5) summary.strengths.push(base);
    else if (roas >= 1.0) summary.watch.push({ ...base, sub: `thin buffer · ${base.sub}` });
    else summary.critical.push({ ...base, sub: `below 1.0x · ${base.sub}` });
  }

  return summary;
}

function renderInsightCard(title, emoji, items, emptyText) {
  const body = items.length === 0
    ? `_${emptyText}_`
    : items.map(it => `• *${it.label}* — \`${it.value}\`  _${it.sub}_`).join('\n');
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: `*${emoji} ${title}*\n${body}` },
  };
}

// --- Build report -----------------------------------------------------------
async function buildReport() {
  const bq = getClient();
  const ref = WEEK_OVERRIDE ? new Date(WEEK_OVERRIDE + 'T00:00:00Z') : nowInMx();
  const current = lastCompleteWeek(ref);
  const prior = priorWeek(current);

  console.error(`📅 Current: ${current.label}  |  Prior: ${prior.label}`);

  const [currKpis, priorKpis] = await Promise.all([fetchKPIs(bq, current), fetchKPIs(bq, prior)]);

  const movers = KPI_DISPLAY_ORDER
    .filter(k => k !== 'firstTicketCac')
    .map(k => ({ k, abs: Math.abs(pctChange(currKpis[k], priorKpis[k]) ?? 0) }))
    .sort((a, b) => b.abs - a.abs).slice(0, 3).map(m => m.k);
  const explanations = await buildExplanations(bq, current, prior, movers);

  const lines = KPI_DISPLAY_ORDER.map(k => {
    const ch = pctChange(currKpis[k], priorKpis[k]);
    return `${arrowFor(k, ch)} *${KPI_LABELS[k]}*: ${fmtValue(k, currKpis[k])}  _(WoW ${fmtPctChange(ch)} vs ${fmtValue(k, priorKpis[k])})_`;
  });

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '📊 Weekly KPIs — Kinedu' } },
    {
      type: 'context', elements: [
        { type: 'mrkdwn', text: `*Current week:* ${current.label}` },
        { type: 'mrkdwn', text: `*Prior week:* ${prior.label}` },
      ],
    },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
  ];

  if (explanations.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*🔎 Top movers — what explains them*' } });
    for (const e of explanations) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${KPI_LABELS[e.kpi]}* — broken down by _${e.dimension}_\n  ↑ ${e.topMover}\n  ↓ ${e.worstMover}`,
        },
      });
    }
  }

  const exec = buildExecSummary(currKpis, priorKpis);
  blocks.push({ type: 'divider' });
  blocks.push({ type: 'header', text: { type: 'plain_text', text: '🧭 Executive Summary' } });
  blocks.push(renderInsightCard('Strengths', '✅', exec.strengths, 'No standout strengths this week.'));
  blocks.push(renderInsightCard('Watch Items', '⚠️', exec.watch, 'Nothing on the watch list.'));
  blocks.push(renderInsightCard('Critical Issues', '❌', exec.critical, 'No critical issues detected.'));

  blocks.push({
    type: 'context', elements: [{ type: 'mrkdwn', text: `_Source: \`an_operational_dash\` (BigQuery) · 🤖 KPI Bot · TEST_` }],
  });

  return {
    text: `Kinedu Weekly KPIs (${current.label})`,
    blocks,
  };
}

async function postToSlack(message) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) throw new Error('SLACK_WEBHOOK_URL env var not set');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
  const body = await res.text();
  if (!res.ok || body !== 'ok') throw new Error(`Slack webhook failed (${res.status}): ${body}`);
}

(async () => {
  const msg = await buildReport();
  if (DRY) {
    console.log(JSON.stringify(msg, null, 2));
    return;
  }
  await postToSlack(msg);
  console.error('✅ Report posted to Slack (#datastudiobot).');
})().catch(e => { console.error('❌', e.message); process.exit(1); });
