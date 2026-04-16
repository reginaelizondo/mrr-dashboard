export interface NpsResponse {
  identity: string;
  date: string;
  score: number;
  category: 'Promoter' | 'Passive' | 'Detractor';
  comment: string;
  dedupKey: string;
  highestPlanType: string;
  userLocale: string;
  os: string;
}

export type PeriodKey = '7d' | '30d' | '90d' | 'all';

export interface NpsFilters {
  period: PeriodKey;
  planType: string;
  locale: string;
  category: string;
  os: string;
}

export interface NpsStats {
  total: number;
  npsScore: number;
  promoters: number;
  passives: number;
  detractors: number;
  promoterPct: number;
  passivePct: number;
  detractorPct: number;
  avgScore: number;
}

export interface WeeklyNps {
  weekStart: string; // yyyy-MM-dd (Monday)
  weekLabel: string; // short "MMM d"
  npsScore: number;
  total: number;
}

export interface ScoreBucket {
  score: number; // 0..10
  count: number;
  category: 'Detractor' | 'Passive' | 'Promoter';
}

export interface SegmentStat {
  segment: string;
  npsScore: number;
  total: number;
  promoters: number;
  passives: number;
  detractors: number;
}
