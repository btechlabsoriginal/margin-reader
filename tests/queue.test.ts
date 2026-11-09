import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { FetchQueue } from '../src/queue.js';
import { PermanentFetchError } from '../src/fetch.js';

const dbs: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function makeArticle() {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const info = db.prepare('INSERT INTO articles(url,title,site,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run('https://example.com/story', '', 'example.com', Date.now(), Date.now());
  return { db, id: Number(info.lastInsertRowid) };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Queue did not settle');
}

describe('persistent fetch queue', () => {
  it('stores a successful extraction and updates the search index', async () => {
    const { db, id } = makeArticle();
    const queue = new FetchQueue(db, 1, async () => ({
      title: 'The saved story', author: null, publishedAt: null, site: 'example.com',
      excerpt: 'A saved story.', contentHtml: '<p>Building a reading library.</p>', contentText: 'Building a reading library.'
    }));
    queue.enqueue(id);
    await until(() => (db.prepare('SELECT status FROM articles WHERE id=?').get(id) as { status: string }).status === 'ready');
    expect((db.prepare('SELECT count(*) AS count FROM articles_fts WHERE articles_fts MATCH ?').get('"library"*') as { count: number }).count).toBe(1);
    expect((db.prepare('SELECT count(*) AS count FROM fetch_jobs').get() as { count: number }).count).toBe(0);
    await queue.stop();
  });

  it('does not retry permanently unreadable pages', async () => {
    const { db, id } = makeArticle();
    const queue = new FetchQueue(db, 1, async () => { throw new PermanentFetchError('Not a readable article'); });
    queue.enqueue(id);
    await until(() => (db.prepare('SELECT status FROM articles WHERE id=?').get(id) as { status: string }).status === 'failed');
    expect((db.prepare('SELECT count(*) AS count FROM fetch_jobs').get() as { count: number }).count).toBe(0);
    await queue.stop();
  });

  it('schedules a later retry after a transient extraction failure', async () => {
    const { db, id } = makeArticle();
    const queue = new FetchQueue(db, 1, async () => { throw new Error('Source temporarily unavailable'); });
    queue.enqueue(id);
    await until(() => (db.prepare('SELECT attempts FROM fetch_jobs WHERE article_id=?').get(id) as { attempts: number }).attempts === 1);
    await queue.stop();
    const job = db.prepare('SELECT attempts, available_at FROM fetch_jobs WHERE article_id=?').get(id) as { attempts: number; available_at: number };
    expect(job.attempts).toBe(1);
    expect(job.available_at).toBeGreaterThan(Date.now());
    expect((db.prepare('SELECT status FROM articles WHERE id=?').get(id) as { status: string }).status).toBe('pending');
  });
});
