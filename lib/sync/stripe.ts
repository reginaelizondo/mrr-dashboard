import Stripe from 'stripe';
import { createServerClient } from '@/lib/supabase/server';
import { getRegion } from '@/lib/constants';
import type { Transaction } from '@/types';

function getStripeClient() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!);
}

function getPlanTypeFromPrice(price: Stripe.Price | null): string {
  if (!price?.recurring) {
    // Non-recurring: check if it's a lifetime product
    const nickname = (price?.nickname || '').toLowerCase();
    const metadata = price?.metadata || {};
    if (nickname.includes('lifetime') || metadata.plan_type === 'lifetime') {
      return 'lifetime';
    }
    return 'other';
  }
  const interval = price.recurring.interval;
  const count = price.recurring.interval_count;

  if (interval === 'month') {
    if (count === 1) return 'monthly';
    if (count === 3) return 'quarterly';
    if (count === 6) return 'semesterly';
    return 'other';
  }
  if (interval === 'year' && count === 1) return 'yearly';
  if (interval === 'week' && count === 1) return 'weekly';
  return 'other';
}

/**
 * Fallback plan type inference from charge amount (USD cents).
 * Used when Stripe charges have no invoice/subscription data.
 * Based on Kinedu's known Stripe pricing tiers:
 * - $12.99 → monthly
 * - $49.99, $59.99, $79.99 → yearly (different SKUs)
 * - $149+ → lifetime
 */
function getPlanTypeFromAmount(amountCents: number): string {
  const amt = amountCents / 100;
  // Monthly plans: $9.99-$19.99 range
  if (amt >= 9 && amt <= 19.99) return 'monthly';
  // Yearly plans: $39.99-$99.99 range (all Kinedu yearly SKUs: $49.99, $59.99, $79.99)
  if (amt >= 39 && amt <= 99.99) return 'yearly';
  // Lifetime: $149+
  if (amt >= 149) return 'lifetime';
  // Trial: $0.50-$2.00
  if (amt >= 0.50 && amt <= 2) return 'monthly';
  // Large amounts (e.g. $199.96, $249.90) could be multi-year
  if (amt >= 100 && amt < 149) return 'yearly';
  return 'other';
}

function normalizeStripeCharge(
  bt: Stripe.BalanceTransaction,
  charge: Stripe.Charge & { invoice?: Stripe.Invoice | string | null }
): Omit<Transaction, 'id' | 'synced_at' | 'created_at'>[] {
  const transactions: Omit<Transaction, 'id' | 'synced_at' | 'created_at'>[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chargeAny = charge as any;
  const invoice = (typeof chargeAny.invoice === 'object' ? chargeAny.invoice : null) as Stripe.Invoice | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lineItem = (invoice?.lines?.data?.[0]) as any;
  const price = lineItem?.price as Stripe.Price | null;

  const transactionDate = new Date(bt.created * 1000).toISOString().split('T')[0];
  const countryCode = chargeAny.billing_details?.address?.country || 'US';

  const isNewSub = invoice?.billing_reason === 'subscription_create';
  const isRenewal = invoice?.billing_reason === 'subscription_cycle';
  const isTrialConversion = invoice?.billing_reason === 'subscription_create' &&
    (lineItem?.period?.start !== undefined);

  // Main charge transaction
  transactions.push({
    source: 'stripe',
    transaction_date: transactionDate,
    order_id: charge.id,
    external_id: bt.id,
    sku: price?.id || 'unknown',
    plan_type: (price ? getPlanTypeFromPrice(price) : getPlanTypeFromAmount(bt.amount)) as Transaction['plan_type'],
    plan_name: price?.nickname || lineItem?.description || charge.description || null,
    transaction_type: 'charge',
    is_new_subscription: isNewSub,
    is_renewal: isRenewal,
    is_trial_conversion: isTrialConversion,
    subscription_period: price?.recurring
      ? `${price.recurring.interval_count}${price.recurring.interval.charAt(0)}`
      : null,
    amount_gross: bt.amount / 100,
    amount_net: bt.net / 100,
    commission_amount: bt.fee / 100,
    tax_amount: ((invoice as any)?.tax ?? 0) / 100,
    country_code: countryCode,
    region: getRegion(countryCode),
    units: 1,
    raw_data: {
      balance_transaction_id: bt.id,
      charge_id: charge.id,
      invoice_id: invoice?.id,
      billing_reason: invoice?.billing_reason,
      fee_details: bt.fee_details,
    },
  });

  return transactions;
}

function normalizeStripeRefund(
  bt: Stripe.BalanceTransaction,
  refund: Stripe.Refund
): Omit<Transaction, 'id' | 'synced_at' | 'created_at'> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refundAny = refund as any;
  const charge = (typeof refundAny.charge === 'object' ? refundAny.charge : null) as Stripe.Charge | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chargeAny = charge as any;
  const countryCode = chargeAny?.billing_details?.address?.country || 'US';
  const transactionDate = new Date(bt.created * 1000).toISOString().split('T')[0];

  return {
    source: 'stripe',
    transaction_date: transactionDate,
    order_id: refund.id,
    external_id: bt.id,
    sku: null,
    plan_type: null,
    plan_name: null,
    transaction_type: 'refund',
    is_new_subscription: false,
    is_renewal: false,
    is_trial_conversion: false,
    subscription_period: null,
    amount_gross: Math.abs(bt.amount) / 100,
    amount_net: Math.abs(bt.net) / 100,
    commission_amount: Math.abs(bt.fee) / 100,
    tax_amount: 0,
    country_code: countryCode,
    region: getRegion(countryCode),
    units: 1,
    raw_data: {
      balance_transaction_id: bt.id,
      refund_id: refund.id,
      charge_id: charge?.id,
    },
  };
}

export async function syncStripe(date: string): Promise<number> {
  const stripe = getStripeClient();
  const supabase = createServerClient();

  const startOfDay = new Date(date);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setUTCHours(23, 59, 59, 999);

  const allTransactions: Omit<Transaction, 'id' | 'synced_at' | 'created_at'>[] = [];

  // Fetch charges with expanded invoice
  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const params: Stripe.BalanceTransactionListParams = {
      created: {
        gte: Math.floor(startOfDay.getTime() / 1000),
        lte: Math.floor(endOfDay.getTime() / 1000),
      },
      limit: 100,
      type: 'charge',
    };
    if (startingAfter) params.starting_after = startingAfter;

    const balanceTransactions = await stripe.balanceTransactions.list(params);

    for (const bt of balanceTransactions.data) {
      try {
        const charge = await stripe.charges.retrieve(bt.source as string, {
          expand: ['invoice', 'invoice.lines'],
        });
        const normalized = normalizeStripeCharge(bt, charge as Stripe.Charge);
        allTransactions.push(...normalized);
      } catch (err) {
        console.error(`Stripe: Error fetching charge ${bt.source}:`, err);
      }
    }

    hasMore = balanceTransactions.has_more;
    if (hasMore && balanceTransactions.data.length > 0) {
      startingAfter = balanceTransactions.data[balanceTransactions.data.length - 1].id;
    }
  }

  // Fetch refunds
  hasMore = true;
  startingAfter = undefined;

  while (hasMore) {
    const params: Stripe.BalanceTransactionListParams = {
      created: {
        gte: Math.floor(startOfDay.getTime() / 1000),
        lte: Math.floor(endOfDay.getTime() / 1000),
      },
      limit: 100,
      type: 'refund',
    };
    if (startingAfter) params.starting_after = startingAfter;

    const balanceTransactions = await stripe.balanceTransactions.list(params);

    for (const bt of balanceTransactions.data) {
      try {
        const refund = await stripe.refunds.retrieve(bt.source as string, {
          expand: ['charge'],
        });
        allTransactions.push(normalizeStripeRefund(bt, refund));
      } catch (err) {
        console.error(`Stripe: Error fetching refund ${bt.source}:`, err);
      }
    }

    hasMore = balanceTransactions.has_more;
    if (hasMore && balanceTransactions.data.length > 0) {
      startingAfter = balanceTransactions.data[balanceTransactions.data.length - 1].id;
    }
  }

  if (allTransactions.length === 0) return 0;

  const { error } = await supabase
    .from('transactions')
    .upsert(allTransactions, {
      onConflict: 'source,external_id',
      ignoreDuplicates: false,
    });

  if (error) {
    throw new Error(`Stripe sync DB error: ${error.message}`);
  }

  return allTransactions.length;
}
