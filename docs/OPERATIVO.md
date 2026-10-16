# Dashboard Operativo — arquitectura y operación

Réplica del Looker "Operational Dashboard" (`aee33f04-f8b9-40ee-bdd6-e42b0e8df416`) dentro del MRR Dashboard
(`/dashboard/operativo`), con una vista **Looker (hoy)** idéntica al Looker y una vista **Corregido** calibrada
con lo que reporta cada tienda. Las diferencias entre ambas están en `docs/DIFERENCIAS-LOOKER.md`; la
validación automática en `docs/AUDITORIA.md`.

## Flujo de datos

```
BigQuery an_operational_dash (dbt, ≈09:01 · 11:02 · 13:01 MX)
   │  cron kpi-daily cada 30 min ?mode=if-changed (solo si BigQuery cambió)  +  diario 15:10 UTC (completo)
   ▼
Supabase kpi_daily  ── cambio atómico por mes (kpi_daily_stage → kpi_daily_swap) ──┐
                                                                                   │ recalcula
Apple apple_sales_daily · Google transactions + GCS earnings/sales · Stripe API                   │
   │  cron store-daily cada hora (10 días) + diario 15:40 UTC (75 días)            ▼
   ▼                                                                kpi_calibration (factores tienda/BigQuery)
Supabase store_daily (día × tienda × país, USD de la propia tienda) ─────────────▶ │
                                                                                   ▼
                                        v_kpi_daily_bucketed (fila + columnas cal_*) → kpi_rollup (semana/mes)
                                                                                   ▼
                                        kpi_daily_agg() (RPC)  →  lib/kpi/replica.ts computeKpis()  →  página
```

## Tablas y funciones (Supabase)

| Objeto | Migración | Qué es |
|---|---|---|
| `kpi_daily` | 031 | Copia diaria de `an_operational_dash` (8 dimensiones × 25 medidas). |
| `v_kpi_daily_totals` | 031 | Totales por día (auditoría histórica). |
| `kpi_daily_agg()` | 032→037 | Sumas por periodo (día/semana/mes/trimestre/año/total) y dimensión, con los filtros del Looker. Usa el rollup para periodos completos. |
| `kpi_daily_dim_values()`, `kpi_daily_status()` | 032 | Valores de filtros y estado. |
| `kpi_rollup`, `refresh_kpi_rollup()` | 033 | Pre-agregado semanal y mensual (4 dimensiones). |
| `v_kpi_daily_bucketed` | 033→037 | Cada fila con sus buckets de OS × Stripe y las columnas calibradas `cal_*`. |
| `kpi_daily_day_totals()` | 033 | Totales por día para verificar contra BigQuery. |
| `sync_log` source `kpi_daily` | 034 | Bitácora de syncs de la réplica. |
| `kpi_daily_stage`, `kpi_daily_swap()` | 035→037 | Sync atómico: reemplaza un mes y recalcula calibración + rollup en una transacción. |
| `stripe_yr_sales` | 036 | Renovaciones anuales iOS cobradas por Stripe (Corregido al 0.965). |
| `store_daily`, `kpi_calibration`, `refresh_kpi_calibration()`, `refresh_store_calibration()`, `store_coverage()` | 037 | Ventas por tienda y factores de calibración del Corregido. |
| `kpi_guard_runs` | 037 | Corridas del auditor automático. |

## Crons (vercel.json)

| Ruta | Horario (UTC) | Qué hace |
|---|---|---|
| `/api/cron/daily` | 07:00 | Sync del MRR (Apple, Google, Stripe → `transactions`, `apple_sales_daily`). |
| `/api/cron/kpi-daily` | 15:10 | Réplica: 95 días + 1 mes viejo en rotación + verificación de todo el historial (día × OS) y reparación. |
| `/api/cron/kpi-daily?mode=if-changed` | cada 30 min | Re-sincroniza 95 días si dbt reconstruyó BigQuery. |
| `/api/cron/store-daily?days=10` | :20 cada hora | Ventas por tienda de los últimos 10 días + recalibración. |
| `/api/cron/store-daily?days=75` | 15:40 | Igual, 75 días (recoge el earnings mensual de Google y días tardíos de Apple). |
| `/api/cron/daily-brief` | 15:30 | Brief diario a Slack (enlaza al dashboard). |
| `/api/cron/store-audit` | 16:00 | Auditoría tiendas vs Looker a Slack (incluye línea de la Réplica y de la Guardia). |
| `/api/cron/kpi-guard` | :45 cada hora | Auditor automático; avisa a Slack solo cuando algo cambia de estado. |

## Fórmulas

- BigQuery (brief, auditoría, verificación): `lib/kpi/formulas.ts` — `KPI_SQL` (definición Corregida) y `…Looker`.
- Dashboard: `lib/kpi/replica.ts` — `computeKpis(agg, 'looker' | 'fixed')`, espejo exacto de formulas.ts más la
  calibración con tiendas para los montos del Corregido.
- La Guardia compara ambas implementaciones cada hora (108 comparaciones).

## Scripts de operación (desde mrr-dashboard/)

| Script | Para qué |
|---|---|
| `npx tsx scripts/backfill-kpi-daily.ts --from … --to …` | Cargar la réplica (también `--verify`, `--rollup`, `--daily`). |
| `npx tsx scripts/backfill-store-daily.ts --from … --to …` | Cargar ventas por tienda y recalibrar. |
| `npx tsx scripts/test-kpi-replica.ts` | 31 KPIs de la réplica vs BigQuery en 10 casos. |
| `npx tsx scripts/audit-kpis.ts` | Correr la Guardia localmente (`--record` guarda y avisa). |
| `npx tsx scripts/test-store-audit.ts` | Auditoría tiendas vs Looker sin publicar. |
| `scripts/looker-parity/capture.js` + `compare.ts` | Comparación gráfica por gráfica contra el Looker original (navegador). |
| `npx tsx scripts/gen-docs.ts` | Regenerar `docs/DIFERENCIAS-LOOKER.md` desde el registro. |

## Corregido calibrado: reglas

- **Base de Total Sales:** lo que pagó el cliente, con impuesto (misma base que el Looker usa para Apple).
- **Base de Net Sales:** lo que deposita cada tienda: sin impuesto y sin comisión, a su tipo de cambio.
- **Factor:** por día × procesador × país, tienda / BigQuery sobre los 7 días que terminan ese día; si el país
  tiene menos de $50 en la ventana se usa el factor del procesador. Reembolsos con su propio factor cuando hay
  volumen; si no, el de ventas.
- **Atribución por OS del usuario:** se mantiene (decisión de negocio): el factor se aplica por procesador sobre
  las filas de BigQuery, que conservan el OS, país, idioma, red y plan.
- **Días estimados:** si la tienda aún no publica (Apple 1–2 días) o el dato es preliminar (Google del mes en
  curso), el dashboard lo dice explícitamente: aviso con los días por tienda y "≈" en las filas afectadas.
- **Google:** cobros desde `transactions` del MRR (une las cuentas SAPI-MXN e INC-USD de la migración ene–feb 2026);
  reembolsos del earnings o del reporte diario del mes en curso.
- **Sin calibrar:** antes de la cobertura (Apple < 2025-04-07) y procesadores sin reporte
  (PayPal, other_sales, LearnWorlds ≈ 0.4 %): tasas fijas del Corregido; el aviso muestra el porcentaje.
