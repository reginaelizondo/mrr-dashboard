import Anthropic from '@anthropic-ai/sdk';
import { KPI_SQL } from './formulas';
import { MIXPANEL_EVENTS, EVENT_HINTS, isKnownMixpanelEvent } from '@/lib/mixpanel/events-catalog';
import { USER_PROPERTIES, EVENT_PROPERTIES, PROPERTY_ALIASES, isKnownProperty } from '@/lib/mixpanel/properties-catalog';
import type { MixpanelMeasure, MixpanelUnit } from '@/lib/mixpanel/client';

/**
 * Convert a natural-language question about KPIs into BigQuery SQL + a short
 * explanation the user will see in the Slack reply.
 *
 * Uses Claude Haiku 4.5 (cheap + fast). Uses structured tool output to get
 * reliable JSON back. The schema + validated KPI formulas are injected into
 * the system prompt so Claude reuses the exact formulas the weekly report uses.
 */

const MODEL = 'claude-haiku-4-5-20251001';

export interface NlBigQueryResult {
  source: 'bigquery';
  sql: string;          // executable BigQuery SQL
  explanation: string;  // one-line plain-English description to show user
  title: string;        // short header for the Slack message
}

export interface NlMixpanelResult {
  source: 'mixpanel';
  event: string;
  measure: MixpanelMeasure;    // 'unique' (users) | 'general' (events)
  fromDate: string;            // YYYY-MM-DD
  toDate: string;              // YYYY-MM-DD
  unit: MixpanelUnit;          // 'day' | 'week' | 'month'
  breakdown?: string;
  explanation: string;
  title: string;
}

export type NlQueryResult = NlBigQueryResult | NlMixpanelResult;

/** @deprecated kept for backward compat — use NlQueryResult discriminated union. */
export type NlToSqlResult = NlBigQueryResult;

// Compact column reference. Keep this list tight — every token costs.
const SCHEMA_CONTEXT = `
Table (fully-qualified, use backticks): \`celtic-music-240111.dbt_prod_analytics.an_operational_dash\`

Columns (grouped for clarity — reference by bare name in SQL):

DIMENSIONS:
- date           DATE       (only field to filter time; range 2013-09-19 to today)
- os             STRING     values: 'iOS','Android','Web','Unknown', or null
- network        STRING     values: 'Facebook','Google','Apple Search Ads','TikTok For Business - Android','TikTok For Business - SAN','Tiktok','Dipperads - Android','Smartlinks','Organics','stripe', null
- payment_processor STRING  values: 'apple','google','stripe','paypal','learnworlds','Web','Unknown','other_sales'
- country        STRING     ISO-2 codes ('US','MX','BR','AR', ...)
- kinedu_region  STRING     values: 'US & CA','Latin America and the Caribbean','Brazil','Europe','Asia Pacific','Africa, Middle East, and India','Other','All Countries or Regions', null
- kinedu_language STRING    values: 'en','es','pt', null
- product        STRING     Kinedu product tier
- plan_type      STRING     e.g. 'monthly','yearly'

FUNNEL / ACQUISITION MEASURES:
- signups                    INT64    signups that day
- fts_started                INT64    free trials started
- fts_converted              INT64    free trials that converted to paid
- impressions                FLOAT64  ad impressions
- clicks                     FLOAT64  ad clicks
- downloads                  INT64
- spend                      FLOAT64  USD ad spend
- total_spend_retargeting    FLOAT64
- signups_retargeting        INT64

REVENUE MEASURES (all USD, stored NET of refunds):
- new_subscriptions          INT64    new-sub count (net of refunds)
- new_subscriptions_sales    FLOAT64  new-sub revenue (net)
- renewals                   INT64    renewal count (net)
- renewals_sales             FLOAT64  renewal revenue (net, ex yearly iOS)
- renewals_yearly_ios        INT64    yearly iOS renewals count
- renewals_sales_yearly_ios  FLOAT64  yearly iOS renewal revenue (broken out because commission differs)
- other_sales                FLOAT64  non-subscription sales (Stripe/Shopify/LearnWorlds)
- other_purchases            INT64    count for other_sales

REFUNDS (two attribution methods):
- refunds_total_amount_sale_date    NUMERIC   refunds attributed to month of original sale
- num_of_refunds_sale_date          INT64     count, sale-date attribution
- refunds_total_amount_refund_date  NUMERIC   refunds attributed to month refund was issued
- num_of_refunds_refund_date        INT64     count, refund-date attribution
- refunds_total_amount_sale_date_ft_conv, num_of_refunds_sale_date_ft_conv  — same, scoped to FT-conversion subs
- refunds_total_amount_refund_date_ft_conv, num_of_refunds_refund_date_ft_conv — same
`;

// Hand-curated list of validated formulas — Claude MUST use these expressions
// verbatim when the user asks for one of these KPIs. Source of truth is
// lib/kpi/formulas.ts (KPI_SQL).
const KPI_REGISTRY = `
Validated KPI formulas — USE THESE VERBATIM when the user asks for a named KPI.
Do NOT reinvent them. All fields should be aggregated via SUM inside these
expressions as shown.

- New Subscriptions (gross):         ${KPI_SQL.newSubs}
- NS Sales / New Subs Sales (gross): ${KPI_SQL.nsSales}
- Spend:                              ${KPI_SQL.spend}
- Signups:                            ${KPI_SQL.signups}
- CAC:                                ${KPI_SQL.cac}
- Conversion Rate:                    ${KPI_SQL.conversionRate}
- ARPU:                               ${KPI_SQL.arpu}
- 1st Ticket / CAC (ratio):           ${KPI_SQL.firstTicketCac}
    (aliases: "ARPU / CAC", "ARPU sobre CAC", "ARPU over CAC", "1st Ticket sobre CAC",
     "1st ticket / CAC", "first ticket ratio", "first-purchase payback", and any
     derivative phrasing — ALL mean the same firstTicketCac formula)
- Total Renewal Sales:                ${KPI_SQL.totalRenewalSales}
- Total Sales:                        ${KPI_SQL.totalSales}
- Net Sales (refactor, yearly iOS):   ${KPI_SQL.netSales}

Notes on semantics:
- new_subscriptions / new_subscriptions_sales are stored NET of refunds. To get
  GROSS new subs, add back num_of_refunds_sale_date / refunds_total_amount_sale_date.
- _sale_date refunds: attributed to original sale month (add back for gross comparisons)
- _refund_date refunds: attributed to month refund was issued (point-in-time impact)
- When user says "revenue" with no qualifier, prefer Net Sales.
- When user says "sales" with no qualifier, prefer Total Sales.
- When user says "conversions" or "conversion", interpret as Conversion Rate unless context says count.
`;

const SAFETY_RULES = `
HARD RULES for the SQL:
1. Use ONLY the table \`celtic-music-240111.dbt_prod_analytics.an_operational_dash\`. No CTEs that reference other tables.
2. SELECT or WITH only. Never write INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/MERGE/TRUNCATE/GRANT/REVOKE/EXECUTE/CALL.
3. Always include a \`date\` filter. Use \`date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'\`.
4. Max date range: 400 days. For "last week"/"last 7 days" type questions, compute concrete dates — do NOT use CURRENT_DATE(), because the analyst's "today" is the CURRENT_DATE from the user's perspective (${new Date().toISOString().slice(0, 10)}).
5. Add LIMIT 100 if the query might return many rows. Aggregates that return 1 row don't need LIMIT.
6. Use backticks around the table, not around bare column names.
7. Use SAFE_DIVIDE instead of / to avoid divide-by-zero.
8. For breakdowns, GROUP BY the dimension and ORDER BY the main metric DESC.
9. Filter out noise buckets (os='Unknown', kinedu_region IS NULL, etc.) only if user asks for "by platform" / "by region" — they're real rows, just usually not useful.
10. Output a single statement, no trailing semicolon.

For relative time:
- "yesterday" / "ayer"       → today - 1 (single day, use date BETWEEN with both endpoints equal)
- "today" / "hoy"            → today (single day, data may be partial; note this in explanation)
- "last week" / "semana pasada" → the most recent complete Mon-Sun before today
- "this week" / "esta semana"   → Mon of the current week through today (inclusive)
- "last 7 days" / "últimos 7 días" → today - 7 through today - 1 (exclude today, data may be partial)
- "last month" / "mes pasado"   → the most recent complete calendar month
- Today's date for reference: ${new Date().toISOString().slice(0, 10)}
`;

const EXAMPLES = `
EXAMPLES (learn the style):

Q: "CAC last week by platform"
A sql:
  SELECT
    os AS platform,
    SAFE_DIVIDE(SUM(spend), SUM(new_subscriptions) + SUM(num_of_refunds_sale_date)) AS cac,
    SUM(spend) AS spend,
    SUM(new_subscriptions) + SUM(num_of_refunds_sale_date) AS new_subs
  FROM \`celtic-music-240111.dbt_prod_analytics.an_operational_dash\`
  WHERE date BETWEEN 'LAST_MON' AND 'LAST_SUN'
    AND os IN ('iOS','Android','Web')
  GROUP BY os
  ORDER BY cac ASC
A title: "CAC by platform, last week"
A explanation: "CAC per iOS/Android/Web for the most recent complete Mon-Sun week."

Q: "top 5 countries by net new subscriptions this month"
A sql:
  SELECT
    country,
    SUM(new_subscriptions) + SUM(num_of_refunds_sale_date) AS new_subs_gross
  FROM \`celtic-music-240111.dbt_prod_analytics.an_operational_dash\`
  WHERE date BETWEEN 'FIRST_OF_MONTH' AND 'TODAY'
    AND country IS NOT NULL
  GROUP BY country
  ORDER BY new_subs_gross DESC
  LIMIT 5
A title: "Top 5 countries by new subscriptions, MTD"
A explanation: "Month-to-date new subscription count by country, top 5."

Q: "ARPU last 30 days for Facebook ads"
A sql:
  SELECT
    SAFE_DIVIDE(
      SUM(new_subscriptions_sales) + SUM(refunds_total_amount_sale_date) + SUM(other_sales),
      SUM(new_subscriptions) + SUM(num_of_refunds_sale_date) + SUM(other_purchases)
    ) AS arpu
  FROM \`celtic-music-240111.dbt_prod_analytics.an_operational_dash\`
  WHERE date BETWEEN 'D30_AGO' AND 'YESTERDAY'
    AND network = 'Facebook'
A title: "ARPU — Facebook, last 30 days"
A explanation: "Average revenue per acquisition for Facebook-attributed subs, last 30 days."
`;

const MIXPANEL_EVENT_LINES = MIXPANEL_EVENTS.map((name) => {
  const hint = EVENT_HINTS[name];
  return hint ? `- ${name}  — ${hint}` : `- ${name}`;
}).join('\n');

const MIXPANEL_CONTEXT = `
Mixpanel (event-level data) — use ONLY for product/behavior questions NOT answerable from BigQuery.

Available events (EXACT names — pick verbatim; do not invent):
${MIXPANEL_EVENT_LINES}

Measure:
- "unique"  → unique users who triggered the event (use for "how many users…", "DAU", conversion counts)
- "general" → total number of event occurrences (use for "how many times…", engagement volume)

Unit: day | week | month (pick the coarsest unit that still answers the question; "ayer"/"yesterday" → unit=day, 1-day range).
Today's date for reference: ${new Date().toISOString().slice(0, 10)}.
Date range MUST be absolute (YYYY-MM-DD), max 90 days, and must not exceed today.

DEFAULT TIME RANGE — if the user does NOT specify a time window, use the last 30 complete days: from_date = today - 30, to_date = today - 1 (exclude today because data is partial). NEVER default to a single day unless the user explicitly says "hoy"/"today"/"ayer"/"yesterday" or gives a specific date. For breakdowns (e.g. "por plan"), unit=day over 30 days is usually overkill — prefer unit=month if range ≥60 days, unit=week if 14-60 days, unit=day if <14 days.

Breakdown property (optional) — ONLY use names from this closed catalog. Numbers match the Mixpanel UI because we default to event-level (super-properties).

EVENT-LEVEL properties (stamped on events, matches Mixpanel UI default):
${EVENT_PROPERTIES.map((p) => `  - ${p}`).join('\n')}

USER-ONLY properties (only use these if the user explicitly wants profile-level grouping):
${USER_PROPERTIES.map((p) => `  - ${p}`).join('\n')}

Natural-language → property mapping (use these mappings when the user asks in Spanish or English):
${Object.entries(PROPERTY_ALIASES).map(([phrase, prop]) => `  - ${phrase}  →  ${prop}`).join('\n')}

Rules:
- If the user asks for a breakdown, ALWAYS pick the EVENT-level property from the catalog unless they explicitly say "user profile".
- "por idioma" / "by language" → breakdown=kineduLanguage (values: 'en','es','pt','(none)')
- "por país" / "by country" → breakdown=kineduCountry (or mp_country_code if they say "detected" or "auto")
- "por plan" → breakdown=planType
- "por platform" / "por SO" / "by platform" → breakdown=$os (values: iOS / Android / Web / Unknown)
- If the requested breakdown dimension is NOT in the catalog above, OMIT the breakdown and mention the limitation in the explanation — do NOT invent a property name.
`;

const SOURCE_CHOICE = `
CHOOSING THE DATA SOURCE — pick EXACTLY ONE tool:

Use \`sql_answer\` (BigQuery) when the question is about:
- Revenue, sales, MRR, ARPU, refunds, CAC, spend, gross margin, commission
- Plan duration, platform (iOS/Android/Web), region/country, network/acquisition channel breakdowns of financial KPIs
- Historical trends of financial metrics (week-over-week, month-over-month)

Use \`mixpanel_answer\` when the question is about:
- Product events: signups (OBCreateUser), free trials (FreeTrialStart/Converted/Canceled), cancellations (CancelSubscription), app opens (OpenApp), activity views (ActivityView), paywall views (S_SWPaywall), etc.
- Unique users who did X (DAU/MAU-style counts)
- Event counts over a date range

Use \`cannot_answer\` only when neither source can produce the answer (e.g. individual user lookups, NPS scores, content titles).

If a question could plausibly use either source, prefer BigQuery for monetary KPIs and Mixpanel for user-behavior counts.
`;

const SYSTEM_PROMPT = `You translate questions about Kinedu's KPIs into one of two data sources: BigQuery SQL (financial/operational KPIs) or Mixpanel Query API parameters (product events).

${SCHEMA_CONTEXT}

${KPI_REGISTRY}

${SAFETY_RULES}

${EXAMPLES}

${MIXPANEL_CONTEXT}

${SOURCE_CHOICE}

When you respond:
- BigQuery questions → use \`sql_answer\` with: sql (one statement, no trailing ;), title (<50 chars), explanation (<140 chars).
- Mixpanel questions → use \`mixpanel_answer\` with: event (from catalog), measure, fromDate, toDate, unit, optional breakdown, title, explanation.
- Unanswerable → use \`cannot_answer\` with a short reason.`;

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'sql_answer',
    description: 'Answer from BigQuery. Use for revenue, ARPU, CAC, refunds, spend, sales breakdowns by platform/region/network — anything in the operational KPI table.',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'BigQuery SQL, single statement, no trailing semicolon.' },
        title: { type: 'string', description: 'Short noun-phrase summarizing the question.' },
        explanation: { type: 'string', description: 'One-sentence plain-English description of what the result shows.' },
      },
      required: ['sql', 'title', 'explanation'],
    },
  },
  {
    name: 'mixpanel_answer',
    description: 'Answer from Mixpanel. Use for product-event questions (signups, free trials, app opens, activity views, cancellations, paywall views, etc.) — counts of users or events over a date range.',
    input_schema: {
      type: 'object',
      properties: {
        event: {
          type: 'string',
          enum: [...MIXPANEL_EVENTS] as string[],
          description: 'Exact Mixpanel event name from the catalog. Do not invent.',
        },
        measure: {
          type: 'string',
          enum: ['unique', 'general'],
          description: '"unique" = unique users. "general" = total event count.',
        },
        fromDate: { type: 'string', description: 'YYYY-MM-DD start date (inclusive).' },
        toDate: { type: 'string', description: 'YYYY-MM-DD end date (inclusive). Must not exceed today.' },
        unit: {
          type: 'string',
          enum: ['day', 'week', 'month'],
          description: 'Time bucket for the series.',
        },
        breakdown: {
          type: 'string',
          enum: [...USER_PROPERTIES, ...EVENT_PROPERTIES] as string[],
          description: 'Optional property to segment by. MUST be from the validated catalog (see system prompt). Omit if the user did not ask for a breakdown, or asked for something not in the catalog.',
        },
        title: { type: 'string', description: 'Short noun-phrase summarizing the question (<50 chars).' },
        explanation: { type: 'string', description: 'One-sentence plain-English description (<140 chars).' },
      },
      required: ['event', 'measure', 'fromDate', 'toDate', 'unit', 'title', 'explanation'],
    },
  },
  {
    name: 'cannot_answer',
    description: 'Use when neither BigQuery nor Mixpanel can answer the question.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short explanation of why the question cannot be answered.' },
      },
      required: ['reason'],
    },
  },
];

export class NlToSqlError extends Error {
  constructor(message: string, public userFacing: boolean = true) {
    super(message);
  }
}

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new NlToSqlError('ANTHROPIC_API_KEY not configured.', false);
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

export async function nlToSql(question: string): Promise<NlQueryResult> {
  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: question }],
  });

  const toolUse = res.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
  );
  if (!toolUse) {
    throw new NlToSqlError('Claude did not return a tool call. Try rephrasing.');
  }

  if (toolUse.name === 'cannot_answer') {
    const reason = (toolUse.input as { reason?: string })?.reason ?? 'Cannot answer from the available data.';
    throw new NlToSqlError(reason);
  }

  if (toolUse.name === 'sql_answer') {
    const input = toolUse.input as { sql?: string; title?: string; explanation?: string };
    if (!input.sql || !input.title || !input.explanation) {
      throw new NlToSqlError('Claude returned incomplete SQL response. Try rephrasing.');
    }
    return {
      source: 'bigquery',
      sql: input.sql,
      title: input.title,
      explanation: input.explanation,
    };
  }

  if (toolUse.name === 'mixpanel_answer') {
    const input = toolUse.input as {
      event?: string;
      measure?: MixpanelMeasure;
      fromDate?: string;
      toDate?: string;
      unit?: MixpanelUnit;
      breakdown?: string;
      title?: string;
      explanation?: string;
    };
    if (!input.event || !input.measure || !input.fromDate || !input.toDate || !input.unit || !input.title || !input.explanation) {
      throw new NlToSqlError('Claude returned incomplete Mixpanel response. Try rephrasing.');
    }
    if (!isKnownMixpanelEvent(input.event)) {
      throw new NlToSqlError(`Claude picked an unknown Mixpanel event: "${input.event}". Try rephrasing.`);
    }
    if (input.breakdown && !isKnownProperty(input.breakdown)) {
      throw new NlToSqlError(`Claude picked an unknown Mixpanel property: "${input.breakdown}". Try rephrasing without a breakdown.`);
    }
    // Override the LLM's `unit` choice with one that matches the date range
    // span. With unit=month over a 30-day window, Mixpanel returns calendar-
    // month buckets keyed by month-start; any month-start before fromDate gets
    // dropped from the response, silently losing partial-month data (e.g.
    // Mar 28-31 disappears for a Mar 28 → Apr 26 query). Picking unit by span
    // avoids that whole class of bug.
    const enforcedUnit = pickUnitForRange(input.fromDate, input.toDate);
    return {
      source: 'mixpanel',
      event: input.event,
      measure: input.measure,
      fromDate: input.fromDate,
      toDate: input.toDate,
      unit: enforcedUnit,
      breakdown: input.breakdown,
      title: input.title,
      explanation: input.explanation,
    };
  }

  throw new NlToSqlError(`Claude returned an unexpected tool: ${toolUse.name}.`);
}

/**
 * Pick the Mixpanel time-bucket `unit` that fits the date range without losing
 * data to partial-bucket truncation:
 *   span >= 60 days → month   (≥2 full month buckets fit cleanly)
 *   span 14-60 days → week    (calendar-week buckets, partial weeks are fine)
 *   span < 14 days  → day     (no bucketing concerns)
 *
 * The LLM is told the same rule in the system prompt but doesn't always
 * follow it — enforcing here prevents silent data loss.
 */
function pickUnitForRange(fromDate: string, toDate: string): MixpanelUnit {
  const from = Date.parse(fromDate);
  const to = Date.parse(toDate);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return 'day';
  const days = Math.round((to - from) / 86_400_000) + 1; // inclusive
  if (days >= 60) return 'month';
  if (days >= 14) return 'week';
  return 'day';
}
