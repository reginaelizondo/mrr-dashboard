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

async function fetchAll(fromDate, toDate) {
  const txs = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .gte('transaction_date', fromDate)
      .lt('transaction_date', toDate)
      .eq('transaction_type', 'charge')
      .range(offset, offset + 999);
    if (error || !data || data.length === 0) { hasMore = false; break; }
    for (const d of data) txs.push(d);
    offset += data.length;
    hasMore = data.length === 1000;
  }
  return txs;
}

async function investigate() {
  // Focus on Jan 2025: Dashboard Gross $344K vs Tableau $284K = +$60K gap
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  INVESTIGATING: Why Dashboard Gross $344K vs Tableau $284K');
  console.log('  Month: January 2025 (gap of +$60K / +21%)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const txs = await fetchAll('2025-01-01', '2025-02-01');
  console.log('Total Jan 2025 charges:', txs.length);

  // Breakdown by plan_type
  console.log('\n--- By Plan Type ---');
  const byPlan = {};
  for (const t of txs) {
    const pt = t.plan_type || 'other';
    if (!byPlan[pt]) byPlan[pt] = { count: 0, gross: 0, mrrContrib: 0 };
    byPlan[pt].count++;
    byPlan[pt].gross += Number(t.amount_gross);
    const periods = { monthly: 1, yearly: 12, semesterly: 6, quarterly: 3, lifetime: 60, other: 1 };
    byPlan[pt].mrrContrib += Number(t.amount_gross) / (periods[pt] || 1);
  }
  for (const [pt, v] of Object.entries(byPlan)) {
    console.log(`  ${pt.padEnd(12)}: ${v.count} txs, $${v.gross.toFixed(0)} cash, $${v.mrrContrib.toFixed(0)} MRR contrib`);
  }

  // Breakdown by source
  console.log('\n--- By Source ---');
  const bySource = {};
  for (const t of txs) {
    const src = t.source;
    if (!bySource[src]) bySource[src] = { count: 0, gross: 0, mrrContrib: 0 };
    bySource[src].count++;
    bySource[src].gross += Number(t.amount_gross);
    const periods = { monthly: 1, yearly: 12, semesterly: 6, quarterly: 3, lifetime: 60, other: 1 };
    bySource[src].mrrContrib += Number(t.amount_gross) / (periods[t.plan_type || 'other'] || 1);
  }
  for (const [src, v] of Object.entries(bySource)) {
    console.log(`  ${src.padEnd(8)}: ${v.count} txs, $${v.gross.toFixed(0)} cash, $${v.mrrContrib.toFixed(0)} MRR contrib`);
  }

  // Check for potential "kinedu_play" vs "kinedu_learn" split
  console.log('\n--- By SKU product (kinedu_learn vs kinedu_play vs kinedu_premium vs other) ---');
  const byProduct = {};
  for (const t of txs) {
    const sku = (t.sku || '').toLowerCase();
    let product;
    if (sku.includes('kinedu_learn')) product = 'kinedu_learn';
    else if (sku.includes('kinedu_play')) product = 'kinedu_play';
    else if (sku.includes('kinedu_premium')) product = 'kinedu_premium';
    else product = 'other: ' + sku.substring(0, 30);
    if (!byProduct[product]) byProduct[product] = { count: 0, gross: 0, mrrContrib: 0 };
    byProduct[product].count++;
    byProduct[product].gross += Number(t.amount_gross);
    const periods = { monthly: 1, yearly: 12, semesterly: 6, quarterly: 3, lifetime: 60, other: 1 };
    byProduct[product].mrrContrib += Number(t.amount_gross) / (periods[t.plan_type || 'other'] || 1);
  }
  for (const [p, v] of Object.entries(byProduct).sort((a, b) => b[1].gross - a[1].gross)) {
    console.log(`  ${p.padEnd(25)}: ${v.count} txs, $${v.gross.toFixed(0)} cash, $${v.mrrContrib.toFixed(0)} MRR contrib`);
  }

  // Now check: if Tableau only counts "kinedu_learn" (their main subscription product),
  // what would the MRR be?
  console.log('\n--- Hypothesis: Tableau might only include kinedu_learn ---');
  const learnOnly = txs.filter(t => (t.sku || '').toLowerCase().includes('kinedu_learn'));
  const periods = { monthly: 1, yearly: 12, semesterly: 6, quarterly: 3, lifetime: 60, other: 1 };
  const learnMRR = learnOnly.reduce((acc, t) => acc + Number(t.amount_gross) / (periods[t.plan_type || 'other'] || 1), 0);
  console.log(`  kinedu_learn only MRR: $${learnMRR.toFixed(0)} (${learnOnly.length} txs)`);

  // Without kinedu_play
  const noPlay = txs.filter(t => !(t.sku || '').toLowerCase().includes('kinedu_play'));
  const noPlayMRR = noPlay.reduce((acc, t) => acc + Number(t.amount_gross) / (periods[t.plan_type || 'other'] || 1), 0);
  console.log(`  Without kinedu_play MRR: $${noPlayMRR.toFixed(0)} (${noPlay.length} txs)`);

  // Only charges where renewed_automatically = 1 OR is_new_subscription = true
  // (maybe Tableau excludes resubscriptions or something)
  const newAndRenew = txs.filter(t => t.is_new_subscription || t.is_renewal);
  const nrMRR = newAndRenew.reduce((acc, t) => acc + Number(t.amount_gross) / (periods[t.plan_type || 'other'] || 1), 0);
  console.log(`  Only new+renewal MRR: $${nrMRR.toFixed(0)} (${newAndRenew.length} txs)`);

  // Now, the FULL spreading MRR for Jan 2025 includes charges from previous months
  // Let's check what the snapshot actually computed
  console.log('\n--- Full Spreading MRR (snapshot includes lookback) ---');
  console.log('  Dashboard Jan 2025 MRR Gross: $344,191');
  console.log('  Tableau  Jan 2025 MRR Total:  $284,078');
  console.log('  Gap: $60,113 = +21.2%');
  console.log('  This gap is from contributions of ALL months (spreading lookback)');

  // The ~21% gap is consistent. Let's check if it's proportional.
  // $344K * 0.825 = $283K ≈ $284K Tableau!
  // So 82.5% of our Gross ≈ Tableau's number.
  // Apple 70%, Google 85%, Stripe 97% proceeds...
  // Weighted average commission rate?
  const totalGross = txs.reduce((acc, t) => acc + Number(t.amount_gross), 0);
  const totalNet = txs.reduce((acc, t) => acc + Number(t.amount_net), 0);
  const avgProceedsRate = totalNet / totalGross;
  console.log(`\n  Avg proceeds rate (Net/Gross): ${(avgProceedsRate * 100).toFixed(1)}%`);
  console.log(`  Dashboard Gross * ${(avgProceedsRate * 100).toFixed(1)}% = $${(344191 * avgProceedsRate).toFixed(0)}`);
  console.log(`  Tableau total: $284,078`);

  // Check: maybe Tableau shows NET not GROSS?
  // Our Net is $251,557 vs Tableau $284,078
  // Hmm, Tableau is between our Gross ($344K) and Net ($252K)
  // Maybe Tableau uses a DIFFERENT commission rate?
  // $284K / $344K = 82.6%... that's close to Apple's 15% (long-term developers get reduced rate)
  const ratio = 284078 / 344191;
  console.log(`\n  Tableau/Dashboard ratio: ${(ratio * 100).toFixed(1)}%`);
  console.log(`  This means Tableau applies ~${((1 - ratio) * 100).toFixed(1)}% overall commission`);
  console.log(`  Compare with Apple 30% → if Apple is 15% (reduced rate for >1yr subs):`);

  // Recalculate with Apple 15% instead of 30%
  let netWith15 = 0;
  for (const t of txs) {
    const amt = Number(t.amount_gross);
    let rate;
    if (t.source === 'apple') rate = 0.15;
    else if (t.source === 'google') rate = 0.15;
    else rate = 0.029;
    netWith15 += amt * (1 - rate);
  }
  console.log(`\n  If Apple commission = 15%: Jan 2025 cash net = $${netWith15.toFixed(0)}`);
  console.log(`  Our current (Apple 30%): $${totalNet.toFixed(0)}`);
}

investigate();
