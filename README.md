# Scraper service for Nopxus

An independent web-scraping service. Nopxus stores tasks, schedules, permissions, history, logs and
results; this service only **executes** runs it is given and reports state, logs and items back
through signed webhooks. It has no database of its own: the only state is Redis (queue, event
stream and short-lived run data).

- Node.js 20, strict TypeScript, pnpm
- Express 5 + Zod (API), BullMQ on Redis (queue), Crawlee (`CheerioCrawler` for `http`,
  `PlaywrightCrawler`/Chromium for `browser`)
- Vitest for tests

Full contract: **[docs/api.md](docs/api.md)**.

## Architecture

```
                    dokploy-network network
   ┌────────┐  REST (Bearer key)  ┌──────────────┐  signed webhooks   ┌────────┐
   │ Nopxus │ ──────────────────▶ │ scraper-api  │ ─────────────────▶ │ Nopxus │
   └────────┘                     └──────┬───────┘                    └────────┘
                                         │ BullMQ jobs ▲ events (Redis Stream)
                       `scraper` network │             │
                                  ┌──────▼─────────────┴──┐
                                  │      scraper-redis    │  (AOF, noeviction)
                                  └──────▲─────────────┬──┘
                                         │             │
                                  ┌──────┴─────────────▼──┐        ┌───────────────┐
                                  │    scraper-worker     │ ─────▶ │ the internet  │
                                  │  http + browser engines│  SSRF-guarded egress  │
                                  └────────────────────────┘        └───────────────┘
```

| Process | Responsibilities | Network |
|---|---|---|
| `scraper-api` | Validates and enqueues runs, answers queries, cancels, **the only process that sends webhooks**. Hosts no crawler and no browser. | `dokploy-network` + `scraper` |
| `scraper-worker` | Consumes the queues, runs the crawlers, stores run state/items in Redis, publishes events. **No route to Nopxus.** Runs previews. | `scraper` only |
| `scraper-redis` | BullMQ queues, run state, items (TTL), the worker → api event stream. | `scraper` only |

Key mechanics:

- **Queues.** One BullMQ queue per engine (`scraper-runs-<engine>`), each with its own concurrency
  (`MAX_CONCURRENT_RUNS` for `http`, `MAX_CONCURRENT_BROWSER_RUNS` for `browser`), plus a preview
  queue. Workers advertise their engines in Redis, so a **new engine** only needs a
  `ScrapingEngine` implementation registered in the worker (`src/engines/types.ts`,
  `src/worker/worker.ts`); the API needs no change.
- **Events.** The worker appends already-serialized webhook bodies (batched: ≤200 items / 512 KB,
  ≤100 log lines / 2 s, progress ≤ 1 per 2 s) to the Redis Stream `scraper:events`. The API
  consumes it with a consumer group and acknowledges an entry only after the webhook was delivered
  (or definitively failed), so events survive an API restart. Per run, webhooks are sent strictly in
  order.
- **State machine.** `queued → running → completed | failed | cancelled`, enforced atomically with a
  Lua script, so a terminal run can never change and exactly one process emits the terminal event.
- **Worker restarts.** Each running run holds a short lease refreshed by its worker. When the lease
  expires (the worker died) any worker's reaper marks the run `failed` / `WORKER_RESTARTED` and
  emits `run.failed`. BullMQ stalled-job retries are disabled (`maxStalledCount: 0`), so runs are
  never resumed.
- **Graceful shutdown (`SIGTERM`).** The worker stops taking jobs, waits up to 30 s for running
  runs, then fails whatever is left (`WORKER_RESTARTED`).

### Security model

All outbound traffic of both engines goes through a **loopback egress proxy** inside the worker
(`src/security/egress-proxy.ts`), which is the single enforcement point of the SSRF policy
(`src/security/ssrf.ts`):

- only `http:`/`https:`, no credentials in the URL;
- the host is resolved **by the proxy**, every returned address is checked (loopback, 10/8,
  172.16/12, 192.168/16, 169.254/16 incl. cloud metadata, CGNAT 100.64/10, multicast, reserved, and
  IPv6 `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped / NAT64 / 6to4 / Teredo forms…), and the socket
  is opened **to that validated IP** (no second lookup ⇒ no DNS rebinding window);
- redirects are followed by the client, so each hop is a new proxied request and is validated again;
- Chromium is launched with this proxy too, so every subresource, XHR and redirect is covered, and
  `page.route` additionally validates each request (and blocks images/media/fonts);
- `localhost`, `*.localhost`, `*.local`, `*.internal`, single-label names (Docker service names) and
  the `BLOCKED_HOSTS` list are rejected;
- API-level fail-fast: start URLs are statically validated when a run is created (`422`).

Other hard requirements: limits (`maxPages`, `maxDepth`, `maxItems`, `maxDurationSec`, response
size 10 MiB, item size 64 KB); a fresh Chromium per run with downloads refused, running as a non-root
user; `secrets` redacted from logs and never sent in webhooks/responses, and only sent to the start
URLs' hosts; `delayMs`, per-domain concurrency (default 2) and an identifiable, configurable
`User-Agent`.

> The loopback allowance used by the integration tests exists only as a constructor option
> (`SsrfGuard({ testAllowIps })`) that **throws unless `NODE_ENV=test`**. There is no environment
> variable that enables it and the production entrypoints never pass it.

## Running locally

Requirements: Node 20+, pnpm (`corepack enable`), a Redis (e.g. `docker run -p 6379:6379 redis:7-alpine`).

```bash
pnpm install
pnpm exec playwright install chromium   # only needed for the browser engine
cp .env.example .env                     # edit the secrets (dev scripts load it via --env-file)

pnpm dev:api      # terminal 1  -> http://localhost:3000
pnpm dev:worker   # terminal 2
```

> For local development the SSRF guard blocks `localhost`/private IPs by design, so you can only
> scrape public sites (or run the test suite, which uses a loopback-only exception).

Smoke test:

```bash
curl -s localhost:3000/health
curl -s -H "Authorization: Bearer $SCRAPER_API_KEY" localhost:3000/v1/config
curl -s -X POST localhost:3000/v1/preview -H "Authorization: Bearer $SCRAPER_API_KEY" \
  -H 'content-type: application/json' -d '{"config":{"version":1,"startUrls":["https://quotes.toscrape.com/"],
  "extraction":{"mode":"list","itemSelector":{"type":"css","value":".quote"},
  "fields":[{"key":"text","selector":{"type":"css","value":".text"},"required":true}]}}}'
```

Production build: `pnpm build && node dist/api/main.js` / `node dist/worker/main.js`.

## Docker

```bash
docker network create dokploy-network   # skip if Nopxus' own stack already created it
cp .env.example .env                     # set SCRAPER_API_KEY, NOPXUS_WEBHOOK_URL, NOPXUS_WEBHOOK_SECRET, limits
docker compose up -d --build
```

- `Dockerfile` has two targets: `api` (light, no browsers) and `worker` (Playwright Chromium + OS
  libs). Both run as the unprivileged `node` user and have healthchecks.
- `docker-compose.yml`: `scraper-redis` (`redis:7-alpine`, `--appendonly yes --maxmemory-policy
  noeviction`, persistent volume), `scraper-api` (networks `dokploy-network` + `scraper`),
  `scraper-worker` (`scraper` only, `shm_size: 1gb`, 2 CPU / 4 GB). **No port is published to the
  host**; Nopxus reaches `http://scraper-api:3000` over `dokploy-network`.
- Run a single `scraper-api` replica (the webhook dispatcher is a single ordered consumer). Workers
  scale horizontally (`docker compose up -d --scale scraper-worker=N`; the per-engine quotas apply
  per worker).
- Redis has no password because it lives on the private `scraper` network, which contains no other
  service.

## Environment variables

Validated at startup; the process exits with a message listing every problem.

| Variable | Req. (api / worker) | Default | Meaning |
|---|---|---|---|
| `PORT` | – | `3000` | API port |
| `SCRAPER_API_KEY` | api | – | Bearer key Nopxus must send (≥ 16 chars) |
| `NOPXUS_WEBHOOK_URL` | api | – | Webhook destination |
| `NOPXUS_WEBHOOK_SECRET` | api | – | HMAC key (≥ 16 chars) |
| `REDIS_URL` | both | – | Redis connection URL |
| `MAX_CONCURRENT_RUNS` | both | – | Concurrent `http` runs per worker |
| `MAX_CONCURRENT_BROWSER_RUNS` | both | – | Concurrent `browser` runs per worker (`0` disables the engine) |
| `MAX_PAGES_PER_RUN` | both | – | Ceiling for `limits.maxPages` |
| `MAX_DEPTH` | both | – | Ceiling for `limits.maxDepth` |
| `MAX_ITEMS_PER_RUN` | both | – | Ceiling for `limits.maxItems` |
| `MAX_RUN_DURATION_SEC` | both | – | Ceiling for `limits.maxDurationSec` |
| `MAX_RESPONSE_BYTES` | – | `10485760` | Max response size |
| `RESULT_TTL_HOURS` | – | `72` | Retention of run state and items after a run ends |
| `USER_AGENT` | – | `NopxusScraper/1.0 (+https://nopxus.com/bot)` | UA sent to sites |
| `BLOCKED_HOSTS` | – | – | Extra blocked hosts (comma separated, `*.x` wildcards) |
| `MAX_CONCURRENCY` | – | `8` | Ceiling for `limits.maxConcurrency` *(extra)* |
| `MAX_CONCURRENCY_PER_DOMAIN` | – | `2` | Parallel requests per domain *(extra)* |
| `MAX_ITEM_BYTES` | – | `65536` | Max size of one item *(extra)* |
| `LEASE_TTL_SEC` | – | `20` | Worker liveness lease; also the restart-detection delay *(extra)* |
| `WEBHOOK_RETRY_BASE_MS` | – | `1000` | Webhook backoff base *(extra)* |
| `LOG_LEVEL` | – | `info` | pino level *(extra)* |

## Tests

Integration tests need a real Redis (the default is `redis://127.0.0.1:6390`; each test stack uses
its own logical DB 1–15 and flushes it). Chromium is needed for the browser tests.

```bash
docker run -d --name scraper-test-redis -p 6390:6379 redis:7-alpine
pnpm exec playwright install chromium

pnpm test                 # everything (unit + integration)
pnpm test:unit            # no Redis needed
pnpm test:integration
pnpm typecheck
# another Redis:  TEST_REDIS_BASE=redis://host:6379 pnpm test
```

What is covered:

- **Unit** — config validation (`version`, defaults, bad shapes), env validation, SSRF guard (every
  blocked IPv4/IPv6 range, obfuscated literals, host rules, DNS resolving to private IPs, mixed
  answers, no caching), HMAC signature, CSS and XPath extraction, transforms, `dedupeKey`, redaction.
- **Integration** (local fixture site + fake webhook receiver + real Redis, API and worker in
  process) — full paginated run, idempotent `POST /v1/runs`, `afterSeq` recovery, cancellation
  (running < 5 s and queued), limits (`maxPages`, `maxItems`, `maxDepth`, `maxDurationSec`→`TIMEOUT`,
  oversize responses/items, clamping), retries and failing pages, webhook retries on `5xx` / no retry
  on `4xx` / ordering / definitive failure not affecting the run / redelivery after an API restart,
  worker crash → `WORKER_RESTARTED` (never resumed), graceful shutdown, concurrent runs without
  mixing items or `context`, per-domain concurrency and `delayMs`, redirect-to-private-IP and
  DNS-pinning through the egress proxy, secret leakage, browser engine (JS rendering, downloads,
  redirects, cancel), preview.

## Layout

```
src/
  config/env.ts            env validation + global limits
  contract/                Zod schemas, types, config validation
  security/                ssrf guard, egress proxy, hmac, redaction
  extraction/extract.ts    CSS/XPath extraction, transforms, dedupeKey
  engines/                 ScrapingEngine interface, registry, http + browser engines, shared crawl logic
  store/run-store.ts       Redis state, items, state machine, event stream
  worker/                  executor (run lifecycle), recorder (batching), worker bootstrap
  api/                     Express app, webhook dispatcher, bootstrap
tests/{unit,integration,helpers}
docs/api.md
```
