import { fetchKPIsForPeriod, fetchKPIsBreakdown, BreakdownRow } from './queries';
import { lastCompleteWeek, priorWeek, Period } from './period';
import { KPI_LABELS, KPIKey } from './formulas';
import type { SlackMessage } from '@/lib/slack/post';

type SlackBlock = NonNullable<SlackMessage['blocks']>[number];

const CURRENCY_KEYS: Set<KPIKey> = new Set([
  'nsSales', 'totalRenewalSales', 'totalSales', 'netSales', 'spend', 'cac', 'arpu',
]);
const PERCENT_KEYS: Set<KPIKey> = new Set(['conversionRate']);
const RATIO_KEYS: Set<KPIKey> = new Set(['firstTicketCac']);
// KPIs where DOWN is good (lower is better)
const INVERTED_KEYS: Set<KPIKey> = new Set(['cac']);

// Order of KPIs in the message (what shows first)
const KPI_DISPLAY_ORDER: KPIKey[] = [
  'spend', 'signups', 'newSubs', 'conversionRate', 'cac',
  'nsSales', 'arpu', 'firstTicketCac',
  'totalRenewalSales', 'totalSales', 'netSales',
];

// Canonical platform values — exclude tracking gaps (Unknown/null) from os breakdown
// so a $60 noise bucket doesn't get surfaced as a "top mover".
const OS_CANONICAL = new Set(['iOS', 'Android', 'Web']);

function fmtValue(key: KPIKey, v: number | null): string {
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

function pctChange(curr: number | null, prev: number | null): number | null {
  if (curr === null || prev === null) return null;
  const c = Number(curr), p = Number(prev);
  if (p === 0 || Number.isNaN(p)) return null;
  return ((c - p) / p) * 100;
}

function arrowFor(key: KPIKey, change: number | null): string {
  if (change === null) return '·';
  const inverted = INVERTED_KEYS.has(key);
  const isGood = inverted ? change < 0 : change > 0;
  if (Math.abs(change) < 0.5) return '→';
  return isGood ? '🟢' : '🔴';
}

function fmtPctChange(change: number | null): string {
  if (change === null) return 'n/a';
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(1)}%`;
}

// Filter rows for a given dimension column to drop noise buckets
function filterBreakdownRows(column: string, rows: BreakdownRow[]): BreakdownRow[] {
  if (column === 'os') {
    return rows.filter(r => OS_CANONICAL.has(r.dimension));
  }
  // Drop "(null)" bucket for region/language
  return rows.filter(r => r.dimension !== '(null)');
}

interface BreakdownExplanation {
  kpi: KPIKey;
  dimension: string;
  topMover: string;
  worstMover: string;
}

async function buildExplanations(
  current: Period,
  prior: Period,
  topKpis: KPIKey[]
): Promise<BreakdownExplanation[]> {
  const dims: Array<[string, string]> = [
    ['os', 'Platform'],
    ['kinedu_region', 'Region'],
    ['kinedu_language', 'Language'],
  ];

  const out: BreakdownExplanation[] = [];

  for (const kpi of topKpis) {
    let bestDim: string | null = null;
    let bestTop = '';
    let bestWorst = '';
    let bestSpread = -Infinity;

    for (const [col, label] of dims) {
      const [rawCurr, rawPrior] = await Promise.all([
        fetchKPIsBreakdown(current, col),
        fetchKPIsBreakdown(prior, col),
      ]);
      const currRows = filterBreakdownRows(col, rawCurr);
      const priorRows = filterBreakdownRows(col, rawPrior);
      const priorMap = new Map(priorRows.map(r => [r.dimension, r]));
      const moves = currRows
        .map(r => {
          const p = priorMap.get(r.dimension);
          const c = Number(r[kpi] ?? 0);
          const pv = Number(p?.[kpi] ?? 0);
          return { dim: r.dimension, delta: c - pv, pct: pctChange(c, pv) };
        })
        .filter(m => isFinite(m.delta));

      if (moves.length === 0) continue;
      moves.sort((a, b) => b.delta - a.delta);
      const top = moves[0];
      const worst = moves[moves.length - 1];
      const spread = Math.abs(top.delta - worst.delta);
      if (spread > bestSpread) {
        bestSpread = spread;
        bestDim = label;
        bestTop = `${top.dim}: ${top.delta >= 0 ? '+' : ''}${fmtValue(kpi, top.delta)} (${fmtPctChange(top.pct)})`;
        bestWorst = `${worst.dim}: ${worst.delta >= 0 ? '+' : ''}${fmtValue(kpi, worst.delta)} (${fmtPctChange(worst.pct)})`;
      }
    }

    if (bestDim) {
      out.push({ kpi, dimension: bestDim, topMover: bestTop, worstMover: bestWorst });
    }
  }

  return out;
}

// --- Executive Summary ------------------------------------------------------
// Rule-based classifier for WoW KPI movement. Thresholds:
//   Strength   : moved in "good" direction by ≥ 5%
//   Watch      : moved in "bad" direction by 2–10%
//   Critical   : moved in "bad" direction by ≥ 10%
// Plus absolute rules for 1st Ticket / CAC (payback health).
//
// Each item returns { label, value, badge, sub } — rendered as one line per card.

interface InsightItem {
  label: string;
  value: string;
  sub: string;
}
interface ExecSummary {
  strengths: InsightItem[];
  watch: InsightItem[];
  critical: InsightItem[];
}

type KPIRowNumeric = Record<KPIKey, number | null>;

function classifyWoW(key: KPIKey, curr: number | null, prev: number | null): 'strength' | 'watch' | 'critical' | null {
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

function buildExecSummary(curr: KPIRowNumeric, prev: KPIRowNumeric): ExecSummary {
  const summary: ExecSummary = { strengths: [], watch: [], critical: [] };

  // Rule 1: absolute threshold on 1st Ticket / CAC
  const ftCac = curr.firstTicketCac;
  if (ftCac !== null && !Number.isNaN(Number(ftCac))) {
    const v = Number(ftCac);
    const ftPct = pctChange(curr.firstTicketCac, prev.firstTicketCac);
    const wowSub = ftPct === null ? '' : ` · WoW ${fmtPctChange(ftPct)}`;
    if (v >= 1.0) {
      summary.strengths.push({
        label: '1st Ticket / CAC',
        value: `${v.toFixed(2)}x`,
        sub: `above breakeven${wowSub}`,
      });
    } else if (v >= 0.5) {
      summary.watch.push({
        label: '1st Ticket / CAC',
        value: `${v.toFixed(2)}x`,
        sub: `below breakeven — relies on renewals${wowSub}`,
      });
    } else {
      summary.critical.push({
        label: '1st Ticket / CAC',
        value: `${v.toFixed(2)}x`,
        sub: `< 0.5x — losing money per new sub${wowSub}`,
      });
    }
  }

  // Rule 2: classify each KPI by WoW magnitude
  for (const k of KPI_DISPLAY_ORDER) {
    if (k === 'firstTicketCac') continue; // handled above
    const cls = classifyWoW(k, curr[k], prev[k]);
    if (!cls) continue;
    const pct = pctChange(curr[k], prev[k]);
    const item: InsightItem = {
      label: KPI_LABELS[k],
      value: fmtValue(k, curr[k]),
      sub: `WoW ${fmtPctChange(pct)} vs ${fmtValue(k, prev[k])}`,
    };
    summary[cls === 'strength' ? 'strengths' : cls === 'watch' ? 'watch' : 'critical'].push(item);
  }

  // Rule 3: ROAS check — Net Sales / Spend
  const netSales = Number(curr.netSales ?? 0);
  const spend = Number(curr.spend ?? 0);
  if (spend > 0) {
    const roas = netSales / spend;
    const item: InsightItem = {
      label: 'Net Sales / Spend',
      value: `${roas.toFixed(2)}x`,
      sub: `$${Math.round(netSales).toLocaleString('en-US')} net on $${Math.round(spend).toLocaleString('en-US')} spend`,
    };
    if (roas >= 1.5) summary.strengths.push(item);
    else if (roas >= 1.0) summary.watch.push({ ...item, sub: `thin buffer · ${item.sub}` });
    else summary.critical.push({ ...item, sub: `below 1.0x · ${item.sub}` });
  }

  return summary;
}

function renderInsightCard(
  title: string,
  emoji: string,
  items: InsightItem[],
  emptyText: string
): SlackBlock {
  const body = items.length === 0
    ? `_${emptyText}_`
    : items.map(it => `• *${it.label}* — \`${it.value}\`  _${it.sub}_`).join('\n');
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: `*${emoji} ${title}*\n${body}` },
  };
}

// --- Main builder -----------------------------------------------------------

export async function buildWeeklyReport(): Promise<SlackMessage> {
  const current = lastCompleteWeek();
  const prior = priorWeek(current);

  const [currKpis, priorKpis] = await Promise.all([
    fetchKPIsForPeriod(current),
    fetchKPIsForPeriod(prior),
  ]);

  // Pick KPIs with biggest WoW magnitude for the explanation section
  const moversRanked = KPI_DISPLAY_ORDER
    .filter(k => k !== 'firstTicketCac') // ratio, not worth decomposing by dimension
    .map(k => ({ k, abs: Math.abs(pctChange(currKpis[k], priorKpis[k]) ?? 0) }))
    .sort((a, b) => b.abs - a.abs)
    .slice(0, 3)
    .map(m => m.k);
  const explanations = await buildExplanations(current, prior, moversRanked);

  // Header
  const header = {
    type: 'header',
    text: { type: 'plain_text', text: '📊 Weekly KPIs — Kinedu' },
  };
  const ctx = {
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `*Current week:* ${current.label}` },
      { type: 'mrkdwn', text: `*Prior week:* ${prior.label}` },
    ],
  };

  const lines = KPI_DISPLAY_ORDER.map(k => {
    const change = pctChange(currKpis[k], priorKpis[k]);
    const arrow = arrowFor(k, change);
    return `${arrow} *${KPI_LABELS[k]}*: ${fmtValue(k, currKpis[k])}  _(WoW ${fmtPctChange(change)} vs ${fmtValue(k, priorKpis[k])})_`;
  });
  const kpiBlock = {
    type: 'section',
    text: { type: 'mrkdwn', text: lines.join('\n') },
  };

  // Explanation section
  const explBlocks: SlackBlock[] = [];
  if (explanations.length > 0) {
    explBlocks.push({ type: 'divider' });
    explBlocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*🔎 Top movers — what explains them*' },
    });
    for (const e of explanations) {
      explBlocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${KPI_LABELS[e.kpi]}* — broken down by _${e.dimension}_\n  ↑ ${e.topMover}\n  ↓ ${e.worstMover}`,
        },
      });
    }
  }

  // Executive summary
  const exec = buildExecSummary(currKpis as KPIRowNumeric, priorKpis as KPIRowNumeric);
  const execBlocks: SlackBlock[] = [
    { type: 'divider' },
    { type: 'header', text: { type: 'plain_text', text: '🧭 Executive Summary' } },
    renderInsightCard('Strengths', '✅', exec.strengths, 'No standout strengths this week.'),
    renderInsightCard('Watch Items', '⚠️', exec.watch, 'Nothing on the watch list.'),
    renderInsightCard('Critical Issues', '❌', exec.critical, 'No critical issues detected.'),
  ];

  const footer = {
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `_Source: \`an_operational_dash\` (BigQuery) · 🤖 KPI Bot_` },
    ],
  };

  return {
    text: `Kinedu Weekly KPIs (${current.label})`,
    blocks: [header, ctx, { type: 'divider' }, kpiBlock, ...explBlocks, ...execBlocks, footer],
  };
}
