const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function loadEnvFile(fp) {
  try {
    const c = fs.readFileSync(fp, 'utf-8');
    for (const l of c.split('\n')) {
      const t = l.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const k = t.substring(0, eq).trim();
      const v = t.substring(eq + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  } catch (e) {}
}
loadEnvFile(path.join(__dirname, '..', '.env.local'));

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Kinedu DB monthly cash totals (from CSV import summary)
const KINEDU_DB_CASH = {
  '2024-01': 317794, '2024-02': 295226, '2024-03': 314098,
  '2024-04': 277383, '2024-05': 267460, '2024-06': 277487,
  '2024-07': 301790, '2024-08': 311777, '2024-09': 268168,
  '2024-10': 284488, '2024-11': 288704, '2024-12': 259630,
  '2025-01': 326144, '2025-02': 266500, '2025-03': 285759,
  '2025-04': 242809, '2025-05': 233047, '2025-06': 294898,
  '2025-07': 366804, '2025-08': 489976, '2025-09': 585041,
  '2025-10': 625015, '2025-11': 606644, '2025-12': 629762,
  '2026-01': 720135, '2026-02': 575157,
};

// Paginated fetch to get ALL transactions for a month
async function fetchAllForMonth(month) {
  const fromDate = month + '-01';
  const [y, m] = month.split('-').map(Number);
  const nextMonth = m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0');
  const toDate = nextMonth + '-01';

  const allTxs = [];
  const PAGE = 1000;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('transactions')
      .select('amount_gross')
      .gte('transaction_date', fromDate)
      .lt('transaction_date', toDate)
      .eq('transaction_type', 'charge')
      .range(offset, offset + PAGE - 1);

    if (error) { console.error('Error:', error.message); break; }
    if (data && data.length > 0) {
      for (const d of data) allTxs.push(d);
      offset += data.length;
      hasMore = data.length === PAGE;
    } else {
      hasMore = false;
    }
  }
  return allTxs;
}

async function verify() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  VERIFICACIÓN: Supabase (paginado) vs Kinedu DB');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  console.log('Month     | Kinedu DB    | Supabase     | Count | Diff     | Match?');
  console.log('----------|-------------|-------------|-------|----------|-------');

  let matches = 0;
  let total = 0;

  for (const month of Object.keys(KINEDU_DB_CASH).sort()) {
    const txs = await fetchAllForMonth(month);
    const supabaseGross = txs.reduce((acc, t) => acc + Number(t.amount_gross || 0), 0);
    const kineduGross = KINEDU_DB_CASH[month];
    const diff = supabaseGross - kineduGross;
    const pct = kineduGross > 0 ? ((diff / kineduGross) * 100).toFixed(1) : '0';
    const match = Math.abs(Number(pct)) < 1 ? '✅' : '❌';

    if (Math.abs(Number(pct)) < 1) matches++;
    total++;

    console.log(`${month}   | $${kineduGross.toLocaleString().padStart(9)} | $${Math.round(supabaseGross).toLocaleString().padStart(9)} | ${String(txs.length).padStart(5)} | ${pct.padStart(6)}% | ${match}`);
  }

  console.log(`\nMatch rate: ${matches}/${total} months within 1%`);

  // Now verify snapshots are reasonable
  console.log('\n\n═══════════════════════════════════════════════════════════════════');
  console.log('  MRR SNAPSHOTS (Oct 2024+ = stable with full 12-month lookback)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const { data: snapshots } = await supabase
    .from('mrr_daily_snapshots')
    .select('*')
    .gte('snapshot_date', '2024-10-01')
    .order('snapshot_date', { ascending: true });

  console.log('Month     | MRR Gross    | MRR Net      | Growth  | New Subs | Renewals');
  console.log('----------|-------------|-------------|---------|----------|--------');

  let prevGross = 0;
  for (const s of snapshots) {
    const month = s.snapshot_date.substring(0, 7);
    const gross = Number(s.mrr_gross);
    const net = Number(s.mrr_net);
    const growth = prevGross > 0 ? ((gross - prevGross) / prevGross * 100).toFixed(1) : '-';
    prevGross = gross;

    console.log(`${month}   | $${Math.round(gross).toLocaleString().padStart(9)} | $${Math.round(net).toLocaleString().padStart(9)} | ${String(growth).padStart(6)}% | ${String(s.new_subscriptions).padStart(8)} | ${String(s.renewals).padStart(8)}`);
  }
}

verify();
