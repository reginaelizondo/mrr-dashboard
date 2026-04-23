import { BigQuery } from '@google-cloud/bigquery';
import fs from 'fs';

let cached: BigQuery | null = null;

/**
 * Singleton BigQuery client. Supports two auth modes:
 * - Local dev: BIGQUERY_KEY_FILE points to JSON path on disk
 * - Vercel:    BIGQUERY_SERVICE_ACCOUNT_KEY_B64 holds base64 of the JSON
 */
export function getBigQueryClient(): BigQuery {
  if (cached) return cached;

  const projectId = process.env.BIGQUERY_PROJECT_ID;
  if (!projectId) throw new Error('BIGQUERY_PROJECT_ID env var not set');

  const b64 = process.env.BIGQUERY_SERVICE_ACCOUNT_KEY_B64;
  if (b64) {
    const credentials = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
    cached = new BigQuery({ projectId, credentials });
    return cached;
  }

  const keyFile = process.env.BIGQUERY_KEY_FILE;
  if (keyFile && fs.existsSync(keyFile)) {
    cached = new BigQuery({ projectId, keyFilename: keyFile });
    return cached;
  }

  throw new Error(
    'No BigQuery credentials found. Set either BIGQUERY_SERVICE_ACCOUNT_KEY_B64 or BIGQUERY_KEY_FILE.'
  );
}

export const KINEDU_OPERATIONAL_TABLE =
  '`celtic-music-240111.dbt_prod_analytics.an_operational_dash`';
