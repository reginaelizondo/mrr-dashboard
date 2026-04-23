/**
 * Post a message to the Slack incoming webhook.
 * Webhook URL is per-channel; this one is bound to #datastudiobot.
 */

interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export interface SlackMessage {
  text: string; // fallback text used in notifications
  blocks?: SlackBlock[];
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
