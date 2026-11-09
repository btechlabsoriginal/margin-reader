import type { Db } from './db.js';
import { fetchAndExtract, PermanentFetchError } from './fetch.js';
import type { ExtractedArticle } from './types.js';

type Job = { article_id: number; attempts: number; url: string };
type Extractor = (url: string) => Promise<ExtractedArticle>;

export class FetchQueue {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly active = new Set<number>();
  private readonly running = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly db: Db, private readonly concurrency = 2, private readonly extract: Extractor = fetchAndExtract) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), 1200);
    this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.running]);
  }

  wake(): void {
    queueMicrotask(() => this.tick());
  }

  enqueue(articleId: number): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO fetch_jobs(article_id, attempts, available_at, leased_until, last_error)
      VALUES (?, 0, ?, NULL, NULL)
      ON CONFLICT(article_id) DO UPDATE SET attempts=0, available_at=excluded.available_at, leased_until=NULL, last_error=NULL
    `).run(articleId, now);
    this.db.prepare('UPDATE articles SET status = ?, error = NULL, updated_at = ? WHERE id = ?').run('pending', now, articleId);
    this.wake();
  }

  private claim(): Job | undefined {
    return this.db.transaction(() => {
      const now = Date.now();
      const job = this.db.prepare(`
        SELECT j.article_id, j.attempts, a.url FROM fetch_jobs j
        JOIN articles a ON a.id = j.article_id
        WHERE j.available_at <= ? AND (j.leased_until IS NULL OR j.leased_until <= ?)
        ORDER BY j.available_at, j.article_id LIMIT 1
      `).get(now, now) as Job | undefined;
      if (!job) return;
      this.db.prepare('UPDATE fetch_jobs SET attempts = attempts + 1, leased_until = ? WHERE article_id = ?').run(now + 180_000, job.article_id);
      this.db.prepare('UPDATE articles SET status = ?, updated_at = ? WHERE id = ?').run('processing', now, job.article_id);
      return { ...job, attempts: job.attempts + 1 };
    })();
  }

  private tick(): void {
    if (this.stopped) return;
    while (this.active.size < this.concurrency) {
      const job = this.claim();
      if (!job) break;
      this.active.add(job.article_id);
      const task = this.run(job).catch(error => {
        console.error('Fetch worker encountered an unexpected error:', error);
      }).finally(() => {
        this.active.delete(job.article_id);
        this.running.delete(task);
        this.wake();
      });
      this.running.add(task);
    }
  }

  private async run(job: Job): Promise<void> {
    try {
      const article = await this.extract(job.url);
      this.db.transaction(() => {
        this.db.prepare(`
          UPDATE articles SET title=?, author=?, published_at=?, site=?, excerpt=?,
            content_html=?, content_text=?, status='ready', error=NULL, updated_at=? WHERE id=?
        `).run(article.title, article.author, article.publishedAt, article.site, article.excerpt, article.contentHtml, article.contentText, Date.now(), job.article_id);
        this.db.prepare('DELETE FROM fetch_jobs WHERE article_id = ?').run(job.article_id);
      })();
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unexpected extraction error';
      const now = Date.now();
      this.db.transaction(() => {
        if (job.attempts >= 4 || error instanceof PermanentFetchError) {
          this.db.prepare('DELETE FROM fetch_jobs WHERE article_id = ?').run(job.article_id);
          this.db.prepare('UPDATE articles SET status=?, error=?, updated_at=? WHERE id=?').run('failed', reason.slice(0, 500), now, job.article_id);
        } else {
          const delay = Math.min(3_600_000, 10_000 * 3 ** (job.attempts - 1));
          this.db.prepare('UPDATE fetch_jobs SET available_at=?, leased_until=NULL, last_error=? WHERE article_id=?')
            .run(now + delay, reason.slice(0, 500), job.article_id);
          this.db.prepare('UPDATE articles SET status=?, error=?, updated_at=? WHERE id=?').run('pending', reason.slice(0, 500), now, job.article_id);
        }
      })();
    }
  }
}
