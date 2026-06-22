import { TOPIC_LABELS, type ReviewTopic, type MonthlyReviewRow, type TopicCountRow, type TerritoryRow, type RatingsSummary } from './reviews';

/**
 * Rule-based insight generator for the Reviews tab.
 * Takes the already-aggregated data we send to ReviewsContent and produces
 * a list of actionable findings with severity and recommended actions.
 *
 * Intentionally deterministic (no LLM call) so it's fast, reproducible, and
 * doesn't cost tokens on every page load.
 */

export type InsightSeverity = 'critical' | 'high' | 'medium' | 'info';

export interface Insight {
  id: string;
  severity: InsightSeverity;
  title: string;
  description: string;
  recommendation: string;
  metric?: string;  // optional numeric summary to highlight
}

interface InsightInput {
  monthly: MonthlyReviewRow[];
  topics: TopicCountRow[];
  topicsByMonth: Record<string, Record<string, number>>;
  territories: TerritoryRow[];
  summary: {
    total: number;
    avg_rating: number;
    negative: number;
    negative_rate: number;
    positive: number;
  };
  ratingsSummary: RatingsSummary;
}

const SEVERITY_ORDER: Record<InsightSeverity, number> = {
  critical: 0, high: 1, medium: 2, info: 3,
};

/**
 * Recommended actions per complaint topic. Written in English to match
 * the audience. Keep these short — the UI shows them as "next step".
 */
const TOPIC_RECOMMENDATIONS: Partial<Record<ReviewTopic, string>> = {
  free_trial:
    'Review the Free Trial start flow: make the exact charge date more visible on the paywall, send a reminder email 48h before the charge, and verify that the ASC copy about the duration is clear in all languages.',
  refund:
    'Monitor the refund rate in parallel and consider a proactive touchpoint (email) for users who cancel within the first 3 days, asking for feedback before they escalate to a public review.',
  subscription_mgmt:
    'Add a direct "Manage subscription" link inside the app with a deeplink to iOS Settings → Subscriptions. Many users don\'t know where to cancel and end up venting in the review.',
  pricing:
    'Review the tiers by country (App Store Price Tiers). If LATAM already has localized pricing but Europe doesn\'t, it\'s a quick win. Evaluate whether a more affordable monthly plan reduces complaints without cannibalizing the annual one.',
  paywall:
    'Consider expanding the free content (e.g. 7-14 days of activities without a paywall) to reduce the perception that "everything is paid". The bias in reviews is very strong on this topic.',
  bugs_crashes:
    'Prioritize the reported crashes with the QA/eng team, cross-referencing with Crashlytics. Each 1⭐ review for a bug typically represents 10-50 silent affected users.',
  performance:
    'Review initial load times and activity content load times. Consider lazy-loading and more aggressive caching. Measure with RUM in production.',
  account_login:
    'Audit the login/signup flow. Many complaints here indicate password recovery issues or lockout from 2FA. Review auth error logs.',
  content_repetitive:
    'Direct feedback to the content team: users perceive that the activities repeat. Consider the cadence of new content and personalization by the baby\'s exact age.',
  content_age_fit:
    'Improve the age-range transition mechanism. When a baby reaches X months, notify the stage change and show new content to avoid the feeling of "running out of content".',
  content_quality:
    'Collect specific examples from the reviews and share them with the product/content team for qualitative benchmarks.',
  ads:
    'If there are ads in the free version, evaluate frequency and type. It\'s a sensitive topic in apps for kids (COPPA/GDPR-K).',
  ux_ui:
    'Review the most-mentioned screens in the reviews with a dedicated UX review. Consider a usability test with 5-8 users to detect friction points.',
  support:
    'Users complain about a lack of response from support. Measure the current ticket SLA, and consider an auto-responder with FAQs while a real agent replies.',
  language_localization:
    'Verify translation coverage in the languages with the most complaints. An audit of untranslated strings usually resolves a good chunk of it.',
};

export function generateInsights(data: InsightInput): Insight[] {
  const insights: Insight[] = [];
  const { monthly, topics, topicsByMonth, territories, summary, ratingsSummary } = data;

  // ─── 1. Dominant complaint ──────────────────────────────────────
  if (topics.length > 0) {
    const top = topics[0];
    insights.push({
      id: 'top-complaint',
      severity: top.pct_of_negative >= 0.3 ? 'critical' : 'high',
      title: `"${top.label}" is the #1 complaint (${top.count} reviews, ${(top.pct_of_negative * 100).toFixed(0)}% of total negative)`,
      description:
        `${top.count} of the ${summary.negative} negative reviews (≤2⭐) in the period mention this topic. It's the dominant pattern and probably the biggest driver of negative written reputation.`,
      recommendation: TOPIC_RECOMMENDATIONS[top.topic as ReviewTopic] ||
        'Investigate the root cause with a qualitative sampling of 20-30 reviews.',
      metric: `${top.count} menciones · ${(top.pct_of_negative * 100).toFixed(0)}%`,
    });
  }

  // ─── 2. Trending topic (rising MoM) ─────────────────────────────
  const months = Object.keys(topicsByMonth).sort();
  if (months.length >= 3) {
    const recent = months.slice(-2);
    const prior = months.slice(-4, -2);
    const recentSum: Record<string, number> = {};
    const priorSum: Record<string, number> = {};
    for (const m of recent) {
      for (const [t, c] of Object.entries(topicsByMonth[m])) recentSum[t] = (recentSum[t] || 0) + c;
    }
    for (const m of prior) {
      for (const [t, c] of Object.entries(topicsByMonth[m])) priorSum[t] = (priorSum[t] || 0) + c;
    }
    let worstTrend: { topic: string; delta: number; recent: number; prior: number } | null = null;
    for (const [topic, recentCount] of Object.entries(recentSum)) {
      const priorCount = priorSum[topic] || 0;
      // At least 5 recent mentions AND at least doubled
      if (recentCount >= 5 && recentCount >= priorCount * 2) {
        const delta = recentCount - priorCount;
        if (!worstTrend || delta > worstTrend.delta) {
          worstTrend = { topic, delta, recent: recentCount, prior: priorCount };
        }
      }
    }
    if (worstTrend) {
      insights.push({
        id: 'rising-topic',
        severity: 'high',
        title: `⚠ Rising trend: "${TOPIC_LABELS[worstTrend.topic as ReviewTopic] || worstTrend.topic}" grew ${worstTrend.prior > 0 ? `${(((worstTrend.recent - worstTrend.prior) / worstTrend.prior) * 100).toFixed(0)}%` : `from ${worstTrend.prior} to ${worstTrend.recent}`} over the last 2 months`,
        description:
          `The last 2 months total ${worstTrend.recent} mentions of this complaint vs ${worstTrend.prior} in the prior 2 months. This usually indicates a recent change (release, new pricing, content change) that triggered the topic.`,
        recommendation: TOPIC_RECOMMENDATIONS[worstTrend.topic as ReviewTopic] ||
          'Investigate what changed in the last 8 weeks (releases, pricing, copy changes). Cross-reference with the product change timeline.',
        metric: `${worstTrend.prior} → ${worstTrend.recent}`,
      });
    }
  }

  // ─── 3. Rating trend (written reviews) ──────────────────────────
  if (monthly.length >= 2) {
    const latest = monthly[monthly.length - 1];
    const prior = monthly[monthly.length - 2];
    const delta = latest.avg_rating - prior.avg_rating;
    if (Math.abs(delta) >= 0.3) {
      insights.push({
        id: 'rating-trend',
        severity: delta < -0.5 ? 'critical' : delta < 0 ? 'high' : 'info',
        title: `Average rating ${delta >= 0 ? 'rose' : 'fell'} ${Math.abs(delta).toFixed(2)}⭐ vs prior month`,
        description:
          `${prior.month}: ${prior.avg_rating.toFixed(2)}⭐ (${prior.total} reviews) → ${latest.month}: ${latest.avg_rating.toFixed(2)}⭐ (${latest.total} reviews). ${delta < 0 ? 'The drop suggests something got worse in the last month.' : 'The rebound is a good sign, but it\'s worth validating that it holds.'}`,
        recommendation: delta < 0
          ? 'Do a deep-dive into this month\'s reviews vs the prior month. Compare the topic distribution and look for the new problem.'
          : 'Document what changed to reinforce and sustain it. If it was a release, tag the release notes in the reviews tracker.',
      });
    }
  }

  // ─── 4. Country outliers (written reviews) ──────────────────────
  if (territories.length >= 3) {
    // Countries with 10+ reviews and >60% negative rate
    const bad = territories.filter((t) => t.total >= 10 && t.negative_rate >= 0.6);
    if (bad.length > 0) {
      const worst = bad[0]; // already sorted by negative_rate desc
      insights.push({
        id: 'country-outlier-neg',
        severity: worst.negative_rate >= 0.75 ? 'critical' : 'high',
        title: `${worst.territory} has ${(worst.negative_rate * 100).toFixed(0)}% negative reviews (${worst.negative}/${worst.total})`,
        description:
          `The written reviews from ${worst.territory} are dominated by complaints. There's probably a market-specific issue (pricing, language, cultural content, payment method).`,
        recommendation:
          `Filter the reviews by ${worst.territory} (use the country filter above) and read the first 20 to detect the local pattern. If it's systemic, coordinate with the market's growth manager.`,
        metric: `${worst.negative}/${worst.total} neg`,
      });
    }
  }

  // ─── 5. Global ratings outliers (ASC panel data, lifetime) ─────
  if (ratingsSummary.by_country.length >= 5) {
    // Countries with 50+ ratings and avg > 0.5⭐ below global weighted avg
    const underperformers = ratingsSummary.by_country
      .filter((c) => c.rating_count >= 50 && c.avg_rating <= ratingsSummary.weighted_avg - 0.5)
      .sort((a, b) => a.avg_rating - b.avg_rating);
    if (underperformers.length > 0) {
      const worst = underperformers[0];
      insights.push({
        id: 'global-rating-outlier',
        severity: 'medium',
        title: `${worst.country_code}: ${worst.avg_rating.toFixed(2)}⭐ global (${(ratingsSummary.weighted_avg - worst.avg_rating).toFixed(2)}⭐ below the average)`,
        description:
          `Across all ${worst.rating_count.toLocaleString()} ratings from ${worst.country_code} (with and without text), the average is significantly below the global of ${ratingsSummary.weighted_avg.toFixed(2)}⭐. This is more statistically reliable than written reviews because the volume is much larger.`,
        recommendation:
          `${worst.country_code} needs a dedicated market analysis. If you don't have written reviews from there, it's worth doing qualitative user research (5-10 calls) to understand what's dragging the rating down.`,
        metric: `${worst.avg_rating.toFixed(2)} vs ${ratingsSummary.weighted_avg.toFixed(2)}`,
      });
    }
  }

  // ─── 6. Written-vs-global gap (the selection bias itself) ──────
  const writtenAvg = summary.avg_rating;
  const globalAvg = ratingsSummary.weighted_avg;
  if (globalAvg > 0 && summary.total > 20) {
    const gap = globalAvg - writtenAvg;
    if (gap >= 1.5) {
      insights.push({
        id: 'selection-bias',
        severity: 'info',
        title: `Gap between written reviews (${writtenAvg.toFixed(2)}⭐) and total ratings (${globalAvg.toFixed(2)}⭐): ${gap.toFixed(2)}⭐`,
        description:
          `Silent users (tappers) are significantly happier than those who write reviews. This is normal, but the magnitude (${gap.toFixed(2)}⭐) confirms a strong selection bias. Be careful not to project this analysis to "all your users" — it reflects only the minority who write.`,
        recommendation:
          'When communicating these findings internally, always mention both numbers. Use written reviews for qualitative diagnosis, total ratings for product metrics.',
      });
    }
  }

  // ─── 7. Positive patterns (what is going well) ─────────────────
  const praise = topics.find((t) => t.topic === 'praise');
  if (monthly.length > 0) {
    const latest = monthly[monthly.length - 1];
    if (latest.positive / (latest.total || 1) >= 0.4 && latest.total >= 10) {
      insights.push({
        id: 'positive-signal',
        severity: 'info',
        title: `${latest.month}: ${((latest.positive / latest.total) * 100).toFixed(0)}% positive (≥4⭐)`,
        description:
          'More than 40% of the written reviews from the last month are positive. Although most who write are critical, there is an engaged cohort that advocates for the product.',
        recommendation:
          'Identify what people who give us 5⭐ mention. Those are your validated "jobs to be done" — amplify them in marketing, ASO, and onboarding.',
      });
    }
  }

  // Sort by severity
  insights.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return insights;
}
