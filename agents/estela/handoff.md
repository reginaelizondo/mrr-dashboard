# Handoff de Estela

- Estado: código listo y probado en local (dry run 19-oct-2026 con datos reales: KPIs, MRR, P&L agosto). Cron programado para los lunes 08:00 MX.
- Pendiente de Pepis para la primera corrida real:
  1. Invitar al bot al canal: en `#bizops-finanzas-agentes` escribir `/invite @kpi_bot`.
  2. Crear la tabla `estela_proposals` en Supabase: pegar `supabase/migrations/027_estela_proposals.sql` en el SQL Editor del proyecto y ejecutar.
  3. Opcional (recomendado): acceso a la hoja *Cash analysis*. Cuenta de servicio en el proyecto GCP `kinedu-agentes-bizops` con Sheets API, compartir la hoja con su correo como lector, y cargar en Vercel `ESTELA_GCP_SA_KEY_B64` y `ESTELA_CASH_SHEET_ID=1SQzmmE-gWMsCfYJ5y6ohLRCacQKBDnhcGzd_8naZvpo`.
- Primera corrida real: lunes 26-oct-2026 08:00 MX, o antes a mano con `npx tsx scripts/test-estela.ts --post`.
- Próxima mejora: que el P&L se lea de una hoja de Google en vez del CSV, cuando Arrowpoint entregue en formato fijo.
