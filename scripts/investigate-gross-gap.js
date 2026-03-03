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

const TABLEAU_GROSS = {
  '2024-10': 280542, '2024-11': 281471, '2024-12': 280597,
  '2025-01': 284078, '2025-02': 280473, '2025-03': 279925,
  '2025-04': 275207, '2025-05': 271849, '2025-06': 274149,
  '2025-07': 279615, '2025-08': 294614, '2025-09': 321137,
  '2025-10': 350640, '2025-11': 374675, '2025-12': 404768,
  '2026-01': 438633, '2026-02': 463782,
};

const PLAN_PERIOD_MONTHS = {
  monthly: 1, yearly: 12, semesterly: 6, quarterly: 3, lifetime: 60, other: 1,
};

async function fetchAll(fromDate, toDate) {
  const txs = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    const { data } = await supabase
      .from('transactions')
      .select('*')
      .gte('transaction_date', fromDate)
      .lt('transaction_date', toDate)
      .eq('transaction_type', 'charge')
      .range(offset, offset + 999);
    if (!data || data.length === 0) { hasMore = false; break; }
    for (const d of data) txs.push(d);
    offset += data.length;
    hasMore = data.length === 1000;
  }
  return txs;
}

async function investigate() {
  // Dashboard Jan 2025 Gross = $344K, Tableau = $284K → gap $60K
  // Our snapshot includes lookback charges spread into Jan 2025
  // Let's see how much each ORIGINATING month contributes to Jan 2025 MRR

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Jan 2025 MRR Gross Breakdown by originating month');
  console.log('  (which month was the charge made, contributing to Jan 2025 via spreading)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Fetch ALL charges from lookback to Jan 2025
  const allCharges = await fetchAll('2023-01-01', '2025-02-01');
  console.log('Total charges fetched (lookback):', allCharges.length);

  const jan2025Start = new Date(Date.UTC(2025, 0, 1));
  const jan2025End = new Date(Date.UTC(2025, 1, 1));

  // Filter to charges whose subscription covers Jan 2025
  const activeCharges = [];
  for (const charge of allCharges) {
    const txDate = new Date(charge.transaction_date + 'T00:00:00Z');
    const planType = charge.plan_type || 'other';
    const periodMonths = PLAN_PERIOD_MONTHS[planType] || 1;

    const txYear = txDate.getUTCFullYear();
    const txMonth = txDate.getUTCMonth();
    const txDay = txDate.getUTCDate();

    let endDate;
    if (periodMonths < 1) {
      endDate = new Date(txDate.getTime() + 7 * 24 * 60 * 60 * 1000);
    } else {
      const endMonth = txMonth + Math.ceil(periodMonths);
      endDate = new Date(Date.UTC(txYear, endMonth, txDay));
    }

    if (txDate < jan2025End && endDate >= jan2025Start) {
      activeCharges.push(charge);
    }
  }

  console.log('Active charges covering Jan 2025:', activeCharges.length);

  // Group by originating month
  const byOriginMonth = {};
  for (const c of activeCharges) {
    const originMonth = c.transaction_date.substring(0, 7);
    if (!byOriginMonth[originMonth]) byOriginMonth[originMonth] = { count: 0, mrrGross: 0 };
    const period = PLAN_PERIOD_MONTHS[c.plan_type || 'other'] || 1;
    byOriginMonth[originMonth].count++;
    byOriginMonth[originMonth].mrrGross += Number(c.amount_gross) / period;
  }

  console.log('\nOrigin Month | Count | MRR Gross Contribution to Jan 2025');
  console.log('-------------|-------|-----------------------------------');
  let totalMRR = 0;
  for (const month of Object.keys(byOriginMonth).sort()) {
    const { count, mrrGross } = byOriginMonth[month];
    totalMRR += mrrGross;
    console.log(`${month}      | ${String(count).padStart(5)} | $${mrrGross.toFixed(0).padStart(8)}`);
  }
  console.log(`TOTAL        |       | $${totalMRR.toFixed(0)}`);
  console.log(`\nDashboard Jan 2025 Gross: $344,191`);
  console.log(`Tableau Jan 2025 Gross:   $284,078`);
  console.log(`Gap: $${(344191 - 284078).toLocaleString()}`);

  // Now: what if we only count "kinedu_learn" SKUs (Tableau might filter by product)?
  console.log('\n\n═══ Hypothesis: Tableau only counts kinedu_learn (not play/premium) ═══\n');
  const learnCharges = activeCharges.filter(c => (c.sku || '').toLowerCase().includes('kinedu_learn'));
  let learnMRR = 0;
  for (const c of learnCharges) {
    const period = PLAN_PERIOD_MONTHS[c.plan_type || 'other'] || 1;
    learnMRR += Number(c.amount_gross) / period;
  }
  console.log(`kinedu_learn only MRR Gross: $${learnMRR.toFixed(0)} (${learnCharges.length} charges)`);
  console.log(`Tableau: $284,078`);
  console.log(`Diff: ${((learnMRR / 284078 - 1) * 100).toFixed(1)}%`);

  // What if Tableau uses a different spreading period for some plans?
  // E.g., yearly = 12 months (same as us)
  // Let's check if maybe Tableau doesn't spread monthly subs (they contribute 1:1)
  // No that's the same...

  // KEY INSIGHT: check the ratio Dashboard/Tableau for Oct 2024 vs Jan 2025
  console.log('\n\n═══ Ratio pattern analysis ═══\n');
  console.log('Month     | Dashboard Gross | Tableau Gross | Ratio D/T');
  console.log('----------|---------------|--------------|----------');

  const { data: snapshots } = await supabase
    .from('mrr_daily_snapshots')
    .select('snapshot_date, mrr_gross')
    .order('snapshot_date', { ascending: true });

  for (const s of snapshots) {
    const month = s.snapshot_date.substring(0, 7);
    const tab = TABLEAU_GROSS[month];
    if (!tab) continue;
    const dash = Math.round(Number(s.mrr_gross));
    const ratio = (dash / tab).toFixed(3);
    console.log(`${month}   | $${dash.toLocaleString().padStart(11)} | $${tab.toLocaleString().padStart(10)} | ${ratio}`);
  }

  // The data starts Jan 2024. Tableau has data going back further.
  // For spreading, a yearly sub from Feb 2023 contributes to Jan 2024.
  // We miss ALL of that. The gap should shrink as we get further from Jan 2024.
  // Let's quantify: if the "missing" pre-2024 data contributes ~$60K/month
  // then we need to find the gap for Jan 2025 (which is 12 months after our data starts)
  // At that point, ALL yearly subs from Jan 2024 onward are captured.
  // But yearly subs from Dec 2023 and earlier are NOT captured.

  console.log('\n\n═══ Estimating pre-2024 data impact ═══\n');
  console.log('Our data starts Jan 2024. Yearly subs from before contribute to MRR.');
  console.log('By Jan 2025, only subs from Feb-Dec 2023 are "missing" (their yearly period');
  console.log('would overlap with Jan 2025 if bought after Jan 2024).');
  console.log('');
  console.log('The consistent ~$60K gap across all months from Oct 2024 onward');
  console.log('suggests Tableau counts ~$60K/month MORE from pre-2024 yearly subs.');
  console.log('');
  console.log('OR... Tableau is actually showing a DIFFERENT metric than pure MRR Gross.');
}

investigate();
