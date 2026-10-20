# Handoff de Estela

- Estado: código listo y probado en local (dry run 19-oct-2026 con datos reales: KPIs, MRR, P&L agosto). Cron programado para los lunes 08:00 MX.
- 19-oct-2026: tabla `estela_proposals` creada (SQL Editor), bot invitado al canal, código en producción. Primera publicación real hecha a mano: propuestas #1, #2 y #3.
- Pendiente opcional (recomendado): acceso a la hoja *Cash analysis*. Cuenta de servicio en el proyecto GCP `kinedu-agentes-bizops` con Sheets API, compartir la hoja con su correo como lector, y cargar en Vercel `ESTELA_GCP_SA_KEY_B64` y `ESTELA_CASH_SHEET_ID=1SQzmmE-gWMsCfYJ5y6ohLRCacQKBDnhcGzd_8naZvpo`.
- Próxima corrida automática: lunes 26-oct-2026 08:00 MX. Pepis debe probar los botones Acepto / No sobre las propuestas #1–#3 para validar el seguimiento.
- Próxima mejora: que el P&L se lea de una hoja de Google en vez del CSV, cuando Arrowpoint entregue en formato fijo.
