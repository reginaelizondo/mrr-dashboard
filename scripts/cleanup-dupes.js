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

async function cleanup() {
  console.log('Cleaning up non-kinedu transactions...');

  // Delete ALL charge transactions that DON'T have kinedu_sale_ prefix
  // These are leftover Apple/Google/Stripe API data
  const { error, count } = await supabase
    .from('transactions')
    .delete()
    .eq('transaction_type', 'charge')
    .not('external_id', 'like', 'kinedu_sale_%');

  if (error) {
    console.error('Error:', error.message);
  } else {
    console.log('Deleted non-kinedu charge transactions');
  }

  // Also delete any refund transactions (we don't have refund data from Kinedu DB)
  const { error: refErr } = await supabase
    .from('transactions')
    .delete()
    .neq('transaction_type', 'charge')
    .not('external_id', 'like', 'kinedu_sale_%');

  if (refErr) {
    console.warn('Refund cleanup error:', refErr.message);
  } else {
    console.log('Deleted non-kinedu refund/other transactions');
  }

  // Verify
  const { count: total } = await supabase.from('transactions').select('*', { count: 'exact', head: true });
  const { count: kinedu } = await supabase.from('transactions').select('*', { count: 'exact', head: true }).like('external_id', 'kinedu_sale_%');
  console.log('\nFinal state:');
  console.log('  Total:', total);
  console.log('  Kinedu:', kinedu);

  // By source
  for (const src of ['apple', 'google', 'stripe']) {
    const { count: c } = await supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('source', src);
    console.log('  ' + src + ':', c);
  }
}

cleanup();
