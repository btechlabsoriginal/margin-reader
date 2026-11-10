# Margin

**A quiet home for everything worth reading.**

Margin is a small self-hosted read-later library. Paste an article URL, and the worker fetches it, removes visual clutter, stores its readable text, and makes it searchable without needing the original site again. The browser client is designed around the reading experience rather than a dashboard.

## Features

- Extraction from real HTML, not just `og:description`: prose-cluster scoring, link-density penalties, semantic article weighting, and removal of navigation, ads, scripts, and interface furniture.
- Title, byline, and publication date from Open Graph, HTML metadata, semantic time elements, and JSON-LD Article / BlogPosting objects.
- Local SQLite storage in WAL mode with FTS5, weighted BM25 ranking, prefix queries, searchable titles/bylines/text, excerpt snippets, and exact UTF-16 highlight ranges for snippets and titles.
- Inbox, archive, tags, URL deduplication, responsive reader layout, adjustable type size, serif/sans fonts, and paper/white/night reading themes.
- Persistent fetch queue with concurrent workers, exponential retry for transient errors (10s, 30s, 90s), immediate failure for permanently unreadable pages, failure state, and recovery of expired leases after restarts.
- Password-protected REST API with HTTP-only SameSite cookies, limited login attempts, and a custom request header required for mutation.
- Network protection for server-side fetching: HTTP(S) only, DNS resolution checks, private IP blocking, pinned destination addresses, redirect validation, fetch timeouts, and response size limits.

## Requirements

Node.js 22 or newer. You also need a compiler toolchain if `better-sqlite3` cannot use a prebuilt binary on your machine.

## Screenshots

<img width="1440" height="900" alt="Screenshot 2026-11-10 at 20 53 29" src="https://github.com/user-attachments/assets/65f0095a-d865-45e9-8484-dbc0cdaba32f" />
<img width="1440" height="900" alt="Screenshot 2026-11-10 at 20 53 35" src="https://github.com/user-attachments/assets/a02bd7bb-1d66-4ea6-ba3b-000db8201e3d" />


## Local setup

```bash
npm install
cp .env.example .env
npm run dev
```

Set `APP_PASSWORD` in `.env` to a unique password of at least 12 characters. The frontend development server runs at **http://127.0.0.1:5173** and proxies API calls to Fastify at **http://127.0.0.1:3000**.

To make one production process serve both the API and the compiled React frontend:

```bash
npm run build
NODE_ENV=production npm start
```

Visit **http://127.0.0.1:3000**. The app refuses to launch in production without `APP_PASSWORD` set to at least 12 characters.

## Docker

```bash
docker build -t margin-reader .
docker volume create margin_data
docker run -d --name margin -p 127.0.0.1:3000:3000 \
  -v margin_data:/data \
  -e APP_PASSWORD='replace-with-a-strong-unique-password' \
  margin-reader
```

Binding to `127.0.0.1` keeps the example private to the host. For access from another device, place it behind HTTPS at your reverse proxy. Do not expose plain HTTP publicly; the login cookie is only marked `Secure` when the incoming request is HTTPS. The database and WAL files live in `/data` and must be backed up together or via the SQLite backup API. When running behind a trusted reverse proxy that terminates HTTPS, set `TRUST_PROXY=1` so secure session cookies and client IP addresses reflect the proxy's forwarded headers. Do not enable that setting when clients can reach Fastify directly.

## Deploy to Fly.io

1. Install and authenticate the Fly CLI.
2. Change the `app` value in `fly.toml` to your app's unique name, and choose a preferred `primary_region`.
3. Create the Fly app and volume in that same region.
4. Store the password as a secret and deploy.

```bash
fly apps create your-unique-margin-app
fly volumes create margin_data --size 1 --region lhr -a your-unique-margin-app
fly secrets set APP_PASSWORD='replace-with-a-strong-unique-password' -a your-unique-margin-app
fly deploy -a your-unique-margin-app
```

Keep **one running machine** against this volume: SQLite is local disk storage and Fly volumes are not a distributed database. A single process runs both HTTP and the fetch worker. The configuration disables automatic scale-to-zero to ensure queued work keeps progressing.

## API

All endpoints except `POST /api/session` and `GET /api/health` require a valid login cookie when `APP_PASSWORD` is set. Write requests also need the `X-Margin-Request: 1` header, including login. The React client handles both automatically.

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness |
| `POST` | `/api/session` | Sign in with `{ "password": "…" }` |
| `GET` | `/api/session` | Check sign-in |
| `DELETE` | `/api/session` | Sign out |
| `POST` | `/api/articles` | Save `{ "url": "…", "tags": ["ideas"] }` |
| `GET` | `/api/articles` | List with `archived`, `tag`, `status`, `limit`, `offset` |
| `GET` | `/api/articles/:id` | Read content and metadata |
| `GET` | `/api/search?q=…` | FTS5 BM25 results with snippets and offsets |
| `PATCH` | `/api/articles/:id` | Set `{ "archived": true }` and/or `{ "tags": [...] }` |
| `POST` | `/api/articles/:id/tags` | Add `{ "tag": "ideas" }` |
| `DELETE` | `/api/articles/:id/tags/:tag` | Remove a tag |
| `POST` | `/api/articles/:id/retry` | Retry a failed or old save |
| `DELETE` | `/api/articles/:id` | Permanently delete |
| `GET` | `/api/tags` | Tag list and usage counts |

`POST /api/articles` returns **201** for a new URL and **200** plus `duplicate: true` for an existing URL. It strips common tracking parameters and fragments during normalization. Extraction is asynchronous: a fresh article initially appears in `pending` or `processing`, then becomes `ready` or `failed`.

### Search result example

```json
{
  "total": 1,
  "items": [
    {
      "id": 12,
      "title": "Reading and remembering",
      "snippet": "…the art of reading slowly and remembering ideas…",
      "snippetOffsets": [[11, 18]],
      "titleOffsets": [[0, 7]],
      "score": -0.92
    }
  ]
}
```

This is an illustrative partial response, not a fixed score or offset contract for that text. Real responses also include URL, tags, metadata, and save timestamps. Highlight offsets are `[start, end]` character-index pairs relative to the corresponding returned snippet/title, in JavaScript UTF-16 indices. Lower BM25 scores are more relevant; title and author matches receive larger weights. Search terms are treated as literal prefix terms joined by AND rather than raw FTS query syntax.

## Development

```bash
npm run check
npm test
npm run build
```

The tests cover extraction and content sanitization, BM25 and FTS lifecycle, highlight offsets, URL normalization / network filtering, and REST route behaviors including authentication and dedupe.

## How it works

```text
React reader → Fastify routes → SQLite (articles, tags, fetch_jobs)
                        ↘ FTS5 external-content index

POST /api/articles → normalize/dedupe → pending job
                                     → worker claims lease
                                     → pinned DNS + bounded download
                                     → extract, sanitize, store
                                     → FTS5 triggers update index
```

`src/fetch.ts` does the downloading and readability-style extraction. `src/index.ts` owns search queries and highlight spans. `src/db.ts` defines the schema and FTS5 triggers. `src/queue.ts` handles durable retries. `src/auth.ts` owns session cookies. `src/routes.ts` is the API. `src/server.ts` wires the process together.

## Known limits

Margin only extracts content present in the fetched HTML. It does not execute JavaScript, bypass paywalls, or recover content behind sign-in walls. Non-English pages may need additional charset support because the current downloader decodes as UTF-8. The extractor is heuristic, so complex multi-column layouts may need site-specific improvements. Remote images are deliberately excluded to avoid tracking requests and keep the reading surface calm. Some private-network URLs cannot be saved by design.

The app is intended for private personal libraries. Respect publishers' rights and site terms when saving material, and avoid redistributing copyrighted articles. SQLite backups should be encrypted if they contain personal reading history.
