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

const TABLEAU = {
  '2024-01': 211752, '2024-02': 225777, '2024-03': 243549,
  '2024-04': 250807, '2024-05': 256220, '2024-06': 262101,
  '2024-07': 264805, '2024-08': 272817, '2024-09': 273553,
  '2024-10': 280542, '2024-11': 281471, '2024-12': 280597,
  '2025-01': 284078, '2025-02': 280473, '2025-03': 279925,
  '2025-04': 275207, '2025-05': 271849, '2025-06': 274149,
  '2025-07': 279615, '2025-08': 294614, '2025-09': 321137,
  '2025-10': 350640, '2025-11': 374675, '2025-12': 404768,
  '2026-01': 438633, '2026-02': 463782, '2026-03': 427666,
};

// The SECONDARY value from Tableau (the number at the bottom of each bar)
const TABLEAU_BOTTOM = {
  '2024-01': 166398, '2024-02': 179002, '2024-03': 192295,
  '2024-04': 200557, '2024-05': 206428, '2024-06': 212031,
  '2024-07': 216860, '2024-08': 223924, '2024-09': 228433,
  '2024-10': 235116, '2024-11': 239886, '2024-12': 241789,
  '2025-01': 242735, '2025-02': 241325, '2025-03': 239964,
  '2025-04': 238131, '2025-05': 236329, '2025-06': 239121,
  '2025-07': 245679, '2025-08': 262125, '2025-09': 289573,
  '2025-10': 319095, '2025-11': 346888, '2025-12': 378795,
  '2026-01': 412948, '2026-02': 439774, '2026-03': 424601,
};

async function test() {
  const { data: snapshots } = await supabase
    .from('mrr_daily_snapshots')
    .select('snapshot_date, mrr_gross, mrr_net, mrr_apple_gross, mrr_google_gross, mrr_stripe_gross')
    .order('snapshot_date', { ascending: true });

  // Hypothesis 1: Tableau top = Gross, bottom = Apple only
  // Hypothesis 2: Tableau shows Net with Apple 15%, Google 15%, Stripe ~3%
  // Hypothesis 3: Tableau shows something between Gross and Net

  console.log('Testing different hypotheses for what Tableau displays:\n');
  console.log('Month     | Tab Total | Tab Bottom | Dash Gross | Dash Net(30%) | Net(15%)    | Apple Gross | Apple*85%');
  console.log('----------|-----------|-----------|-----------|-------------|-------------|------------|----------');

  for (const s of snapshots) {
    const month = s.snapshot_date.substring(0, 7);
    const tabTotal = TABLEAU[month];
    const tabBottom = TABLEAU_BOTTOM[month];
    if (!tabTotal) continue;

    const gross = Math.round(Number(s.mrr_gross));
    const net30 = Math.round(Number(s.mrr_net)); // Apple 30%
    const appleGross = Math.round(Number(s.mrr_apple_gross));
    const googleGross = Math.round(Number(s.mrr_google_gross));
    const stripeGross = Math.round(Number(s.mrr_stripe_gross));

    // Net with Apple 15% instead of 30%
    const net15 = Math.round(appleGross * 0.85 + googleGross * 0.85 + stripeGross * 0.971);

    // Apple * 85% (Apple portion after 15% commission)
    const apple85 = Math.round(appleGross * 0.85);

    console.log(
      `${month}   | $${tabTotal.toLocaleString().padStart(7)} | $${tabBottom.toLocaleString().padStart(7)} | $${gross.toLocaleString().padStart(7)} | $${net30.toLocaleString().padStart(9)} | $${net15.toLocaleString().padStart(9)} | $${appleGross.toLocaleString().padStart(8)} | $${apple85.toLocaleString().padStart(7)}`
    );
  }

  // Now compute the BEST hypothesis by minimizing error
  console.log('\n\n═══ ERROR ANALYSIS (2025-01 to 2026-02 = stable months) ═══\n');

  const stableMonths = Object.keys(TABLEAU).filter(m => m >= '2025-01' && m <= '2026-02');

  const hypotheses = {
    'Dashboard Gross': [],
    'Dashboard Net (Apple 30%)': [],
    'Net (Apple 15%)': [],
    'Gross * 0.825': [],
  };

  for (const month of stableMonths) {
    const s = snapshots.find(x => x.snapshot_date.startsWith(month));
    if (!s) continue;

    const tabTotal = TABLEAU[month];
    const gross = Number(s.mrr_gross);
    const net30 = Number(s.mrr_net);
    const appleGross = Number(s.mrr_apple_gross);
    const googleGross = Number(s.mrr_google_gross);
    const stripeGross = Number(s.mrr_stripe_gross);
    const net15 = appleGross * 0.85 + googleGross * 0.85 + stripeGross * 0.971;

    hypotheses['Dashboard Gross'].push(Math.abs(gross - tabTotal) / tabTotal * 100);
    hypotheses['Dashboard Net (Apple 30%)'].push(Math.abs(net30 - tabTotal) / tabTotal * 100);
    hypotheses['Net (Apple 15%)'].push(Math.abs(net15 - tabTotal) / tabTotal * 100);
    hypotheses['Gross * 0.825'].push(Math.abs(gross * 0.825 - tabTotal) / tabTotal * 100);
  }

  // Also test against BOTTOM value
  const bottomHyp = {
    'vs Apple Gross': [],
    'vs Apple*85% (15% comm)': [],
    'vs Dashboard Net (30%)': [],
  };

  for (const month of stableMonths) {
    const s = snapshots.find(x => x.snapshot_date.startsWith(month));
    if (!s) continue;

    const tabBottom = TABLEAU_BOTTOM[month];
    const net30 = Number(s.mrr_net);
    const appleGross = Number(s.mrr_apple_gross);
    const apple85 = appleGross * 0.85;

    bottomHyp['vs Apple Gross'].push(Math.abs(appleGross - tabBottom) / tabBottom * 100);
    bottomHyp['vs Apple*85% (15% comm)'].push(Math.abs(apple85 - tabBottom) / tabBottom * 100);
    bottomHyp['vs Dashboard Net (30%)'].push(Math.abs(net30 - tabBottom) / tabBottom * 100);
  }

  console.log('Hypothesis (vs Tableau TOP number):');
  for (const [name, errs] of Object.entries(hypotheses)) {
    const avg = errs.reduce((a, b) => a + b, 0) / errs.length;
    console.log(`  ${name.padEnd(30)}: avg error = ${avg.toFixed(1)}%`);
  }

  console.log('\nHypothesis (vs Tableau BOTTOM number):');
  for (const [name, errs] of Object.entries(bottomHyp)) {
    const avg = errs.reduce((a, b) => a + b, 0) / errs.length;
    console.log(`  ${name.padEnd(30)}: avg error = ${avg.toFixed(1)}%`);
  }
}

test();
