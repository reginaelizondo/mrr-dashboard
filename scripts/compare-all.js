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

// Kinedu DB monthly cash totals we validated via SQL in Sequel Pro
const KINEDU_DB_CASH = {
  '2024-01': 317794,
  '2024-02': 295226,
  '2024-03': 314098,
  '2024-04': 277383,
  '2024-05': 267460,
  '2024-06': 277487,
  '2024-07': 301790,
  '2024-08': 311777,
  '2024-09': 268168,
  '2024-10': 284488,
  '2024-11': 288704,
  '2024-12': 259630,
  '2025-01': 326144,
  '2025-02': 266500,
  '2025-03': 285759,
  '2025-04': 242809,
  '2025-05': 233047,
  '2025-06': 294898,
  '2025-07': 366804,
  '2025-08': 489976,
  '2025-09': 585041,
  '2025-10': 625015,
  '2025-11': 606644,
  '2025-12': 629762,
  '2026-01': 720135,
  '2026-02': 575157,
};

// Kinedu DB MRR contribution (spreading, per-month sales only) we validated via SQL
const KINEDU_DB_MRR_CONTRIBUTION = {
  '2024-10': 63466,
  '2024-11': 60613,
  '2025-01': 63466,
  '2025-02': 56924,
  '2025-10': 80067,
  '2026-01': 82970,
};

async function verify() {
  // 1. Check Supabase transactions cash totals match Kinedu DB
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  VERIFICATION: Dashboard Data vs Kinedu DB (Source of Truth)');
  console.log('═══════════════════════════════════════════════════════════════════');

  console.log('\n1️⃣  CASH BASIS: Supabase transactions gross vs Kinedu DB sales');
  console.log('    (These should match exactly - same data source)\n');
  console.log('Month     | Kinedu DB    | Supabase     | Diff     | Match?');
  console.log('----------|-------------|-------------|----------|-------');

  let cashMatches = 0;
  let cashTotal = 0;

  for (const month of Object.keys(KINEDU_DB_CASH).sort()) {
    const fromDate = month + '-01';
    const [y, m] = month.split('-').map(Number);
    const nextMonth = m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0');
    const toDate = nextMonth + '-01';

    // Sum gross from Supabase transactions
    const { data: txs, error } = await supabase
      .from('transactions')
      .select('amount_gross')
      .gte('transaction_date', fromDate)
      .lt('transaction_date', toDate)
      .eq('transaction_type', 'charge');

    if (error) {
      console.log(`${month}    | ERROR: ${error.message}`);
      continue;
    }

    const supabaseGross = (txs || []).reduce((acc, t) => acc + Number(t.amount_gross || 0), 0);
    const kineduGross = KINEDU_DB_CASH[month];
    const diff = supabaseGross - kineduGross;
    const pct = kineduGross > 0 ? ((diff / kineduGross) * 100).toFixed(1) : '0';
    const match = Math.abs(diff) < 100 ? '✅' : '❌';

    if (Math.abs(diff) < 100) cashMatches++;
    cashTotal++;

    console.log(`${month}   | $${kineduGross.toLocaleString().padStart(9)} | $${Math.round(supabaseGross).toLocaleString().padStart(9)} | $${Math.round(diff).toLocaleString().padStart(6)} | ${match} ${pct}%`);
  }

  console.log(`\nCash match rate: ${cashMatches}/${cashTotal} months`);

  // 2. Check MRR snapshots
  console.log('\n\n2️⃣  MRR SNAPSHOTS (Spreading methodology):');
  console.log('    Dashboard MRR Gross by month\n');

  const { data: snapshots } = await supabase
    .from('mrr_daily_snapshots')
    .select('snapshot_date, mrr_gross, mrr_net, mrr_apple_gross, mrr_google_gross, mrr_stripe_gross, new_subscriptions, renewals')
    .order('snapshot_date', { ascending: true });

  console.log('Month     | MRR Gross    | MRR Net      | New Subs | Renewals | Apple%  | Google% | Stripe%');
  console.log('----------|-------------|-------------|----------|----------|---------|---------|--------');

  for (const s of snapshots) {
    const month = s.snapshot_date.substring(0, 7);
    const gross = Number(s.mrr_gross);
    const net = Number(s.mrr_net);
    const appleGross = Number(s.mrr_apple_gross || 0);
    const googleGross = Number(s.mrr_google_gross || 0);
    const stripeGross = Number(s.mrr_stripe_gross || 0);
    const applePct = gross > 0 ? ((appleGross / gross) * 100).toFixed(0) : '0';
    const googlePct = gross > 0 ? ((googleGross / gross) * 100).toFixed(0) : '0';
    const stripePct = gross > 0 ? ((stripeGross / gross) * 100).toFixed(0) : '0';

    console.log(`${month}   | $${Math.round(gross).toLocaleString().padStart(9)} | $${Math.round(net).toLocaleString().padStart(9)} | ${String(s.new_subscriptions).padStart(8)} | ${String(s.renewals).padStart(8)} | ${applePct.padStart(5)}%  | ${googlePct.padStart(5)}%  | ${stripePct.padStart(4)}%`);
  }

  // 3. Growth trend
  console.log('\n\n3️⃣  MRR GROWTH (Month-over-Month):');
  console.log('    Starting from Oct 2024 (first month with full 12-month lookback)\n');

  const stableSnapshots = snapshots.filter(s => s.snapshot_date >= '2024-10-01');
  for (let i = 1; i < stableSnapshots.length; i++) {
    const prev = Number(stableSnapshots[i - 1].mrr_gross);
    const curr = Number(stableSnapshots[i].mrr_gross);
    const growth = prev > 0 ? ((curr - prev) / prev * 100).toFixed(1) : 'N/A';
    const month = stableSnapshots[i].snapshot_date.substring(0, 7);
    const arrow = curr > prev ? '📈' : curr < prev ? '📉' : '➡️';
    console.log(`  ${month}: $${Math.round(curr).toLocaleString().padStart(9)} (${growth > 0 ? '+' : ''}${growth}%) ${arrow}`);
  }

  // 4. Key insight
  console.log('\n\n4️⃣  NOTA IMPORTANTE:');
  console.log('    Los meses Ene-Sep 2024 muestran MRR artificialmente bajo porque');
  console.log('    no tenemos datos pre-2024 para el spreading de subs anuales.');
  console.log('    El MRR "real" estabilizado empieza en Oct 2024.');
  console.log('    Para presentar a CEO, usar datos Oct 2024+.');
}

verify();
