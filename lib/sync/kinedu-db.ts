/**
 * Kinedu DB → Supabase Sync Module
 *
 * Connects to Kinedu's read-only DB replica (dbslave) via SSH tunnel,
 * fetches sales data, and upserts it into Supabase's `transactions` table.
 *
 * This replaces the Apple/Google API sync with the same source of truth
 * that Tableau uses (the `sales` table), ensuring MRR numbers match.
 */

import { Client as SSHClient } from 'ssh2';
import { createServerClient } from '@/lib/supabase/server';
import type { PlanType, Region } from '@/types';

// ─── Types ──────────────────────────────────────────────────────────────────

interface KineduSaleRow {
  id: string;
  store: string;
  sku: string;
  amount: string;
  currency_code: string;
  usd_amount: string;
  created_at: string;
  renewed_automatically: string;
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

// ─── SSH Connection ─────────────────────────────────────────────────────────

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

function execSSHCommand(ssh: SSHClient, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ssh.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (data: Buffer) => { stdout += data.toString(); });
      stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      stream.on('close', (code: number) => {
        if (code !== 0 && stderr) {
          reject(new Error(`SSH command failed (code ${code}): ${stderr.slice(0, 500)}`));
        } else {
          resolve(stdout);
        }
      });
    });
  });
}

// ─── Main Sync Function ────────────────────────────────────────────────────

export async function syncKineduDB(fromDate: string, toDate: string): Promise<SyncResult> {
  console.log(`[kinedu-db] Syncing sales from ${fromDate} to ${toDate}...`);

  // 1. Connect via SSH
  const ssh = await connectSSH();

  // 2. Run MySQL query remotely via SSH exec
  const mysql = getMySQLConfig();
  const mysqlCmd = `mysql -h ${mysql.host} -u ${mysql.user} -p${mysql.password} ${mysql.database} --batch --raw -e`;

  const query = `
    SELECT
      s.id, s.store, s.sku, s.amount, s.currency_code, s.usd_amount,
      s.created_at, s.renewed_automatically,
      sub.email, sub.name
    FROM sales s
    LEFT JOIN subscriptions sub ON s.user_id = sub.user_id
    WHERE s.created_at >= '${fromDate}'
      AND s.created_at < '${toDate}'
      AND s.payment_status = 'paid'
      AND s.fraud = 0
      AND s.livemode = 1
      AND (sub.email IS NULL OR sub.email NOT LIKE '%@test.com%')
      AND (sub.name IS NULL OR sub.name NOT LIKE '%click here%')
    ORDER BY s.created_at ASC
  `;

  const rawOutput = await execSSHCommand(
    ssh,
    `${mysqlCmd} "${query.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`
  );

  // 3. Close SSH immediately after query
  ssh.end();
  console.log('[kinedu-db] SSH closed');

  // 4. Parse TSV output (mysql --batch outputs tab-separated)
  const lines = rawOutput.trim().split('\n');
  if (lines.length <= 1) {
    console.log('[kinedu-db] No sales found in date range');
    return { synced: 0, fetched: 0 };
  }

  const headers = lines[0].split('\t');
  const rows: KineduSaleRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split('\t');
    const row: Record<string, string | null> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] === 'NULL' ? null : values[j];
    }
    rows.push(row as unknown as KineduSaleRow);
  }

  console.log(`[kinedu-db] Fetched ${rows.length} sales from Kinedu DB`);

  // 5. Transform sales → transactions format
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
      is_new_subscription: row.renewed_automatically === '0',
      is_renewal: row.renewed_automatically === '1',
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
      raw_data: { kinedu_sale_id: row.id, store: row.store },
    };
  });

  // 6. Delete old transactions in this range & upsert new ones
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

  // 7. Batch upsert in chunks of 500
  const BATCH_SIZE = 500;
  let totalSynced = 0;

  for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
    const batch = transactions.slice(i, i + BATCH_SIZE);
    const { error: upsertError } = await supabase
      .from('transactions')
      .upsert(batch, { onConflict: 'external_id' });

    if (upsertError) {
      console.error(`[kinedu-db] Batch upsert error (offset ${i}):`, upsertError.message);
      // Fallback: try one by one
      let singles = 0;
      for (const tx of batch) {
        const { error: singleError } = await supabase
          .from('transactions')
          .upsert(tx, { onConflict: 'external_id' });
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
