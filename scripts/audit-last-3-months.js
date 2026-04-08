// MRR Dashboard data audit — last 3 months (Feb, Mar, Apr 2026).
// Cross-references mrr_daily_snapshots against raw transactions and
// apple_sales_daily to flag any discrepancies or staleness.

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

for (const l of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf-8').split('\n')) {
  const t = l.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq < 0) continue;
  if (!process.env[t.slice(0, eq)]) process.env[t.slice(0, eq)] = t.slice(eq + 1);
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const MONTHS = [
  { key: '2026-02', start: '2026-02-01', end: '2026-02-28', label: 'Feb 26' },
  { key: '2026-03', start: '2026-03-01', end: '2026-03-31', label: 'Mar 26' },
  { key: '2026-04', start: '2026-04-01', end: '2026-04-30', label: 'Apr 26' },
];

const f = (n) => n == null ? '—' : '$' + Math.round(Number(n)).toLocaleString();
const pct = (a, b) => b > 0 ? ((a - b) / b * 100).toFixed(1) + '%' : '—';

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n${'='.repeat(80)}\n  MRR DASHBOARD DATA AUDIT — Last 3 months\n  Today: ${today}\n${'='.repeat(80)}\n`);

  // ────────────────────────────────────────────────────────────────────────
  // 1) Snapshot values + computed_at freshness
  // ────────────────────────────────────────────────────────────────────────
  console.log('── 1) mrr_daily_snapshots ────────────────────────────────────');
  const { data: snaps } = await sb.from('mrr_daily_snapshots')
    .select('snapshot_date, mrr_gross, mrr_net, mrr_apple_gross, mrr_apple_net, mrr_google_gross, mrr_google_net, mrr_stripe_gross, mrr_stripe_net, total_commissions, total_refunds, active_subscriptions, new_subscriptions, renewals, computed_at')
    .gte('snapshot_date', '2026-02-01').order('snapshot_date');

  console.log('month  | mrr_gross | mrr_net  | apple    | google  | stripe  | comm     | refunds | active | new+ren | computed_at');
  console.log('-------|-----------|----------|----------|---------|---------|----------|---------|--------|---------|' + '-'.repeat(20));
  for (const s of snaps) {
    const newRen = Number(s.new_subscriptions) + Number(s.renewals);
    console.log(
      s.snapshot_date.slice(0, 7), '|',
      f(s.mrr_gross).padStart(9), '|',
      f(s.mrr_net).padStart(8), '|',
      f(s.mrr_apple_gross).padStart(8), '|',
      f(s.mrr_google_gross).padStart(7), '|',
      f(s.mrr_stripe_gross).padStart(7), '|',
      f(s.total_commissions).padStart(8), '|',
      f(s.total_refunds).padStart(7), '|',
      String(s.active_subscriptions).padStart(6), '|',
      String(newRen).padStart(7), '|',
      s.computed_at
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // 2) Cross-reference: transactions table directly
  // ────────────────────────────────────────────────────────────────────────
  console.log('\n── 2) Direct sum from `transactions` table ───────────────────');
  console.log('(This is what the snapshot SHOULD reflect if freshly recomputed.)');
  console.log('month  | source  | n_rows | sum(amount_gross) | sum(amount_net) | max(transaction_date) | max(synced_at)');
  console.log('-------|---------|--------|-------------------|-----------------|-----------------------|----------------');

  for (const m of MONTHS) {
    for (const source of ['apple', 'google', 'stripe']) {
      const pageSize = 1000;
      let totalRows = 0;
      let gross = 0, net = 0;
      let maxDate = '';
      let maxSynced = '';

      for (let from = 0; ; from += pageSize) {
        const { data, error } = await sb.from('transactions')
          .select('amount_gross, amount_net, transaction_date, synced_at')
          .eq('source', source)
          .eq('transaction_type', 'charge')
          .gte('transaction_date', m.start)
          .lte('transaction_date', m.end)
          .range(from, from + pageSize - 1);
        if (error) { console.error(error); break; }
        if (!data || data.length === 0) break;
        totalRows += data.length;
        for (const r of data) {
          gross += Number(r.amount_gross || 0);
          net += Number(r.amount_net || 0);
          if (r.transaction_date > maxDate) maxDate = r.transaction_date;
          if (r.synced_at && r.synced_at > maxSynced) maxSynced = r.synced_at;
        }
        if (data.length < pageSize) break;
      }

      console.log(
        m.key, '|',
        source.padEnd(7), '|',
        String(totalRows).padStart(6), '|',
        f(gross).padStart(17), '|',
        f(net).padStart(15), '|',
        (maxDate || '—').padEnd(21), '|',
        (maxSynced || '—').slice(0, 19)
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 3) Data freshness per source — max synced_at for THE WHOLE table
  // ────────────────────────────────────────────────────────────────────────
  console.log('\n── 3) Latest sync per source (transactions table) ────────────');
  for (const source of ['apple', 'google', 'stripe']) {
    const { data } = await sb.from('transactions')
      .select('transaction_date, synced_at')
      .eq('source', source)
      .order('transaction_date', { ascending: false })
      .limit(1);
    const { data: syncRow } = await sb.from('transactions')
      .select('synced_at')
      .eq('source', source)
      .order('synced_at', { ascending: false })
      .limit(1);
    console.log(
      source.padEnd(8),
      ' max transaction_date:', (data?.[0]?.transaction_date || '—').padEnd(12),
      ' max synced_at:', syncRow?.[0]?.synced_at || '—'
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // 4) apple_sales_daily (source of truth for Apple refunds page) freshness
  // ────────────────────────────────────────────────────────────────────────
  console.log('\n── 4) apple_sales_daily freshness ────────────────────────────');
  const { data: asdMax } = await sb.from('apple_sales_daily')
    .select('begin_date, synced_at')
    .order('begin_date', { ascending: false })
    .limit(1);
  console.log('  latest begin_date:', asdMax?.[0]?.begin_date);
  console.log('  latest synced_at: ', asdMax?.[0]?.synced_at);

  // Sum per month from apple_sales_daily directly
  console.log('\n  Per-month charges from apple_sales_daily (subscriptions only):');
  const { data: asdMonthly } = await sb.rpc('apple_sales_monthly_range', {
    start_date: '2026-02-01',
    end_date: '2026-04-30',
  });
  console.log('  month   | charge_units | charge_gross_usd | refund_units | refund_gross_usd');
  for (const r of (asdMonthly || [])) {
    console.log(
      '  ' + r.month, '|',
      String(r.charge_units).padStart(12), '|',
      f(r.charge_gross_usd).padStart(16), '|',
      String(r.refund_units).padStart(12), '|',
      f(r.refund_gross_usd).padStart(16)
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // 5) Snapshot vs transactions reconciliation
  // ────────────────────────────────────────────────────────────────────────
  console.log('\n── 5) Reconciliation: snapshot vs transactions table ─────────');
  console.log('(If the cron recomputed the snapshot, these should match within rounding.)');
  for (const m of MONTHS) {
    const snap = snaps.find((s) => s.snapshot_date.startsWith(m.key));
    if (!snap) continue;

    // Sum transactions directly for this month (all sources, charges only)
    const pageSize = 1000;
    let gross = 0, net = 0, rows = 0;
    for (let from = 0; ; from += pageSize) {
      const { data } = await sb.from('transactions')
        .select('amount_gross, amount_net')
        .eq('transaction_type', 'charge')
        .gte('transaction_date', m.start)
        .lte('transaction_date', m.end)
        .range(from, from + pageSize - 1);
      if (!data || data.length === 0) break;
      rows += data.length;
      for (const r of data) {
        gross += Number(r.amount_gross || 0);
        net += Number(r.amount_net || 0);
      }
      if (data.length < pageSize) break;
    }

    const sgross = Number(snap.mrr_gross);
    const snet = Number(snap.mrr_net);
    const deltaG = gross - sgross;
    const deltaN = net - snet;
    const warn = (Math.abs(deltaG) / (sgross || 1) > 0.01) ? ' ⚠' : ' ✓';
    console.log(
      m.key,
      '| snapshot:', f(sgross).padStart(9),
      '| tx_sum:', f(gross).padStart(9),
      '| delta:', f(deltaG).padStart(7), `(${pct(gross, sgross)})`, warn
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // 6) Sanity: is MRR monotonically consistent vs. refunds direction?
  // ────────────────────────────────────────────────────────────────────────
  console.log('\n── 6) Refunds context from Refunds tab (ASC SALES report) ────');
  for (const r of (asdMonthly || [])) {
    const rate = Number(r.charge_gross_usd) > 0
      ? (Number(r.refund_gross_usd) / (Number(r.charge_gross_usd) - Number(r.refund_gross_usd)) * 100).toFixed(2) + '%'
      : '—';
    console.log(`  ${r.month}: refund rate (NET) = ${rate}`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // 7) Sync log — what has the cron done recently?
  // ────────────────────────────────────────────────────────────────────────
  console.log('\n── 7) Recent sync_log entries (last 14 days) ────────────────');
  const { data: logs } = await sb.from('sync_log')
    .select('started_at, completed_at, source, sync_type, status, records_synced, error_message')
    .gte('started_at', new Date(Date.now() - 14 * 86400000).toISOString())
    .order('started_at', { ascending: false })
    .limit(25);
  for (const l of (logs || [])) {
    const dur = l.completed_at && l.started_at
      ? Math.round((new Date(l.completed_at) - new Date(l.started_at)) / 1000) + 's'
      : '—';
    console.log(
      (l.started_at || '').slice(0, 19),
      '|', (l.source || '').padEnd(6),
      '|', (l.sync_type || '').padEnd(9),
      '|', (l.status || '').padEnd(7),
      '|', String(l.records_synced || 0).padStart(6),
      '|', dur.padStart(5),
      l.error_message ? '| ERR: ' + l.error_message.slice(0, 60) : ''
    );
  }

  console.log(`\n${'='.repeat(80)}\n  AUDIT COMPLETE\n${'='.repeat(80)}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
