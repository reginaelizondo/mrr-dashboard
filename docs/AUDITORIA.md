# Auditoría de KPIs — qué se valida, cuándo y cómo

Tres capas, de lo automático a lo profundo. Ninguna cambia fórmulas ni datos: reportan.

## 1. Guardia de KPIs (automática, cada hora)

`lib/audit/kpi-guard.ts` · cron `/api/cron/kpi-guard` (:45) · local `npx tsx scripts/audit-kpis.ts`.
Guarda cada corrida en `kpi_guard_runs`. **Avisa a Slack (#datastudiobot) solo cuando un chequeo empeora o se
recupera**, y recuerda una vez al día si algo sigue en alarma. La línea "Guardia KPIs: N/N" aparece además en la
auditoría diaria de tiendas (10:00 MX).

| Chequeo | Qué valida | ✅ | ⚠️ | 🔴 |
|---|---|---|---|---|
| `frescura.bigquery` | dbt reconstruyó `an_operational_dash` y la réplica tiene esa versión | réplica al día | réplica > 60 min atrás | BigQuery > 26 h sin reconstruir o réplica > 3 h atrás |
| `frescura.tiendas` | último día definitivo por tienda | Apple ≤ 3 días, Google mes anterior cerrado (desde el día 9), Stripe ≤ 1 día | alguno atrasado | — |
| `replica.dias` | réplica = BigQuery, por día × OS, 16 campos, últimos 35 días | 0 días | 1–5 días (la auto-reparación los corrige) | > 5 días |
| `formulas.paridad` | 27 KPIs × 4 ventanas (ayer, 7 días, mes en curso, mes pasado): dashboard (`replica.ts`) = BigQuery (`formulas.ts`), vista Looker completa y Corregido sin montos | 108 iguales | 1–3 distintos (suele ser un rebuild de dbt a medio camino) | > 3 distintos: cambió una fórmula |
| `calibracion.tiendas` | Corregido calibrado vs lo que reportó cada tienda, 4 semanas completas, cobrado y neto | ±3 % | 3–8 % | > 8 % |
| `tiendas.looker` | BigQuery en base Looker vs tiendas, 7 días hasta D-3 | Apple ±4 %, Stripe ±5 %, Google en su banda conocida (+3 a +22 %) | fuera | Apple > 8 %, Stripe > 10 % |
| `datos.invariantes` | 30 días con spend, signups y new subs > 0; CAC, C.R., CM/Sales en rangos posibles; downloads en cero (conocido) | normal | KPI fuera de rango | día sin datos |
| `pagina.salud` | carga de la vista por default del Operativo sin caché (peor caso) | < 4 s | 4–10 s | > 10 s o error |

Lo que la Guardia no puede ver: el Looker original (no tiene API). Si tech cambia una fórmula en el Looker, se
detecta en la capa 3.

## 2. Validaciones diarias ya existentes

- **Réplica vs BigQuery, historial completo** (job de las 15:10 UTC): compara 1,019+ días por día × OS y
  re-sincroniza los que difieran. Resultado en la bitácora y en la línea "Réplica dashboard" de la auditoría.
- **Auditoría tiendas vs Looker** (16:00 UTC, Slack): Apple, Google, Stripe, frescura del Looker, Stripe en TC
  contado una vez, monto de reembolsos de Stripe restados dos veces, réplica y guardia.

## 3. Auditoría profunda (semanal o después de cualquier cambio) — agente `kpi-auditor`

`.claude/agents/kpi-auditor.md`. Corre la Guardia, los 10 casos de `test-kpi-replica`, la auditoría de tiendas y
la **comparación gráfica por gráfica contra el Looker original** con el navegador integrado:
`scripts/looker-parity/capture.js` (recorre las 44 páginas y resume cada tabla y gráfica por columna) y
`scripts/looker-parity/compare.ts` (compara contra la réplica con el mismo rango y granularidad).

Referencia (2026-10-16): **232/234 columnas iguales** en 30 páginas; las 2 restantes eran caché del Looker en
la semana y el mes en curso (Cont / Spend by week y by Month). Capturas: `scripts/looker-parity/capture-*.json`.
Se corre sola cada lunes a las 8:00 MX (tarea programada "Auditoría semanal KPIs" en la app de escritorio:
necesita la app abierta y la sesión de Google en el navegador integrado); deja el reporte en
`Proyecto MRR/auditorias/` y un resumen en #datastudiobot.

Sin tabla de datos en la página (no comparables celda por celda; sus campos se validan en otras páginas):
Funnel Graphs (día/semana/mes/trimestre), Revenue over spend, rangos 25-75, Signups & FT by country,
FT conv + purchases by country, Users needed per purchase, Cost Ranges. Bubble Graphs no se replica.

## Qué hacer cuando algo falla

1. **Frescura / réplica:** casi siempre es un rebuild de dbt en medio de un sync. Esperar el siguiente sync
   (≤ 30 min) o correr `npx tsx scripts/backfill-kpi-daily.ts --daily`.
2. **Fórmulas en alarma:** alguien cambió `formulas.ts` o `replica.ts` sin el otro. Corregir para que vuelvan a
   ser espejo y correr `test-kpi-replica.ts`.
3. **Calibración / tiendas:** revisar `store_daily` del periodo (¿falta un reporte?, ¿cambió el formato del CSV
   de Google?, ¿falla la API de Stripe?) y re-sincronizar con `backfill-store-daily.ts`.
4. **Diferencia nueva contra el Looker:** confirmar con el agente; si es real, agregarla al registro
   `lib/kpi/looker-differences.ts`, regenerar el documento (`npx tsx scripts/gen-docs.ts`) y decidir con Pepis.
