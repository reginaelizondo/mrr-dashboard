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

  const statusColor = lastSync.status === 'success'
    ? 'text-[#45C94E] border-[#45C94E]/30 bg-[#45C94E]/10'
    : lastSync.status === 'error'
    ? 'text-[#DA4D7A] border-[#DA4D7A]/30 bg-[#DA4D7A]/10'
    : 'text-yellow-600 border-yellow-200 bg-yellow-50';

  const timeAgo = getTimeAgo(lastSync.completed_at || lastSync.started_at);

  return (
    <Badge variant="outline" className={`text-xs ${statusColor}`}>
      Last sync: {timeAgo} ({lastSync.records_synced} records)
    </Badge>
  );
}

function getTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
