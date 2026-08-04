/**
 * Kinedu DB → Supabase Sync Module
 *
 * Two fetch modes, toggled by USE_BIGQUERY_SYNC env var:
 *   false (default): SSH tunnel → MySQL dbslave (original path)
 *   true:            BigQuery aws_kinedu_app_import.sales (aligned with tech)
 *
 * Transform + upsert logic is identical for both paths.
 */

import { Client as SSHClient } from 'ssh2';
import mysql from 'mysql2/promise';
import { getBigQueryClient } from '@/lib/bigquery/client';
import { createServerClient } from '@/lib/supabase/server';
import type { PlanType, Region } from '@/types';
import type { Socket } from 'net';

// ─── Types ──────────────────────────────────────────────────────────────────

interface KineduSaleRow {
  id: number;
  store: string | null;
  sku: string | null;
  amount: number;
  currency_code: string | null;
  usd_amount: number;
  created_at: Date;
  renewed_automatically: number;
  email: string | null;
  name: string | null;
}

interface SyncResult {
  synced: number;
  fetched: number;
}

// ─── Configuration ──────────────────────────────────────────────────────────

function getSSHConfig() {
  const privateKeyB64 = process.env.KINEDU_SSH_PRIVATE_KEY_B64;
  if (!privateKeyB64) {
    throw new Error('KINEDU_SSH_PRIVATE_KEY_B64 environment variable is not set');
  }

  return {
    host: process.env.KINEDU_SSH_HOST || 'kineduapp-1860797624.us-west-2.elb.amazonaws.com',
    port: Number(process.env.KINEDU_SSH_PORT) || 2422,
    username: process.env.KINEDU_SSH_USER || 'root',
    privateKey: Buffer.from(privateKeyB64, 'base64').toString('utf-8'),
    passphrase: process.env.KINEDU_SSH_PASSPHRASE || 'Kinedu',
  };
}

function getMySQLConfig() {
  return {
    host: process.env.KINEDU_DB_HOST || 'dbslave.c6ji2pa9hmrh.us-west-2.rds.amazonaws.com',
    port: Number(process.env.KINEDU_DB_PORT) || 3306,
    user: process.env.KINEDU_DB_USER || 'root',
    password: process.env.KINEDU_DB_PASSWORD || 'Kinedu',
    database: process.env.KINEDU_DB_NAME || 'kinedu_app',
  };
}

// ─── SKU → Plan Type mapping ────────────────────────────────────────────────

function getPlanTypeFromSku(sku: string | null): PlanType {
  if (!sku) return 'other';
  const s = sku.toLowerCase();
  if (s.includes('lifetime') || s.includes('_lifetime_')) return 'lifetime';
  if (s.includes('_12_') || s.endsWith('_12')) return 'yearly';
  if (s.includes('_6_') || s.endsWith('_6')) return 'semesterly';
  if (s.includes('_3_') || s.endsWith('_3')) return 'quarterly';
  if (s.includes('_1_') || s.endsWith('_1')) return 'monthly';
  return 'other';
}

function getPlanNameFromSku(sku: string | null): string {
  if (!sku) return 'Unknown';
  const parts = sku.split('_');
  if (parts.length < 3) return sku;

  const product = parts[1] ? parts[1].charAt(0).toUpperCase() + parts[1].slice(1) : '';
  const periodMap: Record<string, string> = { '12': 'Yearly', '6': 'Semesterly', '3': 'Quarterly', '1': 'Monthly' };
  const period = periodMap[parts[2]] || parts[2];
  const rest = parts.slice(3).map((p) => p.toUpperCase()).join(' ');

  return `Kinedu ${product} - ${period} ${rest}`.trim();
}

// ─── Region mapping ─────────────────────────────────────────────────────────

function getRegion(countryCode: string | null): Region {
  if (!countryCode) return 'rest_of_world';
  const code = countryCode.toUpperCase();
  if (code === 'US' || code === 'CA') return 'us_canada';
  if (code === 'MX') return 'mexico';
  if (code === 'BR') return 'brazil';
  return 'rest_of_world';
}

// ─── Source mapping ─────────────────────────────────────────────────────────

function mapStore(store: string | null): 'apple' | 'google' | 'stripe' {
  if (!store) return 'stripe';
  const s = store.toLowerCase();
  if (s === 'apple') return 'apple';
  if (s === 'google') return 'google';
  return 'stripe'; // webapp, stripe, webapp-partners
}

// ─── Country from currency (approximation) ─────────────────────────────────

function getCountryFromCurrency(currencyCode: string | null): string | null {
  if (!currencyCode) return null;
  const map: Record<string, string> = {
    MXN: 'MX', BRL: 'BR', USD: 'US', CAD: 'CA',
    GBP: 'GB', EUR: 'EU', COP: 'CO', AED: 'AE', AUD: 'AU',
  };
  return map[currencyCode.toUpperCase()] || null;
}

// ─── SSH Tunnel + MySQL Connection ──────────────────────────────────────────

function connectSSH(): Promise<SSHClient> {
  return new Promise((resolve, reject) => {
    const ssh = new SSHClient();
    const config = getSSHConfig();

    ssh.on('ready', () => {
      console.log('[kinedu-db] SSH connected');
      resolve(ssh);
    });
    ssh.on('error', (err: Error) => {
      console.error('[kinedu-db] SSH error:', err.message);
      reject(err);
    });
    ssh.connect(config);
  });
}

/**
 * Creates an SSH tunnel (port forwarding) to the MySQL server
 * and returns a mysql2 connection through the tunnel.
 */
function createTunnelConnection(ssh: SSHClient): Promise<mysql.Connection> {
  return new Promise((resolve, reject) => {
    const mysqlConfig = getMySQLConfig();

    // Forward from localhost (on the SSH server side) to the MySQL host
    ssh.forwardOut(
      '127.0.0.1',    // srcIP (our side, can be anything)
      0,              // srcPort (0 = auto-assign)
      mysqlConfig.host, // dstIP (the MySQL server)
      mysqlConfig.port, // dstPort (3306)
      async (err, stream) => {
        if (err) {
          console.error('[kinedu-db] SSH tunnel error:', err.message);
          return reject(err);
        }

        try {
          // Create MySQL connection using the SSH stream as the socket
          const connection = await mysql.createConnection({
            user: mysqlConfig.user,
            password: mysqlConfig.password,
            database: mysqlConfig.database,
            stream: stream as unknown as Socket, // ssh2 stream works as a socket
            connectTimeout: 30000,
          });

          console.log('[kinedu-db] MySQL connected through SSH tunnel');
          resolve(connection);
        } catch (mysqlErr) {
          console.error('[kinedu-db] MySQL connection error:', (mysqlErr as Error).message);
          reject(mysqlErr);
        }
      }
    );
  });
}

// ─── BigQuery fetch (mirrors the MySQL query exactly) ───────────────────────

async function fetchFromBigQuery(fromDate: string, toDate: string): Promise<KineduSaleRow[]> {
  const bq = getBigQueryClient();
  const [bqRows] = await bq.query({
    query: `
      SELECT
        s.id, s.store, s.sku, s.amount, s.currency_code, s.usd_amount,
        s.created_at, s.renewed_automatically,
        sub.email, sub.name
      FROM \`celtic-music-240111.aws_kinedu_app_import.sales\` s
      LEFT JOIN \`celtic-music-240111.aws_kinedu_app_import.subscriptions\` sub
        ON s.user_id = sub.user_id
      WHERE s.created_at >= @fromDate
        AND s.created_at < @toDate
        AND s.payment_status = 'paid'
        AND s.fraud = 0
        AND s.livemode = 1
        AND (sub.email IS NULL OR sub.email NOT LIKE '%@test.com%')
        AND (sub.name IS NULL OR sub.name NOT LIKE '%click here%')
      ORDER BY s.created_at ASC
    `,
    params: { fromDate, toDate },
  });

  // BigQuery returns dates as { value: string } objects — normalize to Date
  return (bqRows as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    store: r.store as string | null,
    sku: r.sku as string | null,
    amount: Number(r.amount),
    currency_code: r.currency_code as string | null,
    usd_amount: Number(r.usd_amount),
    created_at: new Date((r.created_at as { value: string }).value),
    renewed_automatically: Number(r.renewed_automatically),
    email: r.email as string | null,
    name: r.name as string | null,
  }));
}

// ─── Main Sync Function ────────────────────────────────────────────────────

export async function syncKineduDB(fromDate: string, toDate: string): Promise<SyncResult> {
  const useBigQuery = process.env.USE_BIGQUERY_SYNC === 'true';
  console.log(`[kinedu-db] Syncing ${fromDate}→${toDate} via ${useBigQuery ? 'BigQuery' : 'MySQL'}`);

  let rows: KineduSaleRow[];

  if (useBigQuery) {
    // ── BigQuery path (no SSH, no MySQL credentials needed) ──────────────
    rows = await fetchFromBigQuery(fromDate, toDate);
    console.log(`[kinedu-db] Fetched ${rows.length} sales from BigQuery`);
  } else {
    // ── Legacy MySQL path via SSH tunnel ──────────────────────────────────
    const ssh = await connectSSH();
    const mysqlConn = await createTunnelConnection(ssh);
    try {
      const query = `
        SELECT
          s.id, s.store, s.sku, s.amount, s.currency_code, s.usd_amount,
          s.created_at, s.renewed_automatically,
          sub.email, sub.name
        FROM sales s
        LEFT JOIN subscriptions sub ON s.user_id = sub.user_id
        WHERE s.created_at >= ?
          AND s.created_at < ?
          AND s.payment_status = 'paid'
          AND s.fraud = 0
          AND s.livemode = 1
          AND (sub.email IS NULL OR sub.email NOT LIKE '%@test.com%')
          AND (sub.name IS NULL OR sub.name NOT LIKE '%click here%')
        ORDER BY s.created_at ASC
      `;
      const [rawRows] = await mysqlConn.execute(query, [fromDate, toDate]);
      rows = rawRows as KineduSaleRow[];
      console.log(`[kinedu-db] Fetched ${rows.length} sales from MySQL`);
    } finally {
      try { await mysqlConn.end(); } catch { /* ignore */ }
      ssh.end();
    }
  }

  if (rows.length === 0) return { synced: 0, fetched: 0 };

  {
    // 3. Transform sales → transactions format
    const transactions = rows.map((row) => {
      const source = mapStore(row.store);
      const planType = getPlanTypeFromSku(row.sku);
      const planName = getPlanNameFromSku(row.sku);
      const usdAmount = Number(row.usd_amount) || 0;

      // Commission rates (same as Tableau)
      let commissionRate = 0;
      if (source === 'apple') commissionRate = 0.30;
      else if (source === 'google') commissionRate = 0.15;
      else commissionRate = 0.029;

      const commission = usdAmount * commissionRate;
      const netAmount = usdAmount - commission;

      const createdAt = new Date(row.created_at);
      const transactionDate = createdAt.toISOString().split('T')[0];

      const countryCode = getCountryFromCurrency(row.currency_code);

      return {
        source,
        transaction_date: transactionDate,
        order_id: `kinedu_sale_${row.id}`,
        external_id: `kinedu_sale_${row.id}`,
        sku: row.sku,
        plan_type: planType,
        plan_name: planName,
        transaction_type: 'charge' as const,
        is_new_subscription: row.renewed_automatically === 0,
        is_renewal: row.renewed_automatically === 1,
        is_trial_conversion: false,
        subscription_period: null,
        amount_gross: usdAmount,
        amount_net: netAmount,
        commission_amount: commission,
        tax_amount: 0,
        original_amount: Number(row.amount) || 0,
        original_currency: row.currency_code,
        country_code: countryCode,
        region: getRegion(countryCode),
        units: 1,
        raw_data: { kinedu_sale_id: String(row.id), store: row.store },
      };
    });

    // 4. Delete old transactions in this range & upsert new ones
    const supabase = createServerClient();

    // Delete old kinedu-sourced transactions in this range
    console.log(`[kinedu-db] Deleting old transactions from ${fromDate} to ${toDate}...`);
    const { error: deleteError } = await supabase
      .from('transactions')
      .delete()
      .gte('transaction_date', fromDate)
      .lt('transaction_date', toDate)
      .eq('transaction_type', 'charge')
      .like('external_id', 'kinedu_sale_%');

    if (deleteError) {
      console.warn('[kinedu-db] Error deleting old kinedu transactions:', deleteError.message);
    }

    // Also delete old Apple/Google API-sourced transactions to avoid duplicates
    for (const src of ['apple', 'google'] as const) {
      const { error: srcDelError } = await supabase
        .from('transactions')
        .delete()
        .gte('transaction_date', fromDate)
        .lt('transaction_date', toDate)
        .eq('transaction_type', 'charge')
        .eq('source', src)
        .not('external_id', 'like', 'kinedu_sale_%');

      if (srcDelError) {
        console.warn(`[kinedu-db] Error deleting old ${src} transactions:`, srcDelError.message);
      }
    }

    // 5. Batch upsert in chunks of 500
    const BATCH_SIZE = 500;
    let totalSynced = 0;

    for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
      const batch = transactions.slice(i, i + BATCH_SIZE);
      // Compound unique index: (source, external_id) WHERE external_id IS NOT NULL.
      // Passing `external_id` alone as the conflict target makes Postgres
      // throw 42P10 ("no unique constraint matching the ON CONFLICT spec").
      // Must pass both columns.
      const { error: upsertError } = await supabase
        .from('transactions')
        .upsert(batch, { onConflict: 'source,external_id' });

      if (upsertError) {
        console.error(`[kinedu-db] Batch upsert error (offset ${i}):`, upsertError.message);
        // Fallback: try one by one
        let singles = 0;
        for (const tx of batch) {
          const { error: singleError } = await supabase
            .from('transactions')
            .upsert(tx, { onConflict: 'source,external_id' });
          if (!singleError) singles++;
        }
        totalSynced += singles;
        console.log(`[kinedu-db] Recovered ${singles}/${batch.length} via single inserts`);
      } else {
        totalSynced += batch.length;
      }
    }

    console.log(`[kinedu-db] Sync complete: ${totalSynced}/${rows.length} transactions synced`);
    return { synced: totalSynced, fetched: rows.length };
  }
}

// ─── Refunds sync (powers the cohort view on the Refunds tab) ───────────────

interface KineduRefundRow {
  sale_id: number;
  refund_date: string; // YYYY-MM-DD
  charge_date: string; // YYYY-MM-DD (sales.created_at)
  usd_amount: number;
  store: string | null;
  sku: string | null;
  currency_code: string | null;
}

/**
 * Syncs the kinedu backend `refunds` table (sale_id → refund_date) into
 * Supabase `kinedu_refunds`. The linkage refunds.sale_id = sales.id is exact
 * (validated 100% in BigQuery), which lets the dashboard attribute each refund
 * to its original charge — the cohort view ("of the charges in month X, how
 * many were refunded?").
 *
 * Incremental: pass fromDate to fetch only refunds with refund_date >= fromDate
 * (the daily cron uses ~45 days; the backfill script passes '2000-01-01').
 */
export async function syncKineduRefunds(fromDate: string): Promise<{ synced: number; fetched: number }> {
  const useBigQuery = process.env.USE_BIGQUERY_SYNC === 'true';
  console.log(`[kinedu-refunds] Syncing refunds from ${fromDate} via ${useBigQuery ? 'BigQuery' : 'MySQL'}`);

  let rows: KineduRefundRow[];

  if (useBigQuery) {
    const bq = getBigQueryClient();
    // Join to `sales` for the ORIGINAL CHARGE info (date/amount/store): refunded
    // charges flip payment_status 'paid'→'canceled' and get dropped from
    // `transactions` on re-sync, so the cohort view needs the charge data here.
    const [bqRows] = await bq.query({
      query: `
        SELECT r.sale_id,
               MIN(r.refund_date) AS refund_date,
               DATE(s.created_at) AS charge_date,
               CAST(s.usd_amount AS FLOAT64) AS usd_amount,
               s.store, s.sku, s.currency_code
        FROM \`celtic-music-240111.aws_kinedu_app_import.refunds\` r
        JOIN \`celtic-music-240111.aws_kinedu_app_import.sales\` s ON s.id = r.sale_id
        WHERE r.refund_date >= @fromDate
          AND r.sale_id IS NOT NULL
          AND COALESCE(r.__hevo__marked_deleted, FALSE) = FALSE
          AND s.fraud = 0 AND s.livemode = 1
        GROUP BY r.sale_id, charge_date, usd_amount, s.store, s.sku, s.currency_code
      `,
      params: { fromDate },
    });
    const asDate = (v: unknown): string =>
      typeof v === 'object' && v !== null ? (v as { value: string }).value : String(v);
    rows = (bqRows as Record<string, unknown>[]).map((r) => ({
      sale_id: Number(r.sale_id),
      refund_date: asDate(r.refund_date),
      charge_date: asDate(r.charge_date),
      usd_amount: Number(r.usd_amount) || 0,
      store: r.store as string | null,
      sku: r.sku as string | null,
      currency_code: r.currency_code as string | null,
    }));
  } else {
    const ssh = await connectSSH();
    const mysqlConn = await createTunnelConnection(ssh);
    try {
      const [rawRows] = await mysqlConn.execute(
        `SELECT r.sale_id,
                DATE_FORMAT(MIN(r.refund_date), '%Y-%m-%d') AS refund_date,
                DATE_FORMAT(s.created_at, '%Y-%m-%d') AS charge_date,
                s.usd_amount, s.store, s.sku, s.currency_code
         FROM refunds r
         JOIN sales s ON s.id = r.sale_id
         WHERE r.refund_date >= ? AND r.sale_id IS NOT NULL
           AND s.fraud = 0 AND s.livemode = 1
         GROUP BY r.sale_id, s.created_at, s.usd_amount, s.store, s.sku, s.currency_code`,
        [fromDate]
      );
      rows = (rawRows as Record<string, unknown>[]).map((r) => ({
        sale_id: Number(r.sale_id),
        refund_date: String(r.refund_date),
        charge_date: String(r.charge_date),
        usd_amount: Number(r.usd_amount) || 0,
        store: r.store as string | null,
        sku: r.sku as string | null,
        currency_code: r.currency_code as string | null,
      }));
    } finally {
      try { await mysqlConn.end(); } catch { /* ignore */ }
      ssh.end();
    }
  }

  console.log(`[kinedu-refunds] Fetched ${rows.length} refunds`);
  if (rows.length === 0) return { synced: 0, fetched: 0 };

  // Dedup by sale_id keeping the earliest refund_date (a sale is refunded once)
  const bySale = new Map<number, KineduRefundRow>();
  for (const r of rows) {
    const prev = bySale.get(r.sale_id);
    if (!prev || r.refund_date < prev.refund_date) bySale.set(r.sale_id, r);
  }
  const deduped = Array.from(bySale.values(), (r) => ({
    sale_id: r.sale_id,
    refund_date: r.refund_date,
    charge_date: r.charge_date,
    usd_amount: r.usd_amount,
    source: mapStore(r.store),
    sku: r.sku,
    country_code: getCountryFromCurrency(r.currency_code),
  }));

  const supabase = createServerClient();
  const BATCH_SIZE = 500;
  let synced = 0;
  for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
    const batch = deduped.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('kinedu_refunds')
      .upsert(batch, { onConflict: 'sale_id' });
    if (error) {
      console.error(`[kinedu-refunds] Batch upsert error (offset ${i}):`, error.message);
    } else {
      synced += batch.length;
    }
  }

  console.log(`[kinedu-refunds] Sync complete: ${synced}/${deduped.length} refunds synced`);
  return { synced, fetched: rows.length };
}
