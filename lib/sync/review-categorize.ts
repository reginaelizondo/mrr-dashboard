// Rule-based topic tagger for Apple reviews.
// Works on ES / EN / PT (Kinedu's three main markets).
// Tags are additive; `primary_topic` is the first hit in priority order
// so charts don't double-count a review that mentions both pricing and bugs.

export type ReviewTopic =
  | 'pricing'
  | 'paywall'
  | 'free_trial'
  | 'refund'
  | 'subscription_mgmt'
  | 'bugs_crashes'
  | 'performance'
  | 'account_login'
  | 'content_quality'
  | 'content_repetitive'
  | 'content_age_fit'
  | 'ux_ui'
  | 'ads'
  | 'support'
  | 'language_localization'
  | 'praise';

// Priority: quality/money complaints first (those are the ones that drive churn)
const PRIORITY: ReviewTopic[] = [
  'free_trial',
  'refund',
  'subscription_mgmt',
  'pricing',
  'paywall',
  'bugs_crashes',
  'performance',
  'account_login',
  'content_repetitive',
  'content_age_fit',
  'content_quality',
  'ads',
  'ux_ui',
  'support',
  'language_localization',
  'praise',
];

// Regexes are intentionally loose and case-insensitive. They match substrings
// in the concatenated "title + body" string.
const PATTERNS: Record<ReviewTopic, RegExp> = {
  free_trial:
    /\b(prueba\s+gratis|prueba\s+gratuita|periodo\s+de\s+prueba|free\s*trial|per[ií]odo\s*de\s*teste|teste\s*gr[aá]tis|trial|cobro.*sin|me\s*cobraron\s*sin|charged\s*without|sin\s*avisar|me\s*quitaron|charged\s*me)\b/i,
  refund:
    /\b(reembolso|devoluci[oó]n|refund|me\s*devuelvan|reembolso|estorno|devolver\s*mi\s*dinero|money\s*back)\b/i,
  subscription_mgmt:
    /\b(cancelar|cancel(ation)?|renovaci[oó]n|auto-?renew|unsubscribe|darse\s*de\s*baja|no\s*puedo\s*cancelar|can'?t\s*cancel|cancelar\s*la\s*suscripci[oó]n|cancelamento|assinatura)\b/i,
  pricing:
    /\b(car[ií]simo|muy\s*caro|caro|expensive|overpriced|too\s*expensive|precio|price|pricey|no\s*vale\s*(la\s*pena|el\s*precio)|not\s*worth|caro\s*demais|pricing)\b/i,
  paywall:
    /\b(paywall|todo\s*es?\s*de?\s*pago|todo\s*cobra|todo\s*cuesta|all\s*locked|locked\s*behind|everything\s*(is\s*)?paid|nothing\s*is\s*free|nada\s*(es\s*)?gratis|tudo\s*pago|no\s*gratis)\b/i,
  bugs_crashes:
    /\b(crash|se\s*cierra|se\s*cae|se\s*traba|bug|error|not\s*work(ing)?|no\s*funciona|doesn'?t\s*work|broken|glitch|freezes?|congela|travado|bugado|n[aã]o\s*funciona)\b/i,
  performance:
    /\b(slow|lento|lag|lagg?y|tarda\s*mucho|carga\s*(muy\s*)?lento|takes\s*forever|performance|demora|lenta|lentid[aã]o)\b/i,
  account_login:
    /\b(log\s*in|login|no\s*puedo\s*entrar|can'?t\s*(log\s*in|sign\s*in|access)|contrase[nñ]a|password|cuenta|account\s*issue|no\s*entra|can'?t\s*access|iniciar\s*sesi[oó]n|conta\s*bloqueada)\b/i,
  content_repetitive:
    /\b(repetitiv[oa]|mismas?\s*actividades|las?\s*mismas|same\s*(activities|content)|repetitive|aburrido|boring|siempre\s*igual|always\s*the\s*same|repetido|repete|mesmas?)\b/i,
  content_age_fit:
    /\b(no\s*es\s*para|not\s*for|too\s*young|too\s*old|mayor|menor|ya\s*no\s*le\s*sirve|outgrew|grew\s*out|no\s*apto|idade|not\s*age\s*appropriate|not\s*appropriate\s*for)\b/i,
  content_quality:
    /\b(contenido\s*(pobre|b[aá]sico|malo|flojo)|poor\s*content|basic|b[aá]sico|nothing\s*new|sin\s*sustancia|shallow|superficial|limited|limitado|few\s*activities|pocas\s*actividades|conte[uú]do\s*fraco)\b/i,
  ads:
    /\b(ads?|anuncios|publicidad|comerciales|propaganda|an[uú]ncios|too\s*many\s*ads)\b/i,
  support:
    /\b(support|soporte|atenci[oó]n\s*al\s*cliente|customer\s*service|no\s*responden|no\s*contestan|no\s*reply|suporte|atendimento|don'?t\s*respond|never\s*reply)\b/i,
  language_localization:
    /\b(en\s*ingl[eé]s|en\s*espa[nñ]ol|only\s*in\s*english|solo\s*(en\s*)?ingl[eé]s|traducci[oó]n|translation|portugu[eê]s|idioma|language\s*(issue|problem)|not\s*translated|sin\s*traducir|em\s*portugu[eê]s)\b/i,
  ux_ui:
    /\b(confus(o|ing)|hard\s*to\s*use|complicad[oa]|interfaz|interface|ui|ux|not\s*intuitive|poco\s*intuitiv[oa]|dif[ií]cil\s*de\s*usar|navegaci[oó]n|navigation)\b/i,
  praise:
    /\b(excelente|excellent|love|amazing|maravillos[oa]|increible|incre[ií]ble|perfect|perfecto|awesome|fant[aá]stic[oa]|best\s*app|adoro|melhor\s*app)\b/i,
};

export function detectLanguage(text: string): 'es' | 'en' | 'pt' | 'other' {
  const t = text.toLowerCase();
  // Distinctive short words
  const es = (t.match(/\b(que|para|muy|pero|mi|hijo|hija|niñ[oa]|bebé|años?|edad|app|está|gusta|me)\b/g) || []).length;
  const en = (t.match(/\b(the|for|and|but|my|son|daughter|baby|year|old|app|is|love|it)\b/g) || []).length;
  const pt = (t.match(/\b(para|mas|meu|minha|filho|filha|bebê|ano|anos|não|está|muito|com)\b/g) || []).length;
  const max = Math.max(es, en, pt);
  if (max < 2) return 'other';
  if (max === es) return 'es';
  if (max === en) return 'en';
  return 'pt';
}

export function categorizeReview(
  title: string | null,
  body: string | null,
  rating: number
): { topics: ReviewTopic[]; primary: ReviewTopic | null } {
  const text = `${title || ''} ${body || ''}`.trim();
  if (!text) return { topics: [], primary: null };

  const hits: ReviewTopic[] = [];
  for (const topic of PRIORITY) {
    if (PATTERNS[topic].test(text)) hits.push(topic);
  }

  // High-rating reviews with no complaint hits → mark as praise
  if (hits.length === 0 && rating >= 4) hits.push('praise');

  const primary = hits[0] || null;
  return { topics: hits, primary };
}
