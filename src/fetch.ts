import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import * as cheerio from 'cheerio';
import sanitizeHtml from 'sanitize-html';
import { normalizeUrl, resolvePublicHost } from './url.js';
import type { ExtractedArticle } from './types.js';

const maxBytes = 3 * 1024 * 1024;
const excluded = 'script,style,noscript,nav,footer,header,aside,form,button,svg,iframe,canvas,template,dialog';
const allowedTags = ['p', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'strong', 'em', 'b', 'i', 'u', 's', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'hr', 'sup', 'sub', 'figure', 'figcaption'];

export class PermanentFetchError extends Error {}

type Download = { html: string; redirect?: string };

function decodeBody(buffer: Buffer, encoding: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!['gzip', 'deflate', 'br'].includes(encoding)) return resolve(buffer);
    const stream = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : createBrotliDecompress();
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) stream.destroy(new PermanentFetchError('Page exceeds size limit'));
      else chunks.push(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.end(buffer);
  });
}

async function download(url: URL): Promise<Download> {
  const resolved = await resolvePublicHost(url.hostname).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'Private network destinations are not allowed') throw new PermanentFetchError(error.message);
    throw error;
  });
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = transport(url, {
      method: 'GET',
      headers: {
        'user-agent': 'MarginReader/1.0 (+self-hosted reading list)',
        accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5',
        'accept-encoding': 'gzip, deflate, br'
      },
      lookup: (_hostname, _options, callback) => callback(null, resolved.address, resolved.family)
    }, res => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve({ html: '', redirect: res.headers.location });
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(status >= 400 && status < 500 && ![408, 425, 429].includes(status)
          ? new PermanentFetchError(`Source returned HTTP ${status}`)
          : new Error(`Source returned HTTP ${status}`));
        return;
      }
      const type = String(res.headers['content-type'] ?? '').toLowerCase();
      if (type && !/^(text\/html|application\/xhtml\+xml|text\/plain)/.test(type)) {
        res.resume();
        reject(new PermanentFetchError('This URL does not serve a readable HTML page'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) req.destroy(new PermanentFetchError('Page exceeds size limit'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase().trim();
        decodeBody(Buffer.concat(chunks), encoding).then(body => {
          if (body.length > maxBytes) throw new PermanentFetchError('Page exceeds size limit');
          resolve({ html: body.toString('utf8') });
        }).catch(reject);
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error('Source timed out')), 20_000);
    req.once('close', () => clearTimeout(deadline));
    req.setTimeout(15000, () => req.destroy(new Error('Source timed out')));
    req.on('error', reject);
    req.end();
  });
}

export async function fetchPage(input: string): Promise<{ html: string; finalUrl: string }> {
  let url = normalizeUrl(input);
  const visited = new Set<string>();
  for (let hop = 0; hop < 6; hop++) {
    if (visited.has(url)) throw new PermanentFetchError('Redirect loop');
    visited.add(url);
    const result = await download(new URL(url));
    if (!result.redirect) return { html: result.html, finalUrl: url };
    url = normalizeUrl(new URL(result.redirect, url).toString());
  }
  throw new PermanentFetchError('Too many redirects');
}

function firstNonempty(...values: Array<string | undefined | null>): string | null {
  return values.map(value => value?.trim()).find(value => Boolean(value)) ?? null;
}

function cleanDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function metadata(html: string, url: string): { title: string; author: string | null; publishedAt: string | null } {
  const $ = cheerio.load(html);
  const meta = (key: string) => $(`meta[property="${key}"], meta[name="${key}"]`).first().attr('content');
  let jsonLd: Record<string, unknown> = {};
  $('script[type="application/ld+json"]').each((_, element) => {
    if (Object.keys(jsonLd).length) return;
    try {
      const decoded: unknown = JSON.parse($(element).html() ?? '');
      const objects = Array.isArray(decoded) ? decoded : [decoded];
      const flattened = objects.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const obj = item as Record<string, unknown>;
        return Array.isArray(obj['@graph']) ? obj['@graph'] : [obj];
      });
      const found = flattened.find(item => {
        if (!item || typeof item !== 'object') return false;
        const kind = (item as Record<string, unknown>)['@type'];
        return (Array.isArray(kind) ? kind : [kind]).some(value => typeof value === 'string' && /Article|BlogPosting|NewsArticle/i.test(value));
      });
      if (found && typeof found === 'object') jsonLd = found as Record<string, unknown>;
    } catch {}
  });
  const authorData = jsonLd.author;
  const authorLd = typeof authorData === 'string' ? authorData :
    Array.isArray(authorData) ? authorData.map(item => typeof item === 'object' && item !== null ? (item as Record<string, unknown>).name : item).filter(Boolean).join(', ') :
    authorData && typeof authorData === 'object' ? (authorData as Record<string, unknown>).name : null;
  const title = firstNonempty(
    meta('og:title'), meta('twitter:title'),
    typeof jsonLd.headline === 'string' ? jsonLd.headline : null,
    $('h1').first().text(), $('title').first().text(), new URL(url).hostname
  ) ?? new URL(url).hostname;
  const author = firstNonempty(meta('article:author'), meta('author'), meta('parsely-author'), typeof authorLd === 'string' ? authorLd : null, $('[rel="author"]').first().text());
  const publishedAt = cleanDate(firstNonempty(meta('article:published_time'), meta('datePublished'), meta('pubdate'), typeof jsonLd.datePublished === 'string' ? jsonLd.datePublished : null, $('time[datetime]').first().attr('datetime')));
  return { title: title.replace(/\s+/g, ' ').slice(0, 320), author: author?.slice(0, 160) ?? null, publishedAt };
}

export function extractArticle(html: string, url: string): ExtractedArticle {
  const canonicalUrl = normalizeUrl(url);
  const details = metadata(html, canonicalUrl);
  const $ = cheerio.load(html);
  $(excluded).remove();
  $('[hidden], [aria-hidden="true"], .advertisement, .cookie-banner, .share-buttons, .related-posts').remove();
  const candidates: Array<{ element: ReturnType<typeof $>; score: number; length: number }> = [];
  $('article,main,section,div').each((_, node) => {
    const element = $(node);
    const text = element.text().replace(/\s+/g, ' ').trim();
    const length = text.length;
    if (length < 180) return;
    const paragraphs = element.find('p,blockquote,li,pre').toArray();
    const substantial = paragraphs.filter(paragraph => $(paragraph).text().trim().length >= 55);
    if (!substantial.length && length < 500) return;
    const linkedLength = element.find('a').toArray().reduce((sum, link) => sum + $(link).text().length, 0);
    const density = Math.max(0.05, 1 - linkedLength / Math.max(length, 1));
    const punctuation = (text.match(/[.!?;:]/g) ?? []).length;
    const className = `${element.attr('class') ?? ''} ${element.attr('id') ?? ''}`;
    const positive = /article|post|entry|story|content|body|prose|main/i.test(className) ? 1.25 : 1;
    const negative = /comment|sidebar|related|recommend|promo|menu|widget|footer/i.test(className) ? 0.2 : 1;
    const semantic = /^(article|main)$/i.test(node.type === 'tag' ? node.name : '') ? 1.4 : 1;
    const breadth = Math.min(1, 19000 / Math.max(length, 19000));
    const score = (Math.sqrt(length) * (1 + substantial.length * 0.3) + Math.min(punctuation, 100) * 0.2) * density * positive * negative * semantic * breadth;
    candidates.push({ element, score, length });
  });
  candidates.sort((a, b) => b.score - a.score || b.length - a.length);
  const selected = candidates[0]?.element ?? $('body');
  selected.find('nav,aside,footer,form').remove();
  selected.find('a[href]').each((_, element) => {
    const link = $(element);
    const href = link.attr('href');
    if (!href) return;
    try {
      link.attr('href', new URL(href, canonicalUrl).toString());
    } catch {
      link.removeAttr('href');
    }
  });
  const raw = selected.html() ?? '';
  const contentHtml = sanitizeHtml(raw, {
    allowedTags,
    allowedAttributes: { a: ['href', 'title', 'rel', 'target'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: (_tag, attrs) => ({ tagName: 'a', attribs: { ...attrs, rel: 'noopener noreferrer', target: '_blank' } })
    }
  });
  const textView = cheerio.load(`<main>${contentHtml}</main>`);
  const contentText = textView('main').text().replace(/\s+/g, ' ').trim();
  if (contentText.length < 60) throw new PermanentFetchError('Could not extract enough readable text');
  const site = new URL(canonicalUrl).hostname.replace(/^www\./, '');
  return {
    ...details,
    site,
    excerpt: contentText.length > 240 ? `${contentText.slice(0, 240).replace(/\s+\S*$/, '')}…` : contentText,
    contentHtml,
    contentText
  };
}

export async function fetchAndExtract(url: string): Promise<ExtractedArticle> {
  const { html, finalUrl } = await fetchPage(url);
  return extractArticle(html, finalUrl);
}
