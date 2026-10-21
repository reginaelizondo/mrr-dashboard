/**
 * Slack delivery.
 *  - postToSlack: incoming webhook (bound to #datastudiobot). One message, no threads.
 *  - postWithThread: bot token + channel id → main message, then replies in a thread.
 *    Default channel = SLACK_BRIEF_CHANNEL (calendar brief). The cohort brief passes
 *    SLACK_COHORT_CHANNEL and turns the webhook fallback off, so it never lands in
 *    the calendar channel. With the fallback on, a failed bot post goes to the webhook
 *    (everything in one message), so a brief never goes missing because of Slack plumbing.
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
  /**
   * Imágenes (PNG). Si `blocks` trae bloques `{ type: 'image', _file: i }`, la imagen i va DENTRO del mensaje
   * (se sube primero sin compartir y se referencia con `slack_file`). Si no, se suben al hilo después del mensaje
   * con `filesComment` como texto. Solo por el bot.
   */
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

const isImagePlaceholder = (b: SlackBlock) => b.type === 'image' && typeof b._file === 'number';

/** Sube archivos sin compartirlos en ningún canal; devuelve sus ids (para bloques `image` con `slack_file`). */
async function uploadPrivate(token: string, files: SlackFile[]): Promise<string[] | null> {
  const ids: string[] = [];
  for (const f of files) {
    const u = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ filename: f.filename, length: String(f.data.byteLength) }),
    }).then((x) => x.json()).catch(() => null);
    if (!u?.ok) { console.error('[slack] getUploadURLExternal:', u?.error); return null; }
    const put = await fetch(u.upload_url, { method: 'POST', body: new Blob([f.data as BlobPart], { type: 'image/png' }) }).catch(() => null);
    if (!put?.ok) return null;
    ids.push(u.file_id);
  }
  const done = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ files: ids.map((id, i) => ({ id, title: files[i].title })) }),
  }).then((x) => x.json()).catch(() => null);
  if (!done?.ok) { console.error('[slack] completeUploadExternal:', done?.error); return null; }
  return ids;
}

/**
 * Publica un mensaje con imágenes dentro (bloques `image` con `_file`). Slack tarda unos segundos en procesar el
 * archivo ("invalid slack file"), así que se reintenta; si no se puede subir, el mensaje sale sin las imágenes.
 */
async function postWithImages(token: string, channel: string, message: SlackMessage, threadTs?: string): Promise<PostResult> {
  const blocks = message.blocks ?? [];
  const ids = message.files?.length ? await uploadPrivate(token, message.files) : null;
  const withImages = ids
    ? blocks.map((b) => (isImagePlaceholder(b) ? (({ _file, ...rest }) => ({ ...rest, slack_file: { id: ids[_file as number] } }))(b) : b))
    : blocks.filter((b) => !isImagePlaceholder(b));
  let r: PostResult = { ok: false };
  for (let i = 0; i < 6; i++) {
    r = await postChatMessage(token, channel, { ...message, blocks: withImages }, threadTs);
    if (r.ok || !ids || !/invalid_blocks/.test(r.error ?? '')) break;
    await new Promise((res) => setTimeout(res, 2500));
  }
  if (!r.ok && ids) {
    console.error('[slack] mensaje con imágenes falló, se manda sin ellas:', r.error);
    r = await postChatMessage(token, channel, { ...message, blocks: blocks.filter((b) => !isImagePlaceholder(b)) }, threadTs);
  }
  return r;
}

/** Flatten main + thread into one webhook message (fallback path). */
function mergeForWebhook(post: ThreadedPost): SlackMessage {
  const blocks: SlackBlock[] = [...(post.main.blocks ?? [])];
  for (const m of post.thread) {
    blocks.push({ type: 'divider' });
    blocks.push(...(m.blocks ?? []));
  }
  return { text: post.main.text, blocks: degradeTables(blocks.filter((b) => !isImagePlaceholder(b))).slice(0, 50) };
}

export interface PostOptions {
  /** Canal de destino (id). Default: SLACK_BRIEF_CHANNEL. */
  channel?: string;
  /** Si el bot falla, mandar todo por el webhook (#datastudiobot). Default: true. */
  webhookFallback?: boolean;
}

export async function postWithThread(post: ThreadedPost, opts: PostOptions = {}): Promise<{ via: 'bot' | 'webhook'; ts?: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = opts.channel ?? process.env.SLACK_BRIEF_CHANNEL;
  if (token && channel) {
    const inline = (m: SlackMessage) => !!m.files?.length && !!m.blocks?.some(isImagePlaceholder);
    const main = inline(post.main) ? await postWithImages(token, channel, post.main) : await postChatMessage(token, channel, post.main);
    if (main.ok && main.ts) {
      for (const m of post.thread) {
        if (inline(m)) {
          const r = await postWithImages(token, channel, m, main.ts);
          if (!r.ok) console.error('[slack] thread reply failed:', r.error);
          continue;
        }
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
    if (opts.webhookFallback === false) throw new Error(`Slack bot post failed (${channel}): ${main.error}`);
    console.error('[slack] bot post failed, falling back to webhook:', main.error);
  } else if (opts.webhookFallback === false) {
    throw new Error('SLACK_BOT_TOKEN or channel not set');
  }
  await postToSlack(mergeForWebhook(post));
  return { via: 'webhook' };
}
