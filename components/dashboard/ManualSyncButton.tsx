'use client';

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

type SyncState = 'idle' | 'loading' | 'success' | 'error' | 'partial';

export function ManualSyncButton() {
  const [state, setState] = useState<SyncState>('idle');
  const [message, setMessage] = useState('');

  async function handleSync() {
    setState('loading');
    setMessage('');
    try {
      const res = await fetch('/api/sync/trigger-all', { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        setState('error');
        setMessage(data.error || 'Error desconocido');
        return;
      }

      if (data.hasError) {
        setState('partial');
        const failed = Object.entries(data.results as Record<string, { status: string; error?: string }>)
          .filter(([, v]) => v.status === 'error')
          .map(([k]) => k)
          .join(', ');
        setMessage(`Completado con errores en: ${failed}`);
      } else {
        setState('success');
        setMessage('Todo sincronizado correctamente');
      }

      // Reload after short delay so the user can see the result message
      setTimeout(() => window.location.reload(), 1500);
    } catch {
      setState('error');
      setMessage('No se pudo conectar al servidor');
    }
  }

  const isLoading = state === 'loading';

  const colorClass =
    state === 'success' ? 'text-emerald-600 border-emerald-300 bg-emerald-50 hover:bg-emerald-100' :
    state === 'error'   ? 'text-red-600 border-red-300 bg-red-50 hover:bg-red-100' :
    state === 'partial' ? 'text-amber-600 border-amber-300 bg-amber-50 hover:bg-amber-100' :
    'text-[#0E3687] border-[#0E3687]/30 hover:bg-[#0E3687]/5';

  return (
    <div className="flex items-center gap-2">
      {message && (
        <span className={`text-xs ${
          state === 'success' ? 'text-emerald-600' :
          state === 'error'   ? 'text-red-600' :
          'text-amber-600'
        }`}>
          {message}
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={handleSync}
        disabled={isLoading}
        className={`h-7 gap-1.5 text-xs font-medium transition-colors ${colorClass}`}
        title="Sincronizar datos manualmente (~3 min)"
      >
        <RefreshCw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
        {isLoading ? 'Sincronizando…' : 'Sync manual'}
      </Button>
    </div>
  );
}
