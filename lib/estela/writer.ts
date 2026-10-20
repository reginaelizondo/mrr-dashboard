/**
 * Estela · redactor de propuestas.
 *
 * Recibe la hoja de hechos (facts.ts) y devuelve exactamente tres propuestas con impacto
 * en caja. Claude no calcula ni inventa cifras: cada propuesta cita los hechos que la
 * sostienen. Si la llamada falla, el cron publica solo los hechos y lo dice.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { EstelaFacts } from './facts';

const MODEL = 'claude-opus-5-5';

export interface Proposal {
  titulo: string;          // ≤ 70 caracteres
  que: string;             // qué hacer, concreto, ≤ 400
  impactoCash: string;     // '+$4,500/mes' · '−$12,000 una vez' · 'protege $20,000'
  comoSeCalculo: string;   // qué hechos se usaron, ≤ 300
  riesgo: string;          // ≤ 200
  cuandoSeVe: string;      // '2 semanas' · 'cierre de noviembre'
  dueno: string;           // Pepis · Luis · Marketing · Tech · Regina · Paola
  tipo: 'ahorro' | 'ingreso' | 'cobranza' | 'riesgo' | 'pricing' | 'otro';
}

export interface EstelaNarrative {
  lectura: string;         // 2–3 frases: cómo viene la caja y la rentabilidad esta semana
  propuestas: Proposal[];  // exactamente 3
  seguimiento: string[];   // una línea por propuesta anterior aceptada o abierta
}

const SYSTEM_PROMPT = `Eres Estela, la estratega de BizOps de Kinedu. Cada lunes lees la hoja de hechos de la semana (KPIs, MRR, P&L consolidado, budget, caja y el seguimiento de propuestas anteriores) y le propones a Pepis, directora de BizOps, exactamente TRES cosas que mejoren la caja o la rentabilidad. Pepis decide; Luis (CEO) decide lo que toca a precios, headcount o inversionistas.

REGLAS
- Usa solo cifras que estén en el JSON, con el mismo formato. Nunca calcules cifras nuevas salvo sumas o diferencias simples entre dos números del JSON, y entonces escribe la operación en "comoSeCalculo" (por ejemplo "CAC $25.17 × 1,746 subs = $43,955 de spend").
- Toda propuesta se mide en dinero: ahorro mensual, ingreso adicional, cobranza acelerada o riesgo evitado. Si no puedes ponerle un número con los hechos disponibles, no la propongas.
- Prioriza: (1) lo que mueve más caja en los próximos 60 días, (2) lo que depende solo de BizOps, (3) lo que ya tiene señal en los datos (una línea del P&L que crece, un KPI fuera de su tendencia, un desvío contra budget).
- Las tres propuestas tienen que ser distintas entre sí (no tres variantes de recortar pauta). Mezcla ahorro, ingreso y riesgo cuando los hechos lo permitan.
- No repitas una propuesta que ya esté en "seguimiento" con estado "aceptada" o "propuesta". Para cada una escribe UNA línea con este formato: "#id · <título corto> · <qué dicen los hechos de esta semana sobre su impacto, con cifra> · veredicto: SIGUE | YA SE VE | NO SE VE | CERRAR". Usa YA SE VE cuando el dato ya muestra el efecto prometido; NO SE VE cuando ya pasó el plazo ("cuandoSeVe") y el dato no cambió; CERRAR cuando lleva más de 4 semanas sin señal o el tema quedó superado; SIGUE cuando todavía no llega el plazo. Para las que llevan 0 semanas abiertas (propuestas la semana pasada) basta con "SIGUE" y un dato.
- No propongas despidos ni cambios de sueldo: eso es de Luis y no se decide por Slack.
- Nunca uses lenguaje de alarma. Frases cortas. Español neutro de México. No digas que eres una IA.
- Si los hechos de una fuente faltan (por ejemplo, sin caja), no la inventes: trabaja con lo que hay y dilo en "lectura".

FORMATO
Responde ÚNICAMENTE con un objeto JSON válido, sin texto antes ni después, sin bloque de código:
{
  "lectura": "2 a 3 frases sobre caja y rentabilidad esta semana, con cifras del JSON.",
  "propuestas": [
    {"titulo": "...", "que": "...", "impactoCash": "+$X/mes", "comoSeCalculo": "...", "riesgo": "...", "cuandoSeVe": "...", "dueno": "Pepis", "tipo": "ahorro"},
    {...}, {...}
  ],
  "seguimiento": ["#12 · Tope de CAC · CAC semanal bajó de $26.61 a $24.10 · veredicto: YA SE VE", "..."]
}
"tipo" es uno de: ahorro, ingreso, cobranza, riesgo, pricing, otro. "cuandoSeVe" son 2 a 5 palabras ("2 semanas", "P&L de noviembre", "MRR del 1-nov"). Las cifras van siempre con formato de dinero ($14,321), nunca con decimales largos. Longitudes: titulo ≤ 70, que ≤ 400, comoSeCalculo ≤ 300, riesgo ≤ 200.`;

let cached: Anthropic | null = null;
function client(): Anthropic {
  if (cached) return cached;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured.');
  cached = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  return cached;
}

function extractJson(text: string): unknown {
  const s = text.indexOf('{'); const e = text.lastIndexOf('}');
  if (s === -1 || e === -1 || e <= s) throw new Error('No JSON object in response');
  return JSON.parse(text.slice(s, e + 1));
}

const TIPOS = new Set(['ahorro', 'ingreso', 'cobranza', 'riesgo', 'pricing', 'otro']);

function asNarrative(raw: unknown): EstelaNarrative {
  if (!raw || typeof raw !== 'object') throw new Error('Narrative is not an object');
  const o = raw as Record<string, unknown>;
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const lectura = str(o.lectura, 600);
  if (!lectura) throw new Error('Missing lectura');
  const props = Array.isArray(o.propuestas) ? (o.propuestas as unknown[]) : [];
  const propuestas: Proposal[] = props.slice(0, 3).map((p) => {
    const q = (p ?? {}) as Record<string, unknown>;
    const tipo = str(q.tipo, 20);
    return {
      titulo: str(q.titulo, 70) || 'Propuesta',
      que: str(q.que, 400),
      impactoCash: str(q.impactoCash, 60) || 'n/a',
      comoSeCalculo: str(q.comoSeCalculo, 300),
      riesgo: str(q.riesgo, 200),
      cuandoSeVe: str(q.cuandoSeVe, 60) || 'n/a',
      dueno: str(q.dueno, 30) || 'Pepis',
      tipo: (TIPOS.has(tipo) ? tipo : 'otro') as Proposal['tipo'],
    };
  }).filter((p) => p.que);
  if (propuestas.length === 0) throw new Error('No proposals');
  const seguimiento = Array.isArray(o.seguimiento)
    ? (o.seguimiento as unknown[]).map((s) => str(s, 240)).filter(Boolean).slice(0, 8)
    : [];
  return { lectura, propuestas, seguimiento };
}

/** null cuando Claude no está disponible o la respuesta no se puede usar. */
export async function writeEstela(facts: EstelaFacts): Promise<EstelaNarrative | null> {
  try {
    const res = await client().messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(facts) }],
    });
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') {
      console.error('[estela] model stop_reason:', res.stop_reason);
      return null;
    }
    const text = res.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text').map((b) => b.text).join('\n');
    return asNarrative(extractJson(text));
  } catch (err) {
    console.error('[estela] writer failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
