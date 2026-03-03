import * as XLSX from 'xlsx';
import type { MrrDailySnapshot } from '@/types';
import { formatCurrency } from '@/lib/constants';

/**
 * Export filtered snapshot data to Excel with multiple sheets.
 */
export function exportToExcel(
  snapshots: MrrDailySnapshot[],
  totals: {
    gross: number;
    net: number;
    commissions: number;
    taxes: number;
    refunds: number;
    disputes: number;
    newSubs: number;
    renewals: number;
    refundCount: number;
  },
  filename?: string
) {
  const wb = XLSX.utils.book_new();

  // ─── Sheet 1: Summary ───────────────────────────────────────
  const summaryData = [
    ['MRR Dashboard Export'],
    [],
    ['Period', snapshots.length > 0 ? `${snapshots[0].snapshot_date} to ${snapshots[snapshots.length - 1].snapshot_date}` : 'No data'],
    ['Months in Range', snapshots.length],
    [],
    ['Metric', 'Value'],
    ['Gross Revenue', totals.gross],
    ['Net Revenue', totals.net],
    ['Commissions', totals.commissions],
    ['Commission %', totals.gross > 0 ? `${((totals.commissions / totals.gross) * 100).toFixed(1)}%` : '0%'],
    ['Taxes', totals.taxes],
    ['Refunds', totals.refunds],
    ['Disputes', totals.disputes],
    [],
    ['New Subscriptions', totals.newSubs],
    ['Renewals', totals.renewals],
    ['Refund Count', totals.refundCount],
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
  // Set column widths
  summarySheet['!cols'] = [{ wch: 20 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');

  // ─── Sheet 2: Monthly Data ─────────────────────────────────
  const monthlyHeaders = [
    'Month',
    'Gross Revenue',
    'Net Revenue',
    'Commissions',
    'Taxes',
    'Refunds',
    'Disputes',
    'New Subs',
    'Renewals',
    'Trial Conv.',
    'Refund Count',
  ];
  const monthlyRows = snapshots.map((s) => [
    s.snapshot_date,
    Number(s.mrr_gross),
    Number(s.mrr_net),
    Number(s.total_commissions),
    Number(s.total_taxes),
    Number(s.total_refunds),
    Number(s.total_disputes),
    Number(s.new_subscriptions),
    Number(s.renewals),
    Number(s.trial_conversions),
    Number(s.refund_count),
  ]);
  const monthlySheet = XLSX.utils.aoa_to_sheet([monthlyHeaders, ...monthlyRows]);
  monthlySheet['!cols'] = monthlyHeaders.map(() => ({ wch: 16 }));
  XLSX.utils.book_append_sheet(wb, monthlySheet, 'Monthly Data');

  // ─── Sheet 3: Source Breakdown ─────────────────────────────
  const sourceHeaders = [
    'Month',
    'Apple Gross',
    'Apple Net',
    'Google Gross',
    'Google Net',
    'Stripe Gross',
    'Stripe Net',
  ];
  const sourceRows = snapshots.map((s) => [
    s.snapshot_date,
    Number(s.mrr_apple_gross),
    Number(s.mrr_apple_net),
    Number(s.mrr_google_gross),
    Number(s.mrr_google_net),
    Number(s.mrr_stripe_gross),
    Number(s.mrr_stripe_net),
  ]);
  const sourceSheet = XLSX.utils.aoa_to_sheet([sourceHeaders, ...sourceRows]);
  sourceSheet['!cols'] = sourceHeaders.map(() => ({ wch: 14 }));
  XLSX.utils.book_append_sheet(wb, sourceSheet, 'By Source');

  // ─── Sheet 4: Region Breakdown ────────────────────────────
  const regionHeaders = ['Month', 'US & Canada', 'Mexico', 'Brazil', 'Rest of World'];
  const regionRows = snapshots.map((s) => [
    s.snapshot_date,
    Number(s.mrr_us_canada),
    Number(s.mrr_mexico),
    Number(s.mrr_brazil),
    Number(s.mrr_rest_of_world),
  ]);
  const regionSheet = XLSX.utils.aoa_to_sheet([regionHeaders, ...regionRows]);
  regionSheet['!cols'] = regionHeaders.map(() => ({ wch: 14 }));
  XLSX.utils.book_append_sheet(wb, regionSheet, 'By Region');

  // ─── Sheet 5: Plan Breakdown ──────────────────────────────
  const planHeaders = ['Month', 'Monthly', 'Yearly', 'Semesterly', 'Quarterly', 'Weekly', 'Lifetime', 'Other'];
  const planRows = snapshots.map((s) => [
    s.snapshot_date,
    Number(s.mrr_monthly),
    Number(s.mrr_yearly),
    Number(s.mrr_semesterly),
    Number(s.mrr_quarterly),
    Number(s.mrr_weekly),
    Number(s.mrr_lifetime),
    Number(s.mrr_other),
  ]);
  const planSheet = XLSX.utils.aoa_to_sheet([planHeaders, ...planRows]);
  planSheet['!cols'] = planHeaders.map(() => ({ wch: 14 }));
  XLSX.utils.book_append_sheet(wb, planSheet, 'By Plan');

  // ─── Generate and download ────────────────────────────────
  const defaultName = `mrr-dashboard-${snapshots[0]?.snapshot_date || 'export'}.xlsx`;
  XLSX.writeFile(wb, filename || defaultName);
}
