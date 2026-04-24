import { NextRequest, NextResponse } from 'next/server';
import { getIronSession } from 'iron-session';
import type { SessionData } from '@/lib/auth/session';

export async function middleware(request: NextRequest) {
  const response = NextResponse.next();

  // Skip auth for login page, API auth, cron endpoints, and static files
  const { pathname, searchParams } = request.nextUrl;
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/api/cron') ||
    pathname.startsWith('/api/sync') ||
    pathname.startsWith('/api/slack-bot') ||
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
