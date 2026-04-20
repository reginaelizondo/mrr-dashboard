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
      'bug', 'error', 'crash', 'broken', 'glitch', 'freeze', 'freezes', 'stuck',
      'slow', 'loading', 'lag', 'laggy',
      'doesnt work', "doesn't work", 'not working', 'failed',
      "can't change", "cant change", "can't use", "cant use",
      "can't find", "cant find", "unable to", "won't let",
      'falla', 'fallo', 'no funciona', 'no sirve', 'se traba', 'lento', 'lenta',
      'se cierra', 'se cae', 'no carga', 'no abre', 'tarda',
      'no me deja', 'no puedo', 'no se puede', 'no permite',
      'travando', 'travou', 'não funciona', 'não abre', 'erro',
      'não consigo', 'não deixa',
    ),
  },
  {
    key: 'price',
    label: 'Price & paywall',
    patterns: words(
      'price', 'pricing', 'expensive', 'cheap', 'money', 'paid',
      'subscription', 'worth', 'afford', 'charge', 'billing', 'refund',
      'pay for', 'have to pay', 'locked to pay', 'must pay',
      'precio', 'caro', 'cara', 'costoso', 'costosa', 'pagar', 'pagarse',
      'cobro', 'cobran', 'cobraron', 'gratis', 'gratuito', 'gratuita',
      'dinero', 'mensualidad', 'abusiva',
      'se debe de pagar', 'todo es pago', 'todo se tiene que pagar',
      'requiere de pago', 'debe pagarse', 'es pago',
      'contenido gratuito', 'plan comprado', 'no tenemos plan',
      'preço', 'assinatura', 'dinheiro',
    ),
  },
  {
    key: 'content_negative',
    label: 'Missing content',
    patterns: words(
      'no activities', 'few activities', 'need more', 'more content',
      'poco contenido', 'pocas actividades', 'falta contenido',
      'sin contenido', 'pouco conteúdo', 'falta', 'le falta', 'les falta',
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
      // English — too simple / too hard / bad instructions
      'too simple', 'too basic', 'too easy', 'too complicated', 'too difficult',
      'too hard', 'weird supplies', 'big mess', 'too much setup',
      'not really an activity', 'just a statement', 'waste of time',
      // English — age / relevance
      'not age appropriate', 'wrong age', 'not for my baby', 'outdated',
      // Spanish — repetitive / boring
      'repetitivo', 'repetitiva', 'repetidas', 'repetidos',
      'aburrido', 'aburrida', 'aburridas', 'aburridos',
      'tedioso', 'tediosa', 'monótono', 'monótona',
      // Spanish — too simple / too hard / bad
      'muy simple', 'muy simples', 'muy básico', 'muy básica',
      'muy básicas', 'muy básicos',
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
      // Portuguese
      'chato', 'chata', 'entediante', 'repetitivas',
      'muito simples', 'muito básico', 'muito básica',
      'sempre iguais', 'sempre o mesmo', 'mesmas atividades',
    ),
  },
  {
    key: 'ux_negative',
    label: 'Hard to use (app UX)',
    patterns: words(
      // Keep this scoped to APP navigation / interface issues, not content.
      // Ambiguous words like "complicated" / "difficult" were removed because
      // they also match complaints about activity complexity, which belongs
      // in `content_quality`.
      'confusing', 'intuitive', 'layout', 'user interface',
      'hard to use', 'hard to find', 'hard to navigate', 'difficult to navigate',
      'app is confusing', 'app is hard',
      'confuso', 'confusa', 'difícil de usar', 'difícil de navegar',
      'navegar', 'navegación', 'diseño', 'interfaz',
      'aplicación complicada', 'app complicada', 'app confusa',
      'navegação', 'navegação complicada',
    ),
  },
  {
    key: 'feature_request',
    label: 'Feature requests',
    patterns: words(
      'feature', 'improvement', 'suggestion',
      'would be nice', 'should have', 'could add', 'please add',
      'i wish it', 'wish it had', 'wish there',
      'ojalá', 'quisiera', 'sugerencia', 'sugiero', 'agregar',
      'añadir', 'debería tener', 'estaría bien',
      'gostaria', 'sugestão',
    ),
  },
];

export const POSITIVE_TOPICS: TopicDef[] = [
  {
    key: 'love',
    label: 'Love it',
    patterns: words(
      'love', 'amazing', 'awesome', 'excellent', 'wonderful',
      'fantastic', 'perfect',
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
      'activity', 'activities', 'lesson', 'lessons', 'exercise', 'exercises',
      'actividad', 'actividades', 'lección', 'ejercicio', 'ejercicios',
      'atividade', 'atividades', 'lição',
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
}

export function bucketize(responses: NpsResponse[], topics: TopicDef[]): TopicBucket[] {
  const buckets: Record<string, NpsResponse[]> = {};
  topics.forEach((t) => { buckets[t.key] = []; });

  responses.forEach((r) => {
    if (!r.comment || !r.comment.trim()) return;
    topics.forEach((t) => {
      if (t.patterns.some((re) => re.test(r.comment))) {
        buckets[t.key].push(r);
      }
    });
  });

  return topics
    .map((t) => ({
      key: t.key,
      label: t.label,
      count: buckets[t.key].length,
      examples: buckets[t.key].sort((a, b) => b.date.localeCompare(a.date)),
    }))
    .filter((b) => b.count > 0)
    .sort((a, b) => b.count - a.count);
}
