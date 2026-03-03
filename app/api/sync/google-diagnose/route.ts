import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { Storage } from '@google-cloud/storage';

export const maxDuration = 30;

function getGCSCredentials() {
  const keyB64 = process.env.GCP_SERVICE_ACCOUNT_KEY_B64!;
  return JSON.parse(Buffer.from(keyB64, 'base64').toString('utf-8'));
}

/**
 * GET /api/sync/google-diagnose
 *
 * Diagnoses Google Play API access:
 * 1. Tries Android Publisher API (monetization.subscriptions.list)
 * 2. Tries GCS bucket listing
 * 3. Reports what works and what doesn't
 */
export async function GET() {
  const results: Record<string, unknown> = {};
  const credentials = getGCSCredentials();

  // Test 1: Android Publisher API — list subscription products
  try {
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    const androidPublisher = google.androidpublisher({ version: 'v3', auth });
    const packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME!;

    const subsRes = await androidPublisher.monetization.subscriptions.list({
      packageName,
      pageSize: 10,
    });

    results.androidPublisherAPI = {
      status: 'OK',
      subscriptionCount: subsRes.data.subscriptions?.length || 0,
      subscriptions: subsRes.data.subscriptions?.map((s) => ({
        productId: s.productId,
        basePlans: s.basePlans?.map((bp) => ({
          basePlanId: bp.basePlanId,
          state: bp.state,
        })),
      })),
    };
  } catch (err: unknown) {
    const error = err as { code?: number; message?: string; errors?: unknown[] };
    results.androidPublisherAPI = {
      status: 'ERROR',
      code: error.code,
      message: error.message,
      errors: error.errors,
    };
  }

  // Test 2: GCS Earnings bucket — list files
  try {
    const storage = new Storage({ credentials });
    const bucket = storage.bucket(process.env.GOOGLE_PLAY_BUCKET!);

    const [files] = await bucket.getFiles({ prefix: 'earnings/', maxResults: 5 });
    results.gcsBucket = {
      status: 'OK',
      bucket: process.env.GOOGLE_PLAY_BUCKET,
      sampleFiles: files.map((f) => f.name),
    };
  } catch (err: unknown) {
    const error = err as { code?: number; message?: string };
    results.gcsBucket = {
      status: 'ERROR',
      bucket: process.env.GOOGLE_PLAY_BUCKET,
      code: error.code,
      message: error.message,
    };
  }

  // Test 3: GCS Sales report bucket — try sales/ prefix
  try {
    const storage = new Storage({ credentials });
    const bucket = storage.bucket(process.env.GOOGLE_PLAY_BUCKET!);

    const [files] = await bucket.getFiles({ prefix: 'sales/', maxResults: 5 });
    results.gcsSalesBucket = {
      status: 'OK',
      sampleFiles: files.map((f) => f.name),
    };
  } catch (err: unknown) {
    const error = err as { code?: number; message?: string };
    results.gcsSalesBucket = {
      status: 'ERROR',
      message: error.message,
    };
  }

  // Test 4: Try alternative bucket patterns
  // Google Play Console uses "pubsite_prod_rev_XXXXX" for financial reports
  const altBucketId = process.env.GOOGLE_PLAY_BUCKET!.replace('pubsite_prod_', 'pubsite_prod_rev_');
  try {
    const storage = new Storage({ credentials });
    const bucket = storage.bucket(altBucketId);

    const [files] = await bucket.getFiles({ prefix: 'earnings/', maxResults: 5 });
    results.gcsAltBucket = {
      status: 'OK',
      bucket: altBucketId,
      sampleFiles: files.map((f) => f.name),
    };
  } catch (err: unknown) {
    const error = err as { code?: number; message?: string };
    results.gcsAltBucket = {
      status: 'ERROR',
      bucket: altBucketId,
      message: error.message,
    };
  }

  return NextResponse.json({
    serviceAccount: credentials.client_email,
    packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
    results,
  });
}
