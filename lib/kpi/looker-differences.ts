/**
 * Registro ÚNICO de las diferencias entre el Looker "Operational Dashboard" y el dashboard Operativo.
 *
 * De aquí salen: docs/DIFERENCIAS-LOOKER.md (npx tsx scripts/gen-docs.ts), la sección "Diferencias vs Looker"
 * de la pestaña Auditoría del dashboard y la referencia del agente kpi-auditor. Cualquier diferencia nueva
 * se agrega AQUÍ (con fecha, evidencia y quién decidió) y se regenera el documento.
 *
 * Vistas del dashboard:
 *   "Looker (hoy)" — copia exacta del Looker original, incluidos sus errores e inconsistencias.
 *   "Corregido"    — Looker + todas las correcciones acordadas; montos calibrados con lo que reportan las tiendas.
 */

export type DiffKind =
  | 'correccion'        // el Corregido difiere del Looker a propósito (error del Looker)
  | 'inconsistencia'    // el Looker no es consistente consigo mismo; la vista Looker lo copia, el Corregido lo unifica
  | 'alcance'           // algo que el dashboard muestra distinto por diseño (rangos, páginas no replicadas, cobertura)
  | 'dato';             // problema de la fuente de datos (afecta a los dos)

export type DiffStatus =
  | 'resuelto-en-looker'  // tech ya lo corrigió en el Looker; las dos vistas coinciden
  | 'pendiente-tech'      // acordado; falta que tech lo aplique en el Looker
  | 'solo-corregido'      // decidido para el Corregido; no se ha propuesto al Looker
  | 'pendiente-decision'  // falta decisión de negocio
  | 'documentado';        // diferencia por diseño, sin acción pendiente

export interface LookerDifference {
  id: string;
  title: string;
  kind: DiffKind;
  status: DiffStatus;
  kpis: string[];
  looker: string;          // qué hace el Looker
  corregido: string;       // qué hace el Corregido (o el dashboard)
  impact: string;          // magnitud medida, con periodo
  evidence: string;        // cómo se comprobó
  found: string;           // fecha (YYYY-MM-DD)
  decision?: string;       // quién y cuándo decidió
  code?: string;           // dónde vive en el código
}

export const LOOKER_DIFFERENCES: LookerDifference[] = [
  {
    id: 'stripe-doble-conteo',
    title: 'Stripe contado dos veces en Total Contribution',
    kind: 'correccion', status: 'resuelto-en-looker',
    kpis: ['Net Sales', 'MOBILE CONTRIBUTION MARGIN', 'TOTAL CONTRIBUTION', 'CM/Sales'],
    looker: 'Hasta el 15-oct-2026: los cobros de Stripe traen el OS del comprador, caían en los buckets iOS/Android de Net Sales (netos al 0.7/0.85 − 6 %) y TOTAL CONTRIBUTION los volvía a sumar al 0.965 (~1.5×).',
    corregido: 'Variante 2: Stripe fuera de los buckets de OS y dentro de Net Sales al 0.965; TOTAL CONTRIBUTION = Net Sales − spend. Tech la aplicó en el Looker original el 15-oct-2026: hoy las dos vistas coinciden en este punto.',
    impact: '2026 YTD (antes del fix): TC Looker $992K vs $748K. Semana 5–11 oct: Looker $27,142 → $21,411 tras el fix.',
    evidence: 'Fórmula del Looker + API de Stripe + ejemplo del 12-oct dentro del bucket iOS. Looker original verificado el 15-oct (Cont. Tot semana 41 = $21,411).',
    found: '2026-10-12', decision: 'Pepis + Mariana Kalifa (tech), 2026-10-12', code: 'lib/kpi/formulas.ts netSalesByOs()',
  },
  {
    id: 'stripe-reembolsos-dos-veces',
    title: 'Reembolsos de Stripe restados dos veces',
    kind: 'correccion', status: 'pendiente-tech',
    kpis: ['Net Sales', 'MOBILE CONTRIBUTION MARGIN', 'TOTAL CONTRIBUTION', 'CM/Sales'],
    looker: 'El término de Stripe usa new_subscriptions_sales + renewals_sales, que ya vienen NETOS de reembolsos, y además resta refunds_total_amount_refund_date (que incluye los de Stripe). Los buckets de OS evitan esto sumando de vuelta refunds_total_amount_sale_date; el término de Stripe no.',
    corregido: 'Suma los reembolsos de Stripe por fecha de venta al término de Stripe (solo en la primera mitad, no en el ratio): se restan una sola vez.',
    impact: '≈ $230–1,300/semana de TC. Semana 5–11 oct: Looker $21,411 vs $22,111. Auditoría 8–14 oct: −$301.',
    evidence: 'Fórmula; la auditoría diaria mide el monto cada día (línea Looker → "reembolsos de Stripe restados dos veces").',
    found: '2026-10-15', decision: 'Pepis dio VoBo del fix de Stripe y dejó este ajuste como seguimiento con tech (2026-10-15)', code: 'lib/kpi/formulas.ts STRIPE_RSD',
  },
  {
    id: 'stripe-renovaciones-anuales',
    title: 'Renovaciones anuales de iOS cobradas por Stripe netas con la comisión de Apple',
    kind: 'correccion', status: 'solo-corregido',
    kpis: ['Net Sales', 'MOBILE CONTRIBUTION MARGIN', 'TOTAL CONTRIBUTION', 'CM/Sales'],
    looker: 'renewals_sales_yearly_ios incluye renovaciones anuales de usuarios iOS cobradas por Stripe ($55,285 en 2026), PayPal ($5,309) y Google ($3,930); el Looker netea toda la columna al 0.85 − 6 % (Apple).',
    corregido: 'La parte de Stripe va al término de Stripe (0.965). PayPal y Google se quedan como en el Looker (montos chicos; Google 0.85 − 6 % = su propio bucket).',
    impact: '≈ +$9,700 de Net Sales y TC en 2026 YTD; ≈ +$180 la semana 5–11 oct.',
    evidence: 'BigQuery: renewals_sales_yearly_ios por payment_processor, 2026-01-01 → 2026-10-14.',
    found: '2026-10-15', decision: 'Pepis: "sí" (2026-10-15). Aún no se ha propuesto a tech.', code: 'lib/kpi/formulas.ts STRIPE_YR · migración 036',
  },
  {
    id: 'google-impuesto-fx',
    title: 'Google: monto con impuesto y tipo de cambio más fuerte que el de Google',
    kind: 'correccion', status: 'pendiente-tech',
    kpis: ['Total Sales', 'NS Sales', 'Net Sales', 'TOTAL CONTRIBUTION', 'ARPU'],
    looker: 'Registra el monto cobrado (con impuesto) y lo convierte a USD con un tipo de cambio ≈ 8–10 % más fuerte que el de Google (MX 15.5 vs 17.17; BR 4.74 vs 5.14). Desde 2026 Google retiene y entera el IVA.',
    corregido: 'Calibrado con los cobros de Google de la tabla transactions del MRR (une la cuenta vieja de SAPI en MXN y la nueva de INC en USD de la migración ene–feb 2026; bruto, comisión y neto por cobro) y reembolsos del earnings mensual o, en el mes en curso, del reporte diario (marcado como estimado). Total Sales se mantiene CON impuesto (misma base que el Looker usa para Apple); Net Sales = lo que deposita Google.',
    impact: 'Looker ≈ +8 % sobre lo cobrado por Google y ≈ +15 % sobre el precio sin impuesto (8–14 oct).',
    evidence: 'Auditoría diaria tiendas vs Looker (Google en banda 3–22 %); análisis por país y SKU con el FX de Google (2026-10-13).',
    found: '2026-10-13', decision: 'Base de Total Sales con impuesto: se mantiene la del Looker (2026-10-16). Corrección del Looker pendiente con tech/Finanzas.', code: 'lib/sync/store-daily.ts fetchGoogleCells · migración 037',
  },
  {
    id: 'calibracion-tiendas',
    title: 'Corregido calibrado con lo que reporta cada tienda (FX y comisiones reales)',
    kind: 'correccion', status: 'solo-corregido',
    kpis: ['Total Sales', 'NS Sales', 'Net Sales', 'MOBILE CONTRIBUTION MARGIN', 'TOTAL CONTRIBUTION', 'CM/Sales', 'ARPU', '1stTkt/CAC'],
    looker: 'Montos con el FX de la tabla de BigQuery y comisiones fijas por OS: iOS 0.7, Android 0.85, Web/Unknown 0.98, renovaciones anuales iOS 0.85, menos 6 % de impuesto en iOS/Android.',
    corregido: 'Por día × procesador × país, factor = lo que reporta la tienda / BigQuery (ventana de 7 días; si el país tiene < $50 se usa el del procesador). Apple: Customer Price y Developer Proceeds del reporte diario; Google: earnings/reporte de ventas; Stripe: API (monto y neto después de comisión). Mantiene la atribución por OS del usuario (decisión de negocio) y todos los desgloses (país, idioma, OS, red). Días sin reporte definitivo se marcan "estimado" en el dashboard.',
    impact: 'Se mide en la Guardia (calibración vs tiendas, 4 semanas, ±3 %).',
    evidence: 'Cobertura: Apple desde 2025-04-07 (reporte diario), Google desde 2022 (transactions del MRR; el bucket GCS solo tiene la cuenta nueva: enero 2026 salía con $3K en vez de $46K), Stripe completo (API). Antes de eso o en procesadores sin reporte (PayPal, other_sales, LearnWorlds ≈ 0.4 % de ventas): tasas fijas del Corregido.',
    found: '2026-10-15', decision: 'Pepis: calibración y días recientes como estimado, marcados explícitamente (2026-10-16); atribución por OS se mantiene.', code: 'migración 037 · lib/sync/store-daily.ts · lib/kpi/replica.ts computeKpis',
  },
  {
    id: 'compras-netas-vs-brutas',
    title: 'Compras contadas con New Subs netas en unas gráficas y brutas en otras',
    kind: 'inconsistencia', status: 'documentado',
    kpis: ["Purchases (non FT's)", 'CAC from Purchases', 'CAC calculated', 'Users per purchase'],
    looker: 'Las tablas (New Subs, CAC, C.R., Conv. from Purchases) usan New Subs BRUTAS (+ reembolsos por fecha de venta); las gráficas "Purchases (non FT\'s)", "CAC from Purchases" y "CAC calculated" usan la columna NETA.',
    corregido: 'Vista Looker: copia exacta (con nota en la gráfica). Corregido: brutas en todo.',
    impact: 'CAC calculated 1-jun: Looker $25.52 vs CAC de tabla $22.32 (≈ +14 %).',
    evidence: 'Etiquetas de datos de "Daily Purchases and Free Trial" vs réplica, 11 días exactos (2026-10-15).',
    found: '2026-10-15', code: 'lib/kpi/replica.ts purchasesNonFt / cacCalculated',
  },
  {
    id: 'new-sales-spend-mensual',
    title: '"New Sales / Spend" mensual y semanal son campos distintos',
    kind: 'inconsistencia', status: 'documentado',
    kpis: ['New Sales / Spend'],
    looker: 'En Weekly Sales & Margin = NS Sales / spend; en Monthly Sales & Margin = new_subscriptions_sales (neta) / spend.',
    corregido: 'Vista Looker: por mes/trimestre/año usa la neta, por día/semana NS Sales. Corregido: NS Sales en todo.',
    impact: 'Oct-2025: 1.78 (neta) vs 2.19 (NS Sales).',
    evidence: '13 de 13 meses exactos (2026-10-15).',
    found: '2026-10-15', code: 'components/dashboard/OperativoContent.tsx monthlyLooker',
  },
  {
    id: 'margen-new-subs',
    title: 'MARGEN "New subs $" = ventas netas de new subs, no NS Sales',
    kind: 'inconsistencia', status: 'documentado',
    kpis: ['New subs $ (MARGEN, Volume graphs)'],
    looker: 'La página MARGEN y Volume graphs grafican new_subscriptions_sales (neta de reembolsos) bajo el nombre "New subs $".',
    corregido: 'El dashboard muestra NS Sales (bruta) con su nombre; la neta queda implícita en New Subs Margin.',
    impact: '2024-01 → 2026-10: $8.82 M (neta) vs $10.69 M (NS Sales).',
    evidence: 'Comparación por columna (2026-10-15).',
    found: '2026-10-15',
  },
  {
    id: 'new-subs-margin',
    title: 'New Subs Margin usa 0.7 fijo y ventas netas (igual en las dos vistas)',
    kind: 'alcance', status: 'documentado',
    kpis: ['New Subs Margin (NS mgn)'],
    looker: '(new_subscriptions_sales × 0.7 − spend) / new_subscriptions_sales, con la columna neta.',
    corregido: 'Igual que el Looker (no se corrigió: es un indicador de margen aproximado, no de dinero).',
    impact: '—', evidence: 'Fórmula validada al centavo.', found: '2026-10-12',
  },
  {
    id: 'rangos-propios-graficas',
    title: 'Gráficas del Looker con rango propio o sin la primera semana parcial',
    kind: 'alcance', status: 'documentado',
    kpis: ['Cont / Spend by Month', 'Share of Spend'],
    looker: '"Cont / Spend by Month" tiene rango fijo desde el 7-jul-2025 (no usa el filtro de la página). "Share of Spend" omite la primera semana parcial del rango.',
    corregido: 'El dashboard aplica siempre el rango del filtro, completo.',
    impact: 'Julio 2025 en "Cont / Spend by Month": $129,105 (desde el 7) vs $159,674 (mes completo).',
    evidence: 'Comparación por columna (2026-10-15).', found: '2026-10-15',
  },
  {
    id: 'cache-looker',
    title: 'El Looker cachea cada gráfica por separado',
    kind: 'alcance', status: 'documentado',
    kpis: ['Todas'],
    looker: 'Cada gráfica se actualiza a su hora ("algunos elementos de la página no se han actualizado"): el mismo periodo puede mostrar valores distintos en dos gráficas.',
    corregido: 'Un solo corte para toda la página, con la hora de la réplica visible.',
    impact: 'Semana del 12-oct: $13,799.39 (Weekly Sales & Margin) vs $13,862.55 (Cont / Spend by week) el 15-oct.',
    evidence: 'Comparación por columna (2026-10-15).', found: '2026-10-15',
  },
  {
    id: 'frescura',
    title: 'Hora de actualización',
    kind: 'alcance', status: 'documentado',
    kpis: ['Todas'],
    looker: 'Lee BigQuery directo (dbt reconstruye ≈ 09:01, 11:02, 13:01 MX) con caché por gráfica.',
    corregido: 'Réplica re-sincronizada cada 30 min cuando BigQuery cambia (cambio atómico: nunca se ve un mes a medias). Tiendas: Stripe cada hora; Google diario/mensual; Apple con 1–2 días.',
    impact: 'Desfase máximo ≈ 30 min vs BigQuery.', evidence: 'Guardia: chequeo de frescura cada hora.', found: '2026-10-15',
  },
  {
    id: 'historia',
    title: 'Historia desde 2024',
    kind: 'alcance', status: 'documentado',
    kpis: ['Todas'],
    looker: 'Algunas páginas arrancan en 2020–2023.',
    corregido: 'La réplica cubre desde 2024-01-01 (se puede extender si se necesita).',
    impact: '—', evidence: '—', found: '2026-10-14',
  },
  {
    id: 'bubble-graphs',
    title: 'Bubble Graphs no se replica',
    kind: 'alcance', status: 'documentado',
    kpis: ['CAC vs ARPU por región/idioma'],
    looker: 'Burbujas CAC vs ARPU por región e idioma, vs semana anterior.',
    corregido: 'Pestaña Desglose: tabla por región, idioma, OS y país con CAC, ARPU y deltas.',
    impact: '—', evidence: '—', found: '2026-10-14',
  },
  {
    id: 'downloads-cero',
    title: 'downloads llega en 0 muchos días',
    kind: 'dato', status: 'pendiente-tech',
    kpis: ['downloads', 'signups/downloads', 'CPI'],
    looker: 'Mismo dato (sale de la misma tabla).',
    corregido: 'Mismo dato; la Guardia cuenta los días en cero y el dashboard lo avisa en la gráfica.',
    impact: '≈ 14 de 30 días en cero (sep–oct 2026).', evidence: 'BigQuery an_operational_dash.', found: '2026-10-14',
  },
];
