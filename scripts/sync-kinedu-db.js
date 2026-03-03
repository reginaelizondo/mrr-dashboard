#!/usr/bin/env node
/**
 * Kinedu DB → Supabase Sync Script
 *
 * Connects to Kinedu's read-only DB replica (dbslave) via SSH tunnel,
 * fetches sales data, and upserts it into Supabase's `transactions` table.
 *
 * This replaces the Apple/Google API sync with the same source of truth
 * that Tableau uses (the `sales` table), ensuring MRR numbers match.
 *
 * Usage:
 *   node scripts/sync-kinedu-db.js                    # sync last 14 months
 *   node scripts/sync-kinedu-db.js --from 2024-01-01  # sync from specific date
 *   node scripts/sync-kinedu-db.js --full              # sync ALL data from 2020
 *
 * Requires: mysql2, ssh2, @supabase/supabase-js
 */

const { Client: SSHClient } = require('ssh2');
const mysql = require('mysql2/promise');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const net = require('net');

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  ssh: {
    host: 'kineduapp-1860797624.us-west-2.elb.amazonaws.com',
    port: 2422,
    username: 'root',
    privateKey: fs.readFileSync(path.join(__dirname, 'pepis.pem')),
    passphrase: 'Kinedu',
  },
  mysql: {
    host: 'dbslave.c6ji2pa9hmrh.us-west-2.rds.amazonaws.com',
    port: 3306,
    user: 'root',
    password: 'Kinedu',
    database: 'kinedu_app',
  },
  supabase: {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://plxhpxjsysjbhzcwamyy.supabase.co',
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },
};

// ─── SKU → Plan Type mapping ─────────────────────────────────────────────────

function getPlanTypeFromSku(sku) {
  if (!sku) return 'other';
  const s = sku.toLowerCase();
  if (s.includes('lifetime') || s.includes('_lifetime_')) return 'lifetime';
  if (s.includes('_12_') || s.endsWith('_12')) return 'yearly';
  if (s.includes('_6_') || s.endsWith('_6')) return 'semesterly';
  if (s.includes('_3_') || s.endsWith('_3')) return 'quarterly';
  if (s.includes('_1_') || s.endsWith('_1')) return 'monthly';
  return 'other';
}

function getPlanNameFromSku(sku) {
  if (!sku) return 'Unknown';
  // Convert kinedu_learn_12_ht_ft → Kinedu Learn - Yearly (HT) FT
  const parts = sku.split('_');
  if (parts.length < 3) return sku;

  const product = parts[1] ? parts[1].charAt(0).toUpperCase() + parts[1].slice(1) : '';
  const periodMap = { '12': 'Yearly', '6': 'Semesterly', '3': 'Quarterly', '1': 'Monthly' };
  const period = periodMap[parts[2]] || parts[2];
  const rest = parts.slice(3).map(p => p.toUpperCase()).join(' ');

  return `Kinedu ${product} - ${period} ${rest}`.trim();
}

// ─── Region mapping ──────────────────────────────────────────────────────────

function getRegion(countryCode) {
  if (!countryCode) return 'rest_of_world';
  const code = countryCode.toUpperCase();
  if (code === 'US' || code === 'CA') return 'us_canada';
  if (code === 'MX') return 'mexico';
  if (code === 'BR') return 'brazil';
  return 'rest_of_world';
}

// ─── Source mapping ──────────────────────────────────────────────────────────

function mapStore(store) {
  if (!store) return 'stripe';
  const s = store.toLowerCase();
  if (s === 'apple') return 'apple';
  if (s === 'google') return 'google';
  if (s === 'webapp' || s === 'stripe' || s === 'webapp-partners') return 'stripe';
  return 'stripe';
}

// ─── SSH + MySQL via remote exec ─────────────────────────────────────────────

function connectSSH() {
  return new Promise((resolve, reject) => {
    const ssh = new SSHClient();
    ssh.on('ready', () => {
      console.log('✅ SSH connected');
      resolve(ssh);
    });
    ssh.on('error', (err) => {
      console.error('❌ SSH error:', err.message);
      reject(err);
    });
    ssh.connect(CONFIG.ssh);
  });
}

function execSSHCommand(ssh, command) {
  return new Promise((resolve, reject) => {
    ssh.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (data) => { stdout += data.toString(); });
      stream.stderr.on('data', (data) => { stderr += data.toString(); });
      stream.on('close', (code) => {
        if (code !== 0 && stderr) {
          reject(new Error(`Command failed (code ${code}): ${stderr}`));
        } else {
          resolve(stdout);
        }
      });
    });
  });
}

// ─── Main Sync Function ─────────────────────────────────────────────────────

async function syncKineduDB(fromDate, toDate) {
  console.log(`\n🔄 Syncing Kinedu DB sales from ${fromDate} to ${toDate}...\n`);

  // 1. Connect via SSH
  console.log('📡 Connecting via SSH...');
  const ssh = await connectSSH();

  // 2. Run MySQL query remotely via SSH exec
  console.log('🗄️  Querying MySQL (dbslave) remotely...');
  const mysqlCmd = `mysql -h ${CONFIG.mysql.host} -u ${CONFIG.mysql.user} -p${CONFIG.mysql.password} ${CONFIG.mysql.database} --batch --raw -e`;

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

  const rawOutput = await execSSHCommand(ssh, `${mysqlCmd} "${query.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`);

  // Parse TSV output (mysql --batch outputs tab-separated)
  const lines = rawOutput.trim().split('\n');
  const headers = lines[0].split('\t');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split('\t');
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] === 'NULL' ? null : values[j];
    }
    rows.push(row);
  }

  console.log(`✅ Fetched ${rows.length} sales from Kinedu DB`);

  // 3. Close SSH
  ssh.end();
  console.log('🔒 SSH closed');

  if (rows.length === 0) {
    console.log('ℹ️  No sales found in date range');
    return { synced: 0, deleted: 0 };
  }

  // 5. Transform sales → transactions format
  console.log('🔄 Transforming sales to transaction format...');
  const transactions = rows.map((row) => {
    const source = mapStore(row.store);
    const planType = getPlanTypeFromSku(row.sku);
    const planName = getPlanNameFromSku(row.sku);
    const usdAmount = Number(row.usd_amount) || 0;

    // Kinedu DB stores gross (customer price). We need to estimate net.
    // Apple: ~70% goes to developer (30% commission)
    // Google: ~85% goes to developer (15% commission)
    // Stripe: ~97% goes to developer (2.9% + $0.30)
    let commissionRate = 0;
    if (source === 'apple') commissionRate = 0.30;
    else if (source === 'google') commissionRate = 0.15;
    else commissionRate = 0.029;

    const commission = usdAmount * commissionRate;
    const netAmount = usdAmount - commission;

    const createdAt = new Date(row.created_at);
    const transactionDate = createdAt.toISOString().split('T')[0];

    // Determine country from currency (approximate - Kinedu DB doesn't have country directly on sales)
    let countryCode = null;
    if (row.currency_code === 'MXN') countryCode = 'MX';
    else if (row.currency_code === 'BRL') countryCode = 'BR';
    else if (row.currency_code === 'USD') countryCode = 'US'; // approximation
    else if (row.currency_code === 'CAD') countryCode = 'CA';
    else if (row.currency_code === 'GBP') countryCode = 'GB';
    else if (row.currency_code === 'EUR') countryCode = 'EU';
    else if (row.currency_code === 'COP') countryCode = 'CO';
    else if (row.currency_code === 'AED') countryCode = 'AE';
    else if (row.currency_code === 'AUD') countryCode = 'AU';

    return {
      source,
      transaction_date: transactionDate,
      order_id: `kinedu_sale_${row.id}`,
      external_id: `kinedu_sale_${row.id}`,
      sku: row.sku,
      plan_type: planType,
      plan_name: planName,
      transaction_type: 'charge',
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
      raw_data: { kinedu_sale_id: row.id, store: row.store },
    };
  });

  console.log(`✅ Transformed ${transactions.length} transactions`);

  // 6. Delete existing transactions in this date range & upsert new ones
  const supabase = createClient(CONFIG.supabase.url, CONFIG.supabase.key);

  // Delete old kinedu-sourced transactions in this range
  console.log(`🗑️  Deleting old transactions from ${fromDate} to ${toDate}...`);
  const { error: deleteError } = await supabase
    .from('transactions')
    .delete()
    .gte('transaction_date', fromDate)
    .lt('transaction_date', toDate)
    .eq('transaction_type', 'charge')
    .like('external_id', 'kinedu_sale_%');

  // Also delete old Apple/Google/Stripe API-sourced transactions in this range
  // to avoid duplicates
  for (const src of ['apple', 'google']) {
    const { error: srcDelError } = await supabase
      .from('transactions')
      .delete()
      .gte('transaction_date', fromDate)
      .lt('transaction_date', toDate)
      .eq('transaction_type', 'charge')
      .eq('source', src)
      .not('external_id', 'like', 'kinedu_sale_%');

    if (srcDelError) {
      console.warn(`⚠️  Error deleting old ${src} transactions:`, srcDelError.message);
    }
  }

  if (deleteError) {
    console.warn('⚠️  Error deleting old kinedu transactions:', deleteError.message);
  }

  // Batch upsert in chunks of 500
  const BATCH_SIZE = 500;
  let totalSynced = 0;

  for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
    const batch = transactions.slice(i, i + BATCH_SIZE);
    const { error: upsertError } = await supabase
      .from('transactions')
      .upsert(batch, { onConflict: 'external_id' });

    if (upsertError) {
      console.error(`❌ Batch upsert error (offset ${i}):`, upsertError.message);
      // Try one by one for debugging
      let singles = 0;
      for (const tx of batch) {
        const { error: singleError } = await supabase
          .from('transactions')
          .upsert(tx, { onConflict: 'external_id' });
        if (!singleError) singles++;
      }
      totalSynced += singles;
      console.log(`  Recovered ${singles}/${batch.length} via single inserts`);
    } else {
      totalSynced += batch.length;
    }

    process.stdout.write(`\r  Synced ${totalSynced}/${transactions.length} transactions`);
  }
  console.log('');

  console.log(`\n✅ Sync complete: ${totalSynced} transactions synced`);
  return { synced: totalSynced };
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Default: sync last 14 months (covers spreading lookback for recent months)
  let fromDate = new Date();
  fromDate.setMonth(fromDate.getMonth() - 14);
  fromDate = fromDate.toISOString().split('T')[0].substring(0, 8) + '01'; // First of month

  let toDate = new Date();
  toDate.setDate(toDate.getDate() + 1); // Include today
  toDate = toDate.toISOString().split('T')[0];

  // Parse CLI args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && args[i + 1]) {
      fromDate = args[i + 1];
      i++;
    } else if (args[i] === '--to' && args[i + 1]) {
      toDate = args[i + 1];
      i++;
    } else if (args[i] === '--full') {
      fromDate = '2020-01-01';
    }
  }

  console.log('═══════════════════════════════════════════════');
  console.log('  Kinedu DB → Supabase Sync');
  console.log('═══════════════════════════════════════════════');
  console.log(`  From: ${fromDate}`);
  console.log(`  To:   ${toDate}`);
  console.log('═══════════════════════════════════════════════');

  try {
    const result = await syncKineduDB(fromDate, toDate);
    console.log('\n🎉 Done!', result);
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Sync failed:', err.message || err);
    if (err.level === 'handshake') {
      console.error('\n💡 SSH key might need a passphrase. Try: ssh-keygen -p -f scripts/pepis.pem');
    }
    process.exit(1);
  }
}

main();
