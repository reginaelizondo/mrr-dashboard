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
  } catch (e) { console.error(e); }
}
loadEnvFile(path.join(__dirname, '..', '.env.local'));

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function verify() {
  const { data: snapshots } = await supabase
    .from('mrr_daily_snapshots')
    .select('*')
    .order('snapshot_date', { ascending: true });

  if (!snapshots) {
    console.error('No snapshots found');
    return;
  }

  console.log('Month       | MRR Gross    | MRR Net      | Apple Net    | Google Net   | Stripe Net');
  console.log('------------|-------------|-------------|-------------|-------------|------------');

  for (const s of snapshots) {
    const month = s.snapshot_date.substring(0, 7);
    const gross = Number(s.mrr_gross || 0);
    const net = Number(s.mrr_net || 0);
    const appleNet = Number(s.mrr_apple_net || 0);
    const googleNet = Number(s.mrr_google_net || 0);
    const stripeNet = Number(s.mrr_stripe_net || 0);

    console.log(
      `${month}     | $${gross.toFixed(0).padStart(9)} | $${net.toFixed(0).padStart(9)} | $${appleNet.toFixed(0).padStart(9)} | $${googleNet.toFixed(0).padStart(9)} | $${stripeNet.toFixed(0).padStart(8)}`
    );
  }

  // Compare with Kinedu DB data we know:
  // Jan 2025 Kinedu DB total gross: $326,144 (from CSV import)
  // Kinedu DB MRR contribution (spreading, Jan 2025 sales only): ~$63,466
  // But dashboard MRR = SUM of all months' spreading contributions that cover Jan 2025
  console.log('\n');
  console.log('Key months for Tableau comparison:');

  const jan25 = snapshots.find(s => s.snapshot_date.startsWith('2025-01'));
  if (jan25) {
    console.log(`  Jan 2025: MRR Gross = $${Number(jan25.mrr_gross).toFixed(0)}, MRR Net = $${Number(jan25.mrr_net).toFixed(0)}`);
  }

  const oct24 = snapshots.find(s => s.snapshot_date.startsWith('2024-10'));
  if (oct24) {
    console.log(`  Oct 2024: MRR Gross = $${Number(oct24.mrr_gross).toFixed(0)}, MRR Net = $${Number(oct24.mrr_net).toFixed(0)}`);
  }

  const jan26 = snapshots.find(s => s.snapshot_date.startsWith('2026-01'));
  if (jan26) {
    console.log(`  Jan 2026: MRR Gross = $${Number(jan26.mrr_gross).toFixed(0)}, MRR Net = $${Number(jan26.mrr_net).toFixed(0)}`);
  }

  const feb26 = snapshots.find(s => s.snapshot_date.startsWith('2026-02'));
  if (feb26) {
    console.log(`  Feb 2026: MRR Gross = $${Number(feb26.mrr_gross).toFixed(0)}, MRR Net = $${Number(feb26.mrr_net).toFixed(0)}`);
  }
}

verify();
