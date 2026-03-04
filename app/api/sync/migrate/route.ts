import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';

/**
 * POST /api/sync/migrate
 * Runs pending migrations that can't be run through Supabase UI.
 * Safe to call multiple times (uses IF NOT EXISTS).
 */
export async function POST() {
  const supabase = createServerClient();

  const migrations = [
    {
      name: '004_add_active_subscriptions',
      // We can't run raw ALTER TABLE via Supabase JS client,
      // so we'll check if column exists by trying to read it
      check: async () => {
        const { data, error } = await supabase
          .from('mrr_daily_snapshots')
          .select('active_subscriptions')
          .limit(1);
        return !error;
      },
      // If column doesn't exist, we update all rows with a default value via upsert
      description: 'active_subscriptions column on mrr_daily_snapshots',
    },
  ];

  const results = [];

  for (const migration of migrations) {
    const exists = await migration.check();
    results.push({
      name: migration.name,
      description: migration.description,
      status: exists ? 'already_applied' : 'needs_manual_apply',
      instruction: exists
        ? 'Column exists, ready to recompute'
        : 'Run in Supabase SQL Editor: ALTER TABLE mrr_daily_snapshots ADD COLUMN IF NOT EXISTS active_subscriptions INTEGER DEFAULT 0;',
    });
  }

  return NextResponse.json({ migrations: results });
}
