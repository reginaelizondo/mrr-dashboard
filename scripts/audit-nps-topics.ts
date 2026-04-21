/**
 * Audit script: classify every commented NPS response against the current
 * topic rules (NEGATIVE_TOPICS + POSITIVE_TOPICS) and print out:
 *   1. coverage stats per bucket
 *   2. every comment that matched NO bucket, grouped by category
 *      (Detractor / Passive / Promoter), so we can spot the gaps.
 *
 * Run with:  npx tsx scripts/audit-nps-topics.ts
 */

import { NEGATIVE_TOPICS, POSITIVE_TOPICS, TopicDef } from '../lib/nps/comment-topics';

const CSV_URL =
  'https://docs.google.com/spreadsheets/d/1hWhzrFhig8C4Fj382KOTRLUHwZUV8Pd14KXzo2dwe9g/export?format=csv&gid=0';

interface Row {
  identity: string;
  date: string;
  score: number;
  category: 'Promoter' | 'Passive' | 'Detractor';
  comment: string;
  locale: string;
  os: string;
  plan: string;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') {}
      else field += c;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function main() {
  console.log('Fetching CSV…');
  const res = await fetch(CSV_URL);
  if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
  const text = await res.text();
  const rows = parseCsv(text).slice(1);
  const parsed: Row[] = rows
    .filter((r) => r && r.length >= 5)
    .map((r) => {
      const score = parseInt(r[2], 10);
      let category = (r[3] || '').trim() as Row['category'];
      if (!['Promoter', 'Passive', 'Detractor'].includes(category)) {
        if (score >= 9) category = 'Promoter';
        else if (score >= 7) category = 'Passive';
        else category = 'Detractor';
      }
      return {
        identity: r[0] || '',
        date: r[1] || '',
        score,
        category,
        comment: (r[4] || '').trim(),
        plan: (r[6] || '').trim().toLowerCase(),
        locale: (r[7] || '').trim().toLowerCase(),
        os: (r[8] || '').trim(),
      };
    })
    .filter((r) => !isNaN(r.score));

  const withComments = parsed.filter((r) => r.comment && r.comment.length > 2);
  console.log(`\nTotal responses: ${parsed.length}`);
  console.log(`With comments:   ${withComments.length}`);

  // Normalize curly punctuation so patterns match iOS-typed comments
  const normalize = (s: string) =>
    s
      .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
      .replace(/[\u201C\u201D\u201F\u2033]/g, '"');

  // Classify
  const matchesTopics = (comment: string, topics: TopicDef[]): string[] => {
    const c = normalize(comment);
    return topics
      .filter((t) => t.patterns.some((re) => re.test(c)))
      .map((t) => t.key);
  };

  // Stats per bucket
  const negDetractorsPassives = withComments.filter((r) => r.category !== 'Promoter');
  const posPromoters = withComments.filter((r) => r.category === 'Promoter');

  const bucketCounts: Record<string, number> = {};
  NEGATIVE_TOPICS.forEach((t) => (bucketCounts[`neg:${t.key}`] = 0));
  POSITIVE_TOPICS.forEach((t) => (bucketCounts[`pos:${t.key}`] = 0));

  const uncoveredNeg: Row[] = [];
  const uncoveredPos: Row[] = [];

  for (const r of negDetractorsPassives) {
    const hits = matchesTopics(r.comment, NEGATIVE_TOPICS);
    if (hits.length === 0) uncoveredNeg.push(r);
    else hits.forEach((k) => bucketCounts[`neg:${k}`]++);
  }
  for (const r of posPromoters) {
    const hits = matchesTopics(r.comment, POSITIVE_TOPICS);
    if (hits.length === 0) uncoveredPos.push(r);
    else hits.forEach((k) => bucketCounts[`pos:${k}`]++);
  }

  console.log('\n=== Negative topic coverage (detractors + passives) ===');
  console.log(`Pool: ${negDetractorsPassives.length}`);
  NEGATIVE_TOPICS.forEach((t) => {
    const c = bucketCounts[`neg:${t.key}`];
    const pct = ((c / negDetractorsPassives.length) * 100).toFixed(1);
    console.log(`  ${t.label.padEnd(35)} ${String(c).padStart(4)} (${pct}%)`);
  });
  console.log(`  UNCATEGORIZED                       ${String(uncoveredNeg.length).padStart(4)} (${((uncoveredNeg.length / negDetractorsPassives.length) * 100).toFixed(1)}%)`);

  console.log('\n=== Positive topic coverage (promoters) ===');
  console.log(`Pool: ${posPromoters.length}`);
  POSITIVE_TOPICS.forEach((t) => {
    const c = bucketCounts[`pos:${t.key}`];
    const pct = ((c / posPromoters.length) * 100).toFixed(1);
    console.log(`  ${t.label.padEnd(35)} ${String(c).padStart(4)} (${pct}%)`);
  });
  console.log(`  UNCATEGORIZED                       ${String(uncoveredPos.length).padStart(4)} (${((uncoveredPos.length / posPromoters.length) * 100).toFixed(1)}%)`);

  // Dump uncategorized — truncated for readability
  console.log('\n=== Uncategorized NEGATIVE comments ===');
  uncoveredNeg.slice(0, 200).forEach((r, i) => {
    console.log(`${String(i + 1).padStart(3)}. [${r.category}/${r.score}] [${r.locale}/${r.os}] ${r.comment.slice(0, 220)}`);
  });
  if (uncoveredNeg.length > 200) console.log(`…and ${uncoveredNeg.length - 200} more`);

  console.log('\n=== Uncategorized POSITIVE comments ===');
  uncoveredPos.slice(0, 200).forEach((r, i) => {
    console.log(`${String(i + 1).padStart(3)}. [${r.score}] [${r.locale}/${r.os}] ${r.comment.slice(0, 220)}`);
  });
  if (uncoveredPos.length > 200) console.log(`…and ${uncoveredPos.length - 200} more`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
