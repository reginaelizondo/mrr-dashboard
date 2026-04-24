import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { verifySlackSignature } from '@/lib/slack/verify';
import { nlToSql, NlToSqlError, type NlQueryResult } from '@/lib/kpi/nl-to-sql';
import { validateAndHardenSql } from '@/lib/kpi/sql-safety';
import { getBigQueryClient, KINEDU_OPERATIONAL_TABLE } from '@/lib/bigquery/client';
import { queryMixpanel } from '@/lib/mixpanel/client';
import { createBotBookmark } from '@/lib/mixpanel/insights';
import { formatResultAsSlack, formatErrorAsSlack, FormattedResponse } from '@/lib/slack/format-result';
import type { SlackMessage } from '@/lib/slack/post';

// Slash command flow:
//   1. Verify signature; ack immediately in-channel ("Working on it…")
//   2. In waitUntil background: run NL→SQL → BigQuery → format
//   3. Post final answer via chat.postMessage (so we can thread the SQL)
//   4. If chat.postMessage fails for any reason, fall back to response_url
//      so the user still gets an answer (non-threaded).

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');

  const ok = verifySlackSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET ?? '',
    timestamp,
    signature,
    rawBody,
  });
  if (!ok) {
    return new NextResponse('Invalid signature', { status: 401 });
  }

  const params = new URLSearchParams(rawBody);
  const rawText = (params.get('text') ?? '').trim();
  const channelId = params.get('channel_id');
  const responseUrl = params.get('response_url');
  const userName = params.get('user_name') ?? 'someone';

  // Strip optional `--sql` flag from the question. If present, post the
  // generated SQL as a threaded reply; otherwise keep the channel clean.
  const showSqlRequested = /\s--sql\b/i.test(rawText) || /^--sql\s/i.test(rawText);
  const text = rawText.replace(/\s?--sql\b/ig, '').trim();

  if (!channelId || !responseUrl) {
    return NextResponse.json({ response_type: 'ephemeral', text: 'Missing channel_id or response_url.' });
  }

  if (!text) {
    return NextResponse.json({
      response_type: 'ephemeral',
      text: 'Ask a KPI question. Example: `/kpi CAC last week by platform`',
    });
  }

  waitUntil(
    (async () => {
      try {
        const response = await runKpiQuery(text);
        await deliverResponse({ channelId, responseUrl, response, showSql: showSqlRequested });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[slack-bot] runKpiQuery threw:', message);
        await deliverResponse({
          channelId,
          responseUrl,
          response: formatErrorAsSlack({ question: text, error: `Unexpected: ${message}` }),
          showSql: showSqlRequested,
        });
      }
    })()
  );

  return NextResponse.json({
    response_type: 'in_channel',
    text: `🤖 *${userName}* asked:  _${text.slice(0, 200)}_\n_Working on it…_`,
  });
}

async function runKpiQuery(question: string): Promise<FormattedResponse> {
  let nl: NlQueryResult;
  try {
    nl = await nlToSql(question);
  } catch (err) {
    if (err instanceof NlToSqlError) {
      return formatErrorAsSlack({ question, error: err.message });
    }
    throw err;
  }

  if (nl.source === 'mixpanel') {
    return runMixpanelQuery(question, nl);
  }
  return runBigQueryQuery(question, nl);
}

async function runBigQueryQuery(
  question: string,
  nl: Extract<NlQueryResult, { source: 'bigquery' }>
): Promise<FormattedResponse> {
  const safe = validateAndHardenSql(nl.sql);
  if (!safe.ok) {
    return formatErrorAsSlack({
      question,
      error: `Generated SQL failed safety check: ${safe.error}`,
      sql: nl.sql,
    });
  }

  void KINEDU_OPERATIONAL_TABLE;

  const bq = getBigQueryClient();
  let rows: Record<string, unknown>[];
  try {
    const queryResult = await bq.query({ query: safe.sql, jobTimeoutMs: 25000 });
    rows = queryResult[0] as Record<string, unknown>[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return formatErrorAsSlack({ question, error: `BigQuery error: ${msg}`, sql: safe.sql });
  }

  return formatResultAsSlack({
    title: `${nl.title}  _(BigQuery)_`,
    explanation: nl.explanation,
    question,
    sql: safe.sql,
    rows: rows as Record<string, string | number | boolean | null | undefined | { value: string }>[],
    sourceLabel: '`an_operational_dash` (BigQuery)',
    detailsLabel: 'Generated SQL',
  });
}

async function runMixpanelQuery(
  question: string,
  nl: Extract<NlQueryResult, { source: 'mixpanel' }>
): Promise<FormattedResponse> {
  const queryParams = {
    event: nl.event,
    measure: nl.measure,
    fromDate: nl.fromDate,
    toDate: nl.toDate,
    unit: nl.unit,
    breakdown: nl.breakdown,
  };

  let rows;
  try {
    rows = await queryMixpanel(queryParams);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return formatErrorAsSlack({ question, error: `Mixpanel error: ${msg}` });
  }

  // Create an interactive Mixpanel bookmark in parallel with formatting. If
  // this fails (bad network, permissions, etc.), we still return the Slack
  // answer — the link is a nice-to-have, not a blocker.
  let interactiveUrl: string | undefined;
  try {
    const bookmark = await createBotBookmark({ query: queryParams, title: nl.title, question });
    interactiveUrl = bookmark.url;
  } catch (err) {
    console.error('[slack-bot] createBotBookmark failed:', err instanceof Error ? err.message : err);
  }

  const breakdownBadge = nl.breakdown ? `, by ${nl.breakdown}` : '';
  const pseudoSql = `Mixpanel /api/query/${nl.breakdown ? 'segmentation' : 'events'}
event: ${nl.event}
measure: ${nl.measure}  (unit: ${nl.unit})
range: ${nl.fromDate} → ${nl.toDate}${breakdownBadge}`;

  return formatResultAsSlack({
    title: `${nl.title}  _(Mixpanel)_`,
    explanation: nl.explanation,
    question,
    sql: pseudoSql,
    rows: rows as Record<string, string | number | boolean | null | undefined | { value: string }>[],
    sourceLabel: `Mixpanel · \`${nl.event}\``,
    detailsLabel: 'Mixpanel query',
    interactiveUrl,
    interactiveLabel: '🔍 Open in Mixpanel',
  });
}

async function deliverResponse(args: {
  channelId: string;
  responseUrl: string;
  response: FormattedResponse;
  showSql: boolean;
}): Promise<void> {
  const { channelId, responseUrl, response, showSql } = args;
  const token = process.env.SLACK_BOT_TOKEN;

  // Primary path: chat.postMessage. When showSql is true, post the generated
  // SQL as a threaded reply. Default is keep the channel clean.
  if (token) {
    const mainRes = await postChatMessage(token, channelId, response.main);
    if (mainRes.ok) {
      if (showSql && response.sql && mainRes.ts) {
        const sqlRes = await postChatMessage(token, channelId, response.sql, mainRes.ts);
        if (!sqlRes.ok) console.error('[slack-bot] thread SQL postMessage failed:', sqlRes.error);
      }
      return;
    }
    console.error('[slack-bot] primary chat.postMessage failed:', mainRes.error);
  }

  // Fallback: response_url. Inline the SQL only if the caller asked for it.
  console.error('[slack-bot] falling back to response_url');
  const inlineBlocks = [
    ...(response.main.blocks ?? []),
    ...(showSql && response.sql ? response.sql.blocks ?? [] : []),
  ];
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      response_type: 'in_channel',
      text: response.main.text,
      blocks: inlineBlocks,
    }),
  }).catch(e => console.error('[slack-bot] response_url fallback failed:', e));
}

interface PostMessageResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

async function postChatMessage(
  token: string,
  channel: string,
  message: SlackMessage,
  threadTs?: string
): Promise<PostMessageResult> {
  const body: Record<string, unknown> = { channel, text: message.text, blocks: message.blocks };
  if (threadTs) body.thread_ts = threadTs;

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      return { ok: false, error: json.error || `HTTP ${res.status}` };
    }
    return { ok: true, ts: json.ts };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
