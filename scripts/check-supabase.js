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

async function check() {
  // Count current transactions
  const { count: total } = await supabase.from('transactions').select('*', { count: 'exact', head: true });
  console.log('Total transactions in Supabase:', total);

  // Count by source
  for (const src of ['apple', 'google', 'stripe']) {
    const { count } = await supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('source', src);
    console.log('  ' + src + ':', count);
  }

  // Count kinedu-sourced
  const { count: kinedu } = await supabase.from('transactions').select('*', { count: 'exact', head: true }).like('external_id', 'kinedu_sale_%');
  console.log('  kinedu_sale_ prefixed:', kinedu);

  // Check date range
  const { data: minD } = await supabase.from('transactions').select('transaction_date').order('transaction_date', { ascending: true }).limit(1);
  const { data: maxD } = await supabase.from('transactions').select('transaction_date').order('transaction_date', { ascending: false }).limit(1);
  if (minD && minD[0]) console.log('Date range:', minD[0].transaction_date, '->', maxD[0].transaction_date);
}
check();
