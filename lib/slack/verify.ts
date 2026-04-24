import crypto from 'crypto';

/**
 * Verify a Slack request using the v0 HMAC-SHA256 signing scheme.
 * See https://api.slack.com/authentication/verifying-requests-from-slack.
 *
 * Pass the raw request body (string, exactly as received — not re-serialized)
 * and the two headers from the incoming request.
 */
export function verifySlackSignature(args: {
  signingSecret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
}): boolean {
  const { signingSecret, timestamp, signature, rawBody } = args;
  if (!signingSecret || !timestamp || !signature) return false;

  // Reject replays older than 5 minutes
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 300) return false;

  const basestring = `v0:${timestamp}:${rawBody}`;
  const computed =
    'v0=' + crypto.createHmac('sha256', signingSecret).update(basestring).digest('hex');

  // Constant-time compare. Length must match for timingSafeEqual.
  const a = Buffer.from(computed);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
