# Fuentes de los KPIs operativos — auditoría del 12 de octubre de 2026

> **Documentación relacionada (2026-10-16):** `docs/DIFERENCIAS-LOOKER.md` (todas las diferencias Looker vs
> dashboard, generado desde `lib/kpi/looker-differences.ts`) · `docs/OPERATIVO.md` (arquitectura del dashboard
> Operativo, tablas, crons, calibración con tiendas) · `docs/AUDITORIA.md` (auditor automático y semanal).


Qué tabla alimenta cada indicador del brief diario, con qué fórmula, y cómo se
validó contra los dashboards de Looker Studio que usa el equipo.

## Una sola fuente

Los 5 dashboards de Looker Studio del equipo (tabla semanal, funnel diario,
unit economics, ventas/contribución) leen **una sola tabla**:

```
celtic-music-240111.dbt_prod_analytics.an_operational_dash
```

- Modelo dbt, 34 columnas, un renglón por `date × os × network × country × language × product × plan_type × payment_processor`.
- Se reconstruye **una vez al día ≈ 09:01 MX** (15:01 UTC). Por eso el brief sale a las 09:30 MX.
- Dimensiones `os`, `kinedu_language`, `country`, `kinedu_region`: 100 % pobladas en spend y signups (nulos despreciables).
- El bot (`lib/kpi/formulas.ts`) calcula todo con SQL sobre esta tabla. Mixpanel solo se usa en `/kpi` para preguntas de eventos; el brief no lo toca.

## Validación: Looker vs bot, al centavo

Reproducción de la tabla semanal de Looker (semanas del 21-sep, 28-sep, 5-oct y 12-oct parcial) y de las gráficas diarias (5–12 oct):

| Campo en Looker | Fórmula (BigQuery) | Validado |
|---|---|---|
| spend | `SUM(spend)` | ✅ al centavo, 4 semanas |
| signups | `SUM(signups)` | ✅ punto por punto, 8 días |
| fts_started | `SUM(fts_started)` | ✅ |
| fts_converted | `SUM(fts_converted)` | ✅ |
| New Subs | `SUM(new_subscriptions) + SUM(num_of_refunds_sale_date)` | ✅ |
| NS Sales | `SUM(new_subscriptions_sales) + SUM(refunds_total_amount_sale_date)` | ✅ |
| Conversion Rate | `New Subs / SUM(signups)` | ✅ |
| CAC | `SUM(spend) / New Subs` | ✅ |
| CPNU | `SUM(spend) / SUM(signups)` | ✅ |
| CPFT | `SUM(spend) / SUM(fts_started)` | ✅ |
| FreeTrialStartRate | `SUM(fts_started) / SUM(signups)` | ✅ (gráfica, 22–25 %) |
| ARPU | `(NS Sales + SUM(other_sales)) / (New Subs + SUM(other_purchases))` | ✅ |
| 1st Ticket / CAC | `ARPU / CAC` | ✅ |
| Total Sales (refactor) with yearly ios | `renewals_sales + renewals_sales_yearly_ios + new_subscriptions_sales + other_sales + refunds_sale_date − refunds_refund_date` | ✅ |
| Net Sales (refactor) with yearly ios | fórmula larga por plataforma (0.7 iOS · 0.85 Android/yearly iOS · 0.98 Web/Unknown · 0.97 Stripe other) − 6 % tax móvil − refunds × ratio neto | ✅ (vía Mobile CM) |
| MOBILE CONTRIBUTION MARGIN | `Net Sales − SUM(spend)` | ✅ al centavo |
| TOTAL CONTRIBUTION | `Mobile CM + (stripe ns + stripe ren + other_sales ns + other_sales ren) × 0.965` | ✅ (vía Cont. Margin %) |
| Cont. Margin % *(columna "Cont. M…")* | `TOTAL CONTRIBUTION / Total Sales` | ✅ 27.19 / 30.57 / 28.78 / 56.79 % |
| New Subs Margin *(columna "New Su…")* | `(SUM(new_subscriptions_sales) × 0.7 − SUM(spend)) / SUM(new_subscriptions_sales)` | ✅ 12.69 / 13.9 / 17.18 / 53.82 % |
| renewals, renewals_yearly_ios | `SUM(renewals)`, `SUM(renewals_yearly_ios)` | ✅ punto por punto |
| Purchases (non FT's) | Looker: `SUM(new_subscriptions) − SUM(fts_converted)` (neto) | ✅ reproducido, **ver hallazgo 3** |

## Hallazgos y decisión: el brief usa la definición real y muestra Looker como discrepancia

Criterio de Pepis (12-oct-2026): *"hay que hacer caso al real, pero siempre
identificar las discrepancias"*. Por eso el bot calcula las dos versiones:
las columnas `netSales` / `mobileCm` / `totalContribution` /
`purchasesNonFt` son la definición real, y `…Looker` reproduce al centavo lo
que ve el dashboard. Cuando difieren ≥ 1 %, el brief agrega la sección
"Discrepancias vs Looker".

### 1. TOTAL CONTRIBUTION (y Net Sales) netean por `os`, no por procesador de pago → Stripe se cuenta dos veces

**Qué pasa.** Net Sales (refactor) aplica la comisión según el `os` del
usuario: iOS → 0.7, Android → 0.85, y además resta 6 % de impuestos a todo lo
móvil. Pero una suscripción cobrada por **Stripe** desde un iPhone trae
`payment_processor = 'stripe'` y `os = 'iOS'`, así que entra en Net Sales al
0.64 (como si Apple cobrara comisión). Luego TOTAL CONTRIBUTION le **vuelve a
sumar** `stripe × 0.965`. Resultado: cada dólar de Stripe cuenta ~1.6 veces.

**Cuánto es** (semanas Mon–Sun, misma tabla, mismos constantes 0.7 / 0.85 / 0.965 / 6 %):

| Semana | Ventas subs Stripe | Net Sales Looker | Net Sales real | TC Looker | TC real | Diferencia |
|---|---|---|---|---|---|---|
| 14–20 sep | $6,174 | $60,986 | $62,460 | $22,818 | $18,335 | **+$4,483 (+24.5 %)** |
| 21–27 sep | $6,573 | $61,557 | $63,033 | $24,696 | $19,828 | **+$4,868 (+24.5 %)** |
| 28 sep–4 oct | $7,316 | $66,883 | $68,386 | $29,836 | $24,278 | **+$5,557 (+22.9 %)** |
| 5–11 oct | $6,938 | $64,564 | $65,927 | $27,306 | $21,975 | **+$5,332 (+24.3 %)** |

Desglose de la diferencia (semana 5–11 oct): $3,371 es Stripe neteado al 0.64
*y además* sumado al 0.965; el resto (~$1,960) son ventas de Apple/Google cuyo
`os` no coincide con su procesador (p. ej. filas `apple` con `os = 'Web'` al
0.98) y el término de refunds, que hereda la misma mezcla.

**Definición real que usa el bot.** Igual a la de Looker, pero cada venta se
netea con la tasa de **su procesador**: `apple × 0.7`, `google × 0.85`,
`renewals_sales_yearly_ios × 0.85`, `stripe × 0.965`, otros procesadores web
(`paypal`, `learnworlds`, `Web`, `Unknown`) × 0.98, `other_sales` 0.97/0.98 por
`network`, −6 % sobre Apple + Google + yearly iOS, y refunds de `_refund_date`
al ratio neto. TOTAL CONTRIBUTION real = Net Sales real − spend (ya no hace
falta sumar Stripe aparte). Mobile CM real = solo Apple + Google − spend.

**Double check (12-oct-2026, a petición de Mariana / tech).**
- Las filas `payment_processor = 'stripe'` traen `os` = iOS / Android / Web / Unknown
  **desde enero 2025; nunca `os` vacío** → no hay periodo en que la fórmula por os
  + término Stripe no duplicara. Las fórmulas actuales son las mismas documentadas
  el 22-abr-2026 y reproducen el dashboard al centavo: no cambiaron desde entonces.
- Impacto mensual TC Looker vs real: 2025-H2 +9–21 % (+$75K en 6 meses);
  2026 ene–oct +22–37 % por mes; **2026 YTD (ene–11 oct) $992K vs $778K =
  +$214K (+27.5 %)**. Crece porque las ventas Stripe se duplicaron en 2026.
- Renglón de ejemplo: 2026-10-07, stripe / iOS / US / yearly, ns_sales $359.94 →
  en Net Sales como iOS $230.36 (×0.64) + en TC otra vez $347.34 (×0.965) =
  $577.70 contados por $359.94 vendidos.
- Lectura probable del origen: Net Sales (refactor) tiene buckets `Web × 0.98` /
  `Unknown × 0.98`, es decir, ya pretende incluir las compras web/Stripe. El
  `+ stripe × 0.965` de TOTAL CONTRIBUTION se agregó asumiendo que "MOBILE
  CONTRIBUTION MARGIN" era solo móvil por el nombre. Problema de nombre, no de
  intención.
**Decisión final (12-oct-2026, Pepis): se respetan las DOS decisiones de negocio**
— (a) la atribución por `os` se queda (ventas / New Subs / CAC por plataforma) y
(b) **Stripe sigue dentro de Net Sales**. Lo único que se corrige es la
duplicidad: Stripe deja de netearse como Apple/Google y Total deja de sumarlo
aparte. **Cambio ("Variante 2"):**

```
Net Sales (refactor) with yearly ios
   1) en cada bucket por os (iOS, Android, Unknown, Web y el término del 6 %):
      SUM(IF(os = "iOS", ..., 0))  →  SUM(IF(os = "iOS" AND OS (payment processor) != "stripe", ..., 0))
      (!= significa "distinto de": el bucket ya no toma las filas de Stripe)
   2) NUEVO término dentro de Net Sales (en las dos mitades, incluida la del ratio de refunds):
      + ( SUM(IF(OS (payment processor) = "stripe", new_subscriptions_sales, 0))
        + SUM(IF(OS (payment processor) = "stripe", renewals_sales, 0)) ) × 0.965
      (es el mismo término que hoy vive en TOTAL CONTRIBUTION, movido aquí)
MOBILE CONTRIBUTION MARGIN: sin cambio de fórmula (= Net Sales − spend).
TOTAL CONTRIBUTION: se QUITA el "+ Stripe × 0.965" → queda = Mobile CM.
```

Con esto Stripe se cuenta una sola vez, a su comisión. Mobile CM y Total
Contribution quedan con el mismo valor (sugerir dejar uno o renombrar). El bot
usa exactamente esta variante (`netSalesByOs(true)` en `lib/kpi/formulas.ts`;
`mobileCm` = `totalContribution` = Net Sales − spend).

- **Prueba de aceptación, semana 5–11 oct (corrida dbt 17:02 MX del 12-oct):**
  Net Sales **$65,592** · Mobile CM **$21,637** · TOTAL CONTRIBUTION **$21,637**
  (hoy: $64,553 / $20,601 / $27,293). 2026 YTD: TC $992K → $748K (−$245K, −25 %).
- Alternativas descartadas: (1) Stripe solo en Total, fuera de Net Sales (TC
  $22,745) — cambia el significado de Net Sales; (2) solo borrar el término de
  Total (TC $20,598) — deja a Stripe neteado como Apple (~$2K/semana de menos).
- Opcional, misma pasada (~$250/semana): las renovaciones anuales de Stripe
  caen en `renewals_sales_yearly_ios` y se netean al 0.85 − 6 %.
- Verificado contra el API de Stripe (misma semana): 203 cobros de suscripción,
  $8,356 brutos, comisión $319 = **3.8 %**, neto $8,037; BigQuery marca $8,762
  como `stripe` (±5 % por fronteras de día y refunds). Son cobros reales de Stripe.
- La tabla se reconstruye al menos dos veces al día (≈ 09:01 y 17:02 MX), por
  eso las cifras "hoy" pueden moverse unos dólares entre corridas.

**Para el equipo de tech / data (qué pedir).** En el modelo dbt o en Looker:
(a) netear por `payment_processor` en vez de `os`; (b) quitar el término
`+ stripe × 0.965` de TOTAL CONTRIBUTION, o dejar Net Sales solo móvil y
sumar Stripe una sola vez; (c) opcional, siguiente nivel: sustituir las
constantes 0.7 / 0.85 por las comisiones reales medidas en el MRR dashboard
(Apple all-in ≈ 34 % en 2026, Google 17.4 %, Stripe 3.6 %), que varían por mes
y país — eso ya es una decisión de Finanzas.

### 2. `payment_processor = 'other_sales'`
Existe, pero sus ventas van en la columna `other_sales`, que TOTAL
CONTRIBUTION no suma. Los dos términos de esa fórmula valen siempre 0.
Inofensivo ($300 en 3 semanas). El bot real ya lo captura vía `other_sales`.

### 3. "Purchases (non FT's)" mezcla bases
Resta `fts_converted` del conteo **neto** de refunds, mientras la barra "New
Subs" de la misma gráfica es **bruta**. Resultado: ~10 % por debajo (126 vs 151
el 5-oct). El bot usa la base bruta (`New Subs − fts_converted`) y muestra la
cifra de Looker como discrepancia.

### 4. "New Subs Margin" usa ventas netas
`new_subscriptions_sales` (neto) aunque la columna "NS Sales" de al lado es
bruta. Se reproduce tal cual; no entra en el brief.

## Semántica que hay que tener presente

- `new_subscriptions` y `new_subscriptions_sales` están **netos de refunds**;
  `num_of_refunds_sale_date` / `refunds_total_amount_sale_date` los devuelven a bruto.
- `_sale_date` = refund atribuido al día de la venta original (sigue cayendo
  ~2 semanas después → New Subs / NS Sales de días recientes bajan al madurar).
  `_refund_date` = refund atribuido al día en que se emitió (impacto puntual).
- Nunca `SUM(a + b)`: si una columna es NULL en un renglón, el renglón se pierde.
  Siempre `SUM(a) + SUM(b)`.
- `NUMERIC` (refunds) llega como string desde el cliente de node → `Number()`.
- Stripe: `network` es canal de adquisición (Facebook, Organics…), no
  procesador; `payment_processor = 'stripe'` es el procesador.

## Qué queda fuera de esta tabla

MRR devengado, comisiones reales de tiendas y refunds por SKU viven en Supabase
(`mrr-dashboard`) y las APIs directas de Apple/Google/Stripe. No son parte del
brief operativo diario. Las cohortes de signup y de refunds van en el brief de cohortes, en su propio canal
(desde el 2026-10-21, abajo).

## Alerta semanal por OS (desde 2026-10-20, calendar basis)

Motivo: el 20-oct el brief salió "en rango" mientras el Tableau "Conversion (Weekly)
by Signup Cohort" mostraba a Android bajando. El brief compara un día contra 7 y el
total lo domina iOS (≈ 86 % de New Subs), así que una baja de Android no se ve.

- **Qué compara:** por OS (iOS, Android), la última semana completa (lun–dom) contra
  las 4 previas: C.R., CAC y New Subs. Base = promedio semanal para conteos y
  cociente de las sumas de las 4 semanas para ratios. 🔴/🟢 con ±10 % o más
  (redondeado, como se muestra) y solo si la base tiene ≥ 50 New Subs por semana.
- **Dónde sale:** los lunes en el mensaje principal (y en "Lo más importante" y "Qué
  revisaría hoy" si hay 🔴); el resto de la semana en el hilo.
- Código: `osWeeklyCheck` / `renderOsWeekly` en `lib/kpi/daily-brief.ts`.
- Del 20 al 21-oct esta alerta también traía la cohorte de signup a 8 días. Desde el
  21-oct esa cohorte se mudó al brief de cohortes (abajo): el brief diario es solo
  calendar basis.

## Dos canales: calendar y cohortes (desde 2026-10-21)

| | Brief diario (calendar) | Brief de cohortes |
|---|---|---|
| Qué es | Cada KPI cuenta el día en que pasó | Cada número pertenece a un grupo (semana o día de signup, semana de cobro) y se sigue en el tiempo |
| Canal | `SLACK_BRIEF_CHANNEL` | `SLACK_COHORT_CHANNEL` |
| Cron | `/api/cron/daily-brief`, 15:30 UTC | `/api/cron/cohort-brief`, 15:35 UTC |
| Código | `lib/kpi/daily-brief.ts`, `brief-charts.tsx` | `lib/kpi/cohort-brief.ts`, `cohort-charts.tsx` |
| Prueba local | `npx tsx scripts/test-daily-brief.ts` | `npx tsx scripts/test-cohort-brief.ts` |

El brief de cohortes nunca usa el webhook (que apunta al canal calendar): si falta
`SLACK_COHORT_CHANNEL`, el cron no publica y lo dice en su respuesta; si el bot falla,
manda el aviso de error al canal de cohortes y solo si eso falla, al webhook.

### Qué trae el brief de cohortes

- **Cohortes de signup:** `dbt_prod_analytics.an_conversion_analysis` (una fila por
  usuario y venta; `signup_date`, `premium_conversion_date`). Es la fuente del Tableau
  "Conversion (Weekly) by Signup Cohort": los signups por semana cuadran. Métricas:
  % de los que se registraron que compró el mismo día, entre el día 0 y el 7 ("8 días",
  incluye el cobro del trial: día 3 en Android, día 7 en iOS) y entre el día 0 y el 29
  ("30 días"). Consulta: `fetchSignupCohortsDaily` en `lib/kpi/brief-queries.ts`
  (cohortes diarias por OS; las semanas se suman en el código).
  - Semanal a 8 días: última semana ISO cuyo domingo + 7 ≤ ayer, vs las 4 previas.
  - Semanal a 30 días: última semana cuyo domingo + 29 ≤ ayer, vs las 4 previas.
  - Diaria a 8 días: el día de signup = ayer − 7, vs el mismo día de la semana en las 4
    semanas previas.
  - Base = cociente de las sumas de las 4 cohortes previas. 🔴/🟢 con ±10 % o más
    (redondeado) y volumen mínimo: 1,000 signups por semana, 200 por día (la cohorte y el
    promedio de las previas).
  - El Tableau acumula semanas a conversión, así que sus % de cohortes maduras salen algo
    más altos; a la misma edad la tendencia es la misma.
- **Cohortes de refunds:** `kinedu_refunds` en Supabase, RPC `refund_cohorts_weekly`
  (`getRefundCohortsWeekly` en `lib/refunds.ts`): de los cobros de cada semana, % que se
  devolvió (unidades y monto, base bruta; no es la tasa de refunds del calendar). Solo
  se compara la última semana "madura" (terminó hace ≥ 14 días) contra las 4 maduras
  previas, con ≥ 1,000 cobros. Las semanas recientes salen con ⏳.
- **Sin ingresos por cohorte:** `usd_amount` de `an_conversion_analysis` no cuadra con
  NS Sales del calendar (semanas 28-sep y 5-oct: primeras ventas $67.8K y $70.2K en la
  tabla de cohortes contra NS Sales $90.2K y $92.0K; 1,652 y 1,582 primeras compras
  contra 1,852 y 1,759 New Subs). No se usa hasta validarlo.
- **Cadencia (desde 2026-10-21):**
  - **Diario:** todo lo de arriba.
  - **Lunes:** la misma conversión a 8 y 30 días por **red de adquisición** (`network` de
    `an_conversion_analysis`: Organics, Facebook, Smartlinks…; una red con < 500 signups en la semana va a
    "Otras redes", que solo sale si juntas pasan de 500). Solo red, no campaña: en `an_cac_and_purchases` ≈ 90 %
    de las compras no tiene red (sep-2026: 496 compradores Facebook ahí contra 2,533 conversiones a 30 días de
    signups Facebook en `an_conversion_analysis`), así que no sirve para CAC por red. Por eso el Tableau
    "CAC & PURCHASES (All Networks)" muestra compras en cero al filtrar por red.
  - **Primer día hábil del mes** (`firstBusinessDay`, lun–vie, sin feriados): **cohortes mensuales de compra**
    (cohorte = mes del primer pago), leídas de `cohort_cells` del proyecto **kinedu-cohorts**
    (`lib/kpi/cohort-monthly.ts`), sin recalcular: LTV neto a M0/M3/M6/M12, sigue pagando a M6 (réplica de
    "Churn by Cohort"), volvió a pagar a M12, apagó la renovación en M0–M1 (≠ dejar de pagar) y ROAS a la fecha.
    Cada métrica de la cohorte más reciente que ya la tiene se compara con las 3 cohortes previas a la misma edad.
    Necesita `COHORTS_SUPABASE_URL` y `COHORTS_SUPABASE_SERVICE_ROLE_KEY` (las de kinedu-cohorts); sin ellas la
    sección dice "no disponible" y el resto sale igual.
  - Slack acepta una tabla por mensaje: las tablas por red y mensual van al hilo; su resumen y sus 🔴, al mensaje
    principal. Para forzarlas: `?weekly=1&monthly=1` en la ruta o `--weekly --monthly` en el script.
- **Inventario del Tableau (2026-10-21, sitio andressada, proyecto Kinedu PROD):** de 39 workbooks, los de cohortes
  vivos son "Cohort Subscriptions" (Retention, Churn y Revenue/LTR by Cohort), "Conversion Analysis", "Free Trials",
  "Track Subscriptions" (incluye "Subscriber Sales Accounting - FT Cohort") y "CAC & PURCHASES (All Networks)".
  kinedu-cohorts replica todos salvo "Retention by Cohort" (recompra a N meses de la primera compra, con filtro de
  red), "Subscriber Sales Accounting - FT Cohort" y "LTR Projected" (este último por defecto termina en 2022).
- **Formato:** mensaje principal con "Lo más importante" (cuatro líneas: semanal 8 días,
  diaria 8 días, semanal 30 días, refunds), una gráfica PNG de 12 semanas (iOS y Android a
  8 y 30 días, signups por semana, refunds por semana de cobro), la tabla de las últimas 8
  semanas de signup y "Qué revisaría hoy". En el hilo: cohortes diarias de los últimos 14
  días, refunds por semana de cobro y tienda, y notas. Narrativa por reglas (sin Claude).

## Formato del brief en Slack (desde 2026-10-20)

- **Tablas nativas de Slack** (bloque `table`, una por mensaje): ayer (adquisición y monetización, vs prom. 7d y vs
  mismo día), semana en curso / semana pasada, tendencia de 4 semanas, alerta por OS y desglose por plataforma,
  idioma y país. Si Slack rechaza el bloque, `lib/slack/post.ts` reintenta con la tabla en texto monoespaciado; el
  respaldo por webhook también la manda así.
- **Gráficas PNG dentro del mensaje principal**, debajo de "Lo más importante" (`lib/kpi/brief-charts.tsx`; se suben sin compartir y se insertan con bloques `image` + `slack_file`, reintentando unos segundos mientras Slack procesa el archivo): "spend vs signups, últimos 30 días" (barras = signups, línea = spend en doble eje, más CPNU; ayer vs promedio de los 7 días previos), "últimas 12 semanas" (New Subs, CAC, Conversion Rate,
  Total Contribution) y "por OS" (C.R., CAC y New Subs para iOS y Android; hasta el 21-oct traía la cohorte a 8 días). Mismos datos que el Operativo
  (réplica, vista Corregido); el "vs 4 sem." usa la misma base que la alerta por OS. Se dibujan en el servidor con
  `next/og` (sin servicios externos) y se suben con `files:write` (permiso agregado el 2026-10-20). Cada envío trae
  enlaces al Operativo con el mismo periodo y filtro. Si la gráfica falla, el brief sale igual con los enlaces.
