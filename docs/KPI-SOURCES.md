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

## Hallazgos que son decisión del equipo (no se cambiaron)

1. **TOTAL CONTRIBUTION cuenta Stripe dos veces.** Las suscripciones cobradas
   por Stripe traen el `os` del usuario (iOS/Android), así que Net Sales ya las
   incluye — al 0.7/0.85 de Apple/Google, que además no es la comisión de
   Stripe (~3.6 %) — y luego TOTAL CONTRIBUTION les suma otra vez
   `stripe × 0.965`. Magnitud: ~$7 K/semana de ventas Stripe → TC inflado
   ~$4.5 K/semana (~17 %). El bot reporta el número **tal como lo ve Looker**
   para que cuadre con el dashboard; corregirlo es cambiar la definición del KPI.
2. **`payment_processor = 'other_sales'`** existe, pero sus ventas van en la
   columna `other_sales`, que TOTAL CONTRIBUTION no suma. Los dos términos de
   esa fórmula valen siempre 0. Inofensivo ($300 en 3 semanas).
3. **"Purchases (non FT's)" mezcla bases.** Resta `fts_converted` del conteo
   **neto** de refunds, mientras la barra "New Subs" de la misma gráfica es
   **bruta**. Resultado: ~10 % por debajo (126 vs 151 el 5-oct). El bot usa la
   base bruta (`New Subs − fts_converted`) para ser consistente con New Subs.
4. **"New Subs Margin" usa ventas netas** (`new_subscriptions_sales`) aunque la
   columna "NS Sales" de al lado es bruta. Se reproduce tal cual.

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
