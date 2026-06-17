/**
 * Tally the number of records touched across the per-source results of a
 * consolidated sync run, so sync_log.records_synced reflects real activity
 * instead of always logging 0.
 *
 * Tolerant by design: each source returns a different shape, so we sum the
 * known numeric fields and ignore the rest.
 */
export function countSyncedRecords(results: Record<string, unknown>): number {
  let total = 0;
  for (const r of Object.values(results)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if ((o.status as string) === 'error') continue;

    // kinedu-db
    if (typeof o.synced === 'number') total += o.synced;
    // apple events
    if (typeof o.totalRows === 'number') total += o.totalRows;
    // apple sales
    if (typeof o.rows === 'number') total += o.rows;
    // apple reviews + ratings (nested)
    for (const nestedKey of ['reviews', 'ratings'] as const) {
      const nested = o[nestedKey];
      if (nested && typeof nested === 'object') {
        const n = nested as Record<string, unknown>;
        if (typeof n.upserted === 'number') total += n.upserted;
      }
    }
  }
  return total;
}
