import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from './db.js';
import { registerAuth } from './auth.js';
import { FetchQueue } from './queue.js';
import { registerRoutes } from './routes.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const password = process.env.APP_PASSWORD?.trim();
if (process.env.NODE_ENV === 'production' && (!password || password.length < 12)) {
  throw new Error('Set APP_PASSWORD to a unique password of at least 12 characters before exposing the app');
}

const database = openDatabase(process.env.DATABASE_PATH ?? './data/margin.db');
const concurrency = Math.max(1, Math.min(5, Number(process.env.FETCH_CONCURRENCY) || 2));
const queue = new FetchQueue(database, concurrency);
const app = Fastify({ logger: true, bodyLimit: 32 * 1024, trustProxy: process.env.TRUST_PROXY === '1' });

app.addHook('onSend', async (_request, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'none'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  return payload;
});

registerAuth(app, password);
registerRoutes(app, database, queue);

const staticRoot = resolve('web/dist');
if (existsSync(staticRoot)) {
  await app.register(fastifyStatic, { root: staticRoot, prefix: '/', wildcard: false });
  const document = readFileSync(resolve(staticRoot, 'index.html'));
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.method !== 'GET' || request.url.includes('.')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.type('text/html; charset=utf-8').send(document);
  });
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

async function shutdown(): Promise<void> {
  const finishing = queue.stop();
  await app.close();
  await finishing;
  database.close();
}

process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());

try {
  await app.listen({ port, host });
  queue.start();
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await shutdown();
}
