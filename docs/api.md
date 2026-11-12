# Scraper service — API and webhook contract

Version of this document: service `1.0.0`, config schema `version: 1`, webhook `version: 1`.

Everything below is exchanged as JSON (`Content-Type: application/json`).

- [Conventions](#conventions)
- [Endpoints](#endpoints)
- [Run `config` (v1)](#run-config-v1)
- [Run states and views](#run-states-and-views)
- [Webhooks](#webhooks)
- [Verifying the signature](#verifying-the-signature)
- [Recovering after a missed webhook](#recovering-after-a-missed-webhook)
- [Interpretation notes](#interpretation-notes)

---

## Conventions

**Authentication.** Every route except `GET /health` requires
`Authorization: Bearer <SCRAPER_API_KEY>` (compared in constant time).

**Errors.** Always this shape, with an HTTP status that matches:

```json
{ "success": false, "code": "VALIDATION_ERROR", "message": "config.extraction.fields: ..." }
```

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body / query does not match the schema (also oversize `context`) |
| 400 | `INVALID_JSON` | Body is not valid JSON |
| 401 | `UNAUTHORIZED` | Missing or wrong API key |
| 404 | `RUN_NOT_FOUND` / `NOT_FOUND` | Unknown run / route |
| 413 | `PAYLOAD_TOO_LARGE` | Body larger than 2 MB |
| 422 | `UNSUPPORTED_CONFIG_VERSION` | `config.version` is not `1` |
| 422 | `UNKNOWN_ENGINE` | `config.engine` not offered (see `GET /v1/config`) |
| 422 | `INVALID_SELECTOR` | A CSS or XPath selector does not parse |
| 422 | `URL_NOT_ALLOWED` | A start URL is statically forbidden (scheme, credentials, blocked host, private IP literal) |
| 422 | `PREVIEW_FAILED` | The preview page could not be fetched/processed |
| 503 | `QUEUE_UNAVAILABLE` | The run could not be enqueued; nothing was created, retry the same request |
| 504 | `PREVIEW_TIMEOUT` | The preview did not finish in time |
| 500 | `INTERNAL_ERROR` | Unexpected failure |

---

## Endpoints

### `GET /health` (no auth)

`200 {"status":"ok"}` when the process is up and Redis answers `PING`; otherwise `503 {"status":"unavailable"}`.

### `GET /v1/config`

```json
{
  "version": "1.0.0",
  "configVersions": [1],
  "engines": [
    { "name": "http", "available": true, "description": "...", "concurrency": 4 },
    { "name": "browser", "available": true, "description": "...", "concurrency": 2 }
  ],
  "limits": {
    "maxPages": 500, "maxDepth": 3, "maxItems": 10000, "maxDurationSec": 900,
    "maxConcurrency": 8, "maxResponseBytes": 10485760, "maxItemBytes": 65536,
    "maxConcurrentRuns": 4, "maxConcurrentBrowserRuns": 2, "resultTtlHours": 72
  },
  "queue": { "waiting": 0, "active": 1 }
}
```

`engines` lists what the workers have registered (new engines appear here without any API change).

### `POST /v1/runs`

Request:

```json
{
  "idempotencyKey": "unique per run",
  "context": { "any": "opaque object, max 4 KB serialized" },
  "config": { "...": "see Run config" },
  "secrets": {
    "headers": { "Authorization": "Bearer ..." },
    "cookies": [{ "name": "sid", "value": "...", "domain": "example.com" }]
  },
  "limits": { "maxPages": 100, "maxDepth": 2, "maxItems": 10000, "maxDurationSec": 900, "maxConcurrency": 4 }
}
```

Response `202`:

```json
{ "runId": "5b0c...", "status": "queued" }
```

- **Idempotency.** Repeating an `idempotencyKey` returns the run already created
  (`202` with the same `runId` and its *current* `status`) and enqueues nothing. Keys are kept for
  `max(72 h, RESULT_TTL_HOURS)`. The rest of the body of a repeated request is ignored.
- **Limits.** Any `limits` value above the global ceilings is clamped, and the clamp is written to
  the run log (`warn`). Omitted limits default to the ceilings.
- **Secrets.** Optional. Never logged, never returned, never included in webhooks (values are
  redacted from log lines and error messages). They are sent only to the hosts of the
  `startUrls`, never to other domains reached by following links. They live in Redis only inside
  the job payload, which is deleted when the run finishes.
- **Cookies** `domain` matches the host and its subdomains.

### `GET /v1/runs?ids=a,b,c`

Up to 100 ids. Unknown ids are omitted.

```json
{ "runs": [ { "runId": "a", "status": "running", "...": "see Run view" } ] }
```

### `GET /v1/runs/:id`

The [run view](#run-view) (top-level object). `404 RUN_NOT_FOUND` if it does not exist (or expired).

### `GET /v1/runs/:id/items?afterSeq=N&limit=M`

Items with `seq > N`, ascending. `afterSeq` defaults to `0`, `limit` to `200` (max `1000`).

```json
{
  "runId": "a",
  "status": "running",
  "afterSeq": 0,
  "items": [
    { "seq": 1, "sourceUrl": "https://...", "data": { "titulo": "..." }, "dedupeKey": "9f86d0..." }
  ],
  "nextSeq": 1,
  "hasMore": false
}
```

Poll with `afterSeq = nextSeq` until `hasMore` is `false` and the run is terminal.

### `POST /v1/runs/:id/cancel`

Idempotent. Returns `200` with the run view.

- `queued` → becomes `cancelled` immediately (and never starts); `run.cancelled` is emitted.
- `running` → the worker is signalled; the crawler stops within 5 s and the browser is closed. The
  view returned may still say `running`; the terminal state arrives in the `run.cancelled` webhook
  / the next `GET`.
- terminal → the current view, unchanged.

### `POST /v1/preview`

Runs the extraction on **one page** (no pagination, no link following) and answers synchronously
(up to ~55 s). It executes in the worker, never in the API process.

```json
{ "config": { "...": "same as a run" }, "secrets": { }, "url": "optional, default config.startUrls[0]", "maxItems": 50 }
```

Response `200`:

```json
{
  "url": "https://...",
  "itemsFound": 12,
  "items": [ { "sourceUrl": "https://...", "data": { }, "dedupeKey": "..." } ],
  "logs": [ { "level": "info", "message": "..." } ]
}
```

`items` is capped by `maxItems` (default 50, max 200); `itemsFound` counts all matches. Items in a
preview have no `seq`.

---

## Run config (v1)

```json
{
  "version": 1,
  "engine": "http",
  "startUrls": ["https://example.com/products"],
  "queryParams": { "sort": "price" },
  "headers": { "Accept-Language": "en" },
  "extraction": {
    "mode": "list",
    "itemSelector": { "type": "css", "value": ".product" },
    "fields": [
      { "key": "title", "selector": { "type": "css", "value": "h2" }, "attr": "text", "required": true },
      { "key": "price", "selector": { "type": "xpath", "value": ".//span[@class='price']" }, "attr": "text", "transform": "number" },
      { "key": "url", "selector": { "type": "css", "value": "a" }, "attr": "href", "transform": "absoluteUrl" }
    ]
  },
  "navigation": {
    "pagination": { "type": "nextLink", "selector": { "type": "css", "value": "a.next" } },
    "followLinks": { "selector": { "type": "css", "value": "a.detail" }, "sameDomainOnly": true }
  },
  "execution": { "requestTimeoutSec": 30, "maxRetries": 2, "delayMs": 500, "waitForSelector": null },
  "dedupeKeyFields": ["url"]
}
```

| Field | Notes |
|---|---|
| `version` | Must be `1`; anything else → `422 UNSUPPORTED_CONFIG_VERSION`. |
| `engine` | `http` (default, CheerioCrawler) or `browser` (Chromium via Playwright). |
| `startUrls` | 1–100 absolute `http(s)` URLs, no credentials. |
| `queryParams` | Added to every start URL (a param already in the URL wins) and to `urlPattern` URLs. |
| `headers` | Sent with every request (`Accept-Language`, …). Not secret; use `secrets.headers` for tokens. |
| `selector` | `{ "type": "css" \| "xpath", "value": "..." }`. Both work in both engines. |
| `extraction.mode` | `list`: one item per node matched by `itemSelector`; field selectors are evaluated **relative to that node**. `single`: one item per page; selectors are evaluated against the whole document. |
| `fields[].attr` | `text` (default; whitespace collapsed), `html` (inner HTML) or any attribute name (`href`, `src`, `datetime`, …). XPath expressions that return attributes/text nodes/strings (`./a/@href`, `string(./h2)`) are used as-is. |
| `fields[].transform` | `trim` (default; empty → `null`), `number` (tolerant of currency and `1.234,56` / `1,234.56`; non-numeric → `null`), `absoluteUrl` (resolved against the page URL), `date` (→ ISO-8601 UTC; accepts ISO/RFC dates and day-first `dd/mm/yyyy`). |
| `fields[].required` | Items missing a required value (after the transform) are dropped. Items with **no** value at all are dropped too. |
| `pagination.type` | `none` (default); `nextLink` (follow the first link matched by `selector`); `urlPattern` (`template` with a `{page}` placeholder, `from`, `to`, `step` default 1: those URLs are fetched in addition to `startUrls`). |
| `followLinks` | Links matched by `selector` are crawled one level deeper (`depth + 1`, bounded by `limits.maxDepth`). `sameDomainOnly` (default `true`) compares hosts ignoring `www.`. Extraction runs on every crawled page. |
| `execution` | `requestTimeoutSec` 1–300 (30), `maxRetries` 0–10 (2), `delayMs` 0–60000 (500), `waitForSelector` (browser only; CSS, or an XPath starting with `/`, `./` or `(`). |
| `dedupeKeyFields` | Keys of `data` used for `dedupeKey`. |

### Items

```json
{ "seq": 7, "sourceUrl": "https://example.com/products?page=2", "data": { "title": "..." }, "dedupeKey": "<sha256 hex>" }
```

- `seq` increases by 1 per stored item, starting at 1, per run.
- `sourceUrl` is the final URL of the page (after redirects).
- `dedupeKey` = SHA-256 (hex) of `JSON.stringify(dedupeKeyFields.map(k => data[k] ?? null))`; with no
  `dedupeKeyFields`, of the canonical JSON (keys sorted) of the whole `data`.
- Items whose serialized `data` exceeds 64 KB are skipped (warning in the log).

### Limits and what happens when they are hit

| Limit | Effect |
|---|---|
| `maxPages` | Stops fetching new pages. Run ends **`completed`** with a `warn` log. |
| `maxDepth` | Links deeper than this are not followed. `completed` + `warn`. |
| `maxItems` | Stops after exactly that many items. `completed` + `warn`. |
| `maxDurationSec` | Run ends **`failed`** with `error.code = "TIMEOUT"`. Items already extracted are kept. |
| response size (`MAX_RESPONSE_BYTES`, 10 MiB) | That page fails (counts in `pagesFailed`). |
| item size (64 KB) | That item is skipped. |

A page that fails after `maxRetries` is counted in `pagesFailed` and the run continues. A run is
`failed` only if **no start URL could be processed** (`START_URLS_FAILED`), on timeout (`TIMEOUT`), on
an internal error (`INTERNAL_ERROR`) or when the worker restarted (`WORKER_RESTARTED`).

---

## Run states and views

`queued → running → completed | failed | cancelled`. Transitions are monotonic: a terminal run never
changes (enforced atomically in Redis).

### Run view

```json
{
  "runId": "5b0c...",
  "status": "completed",
  "context": { "orgId": "..." },
  "pagesProcessed": 4,
  "pagesFailed": 0,
  "itemsExtracted": 12,
  "lastSeq": 12,
  "startedAt": "2026-11-11T16:00:00.000Z",
  "finishedAt": "2026-11-11T16:00:03.100Z",
  "error": null,
  "stats": { "durationMs": 3100, "bytesDownloaded": 20480, "peakMemoryBytes": 183500800 }
}
```

`error` is `{ "code": "TIMEOUT", "message": "..." }` for failed runs. `context` is returned exactly as
received. `stats.peakMemoryBytes` is the RSS of the worker process (shared by concurrent runs).
`pagesProcessed`/`itemsExtracted`/`lastSeq` of a running run are refreshed about every 2 s.

Run data (state and items) is deleted `RESULT_TTL_HOURS` (default 72) after the run ends.

---

## Webhooks

`POST` to `NOPXUS_WEBHOOK_URL` with headers

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-Timestamp` | Unix epoch seconds (string), regenerated on every attempt |
| `X-Signature` | hex HMAC-SHA256 of `` `${X-Timestamp}.${raw body}` `` keyed with `NOPXUS_WEBHOOK_SECRET` |

Body:

```json
{
  "version": 1,
  "deliveryId": "0b3e6f3e-....",
  "runId": "5b0c...",
  "event": "run.items",
  "context": { "orgId": "..." },
  "timestamp": "2026-11-11T16:00:01.000Z",
  "data": { }
}
```

`context` is the opaque object given at creation. `deliveryId` is a UUID that is **the same for every
retry** of the same webhook (use it to deduplicate). The body bytes are identical across retries
(only `X-Timestamp`/`X-Signature` change).

| `event` | `data` |
|---|---|
| `run.started` | `{ "startedAt": "ISO" }` |
| `run.progress` | `{ "pagesProcessed", "pagesFailed", "itemsExtracted", "queuedUrls" }` — at most one per 2 s per run |
| `run.log` | `{ "entries": [ { "seq", "level": "debug\|info\|warn\|error", "message", "url?", "at" } ] }` — up to 100 entries or 2 s |
| `run.items` | `{ "fromSeq", "toSeq", "items": [ ...items ] }` — up to 200 items or 512 KB, or 2 s |
| `run.completed` / `run.failed` / `run.cancelled` | the final [run view](#run-view) — always sent **after** the last `run.items` / `run.log` |

Delivery rules:

- `2xx` = delivered. `5xx`, a timeout (10 s) or a network error → retried with exponential backoff
  (1 s, 2 s, 4 s … capped at 5 min) up to **8 retries** (9 attempts). `4xx` (and `3xx`) → **not**
  retried; the failure is logged by the service.
- Webhooks of one run are delivered **in order**, one at a time; a webhook that is being retried
  holds back the later ones of the same run (other runs are not affected). After a definitive
  failure the next webhook of that run is sent.
- Events survive a restart of `scraper-api` (they are stored in a Redis stream and acknowledged
  only after delivery); after a restart some may be delivered again (same `deliveryId`).
- A delivery that fails definitively **does not affect the run**.

---

## Verifying the signature

Verify against the **raw** request body (before any JSON parsing/re-serialization), compare in
constant time, and reject stale timestamps.

### Node.js / TypeScript (Next.js route handler)

```ts
import crypto from 'node:crypto';

export async function POST(req: Request) {
  const raw = await req.text(); // raw bytes as a string — do NOT use req.json()
  const timestamp = req.headers.get('x-timestamp') ?? '';
  const signature = req.headers.get('x-signature') ?? '';

  const expected = crypto
    .createHmac('sha256', process.env.NOPXUS_WEBHOOK_SECRET!)
    .update(`${timestamp}.${raw}`)
    .digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300; // 5 min
  if (!ok || !fresh) return new Response('invalid signature', { status: 401 });

  const event = JSON.parse(raw);
  // De-duplicate on event.deliveryId, then process by event.event.
  return new Response(null, { status: 204 });
}
```

### Python

```python
import hmac, hashlib, time

def verify(secret: str, timestamp: str, raw_body: bytes, signature: str) -> bool:
    expected = hmac.new(secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature) and abs(time.time() - int(timestamp)) < 300
```

### curl (to produce a valid request while testing the receiver)

```bash
BODY='{"version":1,"deliveryId":"x","runId":"r","event":"run.started","context":{},"timestamp":"2026-01-01T00:00:00Z","data":{}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$NOPXUS_WEBHOOK_SECRET" -hex | sed 's/^.* //')
curl -X POST "$URL" -H "content-type: application/json" -H "x-timestamp: $TS" -H "x-signature: $SIG" -d "$BODY"
```

---

## Recovering after a missed webhook

Webhooks are best-effort acceleration; the HTTP API is the source of recovery:

1. `GET /v1/runs?ids=...` to learn each run's status and `lastSeq`.
2. `GET /v1/runs/:id/items?afterSeq=<last seq you stored>` until `hasMore` is `false`.

Item `seq` values are contiguous, so a gap in the `fromSeq`/`toSeq` ranges you received tells you
exactly what to fetch. Data is available for `RESULT_TTL_HOURS` after the run ends (default 72 h).
Logs are only delivered through webhooks.

---

## Interpretation notes

These points were not fixed by the original specification; the service implements the following
(please confirm they match Nopxus):

1. **Response envelopes.** Success bodies are not wrapped in `{ "success": true }`: `POST /v1/runs`
   → `{ runId, status }`; `GET /v1/runs/:id` → the view; `GET /v1/runs` → `{ runs }`; items →
   `{ runId, status, afterSeq, items, nextSeq, hasMore }` (items are returned individually, not
   grouped in batches).
2. **`urlPattern`.** `template` uses the placeholder `{page}`; `from`/`to` are inclusive.
3. **`followLinks` + extraction.** Extraction applies to every page crawled (start, pagination and
   followed pages); pages that yield no values produce no items.
4. **Preview request/response** shapes (see above).
5. **Status codes.** Malformed bodies are `400`; unknown `config.version`, unknown engines, bad
   selectors and forbidden start URLs are `422`.
6. **Quotas.** `MAX_CONCURRENT_RUNS` is the quota of `http` runs and `MAX_CONCURRENT_BROWSER_RUNS`
   a separate quota for `browser` runs (they do not borrow from each other). Quotas are per worker
   process.
