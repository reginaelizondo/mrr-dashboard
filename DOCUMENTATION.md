# Kinedu MRR Dashboard - Documentation

## Table of Contents

1. [Overview](#overview)
2. [Tech Stack](#tech-stack)
3. [Data Sources](#data-sources)
4. [Database Schema](#database-schema)
5. [Data Sync Pipeline](#data-sync-pipeline)
6. [MRR Calculation (Spreading Methodology)](#mrr-calculation-spreading-methodology)
7. [Snapshot Computation](#snapshot-computation)
8. [Dashboard Metrics & Formulas](#dashboard-metrics--formulas)
9. [Filters & Date Presets](#filters--date-presets)
10. [Pages & Views](#pages--views)
11. [How to Update Data](#how-to-update-data)
12. [Environment Variables](#environment-variables)
13. [Troubleshooting](#troubleshooting)

---

## Overview

Dashboard de MRR (Monthly Recurring Revenue) para Kinedu que consolida datos de ingresos por suscripcion de tres fuentes: **Apple App Store**, **Google Play** y **Stripe** (web). Calcula MRR usando metodologia de spreading (distribucion proporcional), genera snapshots mensuales y presenta metricas de revenue, churn, breakdowns y crecimiento.

---

## Tech Stack

| Componente | Tecnologia |
|---|---|
| Framework | Next.js 16.1.6 (App Router, Turbopack) |
| Base de datos | Supabase (PostgreSQL) |
| UI | shadcn/ui + Tailwind CSS |
| Charts | Recharts |
| Deploy | Vercel (auto-deploy desde GitHub) |
| Cron | Vercel Cron Jobs |
| Auth APIs | Apple App Store Connect (JWT + Finance Reports), Google Cloud Storage (GCS), Stripe API |

---

## Data Sources

### Apple App Store
- **API**: App Store Connect Finance Reports API v1
- **Endpoint**: `GET /v1/financeReports`
- **Region**: ZZ (All Territories) - con fallback a WW
- **Formato**: TSV comprimido (gzip)
- **Granularidad**: Mensual (YYYY-MM)
- **Moneda**: Reportado en moneda local de cada pais, convertido a USD usando tabla de exchange rates con overrides mensuales para monedas volatiles (MXN, BRL, COP)
- **Auth**: JWT firmado con ES256 (private key en base64)

### Google Play
- **API**: Google Cloud Storage (bucket de earnings reports)
- **Formato**: CSV (`earnings/earnings_YYYYMM_*.csv`)
- **Granularidad**: Mensual (YYYYMM)
- **Moneda**: Reportado en merchant currency, convertido a USD si es necesario (tabla de rates MXN/USD con overrides mensuales)
- **Auth**: Service account key en base64

### Stripe
- **API**: Stripe Balance Transactions + Charges + Invoices
- **Granularidad**: Diaria (por dia)
- **Moneda**: USD nativo (Stripe reporta en centavos)
- **Auth**: Secret key

---

## Database Schema

### Tabla: `transactions`
Almacena todas las transacciones individuales de las tres fuentes.

| Campo | Tipo | Descripcion |
|---|---|---|
| `id` | serial | PK auto-increment |
| `source` | text | `apple`, `google`, `stripe` |
| `transaction_date` | date | Fecha de la transaccion |
| `order_id` | text | ID de orden del source |
| `external_id` | text | ID unico para dedup (UNIQUE con source) |
| `sku` | text | SKU/product ID del plan |
| `plan_type` | text | `monthly`, `yearly`, `semesterly`, `quarterly`, `weekly`, `lifetime`, `other` |
| `plan_name` | text | Nombre legible del plan |
| `transaction_type` | text | `charge`, `refund`, `commission`, `tax`, `dispute` |
| `is_new_subscription` | boolean | Es suscripcion nueva |
| `is_renewal` | boolean | Es renovacion |
| `is_trial_conversion` | boolean | Es conversion de trial |
| `amount_gross` | numeric | Monto bruto en USD |
| `amount_net` | numeric | Monto neto en USD (despues de comisiones) |
| `commission_amount` | numeric | Comision de la store en USD |
| `tax_amount` | numeric | Impuestos |
| `original_amount` | numeric | Monto original en moneda local |
| `original_currency` | text | Moneda original |
| `country_code` | text | Codigo de pais (2 letras) |
| `region` | text | `us_canada`, `mexico`, `brazil`, `rest_of_world` |
| `units` | integer | Cantidad de unidades |
| `raw_data` | jsonb | Datos crudos del source para auditoria |

**Unique constraint**: `(source, external_id)` - permite upserts idempotentes.

### Tabla: `mrr_daily_snapshots`
Snapshots mensuales pre-calculados. Cada fila = un mes (almacenado como YYYY-MM-01).

| Campo | Tipo | Descripcion |
|---|---|---|
| `snapshot_date` | date | Primer dia del mes (YYYY-MM-01) |
| `mrr_gross` | numeric | MRR bruto total (spreading) |
| `mrr_net` | numeric | MRR neto total (despues de comisiones) |
| `total_commissions` | numeric | Total comisiones de stores |
| `total_taxes` | numeric | Total impuestos |
| `total_refunds` | numeric | Total reembolsos |
| `total_disputes` | numeric | Total disputas |
| `mrr_apple_gross/net` | numeric | MRR de Apple (gross y net) |
| `mrr_google_gross/net` | numeric | MRR de Google (gross y net) |
| `mrr_stripe_gross/net` | numeric | MRR de Stripe (gross y net) |
| `mrr_us_canada` | numeric | MRR por region: US & Canada |
| `mrr_mexico` | numeric | MRR por region: Mexico |
| `mrr_brazil` | numeric | MRR por region: Brazil |
| `mrr_rest_of_world` | numeric | MRR por region: Resto del mundo |
| `mrr_monthly` | numeric | MRR por tipo de plan: monthly |
| `mrr_yearly` | numeric | MRR por tipo de plan: yearly |
| `mrr_semesterly` | numeric | MRR por tipo de plan: semesterly |
| `mrr_quarterly` | numeric | MRR por tipo de plan: quarterly |
| `mrr_weekly` | numeric | MRR por tipo de plan: weekly |
| `mrr_lifetime` | numeric | MRR por tipo de plan: lifetime |
| `mrr_other` | numeric | MRR por tipo de plan: other |
| `new_subscriptions` | integer | Suscripciones nuevas del mes |
| `renewals` | integer | Renovaciones del mes |
| `trial_conversions` | integer | Conversiones de trial |
| `refund_count` | integer | Cantidad de refunds |
| `active_subscriptions` | integer | Suscripciones activas (spreading) |

**Unique constraint**: `snapshot_date`

### Tabla: `sync_log`
Log de sincronizaciones ejecutadas.

### Tabla: `sku_mappings`
Mapeo de SKUs a plan names/types (referencia).

---

## Data Sync Pipeline

### Flujo completo:

```
Sources (APIs)  -->  transactions (tabla)  -->  Snapshot computation  -->  mrr_daily_snapshots (tabla)  -->  Dashboard UI
```

### Paso 1: Sync de transacciones

Cada source tiene su propio sync module:

**Apple** (`lib/sync/apple.ts`):
1. Genera JWT con la private key de App Store Connect
2. Hace fetch al Finance Report de la region ZZ (All Territories) para el mes dado
3. Descomprime el TSV (gzip)
4. Parsea las filas y filtra solo suscripciones (`productTypeIdentifier = IAY` o SKUs con `premium`/`learn`/`play`)
5. Calcula commission rate por SKU: `1 - (partnerShare / customerPrice)`
6. Convierte a USD: prefiere USD price tier (si existe el SKU en USD), si no, usa tabla de exchange rates
7. Agrega filas por SKU+pais+precio y genera transactions
8. Upsert a Supabase por batches de 500

**Google** (`lib/sync/google.ts`):
1. Se conecta a GCS con service account
2. Lista archivos CSV en el bucket: `earnings/earnings_YYYYMM_*.csv`
3. Descarga y parsea cada CSV
4. Mapea transaction types: Charge, Google fee, Tax, Charge refund
5. Merge comisiones (Google fee) en las filas de charge correspondientes: `net = gross - commission`
6. Convierte MXN a USD si es necesario
7. Upsert a Supabase

**Stripe** (`lib/sync/stripe.ts`):
1. Lista balance transactions del dia (charges + refunds)
2. Para cada balance transaction, obtiene el charge con invoice expandido
3. Determina plan_type desde el Price object o por inferencia del monto
4. `amount_gross = bt.amount/100`, `amount_net = bt.net/100`, `commission = bt.fee/100`
5. Upsert a Supabase

### Paso 2: Snapshot computation

Despues de sync, se ejecuta `computeMonthlySnapshot(date)` que recalcula el snapshot del mes.

---

## MRR Calculation (Spreading Methodology)

El MRR se calcula con **metodologia de spreading** (distribucion proporcional por servicio):

### Concepto

Cada charge se distribuye proporcionalmente entre todos los meses que cubre su suscripcion:

```
MRR contribution = amount / period_months
```

| Plan Type | Period (months) | Ejemplo: charge de $79.99 |
|---|---|---|
| monthly | 1 | $79.99 / 1 = $79.99/mes |
| quarterly | 3 | $79.99 / 3 = $26.66/mes |
| semesterly | 6 | $79.99 / 6 = $13.33/mes |
| yearly | 12 | $79.99 / 12 = $6.67/mes |
| lifetime | 60 (5 anos) | $79.99 / 60 = $1.33/mes |
| weekly | 0.25 | $9.99 / 0.25 = $39.96/mes |

### Determinacion del periodo activo

Para cada charge, se calcula cuando inicia y termina su periodo de cobertura:

```
Start = transaction_date (primer dia del mes de la transaccion)
End = primer dia del mes DESPUES del ultimo mes cubierto

Ejemplo: Yearly comprado en Marzo 2025
  Start: 2025-03-01
  End: 2026-03-01 (cubre Mar 2025 - Feb 2026)
```

Un charge es **activo** en un mes si:
```
transaction_date < month_end AND end_date > month_start
```

### Active Subscriptions

`active_subscriptions` = cantidad total de charges activos en el mes (por spreading). Esto NO es lo mismo que suscriptores unicos, ya que un usuario con un plan yearly tiene 1 charge activo durante 12 meses.

### Filtros de calidad

Antes de calcular, se excluyen:
- Charges con `plan_name` que contiene "Test"
- Stripe charges no-subscription (ebooks, masterclass, invoices, `plan_name` ends with " charge", equals "Payment for invoice" o "none")
- Charges con `plan_type = 'other'`

---

## Snapshot Computation

**Archivo**: `lib/sync/snapshots.ts` - funcion `computeMonthlySnapshot(date)`

### Proceso:

1. **Fetch charges**: Obtiene todos los charges desde 5 anos atras hasta el fin del mes del snapshot (para capturar lifetimes)
2. **Filtros de calidad**: Excluye test, non-subscription, y unclassified
3. **Fetch other transactions**: Obtiene refunds, taxes, disputes SOLO del mes actual (point-in-time)
4. **Determinar charges activos**: Filtra charges cuyo periodo de suscripcion cubre el mes del snapshot
5. **Calcular MRR (spreading)**: Para cada charge activo, `amount / period_months`
6. **Desglosar por dimensiones**: Source (apple/google/stripe), Region, Plan type
7. **Contar suscripciones del mes**: new, renewals, trial conversions (solo charges con `transaction_date` dentro del mes)
8. **Upsert snapshot**: Guarda en `mrr_daily_snapshots` con ON CONFLICT update

---

## Dashboard Metrics & Formulas

### Overview Page (Row 1 - Responden a filtros de fecha)

| Metrica | Formula | Descripcion |
|---|---|---|
| **MRR (Net Revenue)** | `SUM(mrr_net)` de los meses filtrados | Revenue neto despues de comisiones de stores |
| **Gross Revenue** | `SUM(mrr_gross)` de los meses filtrados | Revenue bruto antes de comisiones |
| **Commissions** | `SUM(total_commissions)` de los meses filtrados | Total comisiones pagadas a Apple/Google/Stripe |
| **Refunds** | `SUM(total_refunds)` de los meses filtrados | Total reembolsos |

### Overview Page (Row 2 - NO responden a filtros, usan TODOS los snapshots)

| Metrica | Formula | Descripcion |
|---|---|---|
| **ARR** | `SUM(mrr_gross)` de los ultimos 12 meses (TTM) | Annual Recurring Revenue - suma REAL de los ultimos 12 meses de gross revenue. Usa `mrr_gross` (no net). |
| **MoM Growth** | `((MRR_net_actual - MRR_net_anterior) / MRR_net_anterior) * 100` | Crecimiento porcentual mes a mes del MRR net |
| **6-Month Growth** | `MRR_net_actual / MRR_net_6_meses_atras` | Multiplicador de crecimiento en 6 meses (ej: 1.25x) |
| **Road to $6M ARR** | `(ARR / 6,000,000) * 100` | Progreso porcentual hacia la meta de $6M ARR |

### Churn Page

| Metrica | Formula | Descripcion |
|---|---|---|
| **Lost Subscriptions** | `prev_active + new_this_month - current_active` | Suscripciones que expiraron o no renovaron. Si prev_active=1000, new=200, current=1050, entonces lost=150 |
| **Churn Rate** | `lost / prev_active * 100` | Porcentaje de suscripciones perdidas respecto al mes anterior |
| **Monthly Churn Rate** | Weighted average: `SUM(lost_i * rate_i) / SUM(prev_active_i)` | Churn rate ponderado por base de suscriptores |
| **Active Subscriptions** | `active_subscriptions` del ultimo mes | Total de charges activos en el mes por spreading |
| **Lost Subs Trend** | `(lost_current - lost_previous) / lost_previous * 100` | Tendencia de cambio en lost subs mes a mes |

### Breakdown Page

- **By Source**: Desglose de MRR por Apple / Google / Stripe
- **By Region**: Desglose por US & Canada / Mexico / Brazil / Rest of World
- **By Plan**: Desglose por Monthly / Yearly / Semesterly / Quarterly / Weekly / Lifetime
- **Commissions**: Desglose de comisiones pagadas a cada store

### Growth Charts

| Chart | Descripcion |
|---|---|
| **Net New MRR** | Barras verticales: `MRR_net_actual - MRR_net_anterior` por mes. Verde = positivo, rojo = negativo |
| **Monthly Growth Rate** | Barras horizontales: `((curr - prev) / prev) * 100` ultimos 6 meses |
| **Revenue & Costs** | Grafica combinada de gross revenue (barras) y commissions (linea) |

---

## Filters & Date Presets

### Date Presets

| Preset | Rango |
|---|---|
| This Month | Primer dia del mes actual -> hoy |
| Last Month | Primer dia del mes pasado -> ultimo dia del mes pasado |
| 3 Months | 3 meses atras -> hoy |
| 6 Months | 6 meses atras -> hoy |
| 12 Months | 12 meses atras -> hoy (DEFAULT) |
| Year to Date | 1 de enero del ano actual -> hoy |
| All | 2024-01-01 -> hoy |
| Custom | Fechas personalizadas |

### Dimension Filters

- **Sources**: Apple, Google, Stripe (multi-select)
- **Regions**: US & Canada, Mexico, Brazil, Rest of World (multi-select)
- **Plans**: Monthly, Yearly, Semesterly, Quarterly, Weekly, Lifetime (multi-select)

Los filtros de dimension recomputan `mrr_gross` y `mrr_net` sumando solo los sub-campos seleccionados. Ejemplo: si seleccionas solo "Apple", `mrr_gross = mrr_apple_gross`.

**Importante**: ARR, MoM Growth, 6-Month Growth y Road to $6M ARR **NO responden** a filtros de fecha ni de dimension - siempre usan todos los snapshots disponibles.

---

## Pages & Views

| Ruta | Descripcion |
|---|---|
| `/dashboard` | Overview: metricas principales, ARR, growth, graficas de revenue y breakdowns |
| `/dashboard/breakdown` | Breakdown: tabs de desglose por Source, Region, Plan, Commissions |
| `/dashboard/churn` | Churn: metricas de churn, grafica de active vs lost, tabla detallada por mes |
| `/dashboard/trends` | Trends: tendencias historicas |

---

## How to Update Data

### Actualizacion automatica (Cron)

El dashboard se actualiza automaticamente cada dia a las **6:00 AM UTC** via Vercel Cron Job.

**Que hace el cron** (`/api/cron/sync`):
1. Sync Apple: descarga finance report del mes actual
2. Sync Google: descarga earnings del mes actual (YYYYMM)
3. Sync Stripe: descarga transacciones de hoy y ayer
4. Recompute snapshot del mes actual
5. Si estamos en los primeros 3 dias del mes, tambien recomputa el mes anterior (late-arriving data)

**Auth del cron**: Requiere header `Authorization: Bearer {CRON_SECRET}`.

### Actualizacion manual

#### Opcion 1: Sync individual por source

**Apple** - Sync un mes especifico:
```bash
curl -X POST https://TU-URL-VERCEL/api/sync/apple \
  -H "Content-Type: application/json" \
  -d '{"month": "2026-03"}'
```

**Google** - Sync un mes especifico:
```bash
curl -X POST https://TU-URL-VERCEL/api/sync/google \
  -H "Content-Type: application/json" \
  -d '{"yearMonth": "202603"}'
```

**Stripe** - Sync un dia especifico:
```bash
curl -X POST https://TU-URL-VERCEL/api/sync/stripe \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-03-04"}'
```

> Nota: Los endpoints de Apple y Stripe automaticamente recomputan el snapshot del mes despues del sync.

#### Opcion 2: Recompute snapshots (sin re-sync de sources)

Recalcula snapshots a partir de los datos de `transactions` que ya existen en la base de datos. Util cuando cambias la logica de calculo o necesitas regenerar snapshots historicos.

```bash
curl -X POST https://TU-URL-VERCEL/api/sync/recompute-snapshots \
  -H "Content-Type: application/json" \
  -d '{"startMonth": "2024-01", "endMonth": "2026-03"}'
```

**Parametros**:
- `startMonth`: Mes de inicio en formato YYYY-MM
- `endMonth`: Mes final en formato YYYY-MM
- Timeout: 5 minutos (300s) - suficiente para ~27 meses

**Cuando usar recompute**:
- Despues de cambiar la logica de calculo en `snapshots.ts`
- Despues de agregar nuevos campos a los snapshots
- Despues de hacer un backfill masivo de transacciones
- Si sospechas que algun snapshot tiene datos incorrectos

#### Opcion 3: Recompute via localhost (desarrollo local)

Si corres el proyecto localmente:

```bash
# 1. Iniciar el dev server
npm run dev

# 2. Recomputar snapshots
curl -X POST http://localhost:3000/api/sync/recompute-snapshots \
  -H "Content-Type: application/json" \
  -d '{"startMonth": "2024-01", "endMonth": "2026-03"}'
```

### Agregar datos de un mes nuevo

Cuando hay un nuevo mes disponible (ej: marzo 2026):

1. **Apple**: Esperar a que Apple publique el Finance Report (generalmente 5-7 dias despues del cierre del mes fiscal)
2. **Google**: El earnings report aparece automaticamente en el bucket de GCS
3. **Stripe**: Se sincroniza diariamente, no requiere accion

Proceso manual si el cron no lo capturo:
```bash
# Sync Apple marzo 2026
curl -X POST https://TU-URL-VERCEL/api/sync/apple \
  -H "Content-Type: application/json" \
  -d '{"month": "2026-03"}'

# Sync Google marzo 2026
curl -X POST https://TU-URL-VERCEL/api/sync/google \
  -H "Content-Type: application/json" \
  -d '{"yearMonth": "202603"}'

# Sync Stripe (cada dia de marzo, o solo los dias faltantes)
curl -X POST https://TU-URL-VERCEL/api/sync/stripe \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-03-01"}'

# Recomputar snapshot del mes
curl -X POST https://TU-URL-VERCEL/api/sync/recompute-snapshots \
  -H "Content-Type: application/json" \
  -d '{"startMonth": "2026-03", "endMonth": "2026-03"}'
```

---

## Environment Variables

| Variable | Descripcion |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL de la instancia de Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key de Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key de Supabase (server-side) |
| `APPLE_ISSUER_ID` | Issuer ID de App Store Connect |
| `APPLE_KEY_ID` | Key ID de la API key de Apple |
| `APPLE_PRIVATE_KEY_B64` | Private key de Apple en base64 |
| `APPLE_VENDOR_NUMBER` | Vendor number de Apple |
| `GCP_SERVICE_ACCOUNT_KEY_B64` | Service account key de Google Cloud en base64 |
| `GOOGLE_PLAY_BUCKET` | Nombre del bucket de GCS con los earnings reports |
| `STRIPE_SECRET_KEY` | Secret key de Stripe |
| `CRON_SECRET` | Secret para autenticar el cron job de Vercel |

---

## Troubleshooting

### Los datos no se actualizan
1. Verificar que el cron job esta corriendo: revisar Vercel Dashboard > Cron Jobs
2. Revisar logs en Vercel > Functions para ver errores de sync
3. Verificar que las API keys no estan expiradas (especialmente Apple JWT expira cada 20 min)

### ARR no coincide con lo esperado
- ARR usa **gross revenue** (no net) de los **ultimos 12 meses (TTM)**
- No responde a filtros de fecha: siempre muestra los ultimos 12 meses de data disponible
- Verificar que todos los meses tienen snapshots computados

### Churn muestra 0 lost
- Asegurar que `active_subscriptions` esta populado en los snapshots
- Si esta en 0, correr recompute: `POST /api/sync/recompute-snapshots`
- La formula requiere al menos 2 meses de datos para calcular lost

### Snapshots con datos faltantes
- Correr recompute para el rango de meses afectados
- Verificar que hay transacciones en la tabla `transactions` para esos meses

### La pagina carga en blanco
- Verificar que el dev server esta corriendo (`npm run dev`)
- Si hay lock file issues: `rm -f .next/dev/lock`
- Matar procesos zombi en el puerto: `lsof -i :3000` y `kill -9 <PID>`

### Exchange rates desactualizados
- Actualizar las tablas `CURRENCY_TO_USD` y `MONTHLY_RATE_OVERRIDES` en `lib/sync/apple.ts`
- Actualizar `MXN_USD_RATES` en `lib/sync/google.ts`
- Despues de actualizar, correr recompute para los meses afectados
