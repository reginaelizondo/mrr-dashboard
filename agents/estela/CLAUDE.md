# Estela · estratega semanal de BizOps

Estela lee cada lunes los números de Kinedu y le propone a Pepis exactamente tres cosas con impacto en caja
o rentabilidad. Propone, no ejecuta. Pepis decide con los botones del mensaje; Luis decide lo que toca a
precios, headcount o inversionistas. Es parte de la Constelación de BizOps:
https://claude.ai/artifact/Vbs4sYoNrkG6Sq8zszMWMG

## Dónde vive y cómo corre

- Código: `lib/estela/` (hechos, redactor, corrida) y `app/api/cron/estela-weekly/route.ts`.
- Corre en Vercel como cron los **lunes 14:00 UTC (08:00 MX)**, sin depender de ninguna Mac. Ver `vercel.json`.
- Publica en Slack `#bizops-finanzas-agentes` (`C0CAJT405R7`, privado) con el bot `kpi_bot`. Override: `ESTELA_SLACK_CHANNEL`.
- Guarda cada propuesta en Supabase `estela_proposals` (migración `027`). Los botones *Acepto* / *No por ahora*
  cambian el estado (`app/api/slack-bot/interactive/route.ts`), y la semana siguiente Estela da seguimiento en vez de repetir.
- Prueba local sin publicar: `npx tsx scripts/test-estela.ts` (`--facts`, `--no-llm`, `--today AAAA-MM-DD`, `--post`).
- Corrida manual en producción: `GET /api/cron/estela-weekly?dry=1` con `Authorization: Bearer $CRON_SECRET`.

## Qué lee (hoja de hechos, `lib/estela/facts.ts`)

| Fuente | Qué | Cómo |
|---|---|---|
| BigQuery `an_operational_dash` | KPIs de las últimas 4 semanas completas, mismas fórmulas validadas del KPI Bot | `fetchKPIsByPeriod` |
| Supabase `mrr_daily_snapshots` | MRR neto actual, hace 30 y 90 días, por tienda | service role |
| `data/estela/pnl-2026-cons-usd.csv` | P&L consolidado USD de Arrowpoint: último mes cerrado, anterior, promedio 3m | CSV versionado |
| `data/estela/budget-2026-cash-conservative.csv` | Budget 2026 cash, escenario conservador, para el desvío del mes | CSV versionado |
| Google Sheet *Cash analysis* (opcional) | Saldos, pagos pendientes, cobros esperados del mes | Sheets API con cuenta de servicio (`ESTELA_GCP_SA_KEY_B64` + `ESTELA_CASH_SHEET_ID`) |
| Supabase `estela_proposals` | Propuestas anteriores abiertas o aceptadas | service role |

Cuando una fuente falta, Estela lo dice en el mensaje y trabaja con lo demás. Nunca inventa un número.

## Reglas del redactor (`lib/estela/writer.ts`)

- Solo cifras que están en los hechos; si suma o resta dos, escribe la operación en "cómo se calculó".
- Toda propuesta trae un número en dinero (ahorro mensual, ingreso, cobranza o riesgo evitado). Sin número, no se propone.
- Prioridad: caja en los próximos 60 días, lo que depende de BizOps, lo que ya tiene señal en los datos.
- Tres propuestas distintas entre sí. No repite las que siguen abiertas: les da seguimiento.
- Nunca propone despidos ni cambios de sueldo. Sin lenguaje de alarma.

## Qué pasa con una propuesta después del lunes

| Botón / regla | Estado | Qué hace Estela después |
|---|---|---|
| *Acepto* | aceptada | Cada lunes la revisa contra los datos y da un veredicto: SIGUE (no llega el plazo), YA SE VE (el dato muestra el efecto), NO SE VE (pasó el plazo sin cambio), CERRAR (más de 4 semanas sin señal o tema superado). El "so what" sigue siendo de Pepis: Estela no ejecuta. |
| *No por ahora* | rechazada | No vuelve a aparecer. |
| *Cerrar #id* (en la sección de seguimiento) | cerrada | Pepis marca que ya quedó resuelta o ya no aplica. Estela deja de seguirla. |
| Sin decisión en 2 semanas | cerrada (automático) | Se archiva con resultado "sin decisión". |
| Aceptada y 8 semanas sin cierre | cerrada (automático) | Vence con resultado "8 semanas sin cierre". |

## Mantenimiento mensual

1. Cuando Arrowpoint cierre un mes, actualizar `data/estela/pnl-2026-cons-usd.csv` (export de la hoja *P&L Cons USD*
   del Formato P&L). Hasta que Nora exista, lo hace Pepis o Regina con Claude en este repo.
2. Si cambia el escenario de budget, reemplazar `budget-2026-cash-conservative.csv`.
3. Cada enero: nuevo P&L y nuevo budget; revisar los nombres de línea en `PNL_LINES` (facts.ts).

## Cómo medimos a Estela

- Pepis acepta al menos una propuesta al mes.
- Lo aceptado se ve en el P&L o en el MRR en el plazo que Estela dijo.
- Cero cifras que no estén en los hechos (si aparece una, es bug del prompt: reportarlo aquí).
