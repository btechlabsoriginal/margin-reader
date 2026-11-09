import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import { openDatabase } from '../src/db.js';
import { prepareQuery, readHighlights, searchIndex } from '../src/index.js';

let db: Db;

beforeEach(() => { db = openDatabase(':memory:'); });
afterEach(() => { db.close(); });

function insert(title: string, content: string, archived = 0): number {
  const info = db.prepare(`INSERT INTO articles(url, title, author, content_text, site, status, archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)`).run(`https://example.com/${title.replace(/\W+/g, '-')}`, title, 'Ada Reader', content, 'example.com', archived, Date.now(), Date.now());
  return Number(info.lastInsertRowid);
}

describe('FTS5 index', () => {
  it('searches with weighted BM25 and returns stable highlight offsets', () => {
    insert('The future of deep reading', 'A few reflections on the future of reading deeply and carefully.');
    insert('A different subject', 'The future is bright, but future predictions are uncertain.');
    const results = searchIndex(db, 'future');
    expect(results.total).toBe(2);
    expect(results.items[0].title).toBe('The future of deep reading');
    expect(results.items[0].titleOffsets.length).toBeGreaterThan(0);
    const hit = results.items[0];
    const [start, end] = hit.titleOffsets[0];
    expect(hit.title.slice(start, end).toLowerCase()).toBe('future');
    expect(hit.snippet.toLowerCase()).toContain('future');
    expect(hit.snippetOffsets.some(([from, to]) => hit.snippet.slice(from, to).toLowerCase() === 'future')).toBe(true);
  });

  it('removes rows from the index when archived, deleted, or reset', () => {
    const id = insert('Reading an old notebook', 'Notebooks hold the little discoveries that everyone forgets.');
    expect(searchIndex(db, 'notebook').total).toBe(1);
    db.prepare('UPDATE articles SET archived = 1 WHERE id = ?').run(id);
    expect(searchIndex(db, 'notebook').total).toBe(0);
    expect(searchIndex(db, 'notebook', 30, 0, 'all').total).toBe(1);
    db.prepare("UPDATE articles SET status = 'pending' WHERE id = ?").run(id);
    expect(searchIndex(db, 'notebook', 30, 0, 'all').total).toBe(0);
    db.prepare('DELETE FROM articles WHERE id = ?').run(id);
    expect(searchIndex(db, 'notebook', 30, 0, 'all').total).toBe(0);
  });

  it('treats FTS operators as plain search terms', () => {
    expect(prepareQuery('hello OR world')).toBe('"hello"* AND "OR"* AND "world"*');
    expect(readHighlights('A \uE000careful\uE001 idea')).toEqual({ text: 'A careful idea', offsets: [[2, 9]] });
  });
});
