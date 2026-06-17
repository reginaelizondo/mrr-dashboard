import { Badge } from '@/components/ui/badge';
import type { SyncLog } from '@/types';

interface SyncStatusProps {
  lastSync: SyncLog | null;
}

export function SyncStatus({ lastSync }: SyncStatusProps) {
  if (!lastSync) {
    return (
      <Badge variant="outline" className="text-xs bg-white/10 border-white/20 text-muted-foreground">
        No sync data
      </Badge>
    );
  }

  const completedAt = lastSync.completed_at || lastSync.started_at;
  const ageHours = (Date.now() - new Date(completedAt).getTime()) / 3_600_000;
  const isStale = ageHours > 25;

  const statusColor = isStale
    ? 'text-amber-600 border-amber-300 bg-amber-50'
    : lastSync.status === 'success'
    ? 'text-[#45C94E] border-[#45C94E]/30 bg-[#45C94E]/10'
    : lastSync.status === 'error'
    ? 'text-[#DA4D7A] border-[#DA4D7A]/30 bg-[#DA4D7A]/10'
    : 'text-yellow-600 border-yellow-200 bg-yellow-50';

  const timeAgo = getTimeAgo(completedAt);
  const label = isStale ? `⚠ Datos desactualizados — hace ${timeAgo}` : `Synced: ${timeAgo}`;

  return (
    <Badge variant="outline" className={`text-xs ${statusColor}`}>
      {label}
    </Badge>
  );
}

function getTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'ahora';
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}
