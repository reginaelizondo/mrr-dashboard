export const dynamic = 'force-dynamic';

import { Suspense } from 'react';
import {
  getReviewsByMonth,
  getReviewsByWeek,
  getTopComplaintTopics,
  getTopComplaintTopicsByMonth,
  getReviewsByTerritory,
  getRecentNegativeReviews,
  getReviewsSummary,
  getLatestRatingsSummary,
  getAvailableTerritories,
  getLastAppleReviewsSync,
} from '@/lib/reviews';
import { generateInsights } from '@/lib/review-insights';
import { ReviewsContent } from '@/components/dashboard/ReviewsContent';
import { Skeleton } from '@/components/ui/skeleton';

type Preset = '3m' | '6m' | '12m' | 'ytd' | 'since2025' | 'all' | 'custom';

interface PageParams {
  preset?: string;
  start?: string;
  end?: string;
  topic?: string;
  territories?: string; // comma-separated ISO-3 codes
}

function resolveDateRange(params: PageParams): {
  startDate: string;
  endDate: string;
  preset: Preset;
} {
  const preset = (params.preset as Preset) || 'since2025';
  const today = new Date();
  let end = today;
  if (preset === 'custom' && params.end) end = new Date(params.end + 'T00:00:00Z');

  let start: Date;
  if (preset === 'custom' && params.start) {
    start = new Date(params.start + 'T00:00:00Z');
  } else {
    switch (preset) {
      case '3m':
        start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 2, 1));
        break;
      case '6m':
        start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 5, 1));
        break;
      case '12m':
        start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1));
        break;
      case 'ytd':
        start = new Date(Date.UTC(end.getUTCFullYear(), 0, 1));
        break;
      case 'since2025':
        start = new Date(Date.UTC(2025, 0, 1));
        break;
      case 'all':
        start = new Date(Date.UTC(2013, 0, 1));
        break;
      default:
        start = new Date(Date.UTC(2025, 0, 1));
    }
  }

  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    preset,
  };
}

async function ReviewsData({
  startDate,
  endDate,
  preset,
  topic,
  selectedTerritories,
}: {
  startDate: string;
  endDate: string;
  preset: Preset;
  topic?: string;
  selectedTerritories: string[];
}) {
  const territoriesFilter = selectedTerritories.length > 0 ? selectedTerritories : undefined;

  const [
    monthly,
    weekly,
    topics,
    topicsByMonth,
    territories,
    recent,
    summary,
    ratingsSummary,
    availableTerritories,
    lastSync,
  ] = await Promise.all([
    getReviewsByMonth(startDate, endDate, territoriesFilter),
    getReviewsByWeek(startDate, endDate, territoriesFilter),
    getTopComplaintTopics(startDate, endDate, { onlyNegative: true, territories: territoriesFilter }),
    getTopComplaintTopicsByMonth(startDate, endDate, territoriesFilter),
    getReviewsByTerritory(startDate, endDate, 5, territoriesFilter),
    getRecentNegativeReviews(startDate, endDate, topic, 150, territoriesFilter),
    getReviewsSummary(startDate, endDate, territoriesFilter),
    getLatestRatingsSummary(),
    getAvailableTerritories(),
    getLastAppleReviewsSync(),
  ]);

  const insights = generateInsights({
    monthly,
    topics,
    topicsByMonth,
    territories,
    summary,
    ratingsSummary,
  });

  return (
    <ReviewsContent
      monthly={monthly}
      weekly={weekly}
      topics={topics}
      topicsByMonth={topicsByMonth}
      territories={territories}
      recent={recent}
      summary={summary}
      ratingsSummary={ratingsSummary}
      insights={insights}
      availableTerritories={availableTerritories}
      lastSync={lastSync}
      preset={preset}
      startDate={startDate}
      endDate={endDate}
      selectedTopic={topic}
      selectedTerritories={selectedTerritories}
    />
  );
}

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<PageParams>;
}) {
  const params = await searchParams;
  const range = resolveDateRange(params);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold text-[#0E3687]">Reviews iOS</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Dos capas: <strong>ratings totales</strong> (panel ASC, ~30K star-taps) y <strong>reviews escritas</strong>
          {' '}(reseñas con texto, categorizadas para entender las quejas).
        </p>
      </div>

      <Suspense fallback={<ReviewsSkeleton />}>
        <ReviewsData
          startDate={range.startDate}
          endDate={range.endDate}
          preset={range.preset}
          topic={params.topic}
          selectedTerritories={
            params.territories
              ? params.territories.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean)
              : []
          }
        />
      </Suspense>
    </div>
  );
}

function ReviewsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-20 w-full" />
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-96 w-full" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Skeleton className="h-80" />
        <Skeleton className="h-80" />
      </div>
    </div>
  );
}
