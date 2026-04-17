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
    pathname.startsWith('/_next') ||
    pathname === '/favicon.ico'
  ) {
    return response;
  }

  // Allow embed routes when a valid embed_token is provided (used by investors.html iframes)
  if (pathname.startsWith('/embed')) {
    const embedToken = process.env.EMBED_TOKEN;
    if (embedToken && searchParams.get('embed_token') === embedToken) {
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
