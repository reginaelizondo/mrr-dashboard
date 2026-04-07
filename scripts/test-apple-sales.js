const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const zlib = require('zlib');

// Load .env.local
const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf-8');
for (const line of env.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq === -1) continue;
  const k = t.substring(0, eq).trim();
  const v = t.substring(eq + 1).trim();
  if (!process.env[k]) process.env[k] = v;
}

function generateJWT() {
  const privateKey = Buffer.from(process.env.APPLE_PRIVATE_KEY_B64, 'base64').toString('utf-8');
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: process.env.APPLE_ISSUER_ID, iat: now, exp: now + 20 * 60, aud: 'appstoreconnect-v1' },
    privateKey,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: process.env.APPLE_KEY_ID, typ: 'JWT' } }
  );
}

async function fetchSales(date) {
  const token = generateJWT();
  const url = new URL('https://api.appstoreconnect.apple.com/v1/salesReports');
  url.searchParams.set('filter[reportType]', 'SALES');
  url.searchParams.set('filter[reportSubType]', 'SUMMARY');
  url.searchParams.set('filter[frequency]', 'DAILY');
  url.searchParams.set('filter[reportDate]', date);
  url.searchParams.set('filter[vendorNumber]', process.env.APPLE_VENDOR_NUMBER);
  url.searchParams.set('filter[version]', '1_0');

  console.log('Fetching:', url.toString());
  const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });

  console.log('Status:', response.status);
  if (!response.ok) {
    console.log('Error body:', await response.text());
    return;
  }

  const buf = Buffer.from(await response.arrayBuffer());
  let tsv;
  try {
    tsv = zlib.gunzipSync(buf).toString('utf-8');
  } catch {
    tsv = buf.toString('utf-8');
  }

  const lines = tsv.split('\n');
  console.log('Total lines:', lines.length);
  console.log('--- Header ---');
  console.log(lines[0]);
  console.log('--- First 3 data rows ---');
  for (let i = 1; i < Math.min(4, lines.length); i++) {
    console.log(lines[i]);
  }
  console.log('--- Refund rows (negative units) ---');
  let refundCount = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const units = parseInt(cols[7]); // Units is column index 7 in v1_0
    if (units < 0) {
      refundCount++;
      if (refundCount <= 3) console.log(lines[i]);
    }
  }
  console.log(`Total refund rows: ${refundCount}`);
}

const date = process.argv[2] || '2026-03-15';
fetchSales(date).catch((e) => { console.error(e); process.exit(1); });
