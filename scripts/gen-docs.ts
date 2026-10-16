/**
 * Genera docs/DIFERENCIAS-LOOKER.md desde el registro lib/kpi/looker-differences.ts.
 *   npx tsx scripts/gen-docs.ts
 * No editar el .md a mano: editar el registro y volver a generar.
 */
import fs from 'fs';
import path from 'path';
import { LOOKER_DIFFERENCES, type DiffKind, type DiffStatus } from '../lib/kpi/looker-differences';

const KIND: Record<DiffKind, string> = { correccion: 'Corrección (error del Looker)', inconsistencia: 'Inconsistencia interna del Looker', alcance: 'Diferencia por diseño', dato: 'Problema de la fuente de datos' };
const STATUS: Record<DiffStatus, string> = { 'resuelto-en-looker': '✅ resuelto en el Looker', 'pendiente-tech': '⏳ pendiente de tech', 'solo-corregido': '🟦 solo en el Corregido', 'pendiente-decision': '❓ pendiente de decisión', documentado: '📄 documentado' };

const lines: string[] = [
  '# Diferencias entre el Looker y el dashboard Operativo',
  '',
  '> Generado desde `lib/kpi/looker-differences.ts` con `npx tsx scripts/gen-docs.ts`. No editar a mano.',
  `> Última generación: ${new Date().toISOString().slice(0, 10)}.`,
  '',
  'El dashboard tiene dos vistas:',
  '',
  '- **Looker (hoy)** — copia exacta del Looker "Operational Dashboard" original, incluidos sus errores e inconsistencias. Validada gráfica por gráfica: 232/234 columnas iguales en 30 páginas (2026-10-16; las 2 restantes son caché del Looker en la semana y el mes en curso). Se re-valida cada lunes (tarea \"Auditoría semanal KPIs\").',
  '- **Corregido** — el Looker más todas las correcciones acordadas, con los montos calibrados con lo que reporta cada tienda.',
  '',
  '## Resumen',
  '',
  '| # | Diferencia | Tipo | Estado | KPIs |',
  '|---|---|---|---|---|',
  ...LOOKER_DIFFERENCES.map((d, i) => `| ${i + 1} | [${d.title}](#${d.id}) | ${KIND[d.kind]} | ${STATUS[d.status]} | ${d.kpis.join(', ')} |`),
  '',
];
for (const [i, d] of LOOKER_DIFFERENCES.entries()) {
  lines.push(
    `## ${i + 1}. ${d.title}`, `<a id="${d.id}"></a>`, '',
    `- **Tipo:** ${KIND[d.kind]} · **Estado:** ${STATUS[d.status]} · **Encontrado:** ${d.found}`,
    `- **KPIs afectados:** ${d.kpis.join(', ')}`, '',
    `**Qué hace el Looker.** ${d.looker}`, '',
    `**Qué hace el dashboard (Corregido).** ${d.corregido}`, '',
    `**Impacto.** ${d.impact}`, '',
    `**Evidencia.** ${d.evidence}`, '',
    ...(d.decision ? [`**Decisión.** ${d.decision}`, ''] : []),
    ...(d.code ? [`**Código.** \`${d.code}\``, ''] : []),
  );
}
const out = path.join(__dirname, '..', 'docs', 'DIFERENCIAS-LOOKER.md');
fs.writeFileSync(out, lines.join('\n'));
console.log(`escrito ${out} (${LOOKER_DIFFERENCES.length} diferencias)`);
