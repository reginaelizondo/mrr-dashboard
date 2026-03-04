import { createServerClient } from '@/lib/supabase/server';
import type { MrrDailySnapshot, Transaction, PlanType } from '@/types';

// Period in months for each plan type
const PLAN_PERIOD_MONTHS: Record<string, number> = {
  monthly: 1,
  yearly: 12,
  semesterly: 6,
  quarterly: 3,
  weekly: 0.25, // ~1 week ≈ 0.25 months
  lifetime: 60, // 5 years
  other: 1,
};

/**
 * Compute MRR snapshot for a given month.
 *
 * MRR = sum of (amount / period_months) for ALL charges whose subscription
 * period covers the snapshot month (spreading / service-date methodology).
 *
 * For example, a yearly charge of $79.99 on 2025-03-15 contributes $79.99/12 = $6.67
 * to every monthly snapshot from 2025-03 through 2026-02.
 *
 * The snapshot is always stored as YYYY-MM-01 (first of month) regardless of input date.
 */
export async function computeMonthlySnapshot(date: string): Promise<void> {
  const supabase = createServerClient();

  const snapshotDate = new Date(date + 'T00:00:00Z');
  const snapshotYear = snapshotDate.getUTCFullYear();
  const snapshotMonth = snapshotDate.getUTCMonth();

  const monthStart = new Date(Date.UTC(snapshotYear, snapshotMonth, 1));
  const monthEnd = new Date(Date.UTC(snapshotYear, snapshotMonth + 1, 1));

  const monthStartStr = monthStart.toISOString().split('T')[0];
  const monthEndStr = monthEnd.toISOString().split('T')[0];

  // Lookback 5 years for lifetime subs
  const lookbackDate = new Date(Date.UTC(snapshotYear - 5, snapshotMonth, 1));
  const lookbackStr = lookbackDate.toISOString().split('T')[0];

  // Fetch ALL charges from lookback to snapshot month end (pagination)
  const charges: Transaction[] = [];
  const PAGE_SIZE = 1000;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data: page, error: chargeError } = await supabase
      .from('transactions')
      .select('*')
      .eq('transaction_type', 'charge')
      .gte('transaction_date', lookbackStr)
      .lt('transaction_date', monthEndStr)
      .order('transaction_date', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (chargeError) {
      throw new Error(`Snapshot charge query error: ${chargeError.message}`);
    }

    if (page && page.length > 0) {
      for (const p of page) {
        charges.push(p as Transaction);
      }
      offset += page.length;
      hasMore = page.length === PAGE_SIZE;
    } else {
      hasMore = false;
    }
  }

  console.log(`[Snapshot ${monthStartStr}] Fetched ${charges.length} charges (lookback from ${lookbackStr})`);

  // ─── Data quality filters (align with Tableau's DBT pipeline) ───
  // 1. Exclude test charges (plan_name contains "Test")
  // 2. Exclude non-subscription Stripe charges (ebooks, masterclass, invoices)
  //    → Tableau tracks these separately as "other_sales"
  // 3. Exclude plan_type='other' (unclassified charges)
  const beforeFilter = charges.length;
  const filteredCharges = charges.filter((t) => {
    const planName = (t.plan_name || '').toLowerCase();
    // Exclude test charges
    if (planName.includes('test')) return false;
    // Exclude Stripe non-subscription charges (one-off products, invoices)
    if (t.source === 'stripe') {
      if (planName.endsWith(' charge')) return false;        // ebooks, masterclass, bundles
      if (planName === 'payment for invoice') return false;  // B2B invoices
      if (planName === 'none') return false;                 // unclassified
    }
    // Exclude unclassified plan types
    if (t.plan_type === 'other') return false;
    return true;
  });
  // Replace charges array content with filtered (avoid spread to prevent stack overflow on large arrays)
  charges.length = 0;
  for (let fi = 0; fi < filteredCharges.length; fi++) {
    charges.push(filteredCharges[fi]);
  }
  console.log(`[Snapshot ${monthStartStr}] After quality filters: ${charges.length} of ${beforeFilter} (excluded ${beforeFilter - charges.length})`);

  // Fetch refunds, taxes, disputes for THIS month only (point-in-time)
  const { data: monthTx, error: monthError } = await supabase
    .from('transactions')
    .select('*')
    .gte('transaction_date', monthStartStr)
    .lt('transaction_date', monthEndStr)
    .neq('transaction_type', 'charge')
    .limit(10000);

  if (monthError) {
    throw new Error(`Snapshot month query error: ${monthError.message}`);
  }

  const otherTx = (monthTx || []) as Transaction[];

  // Filter charges to only those whose subscription period covers this month
  const activeCharges: Transaction[] = [];
  for (const charge of charges) {
    const txDate = new Date(charge.transaction_date + 'T00:00:00Z');
    const planType = charge.plan_type || 'other';
    const periodMonths = PLAN_PERIOD_MONTHS[planType] || 1;

    const txYear = txDate.getUTCFullYear();
    const txMonth = txDate.getUTCMonth();
    const txDay = txDate.getUTCDate();

    // endDate = first day of the month AFTER the last covered month
    // A yearly sold in Jan 2024 covers Jan-Dec 2024, so endDate = Jan 1, 2025
    // A monthly sold in Jan 2025 covers Jan 2025, so endDate = Feb 1, 2025
    let endDate: Date;
    if (periodMonths < 1) {
      endDate = new Date(txDate.getTime() + 7 * 24 * 60 * 60 * 1000);
    } else {
      // Use first of month for both start and end to match Tableau's month-boundary logic
      const endMonth = txMonth + Math.ceil(periodMonths);
      endDate = new Date(Date.UTC(txYear, endMonth, 1));
    }

    // txDate must be before snapshot month end, AND
    // endDate must be AFTER snapshot month start (subscription still active)
    if (txDate < monthEnd && endDate > monthStart) {
      activeCharges.push(charge);
    }
  }

  console.log(`[Snapshot ${monthStartStr}] Active charges: ${activeCharges.length} of ${charges.length} total`);

  // Spreading: each charge contributes amount / period_months
  function mrrSum(txs: Transaction[], field: 'amount_gross' | 'amount_net'): number {
    return txs.reduce((acc, t) => {
      const periodMonths = PLAN_PERIOD_MONTHS[t.plan_type || 'other'] || 1;
      return acc + Number(t[field] || 0) / periodMonths;
    }, 0);
  }

  function mrrCommission(txs: Transaction[]): number {
    return txs.reduce((acc, t) => {
      const periodMonths = PLAN_PERIOD_MONTHS[t.plan_type || 'other'] || 1;
      return acc + Number(t.commission_amount || 0) / periodMonths;
    }, 0);
  }

  const refunds = otherTx.filter((t) => t.transaction_type === 'refund');
  const taxes = otherTx.filter((t) => t.transaction_type === 'tax');
  const disputes = otherTx.filter((t) => t.transaction_type === 'dispute');

  function sumField(txs: Transaction[], field: 'amount_gross' | 'amount_net' | 'commission_amount' | 'tax_amount'): number {
    return txs.reduce((acc, t) => acc + Number(t[field] || 0), 0);
  }

  // MRR from active charges (spreading)
  const mrrGross = mrrSum(activeCharges, 'amount_gross');
  const mrrNet = mrrSum(activeCharges, 'amount_net');
  const totalCommissions = mrrCommission(activeCharges);
  const totalTaxes = sumField(taxes, 'tax_amount');
  const totalRefunds = sumField(refunds, 'amount_gross');
  const totalDisputes = sumField(disputes, 'amount_gross');

  // By source
  const appleCharges = activeCharges.filter((t) => t.source === 'apple');
  const googleCharges = activeCharges.filter((t) => t.source === 'google');
  const stripeCharges = activeCharges.filter((t) => t.source === 'stripe');

  console.log(`[Snapshot ${monthStartStr}] MRR Net: $${mrrNet.toFixed(2)} | Apple: $${mrrSum(appleCharges, 'amount_net').toFixed(2)} | Google: $${mrrSum(googleCharges, 'amount_net').toFixed(2)} | Stripe: $${mrrSum(stripeCharges, 'amount_net').toFixed(2)}`);

  // By region
  const usCanadaCharges = activeCharges.filter((t) => t.region === 'us_canada');
  const mexicoCharges = activeCharges.filter((t) => t.region === 'mexico');
  const brazilCharges = activeCharges.filter((t) => t.region === 'brazil');
  const rowCharges = activeCharges.filter((t) => t.region === 'rest_of_world');

  // By plan type
  const monthlyCharges = activeCharges.filter((t) => t.plan_type === 'monthly');
  const yearlyCharges = activeCharges.filter((t) => t.plan_type === 'yearly');
  const semesterlyCharges = activeCharges.filter((t) => t.plan_type === 'semesterly');
  const quarterlyCharges = activeCharges.filter((t) => t.plan_type === 'quarterly');
  const weeklyCharges = activeCharges.filter((t) => t.plan_type === 'weekly');
  const lifetimeCharges = activeCharges.filter((t) => t.plan_type === 'lifetime');
  const otherCharges = activeCharges.filter((t) => !t.plan_type || t.plan_type === 'other');

  // Subscription counting — only charges from THIS month
  const thisMonthCharges = activeCharges.filter((t) => {
    const td = t.transaction_date;
    return td >= monthStartStr && td < monthEndStr;
  });

  const newSubs = thisMonthCharges.filter((t) => t.is_new_subscription).length;
  const explicitRenewals = thisMonthCharges.filter((t) => t.is_renewal).length;
  const trialConversions = thisMonthCharges.filter((t) => t.is_trial_conversion).length;
  const unlabeledCharges = thisMonthCharges.filter(
    (t) => !t.is_new_subscription && !t.is_renewal && !t.is_trial_conversion
  ).length;
  const totalRenewals = explicitRenewals + unlabeledCharges;

  console.log(`[Snapshot ${monthStartStr}] Subs: ${newSubs} new, ${totalRenewals} renewals, ${trialConversions} trial, ${refunds.length} refunds`);

  const snapshotDateStr = monthStartStr;

  const snapshot: Omit<MrrDailySnapshot, 'id' | 'computed_at'> = {
    snapshot_date: snapshotDateStr,
    mrr_gross: mrrGross,
    mrr_net: mrrNet,
    total_commissions: totalCommissions,
    total_taxes: totalTaxes,
    total_refunds: totalRefunds,
    total_disputes: totalDisputes,

    mrr_apple_gross: mrrSum(appleCharges, 'amount_gross'),
    mrr_apple_net: mrrSum(appleCharges, 'amount_net'),
    mrr_google_gross: mrrSum(googleCharges, 'amount_gross'),
    mrr_google_net: mrrSum(googleCharges, 'amount_net'),
    mrr_stripe_gross: mrrSum(stripeCharges, 'amount_gross'),
    mrr_stripe_net: mrrSum(stripeCharges, 'amount_net'),

    mrr_us_canada: mrrSum(usCanadaCharges, 'amount_gross'),
    mrr_mexico: mrrSum(mexicoCharges, 'amount_gross'),
    mrr_brazil: mrrSum(brazilCharges, 'amount_gross'),
    mrr_rest_of_world: mrrSum(rowCharges, 'amount_gross'),

    mrr_monthly: mrrSum(monthlyCharges, 'amount_gross'),
    mrr_yearly: mrrSum(yearlyCharges, 'amount_gross'),
    mrr_semesterly: mrrSum(semesterlyCharges, 'amount_gross'),
    mrr_quarterly: mrrSum(quarterlyCharges, 'amount_gross'),
    mrr_weekly: mrrSum(weeklyCharges, 'amount_gross'),
    mrr_lifetime: mrrSum(lifetimeCharges, 'amount_gross'),
    mrr_other: mrrSum(otherCharges, 'amount_gross'),

    new_subscriptions: newSubs,
    renewals: totalRenewals,
    trial_conversions: trialConversions,
    refund_count: refunds.length,
    active_subscriptions: activeCharges.length,

    // Cash basis fields kept for backward compat
    mrr_cash_gross: mrrGross,
    mrr_cash_net: mrrNet,
    mrr_cash_apple_gross: mrrSum(appleCharges, 'amount_gross'),
    mrr_cash_google_gross: mrrSum(googleCharges, 'amount_gross'),
    mrr_cash_stripe_gross: mrrSum(stripeCharges, 'amount_gross'),
  };

  let { error: upsertError } = await supabase
    .from('mrr_daily_snapshots')
    .upsert(snapshot, { onConflict: 'snapshot_date' });

  if (upsertError && (upsertError.message.includes('mrr_cash') || upsertError.message.includes('active_subscriptions'))) {
    console.log(`[Snapshot ${monthStartStr}] Some columns not yet in DB, upserting without them...`);
    const { mrr_cash_gross, mrr_cash_net, mrr_cash_apple_gross, mrr_cash_google_gross, mrr_cash_stripe_gross, active_subscriptions, ...snapshotMinimal } = snapshot;
    const { error: retryError } = await supabase
      .from('mrr_daily_snapshots')
      .upsert(snapshotMinimal, { onConflict: 'snapshot_date' });
    upsertError = retryError;
  }

  if (upsertError) {
    throw new Error(`Snapshot upsert error: ${upsertError.message}`);
  }
}

/**
 * Backward-compatible alias. Any date input is normalized to its month.
 */
export const computeDailySnapshot = computeMonthlySnapshot;
