/**
 * Tablas nativas de Slack (bloque `table`): columnas alineadas en el mensaje.
 * https://docs.slack.dev/reference/block-kit/blocks/table-block — máx. 100 filas, 20 columnas, 10,000 caracteres.
 * Si Slack rechaza el bloque (o el envío cae al webhook), `degradeTables` lo convierte en una tabla monoespaciada.
 */

export interface SlackTableBlock {
  type: 'table';
  column_settings?: Array<{ align?: 'left' | 'center' | 'right'; is_wrapped?: boolean } | null>;
  rows: unknown[][];
  /** Copia en texto plano para la versión de respaldo (no se envía a Slack). */
  _plain?: string[][];
  [key: string]: unknown;
}

const cell = (text: string, bold = false) => ({
  type: 'rich_text',
  elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: text || ' ', ...(bold ? { style: { bold: true } } : {}) }] }],
});

/**
 * header = títulos de columna; rows = celdas en texto. Una fila que empieza con '§' es un subtítulo de grupo
 * (p. ej. '§Plataforma'): ocupa la primera celda en negritas y deja vacías las demás.
 */
export function tableBlock(header: string[], rows: string[][], align: Array<'left' | 'right' | 'center'> = []): SlackTableBlock {
  const plain = [header, ...rows.map((r) => (r[0]?.startsWith('§') ? [r[0].slice(1), ...header.slice(1).map(() => '')] : r))];
  return {
    type: 'table',
    column_settings: header.map((_, i) => ({ align: align[i] ?? (i === 0 ? 'left' : 'right') })),
    rows: [
      header.map((h) => cell(h, true)),
      ...rows.map((r) => (r[0]?.startsWith('§') ? [cell(r[0].slice(1), true), ...header.slice(1).map(() => cell(''))] : r.map((c, i) => cell(c, i === 0)))),
    ],
    _plain: plain,
  };
}

/** Tabla en texto monoespaciado (respaldo). */
export function tableToMrkdwn(t: SlackTableBlock): string {
  const rows = t._plain ?? [];
  const width = (s: string) => [...s].length;
  const cols = Math.max(...rows.map((r) => r.length));
  const w = Array.from({ length: cols }, (_, i) => Math.max(...rows.map((r) => width(r[i] ?? ''))));
  const line = (r: string[]) => r.map((c, i) => {
    const pad = ' '.repeat(Math.max(0, w[i] - width(c ?? '')));
    return i === 0 ? (c ?? '') + pad : pad + (c ?? '');
  }).join('  ');
  return '```\n' + rows.map(line).join('\n').slice(0, 2800) + '\n```';
}

/** Quita el campo interno antes de mandar a Slack. */
export function cleanTables<T extends { type: string }>(blocks: T[]): T[] {
  return blocks.map((b) => {
    if (b.type !== 'table') return b;
    const rest = { ...(b as unknown as SlackTableBlock) };
    delete rest._plain;
    return rest as unknown as T;
  });
}

/** Reemplaza cada bloque `table` por una sección con la tabla monoespaciada. */
export function degradeTables<T extends { type: string }>(blocks: T[]): T[] {
  return blocks.map((b) => (b.type === 'table'
    ? ({ type: 'section', text: { type: 'mrkdwn', text: tableToMrkdwn(b as unknown as SlackTableBlock) } } as unknown as T)
    : b));
}
