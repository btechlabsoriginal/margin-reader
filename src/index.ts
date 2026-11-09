import type { Db } from './db.js';
import { tagsFor, toSummary } from './db.js';
import type { ArticleRow, SearchHit } from './types.js';

const begin = '\uE000';
const end = '\uE001';

type IndexedRow = ArticleRow & {
  score: number;
  marked_snippet: string;
  marked_title: string;
};

export function prepareQuery(input: string): string {
  const terms = input.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu)?.slice(0, 10) ?? [];
  return terms.map(term => `"${term.replace(/"/g, '""')}"*`).join(' AND ');
}

export function readHighlights(marked: string): { text: string; offsets: Array<[number, number]> } {
  let text = '';
  let start: number | null = null;
  const offsets: Array<[number, number]> = [];
  for (const char of marked) {
    if (char === begin) start = text.length;
    else if (char === end && start !== null) {
      offsets.push([start, text.length]);
      start = null;
    } else text += char;
  }
  return { text, offsets };
}

export function searchIndex(db: Db, query: string, limit = 30, offset = 0, archived: 0 | 1 | 'all' = 0): { items: SearchHit[]; total: number } {
  const match = prepareQuery(query);
  if (!match) return { items: [], total: 0 };
  const common = `FROM articles_fts JOIN articles a ON a.id = articles_fts.rowid
    WHERE articles_fts MATCH ? AND (a.archived = ? OR ? = 2)`;
  const archivedFilter = archived === 'all' ? 2 : archived;
  const total = (db.prepare(`SELECT count(*) AS count ${common}`).get(match, archivedFilter, archivedFilter) as { count: number }).count;
  const rows = db.prepare(`
    SELECT a.*, bm25(articles_fts, 6.0, 3.0, 1.0) AS score,
      snippet(articles_fts, 2, ?, ?, '…', 32) AS marked_snippet,
      highlight(articles_fts, 0, ?, ?) AS marked_title
    ${common}
    ORDER BY score ASC, a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(begin, end, begin, end, match, archivedFilter, archivedFilter, limit, offset) as IndexedRow[];
  const tagMap = tagsFor(db, rows.map(row => row.id));
  return {
    total,
    items: rows.map(row => {
      const snippet = readHighlights(row.marked_snippet);
      const title = readHighlights(row.marked_title);
      return {
        ...toSummary(row, tagMap.get(row.id) ?? []),
        title: title.text,
        snippet: snippet.text,
        snippetOffsets: snippet.offsets,
        titleOffsets: title.offsets,
        score: row.score
      };
    })
  };
}
