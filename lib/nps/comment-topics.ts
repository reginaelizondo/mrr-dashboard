import { NpsResponse } from './types';

export interface TopicDef {
  key: string;
  label: string;
  patterns: RegExp[];
}

function words(...keywords: string[]): RegExp[] {
  return keywords.map((kw) => {
    if (kw.includes(' ')) return new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[\\s.,;:!?¿¡"'()/])${escaped}(?:$|[\\s.,;:!?¿¡"'()/])`, 'i');
  });
}

export const NEGATIVE_TOPICS: TopicDef[] = [
  {
    key: 'bug',
    label: 'Bugs & errors',
    patterns: words(
      // English
      'bug', 'error', 'crash', 'broken', 'breaks', 'breaks constantly',
      'glitch', 'freeze', 'freezes', 'stuck',
      'slow', 'loading', 'lag', 'laggy',
      'doesnt work', "doesn't work", 'not working', 'failed',
      "can't change", "cant change", "can't use", "cant use",
      "can't find", "cant find", 'unable to', "won't let",
      'app breaks', 'support ignored', 'ignored by support',
      // Spanish
      'falla', 'fallo', 'no funciona', 'no sirve', 'se traba', 'lento', 'lenta',
      'se cierra', 'se cae', 'no carga', 'no abre', 'tarda',
      'no me deja', 'no puedo', 'no se puede', 'no permite',
      'bloquea', 'bloqueado', 'se bloquea', 'se repite eternamente',
      'videos bloqueados',
      // Portuguese
      'travando', 'travou', 'trava muito', 'não funciona', 'não abre', 'erro',
      'não consigo', 'não deixa',
      'muito pesado', 'demora muito', 'demora para carregar',
      'muito problema', 'pessima experiencia',
    ),
  },
  {
    key: 'price',
    label: 'Price & paywall',
    patterns: words(
      // English
      'price', 'pricing', 'expensive', 'cheap', 'money', 'paid',
      'subscription', 'worth', 'afford', 'charge', 'chargeable',
      'billing', 'refund', 'fee', 'the fee', 'fee is high',
      'pay for', 'have to pay', 'locked to pay', 'must pay',
      "aren't free", "isn't free", 'not free', 'everything is paid',
      'everything paid', 'everything chargeable',
      // Spanish
      'precio', 'caro', 'cara', 'costoso', 'costosa', 'pagar', 'pagarse',
      'cobro', 'cobran', 'cobraron', 'gratis', 'gratuito', 'gratuita',
      'dinero', 'mensualidad', 'abusiva',
      'se debe de pagar', 'todo es pago', 'todo se tiene que pagar',
      'requiere de pago', 'debe pagarse', 'es pago',
      'contenido gratuito', 'plan comprado', 'no tenemos plan',
      'aplicación pagada', 'app pagada', 'muy alto el costo',
      'costo muy alto', 'limitan la versión', 'limitan al extremo',
      'limitan', 'todo hay que pagarlo',
      'version gratuita', 'versión gratuita', 'muy cari', 'muy caro',
      'spent so much', 'paid too much',
      // Portuguese
      'preço', 'assinatura', 'dinheiro', 'muito caro',
    ),
  },
  {
    key: 'content_negative',
    label: 'Missing content',
    patterns: words(
      // English
      'no activities', 'few activities', 'need more', 'more content',
      "didn't find", 'not many fun activities', 'no content',
      // Spanish
      'poco contenido', 'pocas actividades', 'falta contenido',
      'sin contenido', 'falta', 'le falta', 'les falta',
      'no hay nada nuevo',
      // Portuguese
      'pouco conteúdo', 'poucos conteúdos',
    ),
  },
  {
    key: 'content_quality',
    label: 'Activities & content quality',
    patterns: words(
      // English — repetitive / boring / low variety
      'repetitive', 'repetitives', 'repeated', 'boring', 'bored', 'tedious',
      'not engaging', 'same activities', 'same exercises', 'same content',
      'same thing', 'same stuff', 'not enough variety', 'limited variety',
      "don't entertain", "doesn't entertain", 'nothing new',
      'nothing beyond', 'beyond the ordinary', 'ordinary',
      // English — too simple / too hard / bad instructions
      'too simple', 'too basic', 'too easy', 'too complicated', 'too difficult',
      'too hard', 'weird supplies', 'big mess', 'too much setup',
      'not really an activity', 'just a statement', 'waste of time',
      'too much bla', 'less exercises', 'less games', 'bla bla',
      // English — age / relevance
      'not age appropriate', 'wrong age', 'not for my baby', 'outdated',
      'based on my babies', 'older babies', 'younger babies',
      'only recommending thing',
      // Spanish — repetitive / boring / no novelty
      'repetitivo', 'repetitiva', 'repetidas', 'repetidos', 'repeticiones',
      'aburrido', 'aburrida', 'aburridas', 'aburridos',
      'tedioso', 'tediosa', 'monótono', 'monótona',
      'no cambian las actividades', 'no hay nada nuevo',
      // Spanish — too simple / too hard / bad
      'muy simple', 'muy simples', 'muy básico', 'muy básica',
      'muy básicas', 'muy básicos',
      'un poco básicas', 'un poco básicos', 'son básicas', 'son básicos',
      'demasiado simple', 'demasiado fácil', 'demasiado difícil',
      'demasiado básico', 'demasiado básica',
      // Spanish — sameness / variety
      'siempre lo mismo', 'siempre igual', 'siempre iguales',
      'siempre las mismas', 'siempre los mismos',
      'misma actividad', 'mismas actividades', 'mismos ejercicios',
      'poca variedad', 'sin variedad', 'falta variedad',
      'actividades aburridas', 'actividades repetitivas',
      'actividades básicas', 'actividades simples',
      'ejercicios aburridos', 'ejercicios repetitivos',
      // Spanish — age / relevance
      'no va con la edad', 'no coincide con la edad',
      'no es para la edad', 'no son adecuadas',
      'para bebés mayores', 'bebés mayores',
      'no me indican', 'no me dan nuevas actividades',
      'no es conveniente', 'ponen cosas',
      // Portuguese
      'chato', 'chata', 'entediante', 'repetitivas',
      'muito simples', 'muito básico', 'muito básica',
      'sempre iguais', 'sempre o mesmo', 'mesmas atividades',
      'fora da idade', 'não condiz com a idade',
      'idade do bebê', 'muito fora', 'bebês maiores',
    ),
  },
  {
    key: 'ux_negative',
    label: 'Hard to use (app UX)',
    patterns: words(
      // English
      'confusing', 'intuitive', 'layout', 'user interface',
      'hard to use', 'hard to find', 'hard to navigate', 'difficult to navigate',
      'app is confusing', 'app is hard', 'less user friendly',
      'not user friendly', 'not user', 'not organized', 'not intuitive',
      'not very intuitive', 'tight schedule friendly',
      // Spanish
      'confuso', 'confusa', 'difícil de usar', 'difícil de navegar',
      'navegar', 'navegación', 'diseño', 'interfaz',
      'aplicación complicada', 'app complicada', 'app confusa',
      'me cuesta entender', 'me ha dificultado',
      'difícil de entender', 'cero amigable', 'no es organizado',
      'no es organizada', 'poco intuitiva', 'poco intuitivo',
      'ser más práctica', 'debería ser más',
      // Portuguese
      'navegação', 'navegação complicada', 'navegabilidade',
      'difícil de me achar', 'não é tão boa', 'poderia ser mais prática',
    ),
  },
  {
    key: 'feature_request',
    label: 'Feature requests',
    patterns: words(
      // English
      'feature', 'improvement', 'suggestion',
      'would be nice', 'should have', 'could add', 'please add',
      'i wish it', 'wish it had', 'wish there', 'i would like',
      "i'd like", 'would like', 'should be based on',
      // Spanish
      'ojalá', 'quisiera', 'sugerencia', 'sugiero', 'agregar',
      'añadir', 'debería tener', 'estaría bien',
      'me encantaría', 'me gustaría que', 'debería ser',
      'deberia tener', 'deberia ser',
      // Portuguese
      'gostaria', 'sugestão', 'deveria', 'deviam',
      'poderia ter', 'poderia ser',
    ),
  },
  {
    key: 'trust_marketing',
    label: 'Misleading / trial issues',
    patterns: words(
      // English
      'misleading', 'trial period', 'free trial',
      'marketing', 'promised', 'advertised',
      // Spanish
      'engañoso', 'engañosa', 'engaño',
      'marketing que la app', 'mejor el marketing',
      'prometieron', 'publicidad',
      // Portuguese
      'enganoso', 'enganosa',
    ),
  },
  {
    key: 'low_usage',
    label: 'Not using yet / low engagement',
    patterns: words(
      // English
      'not useful yet', "haven't used", 'have not used',
      "haven't tried", 'not using', "don't use",
      'not much use', 'not yet useful', 'not used the app',
      'hasn\'t been useful',
      // Spanish
      'aún no la utilizo', 'aun no la utilizo',
      'no la utilizo', 'no la uso', 'no la he usado',
      'todavía no', 'aún no la',
      // Portuguese
      'ainda não', 'ainda não usei',
    ),
  },
  {
    key: 'support_issues',
    label: 'Customer support',
    patterns: words(
      // English
      'support ignored', 'reached out', 'customer service',
      'no response', 'support team', 'no one to ask',
      // Spanish
      'soporte', 'servicio al cliente', 'nadie responde',
      'no había quien preguntar', 'no hay ayuda',
      'no me ayudan', 'no me respondieron',
      // Portuguese
      'atendimento', 'suporte', 'ninguém responde',
    ),
  },
  {
    // Catches short generic complaints that are clearly negative but don't
    // fit any of the specific buckets above ("app sucks", "podría mejor").
    key: 'generic_negative',
    label: 'Generic negative feedback',
    patterns: words(
      // English
      'sucks', 'bad', 'terrible', 'awful', 'hate', 'worst',
      'not good', 'not great', 'disappointing', 'disappointed',
      // Spanish
      'mala', 'malo', 'pésima', 'pésimo', 'horrible',
      'podría mejor', 'podria mejor', 'no me gusta',
      'decepcionado', 'decepcionada', 'decepción',
      // Portuguese
      'ruim', 'péssimo', 'péssima', 'horrível',
    ),
  },
];

export const POSITIVE_TOPICS: TopicDef[] = [
  {
    key: 'love',
    label: 'Love it',
    patterns: words(
      'love', 'amazing', 'awesome', 'excellent', 'wonderful',
      'fantastic', 'perfect', 'great',
      'encanta', 'excelente', 'increíble', 'genial', 'maravilloso', 'maravillosa',
      'fantástico', 'fantástica', 'perfecto', 'perfecta',
      'adoro', 'incrível', 'maravilhoso', 'perfeito', 'perfeita',
    ),
  },
  {
    key: 'helpful',
    label: 'Helpful content',
    patterns: words(
      'helpful', 'useful', 'learning', 'educational',
      'útil', 'ayuda', 'aprender', 'aprendiendo', 'educativo', 'educativa',
      'facilita', 'facilita mucho', 'me ayuda',
      'útil', 'ajuda', 'educativo',
    ),
  },
  {
    key: 'activities_positive',
    label: 'Great activities',
    patterns: words(
      'great activities', 'love the activities', 'fun activities',
      'actividades increíbles', 'buenas actividades', 'me gustan las actividades',
      'atividades boas', 'ótimas atividades',
    ),
  },
  {
    key: 'recommend',
    label: 'Would recommend',
    patterns: words(
      'recommend', 'recommended', 'good app', 'great app', 'best app',
      'recomiendo', 'recomendada', 'buena app', 'buena aplicación',
      'muy buena', 'mejor app',
      'recomendo', 'ótima', 'ótimo',
    ),
  },
];

export interface TopicBucket {
  key: string;
  label: string;
  count: number;
  examples: NpsResponse[];
  /** true when this is the catch-all "Other" bucket */
  isOther?: boolean;
}

/**
 * Normalize curly / smart punctuation to the straight ASCII equivalents so
 * patterns like "don't entertain" match both straight and curly apostrophes,
 * which the Google Sheet CSV export commonly contains for iOS-typed comments.
 */
function normalizeComment(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")  // curly apostrophes → '
    .replace(/[\u201C\u201D\u201F\u2033]/g, '"'); // curly quotes → "
}

/**
 * Classify commented responses into topic buckets. Comments that don't match
 * any topic fall into a synthetic "Other feedback" bucket so audit coverage
 * is always 100% — nothing silently disappears.
 */
export function bucketize(responses: NpsResponse[], topics: TopicDef[]): TopicBucket[] {
  const buckets: Record<string, NpsResponse[]> = {};
  topics.forEach((t) => { buckets[t.key] = []; });
  const uncategorized: NpsResponse[] = [];

  responses.forEach((r) => {
    if (!r.comment || !r.comment.trim()) return;
    const normalized = normalizeComment(r.comment);
    let matched = false;
    topics.forEach((t) => {
      if (t.patterns.some((re) => re.test(normalized))) {
        buckets[t.key].push(r);
        matched = true;
      }
    });
    if (!matched) uncategorized.push(r);
  });

  const regular = topics
    .map((t) => ({
      key: t.key,
      label: t.label,
      count: buckets[t.key].length,
      examples: buckets[t.key].sort((a, b) => b.date.localeCompare(a.date)),
      isOther: false,
    }))
    .filter((b) => b.count > 0)
    .sort((a, b) => b.count - a.count);

  if (uncategorized.length > 0) {
    regular.push({
      key: 'other',
      label: 'Other feedback',
      count: uncategorized.length,
      examples: uncategorized.sort((a, b) => b.date.localeCompare(a.date)),
      isOther: true,
    });
  }

  return regular;
}
