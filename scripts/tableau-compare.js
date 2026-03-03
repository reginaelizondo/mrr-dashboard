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

// Tableau MRR "Service Date Value" from screenshot
const TABLEAU = {
  '2024-01': 211752,
  '2024-02': 225777,
  '2024-03': 243549,
  '2024-04': 250807,
  '2024-05': 256220,
  '2024-06': 262101,
  '2024-07': 264805,
  '2024-08': 272817,
  '2024-09': 273553,
  '2024-10': 280542,
  '2024-11': 281471,
  '2024-12': 280597,
  '2025-01': 284078,
  '2025-02': 280473,
  '2025-03': 279925,
  '2025-04': 275207,
  '2025-05': 271849,
  '2025-06': 274149,
  '2025-07': 279615,
  '2025-08': 294614,
  '2025-09': 321137,
  '2025-10': 350640,
  '2025-11': 374675,
  '2025-12': 404768,
  '2026-01': 438633,
  '2026-02': 463782,
  '2026-03': 427666, // partial month
};

// Secondary values (the smaller numbers at bottom of each bar)
const TABLEAU_SECONDARY = {
  '2024-01': 166398.42,
  '2024-02': 179001.61,
  '2024-03': 192295.02,
  '2024-04': 200557.37,
  '2024-05': 206427.60,
  '2024-06': 212030.54,
  '2024-07': 216860.41,
  '2024-08': 223923.58,
  '2024-09': 228432.80,
  '2024-10': 235116.02,
  '2024-11': 239885.73,
  '2024-12': 241789.33,
  '2025-01': 242735.16,
  '2025-02': 241324.78,
  '2025-03': 239964.23,
  '2025-04': 238131.00,
  '2025-05': 236328.55,
  '2025-06': 239120.60,
  '2025-07': 245679.01,
  '2025-08': 262124.57,
  '2025-09': 289572.71,
  '2025-10': 319094.68,
  '2025-11': 346888.43,
  '2025-12': 378794.92,
  '2026-01': 412948.11,
  '2026-02': 439774.05,
  '2026-03': 424600.69,
};

async function compare() {
  const { data: snapshots } = await supabase
    .from('mrr_daily_snapshots')
    .select('snapshot_date, mrr_gross, mrr_net')
    .order('snapshot_date', { ascending: true });

  console.log('══════════════════════════════════════════════════════════════════════════════════');
  console.log('  DASHBOARD vs TABLEAU — MRR Comparison (Service Date / Spreading)');
  console.log('══════════════════════════════════════════════════════════════════════════════════\n');

  console.log('Tableau shows a stacked bar with two main values:');
  console.log('  - Top total (e.g. $211,752) = likely MRR Gross');
  console.log('  - Bottom label (e.g. $166,398) = likely the largest segment (Apple?)\n');

  console.log('Month     | Tableau Total | Dashboard Gross | Diff      | %Diff   | Tableau Bottom | Dashboard Net  | Diff');
  console.log('----------|--------------|----------------|-----------|---------|---------------|---------------|--------');

  for (const s of snapshots) {
    const month = s.snapshot_date.substring(0, 7);
    const tabTotal = TABLEAU[month];
    const tabSecondary = TABLEAU_SECONDARY[month];
    if (!tabTotal) continue;

    const dashGross = Math.round(Number(s.mrr_gross));
    const dashNet = Math.round(Number(s.mrr_net));
    const diff = dashGross - tabTotal;
    const pctDiff = ((diff / tabTotal) * 100).toFixed(1);

    const netDiff = tabSecondary ? (dashNet - Math.round(tabSecondary)) : '-';
    const netPctDiff = tabSecondary ? (((dashNet - tabSecondary) / tabSecondary) * 100).toFixed(1) : '-';

    console.log(
      `${month}   | $${tabTotal.toLocaleString().padStart(10)} | $${dashGross.toLocaleString().padStart(12)} | $${diff.toLocaleString().padStart(8)} | ${pctDiff.padStart(5)}%  | $${tabSecondary ? Math.round(tabSecondary).toLocaleString().padStart(10) : '-'.padStart(10)} | $${dashNet.toLocaleString().padStart(11)} | ${netPctDiff}%`
    );
  }

  // Summary
  console.log('\n\nSUMMARY:');
  const stableMonths = Object.keys(TABLEAU).filter(m => m >= '2025-01' && m <= '2026-02');
  let totalTabGross = 0, totalDashGross = 0;
  let totalTabNet = 0, totalDashNet = 0;
  for (const month of stableMonths) {
    const snap = snapshots.find(s => s.snapshot_date.startsWith(month));
    if (!snap) continue;
    totalTabGross += TABLEAU[month];
    totalDashGross += Math.round(Number(snap.mrr_gross));
    if (TABLEAU_SECONDARY[month]) {
      totalTabNet += TABLEAU_SECONDARY[month];
      totalDashNet += Math.round(Number(snap.mrr_net));
    }
  }
  console.log(`  Avg Tableau MRR Gross (2025): $${Math.round(totalTabGross / stableMonths.length).toLocaleString()}`);
  console.log(`  Avg Dashboard MRR Gross (2025): $${Math.round(totalDashGross / stableMonths.length).toLocaleString()}`);
  console.log(`  Dashboard is ${((totalDashGross / totalTabGross - 1) * 100).toFixed(1)}% ${totalDashGross > totalTabGross ? 'HIGHER' : 'LOWER'} than Tableau`);
  console.log(`\n  Avg Tableau secondary (2025): $${Math.round(totalTabNet / stableMonths.length).toLocaleString()}`);
  console.log(`  Avg Dashboard MRR Net (2025): $${Math.round(totalDashNet / stableMonths.length).toLocaleString()}`);
  console.log(`  Dashboard Net is ${((totalDashNet / totalTabNet - 1) * 100).toFixed(1)}% ${totalDashNet > totalTabNet ? 'HIGHER' : 'LOWER'} than Tableau secondary`);
}

compare();
