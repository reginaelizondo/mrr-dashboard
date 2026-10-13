/**
 * Slack delivery.
 *  - postToSlack: incoming webhook (bound to #datastudiobot). One message, no threads.
 *  - postWithThread: bot token + channel id → main message, then replies in a thread.
 *    Falls back to the webhook (everything in one message) if the bot path is not
 *    configured or fails, so a brief never goes missing because of Slack plumbing.
 */

interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export interface SlackMessage {
  text: string; // fallback text used in notifications
  blocks?: SlackBlock[];
}

export interface ThreadedPost {
  main: SlackMessage;
  thread: SlackMessage[];
}

export async function postToSlack(message: SlackMessage): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) throw new Error('SLACK_WEBHOOK_URL env var not set');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
  const body = await res.text();
  if (!res.ok || body !== 'ok') {
    throw new Error(`Slack webhook failed (${res.status}): ${body}`);
  }
}

interface PostResult { ok: boolean; ts?: string; error?: string }

/** chat.postMessage with the bot token; threadTs makes it a reply. */
export async function postChatMessage(
  token: string,
  channel: string,
  message: SlackMessage,
  threadTs?: string
): Promise<PostResult> {
  const body: Record<string, unknown> = { channel, text: message.text, blocks: message.blocks, unfurl_links: false };
  if (threadTs) body.thread_ts = threadTs;
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) return { ok: false, error: json.error || `HTTP ${res.status}` };
    return { ok: true, ts: json.ts };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Flatten main + thread into one webhook message (fallback path). */
function mergeForWebhook(post: ThreadedPost): SlackMessage {
  const blocks: SlackBlock[] = [...(post.main.blocks ?? [])];
  for (const m of post.thread) {
    blocks.push({ type: 'divider' });
    blocks.push(...(m.blocks ?? []));
  }
  return { text: post.main.text, blocks: blocks.slice(0, 50) };
}

export async function postWithThread(post: ThreadedPost): Promise<{ via: 'bot' | 'webhook'; ts?: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_BRIEF_CHANNEL;
  if (token && channel) {
    const main = await postChatMessage(token, channel, post.main);
    if (main.ok && main.ts) {
      for (const m of post.thread) {
        const r = await postChatMessage(token, channel, m, main.ts);
        if (!r.ok) console.error('[slack] thread reply failed:', r.error);
      }
      return { via: 'bot', ts: main.ts };
    }
    console.error('[slack] bot post failed, falling back to webhook:', main.error);
  }
  await postToSlack(mergeForWebhook(post));
  return { via: 'webhook' };
}
