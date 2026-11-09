import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAuth } from '../src/auth.js';
import { openDatabase } from '../src/db.js';
import { FetchQueue } from '../src/queue.js';
import { registerRoutes } from '../src/routes.js';

const content = 'A long story about small details, careful decisions, and knowing what to keep. '.repeat(5);

function setup() {
  const db = openDatabase(':memory:');
  const queue = new FetchQueue(db, 1, async () => ({ title: 'A saved essay', site: 'example.com', author: 'Mira', publishedAt: null, excerpt: 'A long story', contentHtml: `<p>${content}</p>`, contentText: content }));
  const app = Fastify();
  registerAuth(app, 'a-very-secure-example-password');
  registerRoutes(app, db, queue);
  return { db, queue, app };
}

async function login(app: ReturnType<typeof Fastify>): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/session', headers: { 'x-margin-request': '1' }, payload: { password: 'a-very-secure-example-password' } });
  expect(response.statusCode).toBe(200);
  return response.headers['set-cookie']!.toString().split(';')[0];
}

describe('REST API', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

  it('enforces auth and supports save, dedupe, tags, archive, and deletion', async () => {
    const { db, queue, app } = setup();
    cleanups.push(async () => { await queue.stop(); await app.close(); db.close(); });
    expect((await app.inject({ method: 'GET', url: '/api/articles' })).statusCode).toBe(401);
    const cookie = await login(app);
    const headers = { cookie, 'x-margin-request': '1' };
    const first = await app.inject({ method: 'POST', url: '/api/articles', headers, payload: { url: 'https://example.com/a?utm_source=test', tags: ['essays'] } });
    expect(first.statusCode).toBe(201);
    const id = first.json().article.id as number;
    const second = await app.inject({ method: 'POST', url: '/api/articles', headers, payload: { url: 'https://example.com/a', tags: ['Ideas'] } });
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicate).toBe(true);
    expect(second.json().article.tags).toEqual(['essays', 'ideas']);
    const details = await app.inject({ method: 'GET', url: `/api/articles/${id}`, headers });
    expect(details.statusCode).toBe(200);
    const archived = await app.inject({ method: 'PATCH', url: `/api/articles/${id}`, headers, payload: { archived: true } });
    expect(archived.json().article.archived).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/articles', headers })).json().total).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/articles?archived=1', headers })).json().total).toBe(1);
    expect((await app.inject({ method: 'DELETE', url: `/api/articles/${id}`, headers })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/articles/${id}`, headers })).statusCode).toBe(404);
  });

  it('rejects unsafe inputs and cross-site form submissions', async () => {
    const { db, queue, app } = setup();
    cleanups.push(async () => { await queue.stop(); await app.close(); db.close(); });
    const cookie = await login(app);
    expect((await app.inject({ method: 'POST', url: '/api/articles', headers: { cookie }, payload: { url: 'https://example.com' } })).statusCode).toBe(403);
    const response = await app.inject({ method: 'POST', url: '/api/articles', headers: { cookie, 'x-margin-request': '1' }, payload: { url: 'file:///etc/passwd' } });
    expect(response.statusCode).toBe(400);
  });
});
