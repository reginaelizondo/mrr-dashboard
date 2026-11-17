import { NextRequest, NextResponse } from 'next/server';
import { getIronSession } from 'iron-session';
import type { SessionData } from '@/lib/auth/session';

export async function middleware(request: NextRequest) {
  const response = NextResponse.next();

  const { pathname, searchParams } = request.nextUrl;

  // /api/sync/* escribe los datos financieros (recarga fuentes, recalcula snapshots).
  // Exige sesión del dashboard (botones de sync) o Authorization: Bearer CRON_SECRET
  // (curl / scripts). Va antes del embed_token a propósito: ese token NO da acceso aquí.
  if (pathname.startsWith('/api/sync')) {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && request.headers.get('authorization') === `Bearer ${cronSecret}`) {
      return response;
    }
    const session = await getIronSession<SessionData>(request, response, {
      password: process.env.SESSION_SECRET!,
      cookieName: 'mrr-dashboard-session',
    });
    if (session.isAuthenticated) {
      return response;
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Skip auth for login page, API auth, cron endpoints, and static files
  // (/api/cron/* valida Bearer CRON_SECRET en cada ruta)
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/api/cron') ||
    pathname.startsWith('/api/slack-bot') ||
    pathname.startsWith('/api/bizops') || // propia auth: Bearer BIZOPS_BRIEF_SECRET
    pathname.startsWith('/_next') ||
    pathname === '/favicon.ico'
  ) {
    return response;
  }

  // Allow embed routes (and APIs they call) when a valid embed_token is provided.
  // The token can come from the URL (initial /embed/* page load) or from a cookie
  // we set after that load — this lets client-side fetches like /api/nps-data work
  // from inside the iframe without modifying shared data hooks.
  const embedToken = process.env.EMBED_TOKEN;
  if (embedToken) {
    const queryToken  = searchParams.get('embed_token');
    const cookieToken = request.cookies.get('mrr_embed_token')?.value;

    // Cross-origin metadata API consumed by investors.html (no cookie available)
    if (pathname.startsWith('/api/embed/') && queryToken === embedToken) {
      return response;
    }

    if (pathname.startsWith('/embed') && queryToken === embedToken) {
      response.cookies.set('mrr_embed_token', embedToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        path: '/',
        maxAge: 60 * 60 * 24, // 1 day
      });
      return response;
    }

    if (cookieToken === embedToken) {
      return response;
    }
  }

  const session = await getIronSession<SessionData>(request, response, {
    password: process.env.SESSION_SECRET!,
    cookieName: 'mrr-dashboard-session',
  });

  if (!session.isAuthenticated) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
