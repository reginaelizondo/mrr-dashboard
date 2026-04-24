import { NextRequest, NextResponse } from 'next/server';
import { verifySlackSignature } from '@/lib/slack/verify';

/**
 * /insight slash command.
 *
 * Lets a user share a deep-dive conversation from claude.ai (or similar)
 * as a clean card in the channel. Pattern:
 *     /insight <url> -- <one-line summary>
 * The URL must start with http(s)://. The summary is optional but recommended.
 *
 * We render an in-channel message with the user as the author and a
 * clickable link to the source conversation.
 */

const USAGE = [
  'Usage:  `/insight <url> -- <one-line summary>`',
  '',
  'Example:',
  '> `/insight https://claude.ai/chat/abc123 -- FT conversion dropped 4pp in BR last week — driven by onboarding step 3`',
  '',
  'The URL is usually a shared claude.ai conversation (Share button in claude.ai).',
].join('\n');

function parseCommand(text: string): { url: string; summary: string } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { error: 'Missing URL.\n\n' + USAGE };

  // Split on ` -- ` (first occurrence). Everything before = url, after = summary.
  const sepIdx = trimmed.indexOf(' -- ');
  let url: string;
  let summary: string;
  if (sepIdx === -1) {
    // No summary supplied; first whitespace-delimited token is the URL
    const firstSpace = trimmed.indexOf(' ');
    if (firstSpace === -1) {
      url = trimmed;
      summary = '';
    } else {
      url = trimmed.slice(0, firstSpace);
      summary = trimmed.slice(firstSpace + 1).trim();
    }
  } else {
    url = trimmed.slice(0, sepIdx).trim();
    summary = trimmed.slice(sepIdx + 4).trim();
  }

  // Slack wraps URLs in <...> or <...|label>. Strip those.
  const slackUrlMatch = url.match(/^<([^|>]+)(?:\|[^>]*)?>$/);
  if (slackUrlMatch) url = slackUrlMatch[1];

  if (!/^https?:\/\//i.test(url)) {
    return { error: 'URL must start with `http://` or `https://`.\n\n' + USAGE };
  }

  return { url, summary };
}

function sourceLabel(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith('claude.ai')) return 'claude.ai (Mixpanel deep-dive)';
    if (host.endsWith('anthropic.com')) return 'Anthropic';
    if (host.endsWith('lookerstudio.google.com')) return 'Looker Studio';
    if (host.endsWith('mixpanel.com')) return 'Mixpanel';
    return host.replace(/^www\./, '');
  } catch {
    return 'External source';
  }
}

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
  if (!ok) return new NextResponse('Invalid signature', { status: 401 });

  const params = new URLSearchParams(rawBody);
  const text = params.get('text') ?? '';
  const userName = params.get('user_name') ?? 'someone';

  const parsed = parseCommand(text);
  if ('error' in parsed) {
    return NextResponse.json({ response_type: 'ephemeral', text: parsed.error });
  }

  const { url, summary } = parsed;
  const source = sourceLabel(url);

  const summaryText = summary
    ? `> ${summary}`
    : `> _No summary provided — click the link to read the full analysis._`;

  return NextResponse.json({
    response_type: 'in_channel',
    text: `💡 Insight shared by ${userName}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `💡 Deep dive by ${userName}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: summaryText },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `🔗 <${url}|View full conversation>` },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_Source: ${source}_` }],
      },
    ],
  });
}
