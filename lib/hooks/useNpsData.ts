'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { NpsResponse, NpsFilters } from '@/lib/nps/types';

const POLL_INTERVAL = 30000; // 30 seconds

interface UseNpsDataReturn {
  responses: NpsResponse[];
  filters: NpsFilters;
  setFilters: React.Dispatch<React.SetStateAction<NpsFilters>>;
  loading: boolean;
  error: string | null;
  lastUpdated: string | null;
  refresh: () => void;
}

const defaultFilters: NpsFilters = {
  period: '30d',
  planType: '',
  locale: '',
  category: '',
  os: '',
};

export function useNpsData(): UseNpsDataReturn {
  const [responses, setResponses] = useState<NpsResponse[]>([]);
  const [filters, setFilters] = useState<NpsFilters>(defaultFilters);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchData = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const res = await fetch('/api/nps-data');
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to fetch data');
      }
      const json = await res.json();
      setResponses(json.data || []);
      setLastUpdated(json.fetchedAt);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData(true);
    intervalRef.current = setInterval(() => fetchData(false), POLL_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchData]);

  return {
    responses,
    filters,
    setFilters,
    loading,
    error,
    lastUpdated,
    refresh: () => fetchData(false),
  };
}
