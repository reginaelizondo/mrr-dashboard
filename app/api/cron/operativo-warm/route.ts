import { NextRequest, NextResponse } from 'next/server';
import { warmOperativoCache } from '@/lib/kpi/operativo-data';

export const maxDuration = 120;

/**
 * Pre-calienta la caché del dashboard Operativo (vistas sin filtros más usadas) unos minutos después de cada
 * sync. Va en su propia petición porque Next aplica revalidateTag al FINAL de la petición del sync: lo que se
 * calentara ahí quedaría invalidado. Si la caché sigue fresca, cada carga es un acierto de caché (barato).
 */
export async function GET(request: NextRequest) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const warmed = await warmOperativoCache();
    return NextResponse.json({ ok: true, warmed });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
