// Backfill Apple customer reviews from ASC API into Supabase `apple_reviews`.
//
// Usage:
//   node scripts/backfill-apple-reviews.js                # full backfill (all reviews)
//   node scripts/backfill-apple-reviews.js --since 2025-01-01
//
// Notes:
// - ASC API paginates with cursor via links.next (no offset). Max limit=200.
// - Sort newest-first so we can early-exit when we pass the --since cutoff.
// - Topic tagging runs inline (rule-based, see lib/sync/review-categorize.ts).
// - Upsert on review_id; safe to re-run.

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// --- env loader (no dotenv dep needed) -------------------------------------
function loadEnv(fp) {
  try {
    for (const l of fs.readFileSync(fp, 'utf-8').split('\n')) {
      const t = l.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {}
}
loadEnv(path.join(__dirname, '..', '.env.local'));

// --- args ------------------------------------------------------------------
const args = process.argv.slice(2);
let sinceDate = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--since' && args[i + 1]) {
    sinceDate = new Date(args[i + 1] + 'T00:00:00Z');
  }
}
const APP_ID = process.env.APPLE_APP_ID || '741277284'; // com.kinedu.kineduapp

// --- ASC JWT ---------------------------------------------------------------
function ascToken() {
  const pk = Buffer.from(process.env.APPLE_PRIVATE_KEY_B64, 'base64').toString('utf-8');
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: process.env.APPLE_ISSUER_ID, iat: now, exp: now + 20 * 60, aud: 'appstoreconnect-v1' },
    pk,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: process.env.APPLE_KEY_ID, typ: 'JWT' } }
  );
}

// --- Topic categorizer (inline copy of lib/sync/review-categorize.ts) ------
// Duplicated in JS so we don't need a TS compile step for the backfill script.
const PRIORITY = [
  'free_trial', 'refund', 'subscription_mgmt', 'pricing', 'paywall',
  'bugs_crashes', 'performance', 'account_login', 'content_repetitive',
  'content_age_fit', 'content_quality', 'ads', 'ux_ui', 'support',
  'language_localization', 'praise',
];
const PATTERNS = {
  free_trial: /\b(prueba\s+gratis|prueba\s+gratuita|periodo\s+de\s+prueba|free\s*trial|per[ií]odo\s*de\s*teste|teste\s*gr[aá]tis|trial|cobro.*sin|me\s*cobraron\s*sin|charged\s*without|sin\s*avisar|me\s*quitaron|charged\s*me)\b/i,
  refund: /\b(reembolso|devoluci[oó]n|refund|me\s*devuelvan|estorno|devolver\s*mi\s*dinero|money\s*back)\b/i,
  subscription_mgmt: /\b(cancelar|cancel(ation)?|renovaci[oó]n|auto-?renew|unsubscribe|darse\s*de\s*baja|no\s*puedo\s*cancelar|can'?t\s*cancel|cancelamento|assinatura)\b/i,
  pricing: /\b(car[ií]simo|muy\s*caro|caro|expensive|overpriced|too\s*expensive|precio|price|pricey|no\s*vale\s*(la\s*pena|el\s*precio)|not\s*worth|caro\s*demais|pricing)\b/i,
  paywall: /\b(paywall|todo\s*es?\s*de?\s*pago|todo\s*cobra|todo\s*cuesta|all\s*locked|locked\s*behind|everything\s*(is\s*)?paid|nothing\s*is\s*free|nada\s*(es\s*)?gratis|tudo\s*pago|no\s*gratis)\b/i,
  bugs_crashes: /\b(crash|se\s*cierra|se\s*cae|se\s*traba|bug|error|not\s*work(ing)?|no\s*funciona|doesn'?t\s*work|broken|glitch|freezes?|congela|travado|bugado|n[aã]o\s*funciona)\b/i,
  performance: /\b(slow|lento|lag|lagg?y|tarda\s*mucho|carga\s*(muy\s*)?lento|takes\s*forever|performance|demora|lenta|lentid[aã]o)\b/i,
  account_login: /\b(log\s*in|login|no\s*puedo\s*entrar|can'?t\s*(log\s*in|sign\s*in|access)|contrase[nñ]a|password|cuenta|account\s*issue|no\s*entra|can'?t\s*access|iniciar\s*sesi[oó]n|conta\s*bloqueada)\b/i,
  content_repetitive: /\b(repetitiv[oa]|mismas?\s*actividades|las?\s*mismas|same\s*(activities|content)|repetitive|aburrido|boring|siempre\s*igual|always\s*the\s*same|repetido|repete|mesmas?)\b/i,
  content_age_fit: /\b(no\s*es\s*para|not\s*for|too\s*young|too\s*old|mayor|menor|ya\s*no\s*le\s*sirve|outgrew|grew\s*out|no\s*apto|idade|not\s*age\s*appropriate|not\s*appropriate\s*for)\b/i,
  content_quality: /\b(contenido\s*(pobre|b[aá]sico|malo|flojo)|poor\s*content|basic|b[aá]sico|nothing\s*new|sin\s*sustancia|shallow|superficial|limited|limitado|few\s*activities|pocas\s*actividades|conte[uú]do\s*fraco)\b/i,
  ads: /\b(ads?|anuncios|publicidad|comerciales|propaganda|an[uú]ncios|too\s*many\s*ads)\b/i,
  support: /\b(support|soporte|atenci[oó]n\s*al\s*cliente|customer\s*service|no\s*responden|no\s*contestan|no\s*reply|suporte|atendimento|don'?t\s*respond|never\s*reply)\b/i,
  language_localization: /\b(en\s*ingl[eé]s|en\s*espa[nñ]ol|only\s*in\s*english|solo\s*(en\s*)?ingl[eé]s|traducci[oó]n|translation|portugu[eê]s|idioma|language\s*(issue|problem)|not\s*translated|sin\s*traducir|em\s*portugu[eê]s)\b/i,
  ux_ui: /\b(confus(o|ing)|hard\s*to\s*use|complicad[oa]|interfaz|interface|ui|ux|not\s*intuitive|poco\s*intuitiv[oa]|dif[ií]cil\s*de\s*usar|navegaci[oó]n|navigation)\b/i,
  praise: /\b(excelente|excellent|love|amazing|maravillos[oa]|increible|incre[ií]ble|perfect|perfecto|awesome|fant[aá]stic[oa]|best\s*app|adoro|melhor\s*app)\b/i,
};

function detectLanguage(text) {
  const t = (text || '').toLowerCase();
  const es = (t.match(/\b(que|para|muy|pero|mi|hijo|hija|niñ[oa]|bebé|años?|edad|app|está|gusta|me)\b/g) || []).length;
  const en = (t.match(/\b(the|for|and|but|my|son|daughter|baby|year|old|app|is|love|it)\b/g) || []).length;
  const pt = (t.match(/\b(para|mas|meu|minha|filho|filha|bebê|ano|anos|não|está|muito|com)\b/g) || []).length;
  const max = Math.max(es, en, pt);
  if (max < 2) return 'other';
  if (max === es) return 'es';
  if (max === en) return 'en';
  return 'pt';
}

function categorize(title, body, rating) {
  const text = `${title || ''} ${body || ''}`.trim();
  if (!text) return { topics: [], primary: null };
  const hits = [];
  for (const topic of PRIORITY) if (PATTERNS[topic].test(text)) hits.push(topic);
  if (hits.length === 0 && rating >= 4) hits.push('praise');
  return { topics: hits, primary: hits[0] || null };
}

// --- Supabase --------------------------------------------------------------
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

async function upsertBatch(batch) {
  const { error } = await supabase
    .from('apple_reviews')
    .upsert(batch, { onConflict: 'review_id' });
  if (error) throw error;
}

// --- Main loop -------------------------------------------------------------
async function main() {
  console.log(`App Store Connect → apple_reviews backfill`);
  console.log(`  appId: ${APP_ID}`);
  console.log(`  since: ${sinceDate ? sinceDate.toISOString().slice(0, 10) : 'all time'}`);

  const token = ascToken();
  const headers = { Authorization: `Bearer ${token}` };

  let nextUrl = (() => {
    const u = new URL(`https://api.appstoreconnect.apple.com/v1/apps/${APP_ID}/customerReviews`);
    u.searchParams.set('limit', '200');
    u.searchParams.set('sort', '-createdDate');
    return u.toString();
  })();

  let fetched = 0, kept = 0, batchBuf = [];
  let stopped = false;

  while (nextUrl && !stopped) {
    const res = await fetch(nextUrl, { headers });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`ASC ${res.status}: ${txt.slice(0, 300)}`);
    }
    const j = await res.json();
    const rows = j.data || [];
    fetched += rows.length;

    for (const r of rows) {
      const a = r.attributes || {};
      const createdAt = new Date(a.createdDate);
      if (sinceDate && createdAt < sinceDate) {
        stopped = true;
        break;
      }
      const { topics, primary } = categorize(a.title, a.body, a.rating);
      const lang = detectLanguage(`${a.title || ''} ${a.body || ''}`);
      batchBuf.push({
        review_id: r.id,
        rating: a.rating,
        title: a.title || null,
        body: a.body || null,
        reviewer_nickname: a.reviewerNickname || null,
        territory: a.territory,
        created_at: a.createdDate,
        app_id: APP_ID,
        language: lang,
        topics,
        primary_topic: primary,
        has_developer_reply: false, // not expanded; can backfill later
      });
      kept++;

      if (batchBuf.length >= 500) {
        await upsertBatch(batchBuf);
        console.log(`  upserted ${kept} reviews (fetched ${fetched}; next: ${a.createdDate.slice(0, 10)})`);
        batchBuf = [];
      }
    }

    nextUrl = j.links?.next || null;
  }

  if (batchBuf.length) {
    await upsertBatch(batchBuf);
  }

  // Final count check
  const { count, error } = await supabase
    .from('apple_reviews')
    .select('*', { count: 'exact', head: true });
  if (error) throw error;

  console.log(`\n✅ Done. fetched=${fetched}  keptForBackfill=${kept}  totalInDB=${count}`);
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
