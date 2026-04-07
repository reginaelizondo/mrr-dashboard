import { TOPIC_LABELS, type ReviewTopic, type MonthlyReviewRow, type TopicCountRow, type TerritoryRow, type RatingsSummary } from './reviews';

/**
 * Rule-based insight generator for the Reviews tab.
 * Takes the already-aggregated data we send to ReviewsContent and produces
 * a list of actionable findings with severity and recommended actions.
 *
 * Intentionally deterministic (no LLM call) so it's fast, reproducible, and
 * doesn't cost tokens on every page load.
 */

export type InsightSeverity = 'critical' | 'high' | 'medium' | 'info';

export interface Insight {
  id: string;
  severity: InsightSeverity;
  title: string;
  description: string;
  recommendation: string;
  metric?: string;  // optional numeric summary to highlight
}

interface InsightInput {
  monthly: MonthlyReviewRow[];
  topics: TopicCountRow[];
  topicsByMonth: Record<string, Record<string, number>>;
  territories: TerritoryRow[];
  summary: {
    total: number;
    avg_rating: number;
    negative: number;
    negative_rate: number;
    positive: number;
  };
  ratingsSummary: RatingsSummary;
}

const SEVERITY_ORDER: Record<InsightSeverity, number> = {
  critical: 0, high: 1, medium: 2, info: 3,
};

/**
 * Recommended actions per complaint topic. Written in Spanish to match
 * the audience. Keep these short — the UI shows them as "próximo paso".
 */
const TOPIC_RECOMMENDATIONS: Partial<Record<ReviewTopic, string>> = {
  free_trial:
    'Revisar el flujo de inicio de Free Trial: hacer más visible la fecha exacta de cobro en el paywall, enviar email de aviso 48h antes del charge, y verificar que el texto de ASC sobre la duración sea claro en todos los idiomas.',
  refund:
    'Monitorear refund rate en paralelo y considerar un touchpoint proactivo (email) para usuarios que cancelan en los primeros 3 días pidiendo feedback antes de que escalen a review pública.',
  subscription_mgmt:
    'Agregar link directo "Gestionar suscripción" dentro de la app con deeplink a Settings → Subscriptions de iOS. Muchos usuarios no saben dónde cancelar y lo vuelcan en la review.',
  pricing:
    'Revisar los tiers por país (App Store Price Tiers). Si LATAM ya tiene precios localizados pero Europa no, es una quick-win. Evaluar si un plan mensual más accesible reduce quejas sin canibalizar el anual.',
  paywall:
    'Considerar ampliar el contenido free (ej. 7-14 días de actividades sin paywall) para reducir la percepción de "todo es de pago". El sesgo en reviews es muy fuerte con este tema.',
  bugs_crashes:
    'Priorizar con el equipo de QA/eng los crashes reportados, cruzando con Crashlytics. Cada review de 1⭐ por bug suele representar 10-50 usuarios silenciosos afectados.',
  performance:
    'Revisar tiempos de carga iniciales y del contenido de actividades. Considerar lazy-loading y caching más agresivo. Medir con RUM en producción.',
  account_login:
    'Auditar el flujo de login/registro. Muchas quejas aquí indican problemas de recuperación de contraseña o bloqueo por 2FA. Revisar logs de auth errors.',
  content_repetitive:
    'Feedback directo al equipo de contenido: los usuarios perciben que las actividades se repiten. Considerar cadencia de nuevo contenido y personalización por edad exacta del bebé.',
  content_age_fit:
    'Mejorar el mecanismo de transición de rangos etarios. Cuando un bebé cumple X meses, notificar el cambio de etapa y mostrar contenido nuevo para evitar la sensación de "se quedó sin contenido".',
  content_quality:
    'Recolectar ejemplos específicos de las reviews y compartir con el equipo de producto/contenido para benchmarks cualitativos.',
  ads:
    'Si hay ads en versión free, evaluar frecuencia y tipo. Es un tema sensible en apps para niños (COPPA/GDPR-K).',
  ux_ui:
    'Revisar las pantallas más mencionadas en las reviews con un UX review dedicado. Considerar un test de usabilidad con 5-8 usuarios para detectar fricciones.',
  support:
    'Los usuarios se quejan de falta de respuesta del soporte. Medir SLA actual de tickets, y considerar auto-responder con FAQ mientras responde un agente real.',
  language_localization:
    'Verificar cobertura de traducciones en los idiomas donde hay más quejas. Un audit de strings no traducidas suele resolver buena parte.',
};

export function generateInsights(data: InsightInput): Insight[] {
  const insights: Insight[] = [];
  const { monthly, topics, topicsByMonth, territories, summary, ratingsSummary } = data;

  // ─── 1. Dominant complaint ──────────────────────────────────────
  if (topics.length > 0) {
    const top = topics[0];
    insights.push({
      id: 'top-complaint',
      severity: top.pct_of_negative >= 0.3 ? 'critical' : 'high',
      title: `"${top.label}" es la queja #1 (${top.count} reviews, ${(top.pct_of_negative * 100).toFixed(0)}% del total negativo)`,
      description:
        `${top.count} de las ${summary.negative} reviews negativas (≤2⭐) del período mencionan este tema. Es el patrón dominante y probablemente el mayor driver de reputación negativa en escritura.`,
      recommendation: TOPIC_RECOMMENDATIONS[top.topic as ReviewTopic] ||
        'Investigar la causa raíz con un sampling cualitativo de 20-30 reviews.',
      metric: `${top.count} menciones · ${(top.pct_of_negative * 100).toFixed(0)}%`,
    });
  }

  // ─── 2. Trending topic (rising MoM) ─────────────────────────────
  const months = Object.keys(topicsByMonth).sort();
  if (months.length >= 3) {
    const recent = months.slice(-2);
    const prior = months.slice(-4, -2);
    const recentSum: Record<string, number> = {};
    const priorSum: Record<string, number> = {};
    for (const m of recent) {
      for (const [t, c] of Object.entries(topicsByMonth[m])) recentSum[t] = (recentSum[t] || 0) + c;
    }
    for (const m of prior) {
      for (const [t, c] of Object.entries(topicsByMonth[m])) priorSum[t] = (priorSum[t] || 0) + c;
    }
    let worstTrend: { topic: string; delta: number; recent: number; prior: number } | null = null;
    for (const [topic, recentCount] of Object.entries(recentSum)) {
      const priorCount = priorSum[topic] || 0;
      // At least 5 recent mentions AND at least doubled
      if (recentCount >= 5 && recentCount >= priorCount * 2) {
        const delta = recentCount - priorCount;
        if (!worstTrend || delta > worstTrend.delta) {
          worstTrend = { topic, delta, recent: recentCount, prior: priorCount };
        }
      }
    }
    if (worstTrend) {
      insights.push({
        id: 'rising-topic',
        severity: 'high',
        title: `⚠ Tendencia al alza: "${TOPIC_LABELS[worstTrend.topic as ReviewTopic] || worstTrend.topic}" creció ${worstTrend.prior > 0 ? `${(((worstTrend.recent - worstTrend.prior) / worstTrend.prior) * 100).toFixed(0)}%` : `de ${worstTrend.prior} a ${worstTrend.recent}`} en los últimos 2 meses`,
        description:
          `Los últimos 2 meses acumulan ${worstTrend.recent} menciones de esta queja vs ${worstTrend.prior} en los 2 meses previos. Esto suele indicar un cambio reciente (release, precio nuevo, cambio de contenido) que disparó el tema.`,
        recommendation: TOPIC_RECOMMENDATIONS[worstTrend.topic as ReviewTopic] ||
          'Investigar qué cambió en las últimas 8 semanas (releases, precios, cambios de copy). Cruzar con el timeline de cambios de producto.',
        metric: `${worstTrend.prior} → ${worstTrend.recent}`,
      });
    }
  }

  // ─── 3. Rating trend (written reviews) ──────────────────────────
  if (monthly.length >= 2) {
    const latest = monthly[monthly.length - 1];
    const prior = monthly[monthly.length - 2];
    const delta = latest.avg_rating - prior.avg_rating;
    if (Math.abs(delta) >= 0.3) {
      insights.push({
        id: 'rating-trend',
        severity: delta < -0.5 ? 'critical' : delta < 0 ? 'high' : 'info',
        title: `Rating promedio ${delta >= 0 ? 'subió' : 'cayó'} ${Math.abs(delta).toFixed(2)}⭐ vs mes anterior`,
        description:
          `${prior.month}: ${prior.avg_rating.toFixed(2)}⭐ (${prior.total} reviews) → ${latest.month}: ${latest.avg_rating.toFixed(2)}⭐ (${latest.total} reviews). ${delta < 0 ? 'La caída sugiere que algo empeoró en el último mes.' : 'El rebote es buena señal pero conviene validar que se sostenga.'}`,
        recommendation: delta < 0
          ? 'Hacer deep-dive en las reviews de este mes vs el anterior. Comparar distribución de topics y buscar el nuevo problema.'
          : 'Documentar qué cambió para reforzar y sostener. Si fue release, tag release notes en el tracker de reviews.',
      });
    }
  }

  // ─── 4. Country outliers (written reviews) ──────────────────────
  if (territories.length >= 3) {
    // Countries with 10+ reviews and >60% negative rate
    const bad = territories.filter((t) => t.total >= 10 && t.negative_rate >= 0.6);
    if (bad.length > 0) {
      const worst = bad[0]; // already sorted by negative_rate desc
      insights.push({
        id: 'country-outlier-neg',
        severity: worst.negative_rate >= 0.75 ? 'critical' : 'high',
        title: `${worst.territory} tiene ${(worst.negative_rate * 100).toFixed(0)}% de reviews negativas (${worst.negative}/${worst.total})`,
        description:
          `Las reviews escritas desde ${worst.territory} están dominadas por quejas. Probablemente hay un problema específico de ese mercado (precio, idioma, contenido cultural, método de pago).`,
        recommendation:
          `Filtrar las reviews por ${worst.territory} (usar el filtro de país que está arriba) y leer los primeros 20 para detectar el patrón local. Si es sistémico, coordinar con el growth manager del mercado.`,
        metric: `${worst.negative}/${worst.total} neg`,
      });
    }
  }

  // ─── 5. Global ratings outliers (ASC panel data, lifetime) ─────
  if (ratingsSummary.by_country.length >= 5) {
    // Countries with 50+ ratings and avg > 0.5⭐ below global weighted avg
    const underperformers = ratingsSummary.by_country
      .filter((c) => c.rating_count >= 50 && c.avg_rating <= ratingsSummary.weighted_avg - 0.5)
      .sort((a, b) => a.avg_rating - b.avg_rating);
    if (underperformers.length > 0) {
      const worst = underperformers[0];
      insights.push({
        id: 'global-rating-outlier',
        severity: 'medium',
        title: `${worst.country_code}: ${worst.avg_rating.toFixed(2)}⭐ global (${(ratingsSummary.weighted_avg - worst.avg_rating).toFixed(2)}⭐ por debajo del promedio)`,
        description:
          `Entre todos los ${worst.rating_count.toLocaleString()} ratings de ${worst.country_code} (con y sin texto), el promedio está significativamente por debajo del global de ${ratingsSummary.weighted_avg.toFixed(2)}⭐. Esto es más estadísticamente confiable que las reviews escritas porque el volumen es mucho mayor.`,
        recommendation:
          `${worst.country_code} necesita un análisis de mercado dedicado. Si no tienes reviews escritas desde ahí, conviene hacer user research cualitativo (5-10 calls) para entender qué hace bajar el rating.`,
        metric: `${worst.avg_rating.toFixed(2)} vs ${ratingsSummary.weighted_avg.toFixed(2)}`,
      });
    }
  }

  // ─── 6. Written-vs-global gap (the selection bias itself) ──────
  const writtenAvg = summary.avg_rating;
  const globalAvg = ratingsSummary.weighted_avg;
  if (globalAvg > 0 && summary.total > 20) {
    const gap = globalAvg - writtenAvg;
    if (gap >= 1.5) {
      insights.push({
        id: 'selection-bias',
        severity: 'info',
        title: `Gap entre reviews escritas (${writtenAvg.toFixed(2)}⭐) y ratings totales (${globalAvg.toFixed(2)}⭐): ${gap.toFixed(2)}⭐`,
        description:
          `Los usuarios silenciosos (tappers) están significativamente más contentos que los que escriben reviews. Esto es normal pero la magnitud (${gap.toFixed(2)}⭐) confirma un sesgo fuerte de selección. Cuida no proyectar este análisis a "todos tus usuarios" — refleja solo a la minoría que escribe.`,
        recommendation:
          'Al comunicar estos hallazgos internamente, siempre mencionar ambos números. Usar reviews escritas para diagnóstico cualitativo, ratings totales para métricas de producto.',
      });
    }
  }

  // ─── 7. Positive patterns (what is going well) ─────────────────
  const praise = topics.find((t) => t.topic === 'praise');
  if (monthly.length > 0) {
    const latest = monthly[monthly.length - 1];
    if (latest.positive / (latest.total || 1) >= 0.4 && latest.total >= 10) {
      insights.push({
        id: 'positive-signal',
        severity: 'info',
        title: `${latest.month}: ${((latest.positive / latest.total) * 100).toFixed(0)}% positivas (≥4⭐)`,
        description:
          'Más del 40% de las reviews escritas del último mes son positivas. Aunque la mayoría que escribe es crítica, hay una cohorte engaged que defiende el producto.',
        recommendation:
          'Identificar qué menciona la gente que nos da 5⭐. Esos son tus "jobs to be done" validados — amplificarlos en marketing, ASO, y onboarding.',
      });
    }
  }

  // Sort by severity
  insights.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return insights;
}
