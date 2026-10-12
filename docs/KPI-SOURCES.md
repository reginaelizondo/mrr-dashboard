# Fuentes de los KPIs operativos — auditoría del 12 de octubre de 2026

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

MRR devengado, comisiones reales de tiendas, refunds por SKU, cohortes: viven en
Supabase (`mrr-dashboard`) y las APIs directas de Apple/Google/Stripe. No son
parte del brief operativo diario.
