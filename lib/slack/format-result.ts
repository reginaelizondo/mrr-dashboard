/**
 * Format a BigQuery result set as two Slack messages:
 *  - `main`: header + explanation + table. Goes in the channel.
 *  - `sql`:  just the generated SQL, posted as a threaded reply so the
 *            channel stays tight but the detail is one click away.
 */

import type { SlackMessage } from './post';

type Cell = string | number | boolean | null | undefined | { value: string };

function toStringCell(v: Cell): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object' && v !== null && 'value' in v) return String(v.value);
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return '—';
    if (!Number.isInteger(v)) return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
    return v.toLocaleString('en-US');
  }
  return String(v);
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

export interface FormattedResponse {
  main: SlackMessage;
  sql: SlackMessage | null;
}

export function formatResultAsSlack(args: {
  title: string;
  explanation: string;
  question: string;
  sql: string;
  rows: Record<string, Cell>[];
  /** Footer label for the data source. Defaults to the BigQuery operational table. */
  sourceLabel?: string;
  /** Label for the details block (defaults to "Generated SQL"). */
  detailsLabel?: string;
  /** Optional URL to open an interactive version of this report (e.g. Mixpanel bookmark). */
  interactiveUrl?: string;
  /** Button text for the interactive link. Defaults to "Open". */
  interactiveLabel?: string;
}): FormattedResponse {
  const { title, explanation, question, sql, rows } = args;
  const sourceLabel = args.sourceLabel ?? '`an_operational_dash`';
  const detailsLabel = args.detailsLabel ?? 'Generated SQL';
  const interactiveUrl = args.interactiveUrl;
  const interactiveLabel = args.interactiveLabel ?? 'Open';

  const blocks: NonNullable<SlackMessage['blocks']> = [
    { type: 'header', text: { type: 'plain_text', text: `📊 ${title.slice(0, 140)}` } },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*Asked:* _${question.slice(0, 300)}_` }],
    },
    { type: 'section', text: { type: 'mrkdwn', text: explanation.slice(0, 500) } },
  ];

  if (rows.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No rows matched._' },
    });
  } else if (rows.length === 1 && Object.keys(rows[0]).length <= 8) {
    const lines = Object.entries(rows[0]).map(([k, v]) => `• *${k}*: \`${toStringCell(v)}\``);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  } else {
    const headers = Object.keys(rows[0]);
    const capped = rows.slice(0, 20);
    const cellStrs = capped.map(r => headers.map(h => toStringCell(r[h])));
    const colWidths = headers.map((h, i) =>
      Math.max(h.length, ...cellStrs.map(r => r[i].length))
    );
    const isNumericCol = headers.map((_, i) =>
      capped.every(r => {
        const v = r[headers[i]];
        return v === null || v === undefined || typeof v === 'number' ||
          (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v));
      })
    );
    const headerRow = headers.map((h, i) =>
      isNumericCol[i] ? padLeft(h, colWidths[i]) : padRight(h, colWidths[i])
    ).join('  ');
    const sepRow = colWidths.map(w => '─'.repeat(w)).join('  ');
    const bodyRows = cellStrs.map(r =>
      r.map((cell, i) => isNumericCol[i] ? padLeft(cell, colWidths[i]) : padRight(cell, colWidths[i])).join('  ')
    );
    const table = [headerRow, sepRow, ...bodyRows].join('\n');
    const footer = rows.length > 20 ? `\n… ${rows.length - 20} more rows truncated` : '';
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '```' + table + footer + '```' },
    });
  }

  if (interactiveUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: interactiveLabel, emoji: true },
          url: interactiveUrl,
          style: 'primary',
        },
      ],
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `_Source: ${sourceLabel} · ${rows.length} row${rows.length === 1 ? '' : 's'}_`,
      },
    ],
  });

  const sqlBlocks: NonNullable<SlackMessage['blocks']> = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${detailsLabel}*\n` + '```' + sql.slice(0, 2800) + '```' },
    },
  ];

  return {
    main: { text: title, blocks },
    sql: { text: detailsLabel, blocks: sqlBlocks },
  };
}

export function formatErrorAsSlack(args: {
  question: string;
  error: string;
  sql?: string;
}): FormattedResponse {
  const { question, error, sql } = args;
  const mainBlocks: NonNullable<SlackMessage['blocks']> = [
    { type: 'header', text: { type: 'plain_text', text: '⚠️  Could not answer' } },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*Asked:* _${question.slice(0, 300)}_` }],
    },
    { type: 'section', text: { type: 'mrkdwn', text: error.slice(0, 1500) } },
  ];

  const main: SlackMessage = { text: `Could not answer: ${error.slice(0, 100)}`, blocks: mainBlocks };
  const sqlMsg: SlackMessage | null = sql
    ? {
        text: 'Generated SQL',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: '*Generated SQL*\n```' + sql.slice(0, 2800) + '```' } },
        ],
      }
    : null;

  return { main, sql: sqlMsg };
}
