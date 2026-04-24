import { isKnownMixpanelEvent } from './events-catalog';
import { segmentationExprFor, userLevelExprFor, hasUserFallback } from './properties-catalog';

/**
 * Mixpanel Query API client. Uses the Service Account credentials (HTTP Basic
 * auth) against the US region (data.mixpanel.com / mixpanel.com).
 *
 * Auth:  MIXPANEL_SERVICE_USERNAME + MIXPANEL_SERVICE_SECRET
 * Scope: MIXPANEL_PROJECT_ID
 *
 * Endpoints wrapped:
 * - GET /api/query/events         — totals per event, per time unit
 * - GET /api/query/segmentation   — totals broken down by one event property
 *
 * All calls are read-only. The service account is `Consumer` role.
 */

const QUERY_API_BASE = 'https://mixpanel.com/api/query';
const DEFAULT_TIMEOUT_MS = 25_000;

export interface MixpanelCreds {
  username: string;
  secret: string;
  projectId: string;
}

let cached: MixpanelCreds | null = null;

export function getMixpanelCreds(): MixpanelCreds {
  if (cached) return cached;
  const username = process.env.MIXPANEL_SERVICE_USERNAME;
  const secret = process.env.MIXPANEL_SERVICE_SECRET;
  const projectId = process.env.MIXPANEL_PROJECT_ID;
  if (!username || !secret || !projectId) {
    throw new Error(
      'Mixpanel credentials missing. Set MIXPANEL_SERVICE_USERNAME, MIXPANEL_SERVICE_SECRET, MIXPANEL_PROJECT_ID.'
    );
  }
  cached = { username, secret, projectId };
  return cached;
}

export type MixpanelMeasure = 'unique' | 'general';
export type MixpanelUnit = 'day' | 'week' | 'month';

export interface MixpanelQueryParams {
  event: string;
  measure: MixpanelMeasure;
  fromDate: string;  // YYYY-MM-DD
  toDate: string;    // YYYY-MM-DD
  unit: MixpanelUnit;
  breakdown?: string;  // optional event-property name for segmentation
  where?: string;      // optional JQL-style filter expression
}

export interface MixpanelRow {
  event: string;
  date: string;        // period start (YYYY-MM-DD for unit=day)
  value: number;
  breakdown?: string;  // set when segmentation was used
  [k: string]: unknown;
}

interface EventsApiResponse {
  data: {
    series: string[];
    values: Record<string, Record<string, number>>;
  };
}

interface SegmentationApiResponse {
  data: {
    series: string[];
    values: Record<string, Record<string, number>>;  // outer key = breakdown value
  };
}

function authHeader(creds: MixpanelCreds): string {
  const token = Buffer.from(`${creds.username}:${creds.secret}`).toString('base64');
  return `Basic ${token}`;
}

async function fetchJson<T>(url: string, creds: MixpanelCreds): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: authHeader(creds), Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Mixpanel API HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function buildUrl(endpoint: 'events' | 'segmentation', params: Record<string, string>, projectId: string): string {
  const qs = new URLSearchParams({ project_id: projectId, ...params });
  return `${QUERY_API_BASE}/${endpoint}?${qs.toString()}`;
}

/**
 * Run a Mixpanel query and return normalized rows shaped like BigQuery rows
 * so the Slack formatter doesn't care which data source produced them.
 *
 * No breakdown  → rows: [{ date, value }]
 * With breakdown → rows: [{ date, breakdown, value }]  (one row per date × breakdown value)
 */
export async function queryMixpanel(params: MixpanelQueryParams): Promise<MixpanelRow[]> {
  if (!isKnownMixpanelEvent(params.event)) {
    throw new Error(`Unknown Mixpanel event: "${params.event}". Not in Lexicon top-40 catalog.`);
  }
  const creds = getMixpanelCreds();

  if (!params.breakdown) {
    const url = buildUrl('events', {
      event: JSON.stringify([params.event]),
      type: params.measure,
      unit: params.unit,
      from_date: params.fromDate,
      to_date: params.toDate,
    }, creds.projectId);
    const json = await fetchJson<EventsApiResponse>(url, creds);
    const byDate = json.data.values[params.event] ?? {};
    return json.data.series.map((date) => ({
      event: params.event,
      date,
      value: byDate[date] ?? 0,
    }));
  }

  // Segmentation endpoint — one event, broken down by a property.
  // Try event-level first (matches Mixpanel UI). If the response is "useless"
  // (≥95% of volume lives in the undefined bucket — usually means this event
  // doesn't carry the super-prop), auto-fall back to user-level when possible.
  const baseParams: Record<string, string> = {
    event: params.event,
    type: params.measure,
    unit: params.unit,
    from_date: params.fromDate,
    to_date: params.toDate,
  };
  if (params.where) baseParams.where = params.where;

  let json = await fetchJson<SegmentationApiResponse>(
    buildUrl('segmentation', { ...baseParams, on: segmentationExprFor(params.breakdown) }, creds.projectId),
    creds
  );

  if (isMostlyUndefined(json) && hasUserFallback(params.breakdown)) {
    json = await fetchJson<SegmentationApiResponse>(
      buildUrl('segmentation', { ...baseParams, on: userLevelExprFor(params.breakdown) }, creds.projectId),
      creds
    );
  }

  const rows: MixpanelRow[] = [];
  for (const [breakdownValue, byDate] of Object.entries(json.data.values)) {
    for (const date of json.data.series) {
      rows.push({
        event: params.event,
        date,
        breakdown: breakdownValue === 'undefined' ? '(none)' : breakdownValue,
        value: byDate[date] ?? 0,
      });
    }
  }
  return rows;
}

function isMostlyUndefined(json: SegmentationApiResponse): boolean {
  const totals: Record<string, number> = {};
  for (const [bucket, byDate] of Object.entries(json.data.values)) {
    totals[bucket] = Object.values(byDate).reduce((a, b) => a + b, 0);
  }
  const grand = Object.values(totals).reduce((a, b) => a + b, 0);
  if (grand === 0) return false;
  const undef = totals['undefined'] ?? 0;
  return undef / grand >= 0.95;
}
