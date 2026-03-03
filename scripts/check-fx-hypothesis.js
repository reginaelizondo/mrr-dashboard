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
    const { data } = await supabase
      .from('transactions')
      .select('amount_gross, original_amount, original_currency, source, plan_type, is_renewal, is_new_subscription')
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

const PLAN_PERIOD_MONTHS = {
  monthly: 1, yearly: 12, semesterly: 6, quarterly: 3, lifetime: 60, other: 1,
};

async function check() {
  // Focus on Jan 2025 cash basis first
  const jan = await fetchAll('2025-01-01', '2025-02-01');

  console.log('═══ Jan 2025 Cash Basis Analysis ═══\n');
  console.log('Total transactions:', jan.length);

  // Total gross
  const totalGross = jan.reduce((a, t) => a + Number(t.amount_gross), 0);
  console.log('Total amount_gross (usd_amount):', totalGross.toFixed(0));

  // Currency breakdown
  const byCurrency = {};
  for (const t of jan) {
    const cur = t.original_currency || 'USD';
    if (!byCurrency[cur]) byCurrency[cur] = { count: 0, grossUSD: 0, originalSum: 0 };
    byCurrency[cur].count++;
    byCurrency[cur].grossUSD += Number(t.amount_gross);
    byCurrency[cur].originalSum += Number(t.original_amount);
  }

  console.log('\nCurrency | Count | USD Gross   | Original Sum | Implied FX Rate');
  console.log('---------|-------|------------|-------------|---------------');
  for (const [cur, v] of Object.entries(byCurrency).sort((a, b) => b[1].grossUSD - a[1].grossUSD).slice(0, 15)) {
    const fxRate = v.originalSum / v.grossUSD;
    console.log(`${cur.padEnd(8)} | ${String(v.count).padStart(5)} | $${v.grossUSD.toFixed(0).padStart(8)} | ${v.originalSum.toFixed(0).padStart(11)} | ${fxRate.toFixed(3)}`);
  }

  // MRR contribution by plan_type for Jan 2025 only
  console.log('\n\n═══ Jan 2025 MRR by plan_type (THIS month charges only) ═══\n');
  const byPlan = {};
  for (const t of jan) {
    const pt = t.plan_type || 'other';
    if (!byPlan[pt]) byPlan[pt] = { count: 0, gross: 0, mrr: 0 };
    byPlan[pt].count++;
    byPlan[pt].gross += Number(t.amount_gross);
    byPlan[pt].mrr += Number(t.amount_gross) / (PLAN_PERIOD_MONTHS[pt] || 1);
  }
  console.log('Plan Type   | Count | Cash Gross | MRR Contribution');
  for (const [pt, v] of Object.entries(byPlan).sort((a, b) => b[1].mrr - a[1].mrr)) {
    console.log(`${pt.padEnd(12)}| ${String(v.count).padStart(5)} | $${v.gross.toFixed(0).padStart(8)} | $${v.mrr.toFixed(0).padStart(8)}`);
  }

  // New vs Renewal breakdown
  console.log('\n\n═══ New vs Renewal (Jan 2025) ═══\n');
  const newSubs = jan.filter(t => t.is_new_subscription);
  const renewals = jan.filter(t => t.is_renewal);
  const newGross = newSubs.reduce((a, t) => a + Number(t.amount_gross), 0);
  const renGross = renewals.reduce((a, t) => a + Number(t.amount_gross), 0);
  console.log(`New subs:  ${newSubs.length} txs, $${newGross.toFixed(0)} gross (${(newGross/totalGross*100).toFixed(1)}%)`);
  console.log(`Renewals:  ${renewals.length} txs, $${renGross.toFixed(0)} gross (${(renGross/totalGross*100).toFixed(1)}%)`);

  // KEY TEST: What if Tableau applies Apple 30% and Google 30% to ALL transactions?
  // (not differentiating new vs renewal)
  console.log('\n\n═══ What-If Scenarios for Tableau MRR ($284,078) ═══\n');

  // Our snapshot MRR Gross = $344,191
  // Tableau = $284,078
  // Ratio = 0.825 → ~17.5% deduction

  // Scenario A: Tableau applies flat ~17.5% to Gross
  console.log(`Dashboard Gross: $344,191`);
  console.log(`Tableau:         $284,078`);
  console.log(`Ratio:           ${(284078/344191*100).toFixed(1)}% = Tableau is ${((1-284078/344191)*100).toFixed(1)}% less`);

  // Scenario B: Tableau Net with Apple/Google 30% flat (no 15% for renewals)
  // We computed with 30%/15%, let's see what pure 30% gives
  // Apple is ~82% of MRR, Google ~15%, Stripe ~3%
  // With 30%: Apple*0.70 + Google*0.70 + Stripe*0.971
  // = 0.82*0.70 + 0.15*0.70 + 0.03*0.971 = 0.574 + 0.105 + 0.029 = 0.708
  // Dashboard Gross * 0.708 = $243K → too low
  console.log(`\nWith flat 30% Apple/Google: $${(344191*0.708).toFixed(0)} → too low`);

  // Scenario C: Tableau uses "proceeds" field from caf_sales which has actual App Store proceeds
  // Those proceeds = Gross * (1 - blended commission)
  // Blended = mix of 30% new + 15% renewal
  // $284K / $344K = 82.5% → blended commission = 17.5%
  // This matches our 30% new / 15% renewal if ~50% are new
  const pctNew = newSubs.length / jan.length;
  const blendedRate = pctNew * 0.30 + (1 - pctNew) * 0.15;
  console.log(`\n% new subs (Jan 2025): ${(pctNew*100).toFixed(1)}%`);
  console.log(`Blended commission: ${(blendedRate*100).toFixed(1)}%`);
  console.log(`Gross * (1 - ${(blendedRate*100).toFixed(1)}%) = $${(344191*(1-blendedRate)).toFixed(0)}`);
  console.log(`Tableau: $284,078`);

  // Scenario D: We have MORE transactions than Tableau because their pipeline filters more
  // Let's count how many charges from the FULL spreading contribute >$0
  // If we assume Tableau only counts yearly plans (main subscription, not monthly)
  const yearlyJan = jan.filter(t => t.plan_type === 'yearly');
  const monthlyJan = jan.filter(t => t.plan_type === 'monthly');
  console.log(`\nYearly Jan charges: ${yearlyJan.length}, $${yearlyJan.reduce((a,t) => a + Number(t.amount_gross), 0).toFixed(0)}`);
  console.log(`Monthly Jan charges: ${monthlyJan.length}, $${monthlyJan.reduce((a,t) => a + Number(t.amount_gross), 0).toFixed(0)}`);
  console.log(`If MRR = yearly_mrr_contrib + monthly_cash:`);
  const yearlyMRR = yearlyJan.reduce((a,t) => a + Number(t.amount_gross)/12, 0);
  const monthlyCash = monthlyJan.reduce((a,t) => a + Number(t.amount_gross), 0);
  console.log(`  Jan charges only: $${yearlyMRR.toFixed(0)} + $${monthlyCash.toFixed(0)} = $${(yearlyMRR + monthlyCash).toFixed(0)}`);
}

check();
