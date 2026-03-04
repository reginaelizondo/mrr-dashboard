export type Source = 'apple' | 'google' | 'stripe';
export type TransactionType = 'charge' | 'refund' | 'commission' | 'tax' | 'dispute';
export type PlanType = 'monthly' | 'yearly' | 'semesterly' | 'quarterly' | 'weekly' | 'lifetime' | 'other';
export type Region = 'us_canada' | 'mexico' | 'brazil' | 'rest_of_world';
export type TimeRange = 'daily' | 'weekly' | 'monthly';
export type DatePreset = 'this_month' | 'last_month' | '3m' | '6m' | '12m' | 'ytd' | 'all' | 'custom';
export type SyncType = 'daily' | 'backfill' | 'manual';
export type SyncStatus = 'running' | 'success' | 'error';

export interface Transaction {
  id?: number;
  source: Source;
  transaction_date: string;
  order_id?: string | null;
  external_id?: string | null;
  sku?: string | null;
  plan_type?: PlanType | null;
  plan_name?: string | null;
  transaction_type: TransactionType;
  is_new_subscription: boolean;
  is_renewal: boolean;
  is_trial_conversion: boolean;
  subscription_period?: string | null;
  amount_gross: number;
  amount_net: number;
  commission_amount: number;
  tax_amount: number;
  original_amount?: number | null;
  original_currency?: string | null;
  country_code?: string | null;
  region?: Region | null;
  units: number;
  raw_data?: Record<string, unknown> | null;
  synced_at?: string;
  created_at?: string;
}

export interface MrrDailySnapshot {
  id?: number;
  snapshot_date: string;
  mrr_gross: number;
  mrr_net: number;
  total_commissions: number;
  total_taxes: number;
  total_refunds: number;
  total_disputes: number;
  mrr_apple_gross: number;
  mrr_apple_net: number;
  mrr_google_gross: number;
  mrr_google_net: number;
  mrr_stripe_gross: number;
  mrr_stripe_net: number;
  mrr_us_canada: number;
  mrr_mexico: number;
  mrr_brazil: number;
  mrr_rest_of_world: number;
  mrr_monthly: number;
  mrr_yearly: number;
  mrr_semesterly: number;
  mrr_quarterly: number;
  mrr_weekly: number;
  mrr_lifetime: number;
  mrr_other: number;
  new_subscriptions: number;
  renewals: number;
  trial_conversions: number;
  refund_count: number;
  active_subscriptions: number;
  // Cash basis fields (charges in THIS month only, normalized to monthly)
  mrr_cash_gross?: number;
  mrr_cash_net?: number;
  mrr_cash_apple_gross?: number;
  mrr_cash_google_gross?: number;
  mrr_cash_stripe_gross?: number;
  computed_at?: string;
}

export interface SkuMapping {
  id?: number;
  source: Source;
  raw_sku: string;
  plan_name: string;
  plan_type: PlanType;
  monthly_value?: number | null;
  is_active: boolean;
  notes?: string | null;
}

export interface SyncLog {
  id?: number;
  source: Source | 'all';
  sync_type: SyncType;
  status: SyncStatus;
  started_at: string;
  completed_at?: string | null;
  records_synced: number;
  date_range_start?: string | null;
  date_range_end?: string | null;
  error_message?: string | null;
  details?: Record<string, unknown> | null;
}

export interface DashboardFilters {
  timeRange: TimeRange;
  startDate: string;
  endDate: string;
  source?: Source;
  region?: Region;
  planType?: PlanType;
}
