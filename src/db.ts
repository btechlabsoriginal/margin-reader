import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { ArticleRow, ArticleSummary } from './types.js';

export type Db = Database.Database;

const schema = `
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  author TEXT,
  published_at TEXT,
  site TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  content_html TEXT NOT NULL DEFAULT '',
  content_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS articles_recent ON articles(archived, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS article_tags (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, tag_id)
);
CREATE INDEX IF NOT EXISTS article_tags_tag ON article_tags(tag_id);
CREATE TABLE IF NOT EXISTS fetch_jobs (
  article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  leased_until INTEGER,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS fetch_jobs_due ON fetch_jobs(available_at, leased_until);
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  title, author, content_text,
  content='articles', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS articles_fts_insert AFTER INSERT ON articles
WHEN new.status = 'ready' BEGIN
  INSERT INTO articles_fts(rowid, title, author, content_text)
  VALUES (new.id, new.title, new.author, new.content_text);
END;
CREATE TRIGGER IF NOT EXISTS articles_fts_delete AFTER DELETE ON articles
WHEN old.status = 'ready' BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, author, content_text)
  VALUES ('delete', old.id, old.title, old.author, old.content_text);
END;
CREATE TRIGGER IF NOT EXISTS articles_fts_update AFTER UPDATE OF title, author, content_text, status ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, author, content_text)
  SELECT 'delete', old.id, old.title, old.author, old.content_text
  WHERE old.status = 'ready';
  INSERT INTO articles_fts(rowid, title, author, content_text)
  SELECT new.id, new.title, new.author, new.content_text
  WHERE new.status = 'ready';
END;
`;

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(schema);
  return db;
}

export function tagsFor(db: Db, ids: number[]): Map<number, string[]> {
  const result = new Map<number, string[]>();
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT at.article_id AS articleId, t.name
    FROM article_tags at JOIN tags t ON t.id = at.tag_id
    WHERE at.article_id IN (${placeholders}) ORDER BY t.name COLLATE NOCASE
  `).all(...ids) as Array<{ articleId: number; name: string }>;
  for (const row of rows) result.set(row.articleId, [...(result.get(row.articleId) ?? []), row.name]);
  return result;
}

export function toSummary(row: ArticleRow, tags: string[]): ArticleSummary {
  return {
    id: row.id,
    url: row.url,
    title: row.title || row.url,
    author: row.author,
    publishedAt: row.published_at,
    site: row.site,
    excerpt: row.excerpt,
    status: row.status,
    archived: row.archived === 1,
    error: row.error,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function setTags(db: Db, articleId: number, names: string[]): void {
  const unique = [...new Set(names.map(name => name.trim().toLowerCase()).filter(Boolean))];
  db.transaction(() => {
    db.prepare('DELETE FROM article_tags WHERE article_id = ?').run(articleId);
    const add = db.prepare('INSERT INTO tags(name) VALUES (?) ON CONFLICT(name) DO NOTHING');
    const link = db.prepare('INSERT INTO article_tags(article_id, tag_id) SELECT ?, id FROM tags WHERE name = ?');
    for (const name of unique) {
      add.run(name);
      link.run(articleId, name);
    }
    db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM article_tags)').run();
    db.prepare('UPDATE articles SET updated_at = max(updated_at + 1, ?) WHERE id = ?').run(Date.now(), articleId);
  })();
}

export function oneArticle(db: Db, id: number): ArticleRow | undefined {
  return db.prepare('SELECT * FROM articles WHERE id = ?').get(id) as ArticleRow | undefined;
}
