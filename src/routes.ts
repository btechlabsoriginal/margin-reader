import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.js';
import { oneArticle, setTags, tagsFor, toSummary } from './db.js';
import { searchIndex } from './index.js';
import type { FetchQueue } from './queue.js';
import type { ArticleRow } from './types.js';
import { normalizeUrl } from './url.js';

const tagName = z.string().trim().min(1).max(32).regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u);
const tagList = z.array(tagName).max(16);
const saveBody = z.object({ url: z.string().trim().min(7).max(2048), tags: tagList.optional() });
const editBody = z.object({ archived: z.boolean().optional(), tags: tagList.optional() }).refine(value => value.archived !== undefined || value.tags !== undefined);
const paging = z.object({ limit: z.coerce.number().int().min(1).max(60).default(30), offset: z.coerce.number().int().min(0).max(100000).default(0) });
const listing = paging.extend({ archived: z.enum(['0', '1', 'all']).default('0'), status: z.enum(['pending', 'processing', 'ready', 'failed']).optional(), tag: tagName.optional() });
const searching = paging.extend({ q: z.string().max(200).default(''), archived: z.enum(['0', '1', 'all']).default('0') });

type IdParams = { id: string };

function invalid(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({ error: 'Invalid request parameters' });
}

function articleId(raw: string): number | null {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && String(value) === raw ? value : null;
}

function summary(db: Db, row: ArticleRow) {
  return toSummary(row, tagsFor(db, [row.id]).get(row.id) ?? []);
}

export function registerRoutes(app: FastifyInstance, db: Db, queue: FetchQueue): void {
  app.post('/api/articles', async (request, reply) => {
    const parsed = saveBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    let url: string;
    try {
      url = normalizeUrl(parsed.data.url);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid URL' });
    }
    const now = Date.now();
    const existing = db.prepare('SELECT * FROM articles WHERE url = ?').get(url) as ArticleRow | undefined;
    if (existing) {
      if (parsed.data.tags?.length) setTags(db, existing.id, [...(tagsFor(db, [existing.id]).get(existing.id) ?? []), ...parsed.data.tags]);
      return reply.code(200).send({ article: summary(db, existing), duplicate: true });
    }
    const info = db.prepare('INSERT INTO articles(url, title, site, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(url, new URL(url).hostname, new URL(url).hostname.replace(/^www\./, ''), now, now);
    const id = Number(info.lastInsertRowid);
    if (parsed.data.tags) setTags(db, id, parsed.data.tags);
    queue.enqueue(id);
    return reply.code(201).send({ article: summary(db, oneArticle(db, id)!), duplicate: false });
  });

  app.get('/api/articles', async (request, reply) => {
    const parsed = listing.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const { archived, status, tag, limit, offset } = parsed.data;
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (archived !== 'all') {
      conditions.push('a.archived = ?');
      params.push(Number(archived));
    }
    if (status) {
      conditions.push('a.status = ?');
      params.push(status);
    }
    if (tag) {
      conditions.push('EXISTS (SELECT 1 FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = a.id AND t.name = ? COLLATE NOCASE)');
      params.push(tag);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT count(*) AS count FROM articles a ${where}`).get(...params) as { count: number }).count;
    const rows = db.prepare(`SELECT a.* FROM articles a ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as ArticleRow[];
    const tagMap = tagsFor(db, rows.map(row => row.id));
    return { total, items: rows.map(row => toSummary(row, tagMap.get(row.id) ?? [])) };
  });

  app.get('/api/search', async (request, reply) => {
    const parsed = searching.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const { q, limit, offset, archived } = parsed.data;
    return searchIndex(db, q, limit, offset, archived === 'all' ? 'all' : archived === '1' ? 1 : 0);
  });

  app.get<{ Params: IdParams }>('/api/articles/:id', async (request, reply) => {
    const id = articleId(request.params.id);
    if (!id) return invalid(reply);
    const row = oneArticle(db, id);
    if (!row) return reply.code(404).send({ error: 'Article not found' });
    return { ...summary(db, row), contentHtml: row.content_html, contentText: row.content_text };
  });

  app.patch<{ Params: IdParams }>('/api/articles/:id', async (request, reply) => {
    const id = articleId(request.params.id);
    const parsed = editBody.safeParse(request.body);
    if (!id || !parsed.success) return invalid(reply);
    if (!oneArticle(db, id)) return reply.code(404).send({ error: 'Article not found' });
    db.transaction(() => {
      if (parsed.data.archived !== undefined) {
        db.prepare('UPDATE articles SET archived = ?, updated_at = ? WHERE id = ?')
          .run(Number(parsed.data.archived), Date.now(), id);
      }
      if (parsed.data.tags) setTags(db, id, parsed.data.tags);
    })();
    return { article: summary(db, oneArticle(db, id)!) };
  });

  app.post<{ Params: IdParams }>('/api/articles/:id/tags', async (request, reply) => {
    const id = articleId(request.params.id);
    const parsed = z.object({ tag: tagName }).safeParse(request.body);
    if (!id || !parsed.success) return invalid(reply);
    if (!oneArticle(db, id)) return reply.code(404).send({ error: 'Article not found' });
    setTags(db, id, [...(tagsFor(db, [id]).get(id) ?? []), parsed.data.tag]);
    return { article: summary(db, oneArticle(db, id)!) };
  });

  app.delete<{ Params: { id: string; tag: string } }>('/api/articles/:id/tags/:tag', async (request, reply) => {
    const id = articleId(request.params.id);
    if (!id) return invalid(reply);
    if (!oneArticle(db, id)) return reply.code(404).send({ error: 'Article not found' });
    const remaining = (tagsFor(db, [id]).get(id) ?? []).filter(tag => tag.toLowerCase() !== request.params.tag.toLowerCase());
    setTags(db, id, remaining);
    return { article: summary(db, oneArticle(db, id)!) };
  });

  app.post<{ Params: IdParams }>('/api/articles/:id/retry', async (request, reply) => {
    const id = articleId(request.params.id);
    if (!id) return invalid(reply);
    const article = oneArticle(db, id);
    if (!article) return reply.code(404).send({ error: 'Article not found' });
    if (article.status === 'processing') return reply.code(409).send({ error: 'Already fetching' });
    queue.enqueue(id);
    return reply.code(202).send({ article: summary(db, oneArticle(db, id)!) });
  });

  app.delete<{ Params: IdParams }>('/api/articles/:id', async (request, reply) => {
    const id = articleId(request.params.id);
    if (!id) return invalid(reply);
    const result = db.prepare('DELETE FROM articles WHERE id = ?').run(id);
    if (!result.changes) return reply.code(404).send({ error: 'Article not found' });
    return reply.code(204).send();
  });

  app.get('/api/tags', async () => ({
    items: db.prepare(`SELECT t.name, count(at.article_id) AS count FROM tags t
      JOIN article_tags at ON at.tag_id = t.id GROUP BY t.id ORDER BY t.name COLLATE NOCASE`)
      .all() as Array<{ name: string; count: number }>
  }));
}
