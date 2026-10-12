import Anthropic from '@anthropic-ai/sdk';

/**
 * Narrative layer of the daily brief.
 *
 * The numbers are computed in SQL (brief-queries.ts) and compared in TS
 * (daily-brief.ts). Claude only turns that fact sheet into the prose
 * sections — headline, one-line comments, "qué revisaría hoy" — and tags
 * every claim FACT / HIPÓTESIS. It never invents or recomputes a number.
 *
 * If the call fails or the output can't be parsed, the brief still ships
 * with a rule-based headline (see daily-brief.ts buildFallbackNarrative).
 */

const MODEL = 'claude-opus-5-5';

// ---- Facts contract (what daily-brief.ts hands to the writer) --------------

export interface FactComparison {
  kpi: string;
  label: string;
  value: string;            // formatted, e.g. "$43,950" / "9.00%" / "2,596"
  vsBaseline: string | null; // e.g. "+12%" / "−0.4 pp"
  vsSameDay: string | null;  // vs same weekday last week (daily only)
  flag: 'mejor' | 'peor' | null; // outside the 28-day noise band
}

export interface FactBreakdownRow {
  segment: string;           // 'iOS' | 'es' | 'US' ...
  metrics: Record<string, { value: string; delta: string | null }>; // kpi → {value, delta}
}

export interface BriefFacts {
  fecha: string;             // 'lunes 12 de octubre'
  ayer: { dia: string; comparadoCon: string; kpis: FactComparison[] };
  semanaEnCurso?: { rango: string; dias: number; comparadoCon: string; kpis: FactComparison[] };
  semanaPasada?: { rango: string; comparadoCon: string; kpis: FactComparison[] };
  desglose: {
    base: string;            // 'ayer vs promedio 7 días' | 'semana pasada vs anterior'
    plataforma: FactBreakdownRow[];
    idioma: FactBreakdownRow[];
    pais: FactBreakdownRow[];
  };
  movers: string[];          // "New Subs: el movimiento viene de iOS (−22 vs prom 7d)"
  notasDeDatos: string[];    // freshness, known lags
}

export interface BriefNarrative {
  loMasImportante: string;
  comentarioAyer?: string;
  comentarioSemana?: string;
  comentarioDesglose?: string;
  queRevisariaHoy: string[];
}

// ---- Prompt ------------------------------------------------------------------

const SYSTEM_PROMPT = `Eres el analista de BizOps de Kinedu. Cada mañana escribes el "morning brief" de KPIs operativos para el equipo en Slack. Recibes una hoja de hechos en JSON con los KPIs de ayer, de la semana y el desglose por plataforma, idioma y país. Tu trabajo es redactar las partes narrativas; las tablas de KPIs ya están resueltas y NO las repites.

REGLAS DE CONTENIDO
- Usa SOLO cifras que aparezcan en el JSON, con el mismo formato. No calcules nada nuevo, no inventes cifras ni causas.
- Etiqueta cada afirmación con una de estas marcas al final de la frase, en código Slack: \`FACT\` cuando es lectura directa de los datos; \`HIPÓTESIS\` cuando propones una causa o una interpretación no verificable con el JSON. Una causa sin \`HIPÓTESIS\` está prohibida.
- Prioriza en este orden: (1) KPIs marcados con flag (fuera de su banda de ruido de 28 días), (2) lo que mueve dinero: New Subs Sales, CAC, spend, Total Sales, (3) el desglose que explica el movimiento (movers). Lo que está dentro de banda no merece frase, salvo que acumule tendencia en la semana.
- Si nada está fuera de banda, dilo en una frase ("día dentro de rango") y no rellenes.
- "Qué revisaría hoy": 2 a 4 acciones concretas y chequeables, cada una dirigida a un rol (Marketing, Producto, Finanzas, Data). Si no hay nada que revisar, una sola línea diciéndolo.
- Nunca uses lenguaje de alarma ("crisis", "desplome", "alarmante") ni adjetivos vacíos. Frases cortas. Números en negritas con asteriscos simples (*1,745*).

FORMATO DE SALIDA
Responde ÚNICAMENTE con un objeto JSON válido, sin texto antes ni después, sin bloque de código:
{
  "loMasImportante": "2 a 3 frases. El titular del día.",
  "comentarioAyer": "Opcional. 1 frase sobre el día, solo si aporta algo que no diga el titular.",
  "comentarioSemana": "Opcional. 1 frase sobre la semana (en curso o pasada).",
  "comentarioDesglose": "Opcional. 1 frase: qué segmento explica el movimiento principal.",
  "queRevisariaHoy": ["Rol: acción concreta.", "..."]
}
Longitud: loMasImportante ≤ 450 caracteres; cada comentario ≤ 220; cada acción ≤ 160. Español neutro de México. No menciones que eres una IA ni digas "según los datos".`;

// ---- Call ----------------------------------------------------------------------

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured.');
  cachedClient = new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
  return cachedClient;
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object in response');
  return JSON.parse(text.slice(start, end + 1));
}

function asNarrative(raw: unknown): BriefNarrative {
  if (!raw || typeof raw !== 'object') throw new Error('Narrative is not an object');
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const lo = str(o.loMasImportante);
  if (!lo) throw new Error('Narrative missing loMasImportante');
  const acciones = Array.isArray(o.queRevisariaHoy)
    ? (o.queRevisariaHoy as unknown[]).map(str).filter((s): s is string => Boolean(s)).slice(0, 4)
    : [];
  return {
    loMasImportante: lo,
    comentarioAyer: str(o.comentarioAyer),
    comentarioSemana: str(o.comentarioSemana),
    comentarioDesglose: str(o.comentarioDesglose),
    queRevisariaHoy: acciones,
  };
}

/**
 * Returns the narrative, or null when Claude is unavailable / refused / returned
 * something unparsable. Callers must handle null with a deterministic fallback.
 */
export async function writeBriefNarrative(facts: BriefFacts): Promise<BriefNarrative | null> {
  try {
    const res = await client().messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: 'medium' },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(facts) }],
    });

    if (res.stop_reason === 'refusal') {
      console.error('[brief-writer] model refused:', res.stop_details?.explanation ?? '(no explanation)');
      return null;
    }
    if (res.stop_reason === 'max_tokens') {
      console.error('[brief-writer] output truncated at max_tokens');
      return null;
    }

    const text = res.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    return asNarrative(extractJson(text));
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      console.error('[brief-writer] rate limited:', err.message);
    } else if (err instanceof Anthropic.APIConnectionError) {
      console.error('[brief-writer] connection error:', err.message);
    } else if (err instanceof Anthropic.APIError) {
      console.error(`[brief-writer] API error ${err.status}:`, err.message);
    } else {
      console.error('[brief-writer] failed:', err instanceof Error ? err.message : err);
    }
    return null;
  }
}
