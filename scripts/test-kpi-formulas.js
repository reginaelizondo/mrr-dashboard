/**
 * Test KPI formulas against BigQuery for validation against Data Studio.
 * Run: node scripts/test-kpi-formulas.js
 */

const { BigQuery } = require('@google-cloud/bigquery');

const bq = new BigQuery({
  keyFilename: './bigquery-service-account.json',
  projectId: 'celtic-music-240111',
});

// Inline copy of formulas (CommonJS — keep in sync with lib/kpi/formulas.ts)
const KPI_SQL = {
  newSubs: `(SUM(new_subscriptions) + SUM(num_of_refunds_sale_date))`,
  nsSales: `(SUM(new_subscriptions_sales) + SUM(refunds_total_amount_sale_date))`,
  spend: `SUM(spend)`,
  signups: `SUM(signups)`,
  cac: `SAFE_DIVIDE(SUM(spend), SUM(new_subscriptions) + SUM(num_of_refunds_sale_date))`,
  conversionRate: `SAFE_DIVIDE(SUM(new_subscriptions) + SUM(num_of_refunds_sale_date), SUM(signups))`,
  totalRenewalSales: `(SUM(renewals_sales_yearly_ios) + SUM(renewals_sales))`,
  totalSales: `(
    SUM(renewals_sales) + SUM(renewals_sales_yearly_ios) + SUM(new_subscriptions_sales)
    + SUM(other_sales) + SUM(refunds_total_amount_sale_date) - SUM(refunds_total_amount_refund_date)
  )`,
  arpu: `SAFE_DIVIDE(
    SUM(new_subscriptions_sales) + SUM(refunds_total_amount_sale_date) + SUM(other_sales),
    SUM(new_subscriptions) + SUM(num_of_refunds_sale_date) + SUM(other_purchases)
  )`,
  netSales: `(
    SUM(IF(network = "stripe", other_sales, 0)) * 0.97
    + SUM(IF(network = "shopify", other_sales, 0)) * 0.98
    + ((SUM(IF(os = "iOS", renewals_sales, 0)) + SUM(IF(os = "iOS", new_subscriptions_sales, 0))
        + SUM(IF(os = "iOS", refunds_total_amount_sale_date, 0))) * 0.7)
    + (SUM(renewals_sales_yearly_ios) * 0.85)
    + ((SUM(IF(os = "Android", renewals_sales, 0)) + SUM(IF(os = "Android", new_subscriptions_sales, 0))
        + SUM(IF(os = "Android", refunds_total_amount_sale_date, 0))) * 0.85)
    + ((SUM(IF(os = "Unknown", renewals_sales, 0)) + SUM(IF(os = "Unknown", new_subscriptions_sales, 0))
        + SUM(IF(os = "Unknown", refunds_total_amount_sale_date, 0))) * 0.98)
    + ((SUM(IF(os = "Web", renewals_sales, 0)) + SUM(IF(os = "Web", new_subscriptions_sales, 0))
        + SUM(IF(os = "Web", refunds_total_amount_sale_date, 0))) * 0.98)
    - ((SUM(IF(os = "Android" OR os = "iOS", renewals_sales, 0)) + SUM(renewals_sales_yearly_ios)
        + SUM(IF(os = "Android" OR os = "iOS", new_subscriptions_sales, 0))
        + SUM(IF(os = "Android" OR os = "iOS", refunds_total_amount_sale_date, 0))) * 0.06)
    - SUM(refunds_total_amount_refund_date) * SAFE_DIVIDE(
        SUM(IF(network = "stripe", other_sales, 0)) * 0.97
        + SUM(IF(network = "shopify", other_sales, 0)) * 0.98
        + ((SUM(IF(os = "iOS", renewals_sales, 0)) + SUM(IF(os = "iOS", new_subscriptions_sales, 0))) * 0.7)
        + (SUM(renewals_sales_yearly_ios) * 0.85)
        + ((SUM(IF(os = "Android", renewals_sales, 0)) + SUM(IF(os = "Android", new_subscriptions_sales, 0))) * 0.85)
        + ((SUM(IF(os = "Unknown", renewals_sales, 0)) + SUM(IF(os = "Unknown", new_subscriptions_sales, 0))) * 0.98)
        + ((SUM(IF(os = "Web", renewals_sales, 0)) + SUM(IF(os = "Web", new_subscriptions_sales, 0))) * 0.98)
        - ((SUM(IF(os = "Android" OR os = "iOS", renewals_sales, 0)) + SUM(renewals_sales_yearly_ios)
            + SUM(IF(os = "Android" OR os = "iOS", new_subscriptions_sales, 0))) * 0.06),
        SUM(renewals_sales) + SUM(renewals_sales_yearly_ios) + SUM(new_subscriptions_sales) + SUM(other_sales)
      )
  )`,
};

const PERIODS = [
  { label: 'Semana 13-19 abril 2026', start: '2026-04-13', end: '2026-04-19' },
  { label: 'Semana 6-12 abril 2026',  start: '2026-04-06', end: '2026-04-12' },
];

async function runForPeriod({ label, start, end }) {
  const selectClause = Object.entries(KPI_SQL)
    .map(([key, sql]) => `  ${sql} AS ${key}`)
    .join(',\n');

  const query = `
    SELECT
${selectClause}
    FROM \`celtic-music-240111.dbt_prod_analytics.an_operational_dash\`
    WHERE date BETWEEN @start AND @end
  `;

  const [rows] = await bq.query({ query, params: { start, end } });
  return { label, start, end, kpis: rows[0] };
}

function pct(curr, prev) {
  if (prev === 0 || prev === null || prev === undefined) return 'n/a';
  const v = ((curr - prev) / prev) * 100;
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function fmtNum(v, key) {
  if (v === null || v === undefined) return 'null';
  if (key === 'cac' || key === 'arpu') return `$${Number(v).toFixed(2)}`;
  if (key === 'conversionRate') return `${(Number(v) * 100).toFixed(2)}%`;
  if (['nsSales', 'totalRenewalSales', 'totalSales', 'netSales', 'spend'].includes(key))
    return `$${Math.round(Number(v)).toLocaleString('en-US')}`;
  return Math.round(Number(v)).toLocaleString('en-US');
}

(async () => {
  console.log('🔍 Corriendo KPIs en BigQuery (puede tardar 5-10 seg)...\n');
  const results = await Promise.all(PERIODS.map(runForPeriod));
  const [last, prev] = results;

  console.log(`📊 KPIs comparados — Validar contra Data Studio:\n`);
  console.log(`   Período actual:  ${last.label}`);
  console.log(`   Período previo:  ${prev.label}\n`);

  const keys = Object.keys(KPI_SQL);
  const padKey = Math.max(...keys.map(k => k.length));

  console.log(`${'KPI'.padEnd(padKey)}  ${'Actual'.padStart(15)}  ${'Previo'.padStart(15)}  ${'WoW'.padStart(8)}`);
  console.log('-'.repeat(padKey + 45));

  for (const k of keys) {
    const c = Number(last.kpis[k]);
    const p = Number(prev.kpis[k]);
    console.log(
      `${k.padEnd(padKey)}  ${fmtNum(c, k).padStart(15)}  ${fmtNum(p, k).padStart(15)}  ${pct(c, p).padStart(8)}`
    );
  }
  console.log('\n✅ Listo. Compara estos números contra los mismos rangos en Data Studio para validar.');
})().catch(e => { console.error('❌ ERROR:', e.message); process.exit(1); });
