import { NextResponse } from 'next/server';
import { fetchNpsData } from '@/lib/nps/google-sheets';

export const revalidate = 30;

export async function GET() {
  try {
    const data = await fetchNpsData();
    return NextResponse.json({ data, fetchedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Error fetching NPS data:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch NPS data' },
      { status: 500 }
    );
  }
}
