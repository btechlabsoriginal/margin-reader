import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

const sessionName = 'margin_session';
const lifetime = 30 * 24 * 60 * 60;
const failures = new Map<string, { count: number; reset: number }>();

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function equivalent(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function signature(password: string, timestamp: string): string {
  return createHmac('sha256', password).update(`margin:v1:${timestamp}`).digest('base64url');
}

function getCookie(request: FastifyRequest): string | undefined {
  const cookies = request.headers.cookie?.split(';') ?? [];
  const entry = cookies.map(cookie => cookie.trim()).find(cookie => cookie.startsWith(`${sessionName}=`));
  return entry?.slice(sessionName.length + 1);
}

function authorized(request: FastifyRequest, password: string): boolean {
  const token = getCookie(request);
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !/^\d+$/.test(parts[0])) return false;
  const expiry = Number(parts[0]);
  return expiry > Math.floor(Date.now() / 1000) && Number.isSafeInteger(expiry) && equivalent(parts[1], signature(password, parts[0]));
}

export function registerAuth(app: FastifyInstance, password: string | undefined): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    if (request.url === '/api/health' || (request.url === '/api/session' && request.method === 'POST')) return;
    if (password && !authorized(request, password)) {
      reply.code(401).send({ error: 'Authentication required' });
      return;
    }
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) && request.headers['x-margin-request'] !== '1') {
      reply.code(403).send({ error: 'Missing request header' });
    }
  });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/session', async () => ({ authenticated: true, protected: Boolean(password) }));

  app.post('/api/session', async (request, reply) => {
    if (request.headers['x-margin-request'] !== '1') return reply.code(403).send({ error: 'Missing request header' });
    const input = z.object({ password: z.string() }).safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Password required' });
    if (!password) return { authenticated: true };
    const ip = request.ip;
    const prior = failures.get(ip);
    const now = Date.now();
    if (prior && prior.count >= 8 && now < prior.reset) return reply.code(429).send({ error: 'Too many attempts. Try later.' });
    if (!equivalent(input.data.password, password)) {
      failures.set(ip, { count: (prior && prior.reset > now ? prior.count : 0) + 1, reset: now + 15 * 60_000 });
      return reply.code(401).send({ error: 'Incorrect password' });
    }
    failures.delete(ip);
    const expiry = String(Math.floor(Date.now() / 1000) + lifetime);
    const secure = request.protocol === 'https' ? '; Secure' : '';
    reply.header('Set-Cookie', `${sessionName}=${expiry}.${signature(password, expiry)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${lifetime}${secure}`);
    return { authenticated: true };
  });

  app.delete('/api/session', async (_request, reply) => {
    reply.header('Set-Cookie', `${sessionName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return { authenticated: false };
  });
}
