/*
 * Captura del Looker original para la comparación gráfica por gráfica (scripts/looker-parity/compare.ts).
 *
 * Uso (agente kpi-auditor, navegador integrado con sesión de Google iniciada):
 *   1. Abrir https://datastudio.google.com/reporting/aee33f04-f8b9-40ee-bdd6-e42b0e8df416 (panel visible:
 *      con el panel oculto los clics de navegación no funcionan).
 *   2. Pegar este archivo completo en javascript_tool. Arranca el recorrido de las 44 páginas en segundo
 *      plano (≈ 7 s por página, > 45 s en total: no se espera aquí).
 *   3. Esperar ~5.5 min y luego ejecutar:  window.__lp.done && JSON.stringify(window.__lp.digest())
 *      → guardar el resultado en un archivo y correr:
 *        npx tsx scripts/looker-parity/compare.ts <archivo.json>
 *
 * Qué captura: las tablas reales (.table) y las tablas de datos ocultas de cada gráfica (líneas con
 * tabuladores en innerText). Devuelve un RESUMEN por columna (n, suma, tolerancia de redondeo) solo con
 * periodos desde 2024-01-01 — suficiente para comparar sin copiar miles de celdas.
 */
(() => {
  const MES = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sept: 9, sep: 9, oct: 10, nov: 11, dic: 12 };
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const pd = (s) => { const m = String(s).trim().match(/^(\d{1,2}) ([a-z]+)\.? (\d{4})$/); return m && MES[m[2]] ? iso(+m[3], MES[m[2]], +m[1]) : null; };
  const lab = (s) => { s = String(s).trim(); let m = s.match(/^Del (\d{1,2} [a-z]+ \d{4}) al/); if (m) return pd(m[1]); m = s.match(/^T(\d), (\d{4})$/); if (m) return iso(+m[2], (+m[1] - 1) * 3 + 1, 1); m = s.match(/^([a-z]+) (\d{4})$/); if (m && MES[m[1]]) return iso(+m[2], MES[m[1]], 1); m = s.match(/^(\d{4})$/); if (m) return iso(+m[1], 1, 1); return pd(s); };
  const pv = (raw) => { let s = String(raw).trim(); if (!s || s === '-' || s === 'null' || s === '—' || /…$/.test(s)) return null; const neg = /^-|^−|^\$?\(.*\)$|^\$-/.test(s); s = s.replace(/[()$\s−]/g, '').replace(/^-/, ''); let mult = 1; if (/mil$/.test(s)) { mult = 1e3; s = s.replace(/mil$/, ''); } else if (/M$/.test(s)) { mult = 1e6; s = s.replace(/M$/, ''); } let pct = false; if (s.endsWith('%')) { pct = true; s = s.slice(0, -1); } const dec = s.includes(',') ? s.split(',')[1].length : 0; const n = Number(s.replace(/\./g, '').replace(',', '.')); if (!Number.isFinite(n)) return null; const sc = mult * (pct ? 0.01 : 1); return { v: (neg ? -n : n) * sc, t: 0.5 * Math.pow(10, -dec) * sc }; };
  const grainOf = (t) => { t = t.toLowerCase(); if (/daily|per day/.test(t)) return 'day'; if (/week|share of spend/.test(t)) return 'week'; if (/quarter/.test(t)) return 'quarter'; if (/year/.test(t)) return 'year'; if (/month|margen|efficiency|volume graphs$|contribution health/.test(t)) return 'month'; if (/cpi\/cpnu/.test(t)) return 'day'; return null; };
  const periodsOf = (s, e, g) => { const out = []; const st = (d) => { const x = new Date(d + 'T00:00:00Z'); if (g === 'week') x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); else if (g === 'month') x.setUTCDate(1); else if (g === 'quarter') x.setUTCMonth(Math.floor(x.getUTCMonth() / 3) * 3, 1); else if (g === 'year') x.setUTCMonth(0, 1); return x.toISOString().slice(0, 10); }; let p = st(s); while (p <= e) { out.push(p); const x = new Date(p + 'T00:00:00Z'); if (g === 'day') x.setUTCDate(x.getUTCDate() + 1); else if (g === 'week') x.setUTCDate(x.getUTCDate() + 7); else if (g === 'month') x.setUTCMonth(x.getUTCMonth() + 1); else if (g === 'quarter') x.setUTCMonth(x.getUTCMonth() + 3); else x.setUTCFullYear(x.getUTCFullYear() + 1); p = x.toISOString().slice(0, 10); } return out; };
  const digestCols = (head, rows) => head.map((h, j) => { let n = 0, sum = 0, tol = 0; for (const r of rows) { const x = pv(r[j]); if (!x) continue; n++; sum += x.v; tol += x.t; } return { h, n, sum: +sum.toFixed(6), tol: +tol.toFixed(6) }; }).filter((c) => c.n);

  const capture = () => {
    const t = document.body.innerText;
    const range = (t.match(/\n(\d{1,2} [a-z]+ \d{4} - \d{1,2} [a-z]+ \d{4})\n/) || [])[1] || null;
    const lines = t.split('\n'); const blocks = []; const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]; if (!l.includes('\t')) continue;
      const head = l.split('\t'); const rows = []; let j = i + 1;
      while (j < lines.length && lines[j].includes('\t')) { const c = lines[j].split('\t'); if (c.length !== head.length || lines[j] === l) break; rows.push(c); j++; }
      const k = l + '|' + rows.length + '|' + (rows[0] || []).join(',');
      if (rows.length && !seen.has(k) && !head.every((h) => h === '25-75')) { seen.add(k); blocks.push({ head, rows }); }
      i = Math.max(i, j - 1);
    }
    const tables = []; const seenT = new Set();
    for (const tb of document.querySelectorAll('.table')) {
      const rws = [...tb.querySelectorAll('.row[class*="block-"]')].map((r) => [...r.querySelectorAll('.cell')].map((c) => c.innerText.trim())).filter((r) => r.length && r.some((x) => x));
      if (!rws.length) continue;
      const hl = tb.innerText.split('\n').map((x) => x.trim()).filter((x) => x && x !== '▼');
      const k = hl.slice(0, rws[0].length).join('|') + rws.length + rws[0].join('|');
      if (!seenT.has(k)) { seenT.add(k); tables.push({ head: hl.slice(0, rws[0].length), rows: rws }); }
    }
    return { url: location.pathname.split('/').pop(), title: document.title.replace('Operational Dashboard › ', ''), range, blocks, tables };
  };

  const digestPage = (d, i) => {
    const rng = (d.range || '').split(' - ').map(pd); const g = grainOf(d.title);
    const out = { i, t: d.title, r: rng, g, items: [] };
    for (const tb of d.tables) {
      const rows = tb.rows.filter((r) => { const p = lab(r[0]); return p && p >= '2024-01-01'; });
      const ps = rows.map((r) => lab(r[0]));
      out.items.push({ k: 'table', periods: [ps.length, ps[0], ps[ps.length - 1]], cols: digestCols(tb.head.slice(1), rows.map((r) => r.slice(1))) });
    }
    for (const b of d.blocks) {
      if (b.head.some((h) => /semana anterior/.test(h))) continue;   // Bubble Graphs: fuera de alcance
      const periodHeads = b.head.length > 2 && b.head.slice(1).every((h) => lab(h));
      if (periodHeads) {
        const vals = []; for (const r of b.rows) { const j = r.slice(1).findIndex((x) => x !== ''); if (j < 0) continue; const p = lab(b.head[j + 1]); if (p >= '2024-01-01') vals.push([p, r[0], r[j + 1]]); }
        const ps = vals.map((v) => v[0]).sort();
        out.items.push({ k: 'pcols', note: /efficiency/i.test(d.title) ? 'cont/sales' : undefined, periods: [ps.length, ps[0], ps[ps.length - 1]], cols: digestCols([b.head[0], /efficiency/i.test(d.title) ? 'CM/Sales' : 'TOTAL CONTRIBUTION'], vals.map((v) => [v[1], v[2]])) });
        continue;
      }
      const dims = { os: ['iOS', 'Android', 'Unknown', 'Web'], kinedu_language: ['en', 'es', 'pt'], kinedu_region: ['US & CA', 'Brazil', 'Europe', 'Asia Pacific', 'Other', 'Latin America and the Caribbean', 'Africa, Middle East, and India', 'All Countries or Regions'] };
      const dim = Object.entries(dims).find(([, v]) => b.head.filter((h) => h !== 'null').every((h) => v.includes(h)))?.[0] || (b.head.filter((h) => h !== 'null').every((h) => /^[A-Z]{2}$/.test(h)) ? 'country' : null);
      if (dim) { out.items.push({ k: 'dim', dim, n: b.rows.length, cols: digestCols(b.head, b.rows).filter((c) => c.h !== 'null') }); continue; }
      if (!g || !rng[0]) { out.items.push({ k: 'block', head: b.head, n: b.rows.length, note: 'sin granularidad/rango' }); continue; }
      let per = periodsOf(rng[0], rng[1], g);
      if (per.length === b.rows.length + 1) per = per.slice(1);   // el Looker omite el primer periodo parcial en algunas gráficas
      if (per.length !== b.rows.length) { out.items.push({ k: 'block', head: b.head, n: b.rows.length, np: per.length, note: 'filas ≠ periodos' }); continue; }
      const keep = per.map((p, j) => [p, b.rows[j]]).filter(([p]) => p >= '2024-01-01');
      out.items.push({ k: 'block', periods: [keep.length, keep[0]?.[0], keep[keep.length - 1]?.[0]], cols: digestCols(b.head, keep.map((x) => x[1])) });
    }
    return out;
  };

  const navTo = async (i) => {
    const it = document.querySelectorAll('[role="treeitem"]')[i]; it.scrollIntoView({ block: 'center' });
    const r = it.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const tgt = document.elementFromPoint(x, y) || it;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) tgt.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type.endsWith('down') ? 1 : 0, view: window }));
    await new Promise((res) => setTimeout(res, 7000));
  };

  const lp = (window.__lp = { pages: [], done: false, startedAt: new Date().toISOString() });
  lp.digest = () => lp.pages.map(digestPage).filter((d) => d.items.length);
  (async () => {
    const n = document.querySelectorAll('[role="treeitem"]').length;
    for (let i = 0; i < n; i++) { await navTo(i); lp.pages[i] = capture(); }
    lp.done = true;
  })();
  return `recorriendo ${document.querySelectorAll('[role="treeitem"]').length} páginas…`;
})();
