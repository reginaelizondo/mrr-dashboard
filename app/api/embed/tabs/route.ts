import { NextResponse } from 'next/server';
import { navItems } from '@/lib/nav-config';

export const dynamic = 'force-dynamic';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function GET() {
  const tabs = navItems
    .filter(i => i.investorTab && i.embedSlug)
    .map(i => ({ label: i.label, slug: i.embedSlug! }));

  return NextResponse.json({ tabs }, { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
