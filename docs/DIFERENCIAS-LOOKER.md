# Diferencias entre el Looker y el dashboard Operativo

> Generado desde `lib/kpi/looker-differences.ts` con `npx tsx scripts/gen-docs.ts`. No editar a mano.
> Última generación: 2026-10-16.

El dashboard tiene dos vistas:

- **Looker (hoy)** — copia exacta del Looker "Operational Dashboard" original, incluidos sus errores e inconsistencias. Validada gráfica por gráfica: 232/234 columnas iguales en 30 páginas (2026-10-16; las 2 restantes son caché del Looker en la semana y el mes en curso). Se re-valida cada lunes (tarea "Auditoría semanal KPIs").
- **Corregido** — el Looker más todas las correcciones acordadas, con los montos calibrados con lo que reporta cada tienda.

## Resumen

| # | Diferencia | Tipo | Estado | KPIs |
|---|---|---|---|---|
| 1 | [Stripe contado dos veces en Total Contribution](#stripe-doble-conteo) | Corrección (error del Looker) | ✅ resuelto en el Looker | Net Sales, MOBILE CONTRIBUTION MARGIN, TOTAL CONTRIBUTION, CM/Sales |
| 2 | [Reembolsos de Stripe restados dos veces](#stripe-reembolsos-dos-veces) | Corrección (error del Looker) | ⏳ pendiente de tech | Net Sales, MOBILE CONTRIBUTION MARGIN, TOTAL CONTRIBUTION, CM/Sales |
| 3 | [Renovaciones anuales de iOS cobradas por Stripe netas con la comisión de Apple](#stripe-renovaciones-anuales) | Corrección (error del Looker) | 🟦 solo en el Corregido | Net Sales, MOBILE CONTRIBUTION MARGIN, TOTAL CONTRIBUTION, CM/Sales |
| 4 | [Google: monto con impuesto y tipo de cambio más fuerte que el de Google](#google-impuesto-fx) | Corrección (error del Looker) | ⏳ pendiente de tech | Total Sales, NS Sales, Net Sales, TOTAL CONTRIBUTION, ARPU |
| 5 | [Corregido calibrado con lo que reporta cada tienda (FX y comisiones reales)](#calibracion-tiendas) | Corrección (error del Looker) | 🟦 solo en el Corregido | Total Sales, NS Sales, Net Sales, MOBILE CONTRIBUTION MARGIN, TOTAL CONTRIBUTION, CM/Sales, ARPU, 1stTkt/CAC |
| 6 | [Compras contadas con New Subs netas en unas gráficas y brutas en otras](#compras-netas-vs-brutas) | Inconsistencia interna del Looker | 📄 documentado | Purchases (non FT's), CAC from Purchases, CAC calculated, Users per purchase |
| 7 | ["New Sales / Spend" mensual y semanal son campos distintos](#new-sales-spend-mensual) | Inconsistencia interna del Looker | 📄 documentado | New Sales / Spend |
| 8 | [MARGEN "New subs $" = ventas netas de new subs, no NS Sales](#margen-new-subs) | Inconsistencia interna del Looker | 📄 documentado | New subs $ (MARGEN, Volume graphs) |
| 9 | [New Subs Margin usa 0.7 fijo y ventas netas (igual en las dos vistas)](#new-subs-margin) | Diferencia por diseño | 📄 documentado | New Subs Margin (NS mgn) |
| 10 | [Gráficas del Looker con rango propio o sin la primera semana parcial](#rangos-propios-graficas) | Diferencia por diseño | 📄 documentado | Cont / Spend by Month, Share of Spend |
| 11 | [El Looker cachea cada gráfica por separado](#cache-looker) | Diferencia por diseño | 📄 documentado | Todas |
| 12 | [Hora de actualización](#frescura) | Diferencia por diseño | 📄 documentado | Todas |
| 13 | [Historia desde 2024](#historia) | Diferencia por diseño | 📄 documentado | Todas |
| 14 | [Bubble Graphs no se replica](#bubble-graphs) | Diferencia por diseño | 📄 documentado | CAC vs ARPU por región/idioma |
| 15 | [downloads llega en 0 muchos días](#downloads-cero) | Problema de la fuente de datos | ⏳ pendiente de tech | downloads, signups/downloads, CPI |

## 1. Stripe contado dos veces en Total Contribution
<a id="stripe-doble-conteo"></a>

- **Tipo:** Corrección (error del Looker) · **Estado:** ✅ resuelto en el Looker · **Encontrado:** 2026-10-12
- **KPIs afectados:** Net Sales, MOBILE CONTRIBUTION MARGIN, TOTAL CONTRIBUTION, CM/Sales

**Qué hace el Looker.** Hasta el 15-oct-2026: los cobros de Stripe traen el OS del comprador, caían en los buckets iOS/Android de Net Sales (netos al 0.7/0.85 − 6 %) y TOTAL CONTRIBUTION los volvía a sumar al 0.965 (~1.5×).

**Qué hace el dashboard (Corregido).** Variante 2: Stripe fuera de los buckets de OS y dentro de Net Sales al 0.965; TOTAL CONTRIBUTION = Net Sales − spend. Tech la aplicó en el Looker original el 15-oct-2026: hoy las dos vistas coinciden en este punto.

**Impacto.** 2026 YTD (antes del fix): TC Looker $992K vs $748K. Semana 5–11 oct: Looker $27,142 → $21,411 tras el fix.

**Evidencia.** Fórmula del Looker + API de Stripe + ejemplo del 12-oct dentro del bucket iOS. Looker original verificado el 15-oct (Cont. Tot semana 41 = $21,411).

**Decisión.** Pepis + Mariana Kalifa (tech), 2026-10-12

**Código.** `lib/kpi/formulas.ts netSalesByOs()`

## 2. Reembolsos de Stripe restados dos veces
<a id="stripe-reembolsos-dos-veces"></a>

- **Tipo:** Corrección (error del Looker) · **Estado:** ⏳ pendiente de tech · **Encontrado:** 2026-10-15
- **KPIs afectados:** Net Sales, MOBILE CONTRIBUTION MARGIN, TOTAL CONTRIBUTION, CM/Sales

**Qué hace el Looker.** El término de Stripe usa new_subscriptions_sales + renewals_sales, que ya vienen NETOS de reembolsos, y además resta refunds_total_amount_refund_date (que incluye los de Stripe). Los buckets de OS evitan esto sumando de vuelta refunds_total_amount_sale_date; el término de Stripe no.

**Qué hace el dashboard (Corregido).** Suma los reembolsos de Stripe por fecha de venta al término de Stripe (solo en la primera mitad, no en el ratio): se restan una sola vez.

**Impacto.** ≈ $230–1,300/semana de TC. Semana 5–11 oct: Looker $21,411 vs $22,111. Auditoría 8–14 oct: −$301.

**Evidencia.** Fórmula; la auditoría diaria mide el monto cada día (línea Looker → "reembolsos de Stripe restados dos veces").

**Decisión.** Pepis dio VoBo del fix de Stripe y dejó este ajuste como seguimiento con tech (2026-10-15)

**Código.** `lib/kpi/formulas.ts STRIPE_RSD`

## 3. Renovaciones anuales de iOS cobradas por Stripe netas con la comisión de Apple
<a id="stripe-renovaciones-anuales"></a>

- **Tipo:** Corrección (error del Looker) · **Estado:** 🟦 solo en el Corregido · **Encontrado:** 2026-10-15
- **KPIs afectados:** Net Sales, MOBILE CONTRIBUTION MARGIN, TOTAL CONTRIBUTION, CM/Sales

**Qué hace el Looker.** renewals_sales_yearly_ios incluye renovaciones anuales de usuarios iOS cobradas por Stripe ($55,285 en 2026), PayPal ($5,309) y Google ($3,930); el Looker netea toda la columna al 0.85 − 6 % (Apple).

**Qué hace el dashboard (Corregido).** La parte de Stripe va al término de Stripe (0.965). PayPal y Google se quedan como en el Looker (montos chicos; Google 0.85 − 6 % = su propio bucket).

**Impacto.** ≈ +$9,700 de Net Sales y TC en 2026 YTD; ≈ +$180 la semana 5–11 oct.

**Evidencia.** BigQuery: renewals_sales_yearly_ios por payment_processor, 2026-01-01 → 2026-10-14.

**Decisión.** Pepis: "sí" (2026-10-15). Aún no se ha propuesto a tech.

**Código.** `lib/kpi/formulas.ts STRIPE_YR · migración 036`

## 4. Google: monto con impuesto y tipo de cambio más fuerte que el de Google
<a id="google-impuesto-fx"></a>

- **Tipo:** Corrección (error del Looker) · **Estado:** ⏳ pendiente de tech · **Encontrado:** 2026-10-13
- **KPIs afectados:** Total Sales, NS Sales, Net Sales, TOTAL CONTRIBUTION, ARPU

**Qué hace el Looker.** Registra el monto cobrado (con impuesto) y lo convierte a USD con un tipo de cambio ≈ 8–10 % más fuerte que el de Google (MX 15.5 vs 17.17; BR 4.74 vs 5.14). Desde 2026 Google retiene y entera el IVA.

**Qué hace el dashboard (Corregido).** Calibrado con los cobros de Google de la tabla transactions del MRR (une la cuenta vieja de SAPI en MXN y la nueva de INC en USD de la migración ene–feb 2026; bruto, comisión y neto por cobro) y reembolsos del earnings mensual o, en el mes en curso, del reporte diario (marcado como estimado). Total Sales se mantiene CON impuesto (misma base que el Looker usa para Apple); Net Sales = lo que deposita Google.

**Impacto.** Looker ≈ +8 % sobre lo cobrado por Google y ≈ +15 % sobre el precio sin impuesto (8–14 oct).

**Evidencia.** Auditoría diaria tiendas vs Looker (Google en banda 3–22 %); análisis por país y SKU con el FX de Google (2026-10-13).

**Decisión.** Base de Total Sales con impuesto: se mantiene la del Looker (2026-10-16). Corrección del Looker pendiente con tech/Finanzas.

**Código.** `lib/sync/store-daily.ts fetchGoogleCells · migración 037`

## 5. Corregido calibrado con lo que reporta cada tienda (FX y comisiones reales)
<a id="calibracion-tiendas"></a>

- **Tipo:** Corrección (error del Looker) · **Estado:** 🟦 solo en el Corregido · **Encontrado:** 2026-10-15
- **KPIs afectados:** Total Sales, NS Sales, Net Sales, MOBILE CONTRIBUTION MARGIN, TOTAL CONTRIBUTION, CM/Sales, ARPU, 1stTkt/CAC

**Qué hace el Looker.** Montos con el FX de la tabla de BigQuery y comisiones fijas por OS: iOS 0.7, Android 0.85, Web/Unknown 0.98, renovaciones anuales iOS 0.85, menos 6 % de impuesto en iOS/Android.

**Qué hace el dashboard (Corregido).** Por día × procesador × país, factor = lo que reporta la tienda / BigQuery (ventana de 7 días; si el país tiene < $50 se usa el del procesador). Apple: Customer Price y Developer Proceeds del reporte diario; Google: earnings/reporte de ventas; Stripe: API (monto y neto después de comisión). Mantiene la atribución por OS del usuario (decisión de negocio) y todos los desgloses (país, idioma, OS, red). Días sin reporte definitivo se marcan "estimado" en el dashboard.

**Impacto.** Se mide en la Guardia (calibración vs tiendas, 4 semanas, ±3 %).

**Evidencia.** Cobertura: Apple desde 2025-04-07 (reporte diario), Google desde 2022 (transactions del MRR; el bucket GCS solo tiene la cuenta nueva: enero 2026 salía con $3K en vez de $46K), Stripe completo (API). Antes de eso o en procesadores sin reporte (PayPal, other_sales, LearnWorlds ≈ 0.4 % de ventas): tasas fijas del Corregido.

**Decisión.** Pepis: calibración y días recientes como estimado, marcados explícitamente (2026-10-16); atribución por OS se mantiene.

**Código.** `migración 037 · lib/sync/store-daily.ts · lib/kpi/replica.ts computeKpis`

## 6. Compras contadas con New Subs netas en unas gráficas y brutas en otras
<a id="compras-netas-vs-brutas"></a>

- **Tipo:** Inconsistencia interna del Looker · **Estado:** 📄 documentado · **Encontrado:** 2026-10-15
- **KPIs afectados:** Purchases (non FT's), CAC from Purchases, CAC calculated, Users per purchase

**Qué hace el Looker.** Las tablas (New Subs, CAC, C.R., Conv. from Purchases) usan New Subs BRUTAS (+ reembolsos por fecha de venta); las gráficas "Purchases (non FT's)", "CAC from Purchases" y "CAC calculated" usan la columna NETA.

**Qué hace el dashboard (Corregido).** Vista Looker: copia exacta (con nota en la gráfica). Corregido: brutas en todo.

**Impacto.** CAC calculated 1-jun: Looker $25.52 vs CAC de tabla $22.32 (≈ +14 %).

**Evidencia.** Etiquetas de datos de "Daily Purchases and Free Trial" vs réplica, 11 días exactos (2026-10-15).

**Código.** `lib/kpi/replica.ts purchasesNonFt / cacCalculated`

## 7. "New Sales / Spend" mensual y semanal son campos distintos
<a id="new-sales-spend-mensual"></a>

- **Tipo:** Inconsistencia interna del Looker · **Estado:** 📄 documentado · **Encontrado:** 2026-10-15
- **KPIs afectados:** New Sales / Spend

**Qué hace el Looker.** En Weekly Sales & Margin = NS Sales / spend; en Monthly Sales & Margin = new_subscriptions_sales (neta) / spend.

**Qué hace el dashboard (Corregido).** Vista Looker: por mes/trimestre/año usa la neta, por día/semana NS Sales. Corregido: NS Sales en todo.

**Impacto.** Oct-2025: 1.78 (neta) vs 2.19 (NS Sales).

**Evidencia.** 13 de 13 meses exactos (2026-10-15).

**Código.** `components/dashboard/OperativoContent.tsx monthlyLooker`

## 8. MARGEN "New subs $" = ventas netas de new subs, no NS Sales
<a id="margen-new-subs"></a>

- **Tipo:** Inconsistencia interna del Looker · **Estado:** 📄 documentado · **Encontrado:** 2026-10-15
- **KPIs afectados:** New subs $ (MARGEN, Volume graphs)

**Qué hace el Looker.** La página MARGEN y Volume graphs grafican new_subscriptions_sales (neta de reembolsos) bajo el nombre "New subs $".

**Qué hace el dashboard (Corregido).** El dashboard muestra NS Sales (bruta) con su nombre; la neta queda implícita en New Subs Margin.

**Impacto.** 2024-01 → 2026-10: $8.82 M (neta) vs $10.69 M (NS Sales).

**Evidencia.** Comparación por columna (2026-10-15).

## 9. New Subs Margin usa 0.7 fijo y ventas netas (igual en las dos vistas)
<a id="new-subs-margin"></a>

- **Tipo:** Diferencia por diseño · **Estado:** 📄 documentado · **Encontrado:** 2026-10-12
- **KPIs afectados:** New Subs Margin (NS mgn)

**Qué hace el Looker.** (new_subscriptions_sales × 0.7 − spend) / new_subscriptions_sales, con la columna neta.

**Qué hace el dashboard (Corregido).** Igual que el Looker (no se corrigió: es un indicador de margen aproximado, no de dinero).

**Impacto.** —

**Evidencia.** Fórmula validada al centavo.

## 10. Gráficas del Looker con rango propio o sin la primera semana parcial
<a id="rangos-propios-graficas"></a>

- **Tipo:** Diferencia por diseño · **Estado:** 📄 documentado · **Encontrado:** 2026-10-15
- **KPIs afectados:** Cont / Spend by Month, Share of Spend

**Qué hace el Looker.** "Cont / Spend by Month" tiene rango fijo desde el 7-jul-2025 (no usa el filtro de la página). "Share of Spend" omite la primera semana parcial del rango.

**Qué hace el dashboard (Corregido).** El dashboard aplica siempre el rango del filtro, completo.

**Impacto.** Julio 2025 en "Cont / Spend by Month": $129,105 (desde el 7) vs $159,674 (mes completo).

**Evidencia.** Comparación por columna (2026-10-15).

## 11. El Looker cachea cada gráfica por separado
<a id="cache-looker"></a>

- **Tipo:** Diferencia por diseño · **Estado:** 📄 documentado · **Encontrado:** 2026-10-15
- **KPIs afectados:** Todas

**Qué hace el Looker.** Cada gráfica se actualiza a su hora ("algunos elementos de la página no se han actualizado"): el mismo periodo puede mostrar valores distintos en dos gráficas.

**Qué hace el dashboard (Corregido).** Un solo corte para toda la página, con la hora de la réplica visible.

**Impacto.** Semana del 12-oct: $13,799.39 (Weekly Sales & Margin) vs $13,862.55 (Cont / Spend by week) el 15-oct.

**Evidencia.** Comparación por columna (2026-10-15).

## 12. Hora de actualización
<a id="frescura"></a>

- **Tipo:** Diferencia por diseño · **Estado:** 📄 documentado · **Encontrado:** 2026-10-15
- **KPIs afectados:** Todas

**Qué hace el Looker.** Lee BigQuery directo (dbt reconstruye ≈ 09:01, 11:02, 13:01 MX) con caché por gráfica.

**Qué hace el dashboard (Corregido).** Réplica re-sincronizada cada 30 min cuando BigQuery cambia (cambio atómico: nunca se ve un mes a medias). Tiendas: Stripe cada hora; Google diario/mensual; Apple con 1–2 días.

**Impacto.** Desfase máximo ≈ 30 min vs BigQuery.

**Evidencia.** Guardia: chequeo de frescura cada hora.

## 13. Historia desde 2024
<a id="historia"></a>

- **Tipo:** Diferencia por diseño · **Estado:** 📄 documentado · **Encontrado:** 2026-10-14
- **KPIs afectados:** Todas

**Qué hace el Looker.** Algunas páginas arrancan en 2020–2023.

**Qué hace el dashboard (Corregido).** La réplica cubre desde 2024-01-01 (se puede extender si se necesita).

**Impacto.** —

**Evidencia.** —

## 14. Bubble Graphs no se replica
<a id="bubble-graphs"></a>

- **Tipo:** Diferencia por diseño · **Estado:** 📄 documentado · **Encontrado:** 2026-10-14
- **KPIs afectados:** CAC vs ARPU por región/idioma

**Qué hace el Looker.** Burbujas CAC vs ARPU por región e idioma, vs semana anterior.

**Qué hace el dashboard (Corregido).** Pestaña Desglose: tabla por región, idioma, OS y país con CAC, ARPU y deltas.

**Impacto.** —

**Evidencia.** —

## 15. downloads llega en 0 muchos días
<a id="downloads-cero"></a>

- **Tipo:** Problema de la fuente de datos · **Estado:** ⏳ pendiente de tech · **Encontrado:** 2026-10-14
- **KPIs afectados:** downloads, signups/downloads, CPI

**Qué hace el Looker.** Mismo dato (sale de la misma tabla).

**Qué hace el dashboard (Corregido).** Mismo dato; la Guardia cuenta los días en cero y el dashboard lo avisa en la gráfica.

**Impacto.** ≈ 14 de 30 días en cero (sep–oct 2026).

**Evidencia.** BigQuery an_operational_dash.
