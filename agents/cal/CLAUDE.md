# Cal · calendario único de cumplimiento (INC y SAPI)

Cal avisa con anticipación de cada fecha fiscal, legal y de personas que puede costar dinero si se pasa.
No presenta nada: quien ejecuta sigue siendo la persona o el despacho que dice cada fecha. Parte de la
Constelación de BizOps: https://claude.ai/artifact/Vbs4sYoNrkG6Sq8zszMWMG

## Fuente de verdad

El calendario de Google **"Kinedu INC y SAPI fillings"** (propietaria: Pepis). Ahí viven las fechas anuales
(1099, Delaware, 1120, anual SAPI, 409A, pagos trimestrales de franchise tax) y las que Cal agregó el
19-oct-2026 (Stripe Tax, registered agent, payment freeze, aguinaldos, 360, W9, HR Policies, REPSE trimestral).

- Para **mover una fecha, quitar algo ya hecho o agregar una nueva**: edita el evento en ese calendario. Nada más.
- Convención opcional en la descripción del evento: `[Cal: alertas 30,15,5]` fija los días de aviso. Sin eso, Cal avisa a 30, 15, 5 y 1 días.
- En eventos de varios días, la fecha límite es el **último** día del evento.
- `data/cal/compliance.json` es solo el respaldo que Cal usa mientras no pueda leer el calendario.

## Dónde vive y cómo corre

- Código: `lib/cal/cal.ts`, `lib/cal/calendar-source.ts`, `app/api/cron/cal-daily/route.ts`.
- Cron en Vercel **todos los días 14:05 UTC (08:05 MX)**. Publica en `#bizops-finanzas-agentes` solo si:
  hoy cae un umbral de alerta de alguna fecha, algo pasó de fecha en los últimos 14 días, o es lunes (resumen de 45 días + pendientes por confirmar).
- Para que lea el calendario: cuenta de servicio de BizOps (`BIZOPS_GCP_SA_KEY_B64` en Vercel) y compartir el calendario
  con el correo de esa cuenta como "Ver todos los detalles de los eventos". Es la misma cuenta que Estela usa para la hoja de caja.
- Prueba local: `npx tsx scripts/test-cal.ts [--today AAAA-MM-DD] [--post]`.

## Qué no hace (todavía)

- No sabe si algo ya se hizo: cuando una fecha pasa, la lista 14 días como "confirma si ya quedó". Para que deje de aparecer, se quita o se mueve el evento.
- No pide acuses a los despachos ni persigue entregas: eso es de Dalia.
- Pendientes por confirmar (viven en el JSON, sección `pendientes`): renovación de seguros, co-registro anual en Delaware, materialidad SAT, fechas exactas de REPSE.
