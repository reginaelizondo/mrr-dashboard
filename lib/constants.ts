import type { Region } from '@/types';

export const REGION_MAP: Record<string, Region> = {
  US: 'us_canada',
  CA: 'us_canada',
  MX: 'mexico',
  BR: 'brazil',
};

export function getRegion(countryCode: string | null | undefined): Region {
  if (!countryCode) return 'rest_of_world';
  return REGION_MAP[countryCode.toUpperCase()] ?? 'rest_of_world';
}

export const REGION_LABELS: Record<Region, string> = {
  us_canada: 'US & Canada',
  mexico: 'Mexico',
  brazil: 'Brazil',
  rest_of_world: 'Rest of World',
};

export const SOURCE_LABELS: Record<string, string> = {
  apple: 'App Store (iOS)',
  google: 'Google Play (Android)',
  stripe: 'Web (Stripe)',
};

export const SOURCE_COLORS: Record<string, string> = {
  apple: '#0086D8',    // Kinedu Teal
  google: '#45C94E',   // Kinedu Green
  stripe: '#0E3687',   // Kinedu Navy
};

export const REGION_COLORS: Record<Region, string> = {
  us_canada: '#0086D8',    // Teal
  mexico: '#45C94E',       // Green
  brazil: '#DA4D7A',       // Rose
  rest_of_world: '#0E3687', // Navy
};

export const PLAN_COLORS: Record<string, string> = {
  lifetime: '#0E3687',   // Navy
  yearly: '#F59E0B',     // Amber/Gold
  semesterly: '#45C94E', // Green
  quarterly: '#DA4D7A',  // Rose
  monthly: '#0086D8',    // Teal
  weekly: '#8B5CF6',     // Purple
  other: '#94A3B8',      // Slate Gray
};

export const PLAN_LABELS: Record<string, string> = {
  lifetime: 'MRR Lifetime',
  yearly: 'MRR Yearly',
  semesterly: 'MRR Semesterly',
  quarterly: 'MRR Quarterly',
  monthly: 'MRR Monthly',
  weekly: 'MRR Weekly',
  other: 'MRR Other',
};

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatCurrencyDetailed(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

export const PLAN_LABELS_SHORT: Record<string, string> = {
  lifetime: 'Lifetime',
  yearly: 'Yearly',
  semesterly: 'Semesterly',
  quarterly: 'Quarterly',
  monthly: 'Monthly',
  weekly: 'Weekly',
  other: 'Other',
};

// MRR normalization multipliers
// Each plan type is normalized to monthly equivalent
export const MRR_MULTIPLIERS: Record<string, number> = {
  monthly: 1,
  yearly: 1 / 12,
  semesterly: 1 / 6,
  quarterly: 1 / 3,
  weekly: 4.33,
  lifetime: 1 / 60, // Amortized over 5 years (60 months)
  other: 1,
};
