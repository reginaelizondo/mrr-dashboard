/**
 * Slack delivery.
 *  - postToSlack: incoming webhook (bound to #datastudiobot). One message, no threads.
 *  - postWithThread: bot token + channel id → main message, then replies in a thread.
 *    Falls back to the webhook (everything in one message) if the bot path is not
 *    configured or fails, so a brief never goes missing because of Slack plumbing.
 */

import { cleanTables, degradeTables } from './table';

interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export interface SlackFile {
  filename: string;
  title: string;
  data: Uint8Array;
}

export interface SlackMessage {
  text: string; // fallback text used in notifications
  blocks?: SlackBlock[];
  /** Imágenes (PNG) que se suben al hilo después de este mensaje, con `filesComment` como texto. Solo por el bot. */
  files?: SlackFile[];
  filesComment?: string;
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
  const send = async (blocks: SlackBlock[] | undefined): Promise<PostResult> => {
    const body: Record<string, unknown> = { channel, text: message.text, blocks, unfurl_links: false };
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
  };
  const blocks = message.blocks;
  const hasTable = !!blocks?.some((b) => b.type === 'table');
  const r = await send(blocks ? cleanTables(blocks) : undefined);
  // Si Slack no acepta el bloque de tabla, se reintenta con la tabla en texto monoespaciado.
  if (!r.ok && hasTable && /invalid_blocks|invalid_attachments/.test(r.error ?? '')) return send(degradeTables(blocks!));
  return r;
}

/**
 * Sube imágenes a un canal (en el hilo `threadTs` si se da) con el flujo actual de Slack:
 * files.getUploadURLExternal → POST de los bytes → files.completeUploadExternal. Requiere `files:write`.
 */
export async function uploadFiles(token: string, channel: string, files: SlackFile[], comment?: string, threadTs?: string): Promise<PostResult> {
  try {
    const uploaded: { id: string; title: string }[] = [];
    for (const f of files) {
      const form = new URLSearchParams({ filename: f.filename, length: String(f.data.byteLength) });
      const u = await fetch('https://slack.com/api/files.getUploadURLExternal', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
      }).then((x) => x.json());
      if (!u.ok) return { ok: false, error: `getUploadURLExternal: ${u.error}` };
      const put = await fetch(u.upload_url, { method: 'POST', body: new Blob([f.data as BlobPart], { type: 'image/png' }) });
      if (!put.ok) return { ok: false, error: `upload HTTP ${put.status}` };
      uploaded.push({ id: u.file_id, title: f.title });
    }
    const body: Record<string, unknown> = { files: uploaded, channel_id: channel };
    if (comment) body.initial_comment = comment;
    if (threadTs) body.thread_ts = threadTs;
    const done = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body),
    }).then((x) => x.json());
    return done.ok ? { ok: true } : { ok: false, error: `completeUploadExternal: ${done.error}` };
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
  return { text: post.main.text, blocks: degradeTables(blocks).slice(0, 50) };
}

export async function postWithThread(post: ThreadedPost): Promise<{ via: 'bot' | 'webhook'; ts?: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_BRIEF_CHANNEL;
  if (token && channel) {
    const main = await postChatMessage(token, channel, post.main);
    if (main.ok && main.ts) {
      for (const m of post.thread) {
        if (m.blocks?.length) {
          const r = await postChatMessage(token, channel, m, main.ts);
          if (!r.ok) console.error('[slack] thread reply failed:', r.error);
        }
        if (m.files?.length) {
          const f = await uploadFiles(token, channel, m.files, m.filesComment, main.ts);
          // Slack comparte el archivo de forma asíncrona: se espera para que el hilo conserve el orden.
          if (f.ok) await new Promise((res) => setTimeout(res, 6000));
          // Sin imagen (p. ej. falta files:write), al menos van los enlaces.
          if (!f.ok) {
            console.error('[slack] image upload failed:', f.error);
            if (m.filesComment) await postChatMessage(token, channel, { text: m.filesComment }, main.ts);
          }
        }
      }
      return { via: 'bot', ts: main.ts };
    }
    console.error('[slack] bot post failed, falling back to webhook:', main.error);
  }
  await postToSlack(mergeForWebhook(post));
  return { via: 'webhook' };
}
