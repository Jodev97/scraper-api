import { PlaywrightCrawler } from 'crawlee';
import { chromium } from 'playwright';
import { errMessage } from '../util/misc.js';
import { CrawlCore, SkipRequestError, type PageMeta } from './core.js';
import { driveCrawler, openRunStorage } from './crawl-common.js';
import type { EngineContext, EngineOutcome, ScrapingEngine } from './types.js';

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

const toPlaywrightSelector = (s: string): string =>
  s.startsWith('/') || s.startsWith('(') || s.startsWith('./') ? `xpath=${s}` : s;

/**
 * Chromium via Playwright. One browser (and therefore a fresh, isolated
 * profile) per run; downloads disabled; all traffic goes through the SSRF
 * egress proxy, and every request is additionally validated in `page.route`.
 */
export class BrowserEngine implements ScrapingEngine {
  readonly name = 'browser';
  readonly description = 'Chromium (Playwright) rendering, for JavaScript-heavy pages';

  async run(ctx: EngineContext): Promise<EngineOutcome> {
    const { config, sink, signal } = ctx;
    const core = new CrawlCore(ctx);
    const { config: crawlee, queue } = await openRunStorage();
    const releases = new Map<string, () => void>();
    const release = (key: string) => {
      releases.get(key)?.();
      releases.delete(key);
    };
    let startUrlsProcessed = 0;
    const timeoutMs = config.execution.requestTimeoutSec * 1000;

    const crawler: PlaywrightCrawler = new PlaywrightCrawler(
      {
        requestQueue: queue,
        launchContext: {
          launcher: chromium,
          userAgent: ctx.userAgent,
          launchOptions: {
            headless: true,
            // Loopback is proxied too (default Chromium bypasses it).
            proxy: { server: ctx.proxyUrl, bypass: '<-loopback>' },
            args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--mute-audio'],
          },
        },
        browserPoolOptions: { useFingerprints: false, retireBrowserAfterPageCount: 1_000_000 },
        headless: true,
        useSessionPool: false,
        persistCookiesPerSession: false,
        retryOnBlocked: false,
        maxRequestRetries: config.execution.maxRetries,
        maxConcurrency: ctx.limits.maxConcurrency,
        navigationTimeoutSecs: config.execution.requestTimeoutSec,
        requestHandlerTimeoutSecs: config.execution.requestTimeoutSec * 2 + 30,

        preNavigationHooks: [
          async ({ page, request }, gotoOptions) => {
            const key = request.uniqueKey;
            if (signal.aborted) {
              request.noRetry = true;
              throw new SkipRequestError('run aborted', false);
            }
            if ((request.retryCount ?? 0) === 0 && !core.claimPage()) {
              request.noRetry = true;
              crawler.stop('maxPages');
              throw new SkipRequestError('maxPages reached', false);
            }
            try {
              await ctx.guard.assertUrl(request.url);
            } catch (e) {
              request.noRetry = true;
              throw new SkipRequestError(errMessage(e), true);
            }
            releases.set(key, await core.gate.acquire(new URL(request.url).hostname, signal));

            // Downloads are never accepted.
            page.on('download', (d) => void d.cancel().catch(() => undefined));
            page.on('dialog', (d) => void d.dismiss().catch(() => undefined));

            const secretCookies = ctx.secrets?.cookies ?? [];
            if (secretCookies.length) {
              await page.context().addCookies(
                secretCookies.map((c) => ({
                  name: c.name,
                  value: c.value,
                  domain: c.domain,
                  path: c.path ?? '/',
                })),
              );
            }

            // Every request the page makes (document, XHR, subresources,
            // redirects) is validated here and again by the egress proxy.
            await page.route('**/*', async (route) => {
              const req = route.request();
              const url = req.url();
              if (url.startsWith('about:') || url.startsWith('data:') || url.startsWith('blob:')) {
                await route.continue();
                return;
              }
              if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) {
                await route.abort('blockedbyclient');
                return;
              }
              try {
                await ctx.guard.assertUrl(url);
              } catch (e) {
                sink.log('warn', `Blocked request: ${errMessage(e)}`, url);
                await route.abort('blockedbyclient');
                return;
              }
              const extra = core.headersFor(url);
              await route.continue({ headers: { ...req.headers(), ...extra, 'user-agent': ctx.userAgent } });
            });

            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = timeoutMs;
          },
        ],

        requestHandler: async ({ page, request, response }) => {
          const key = request.uniqueKey;
          try {
            const status = response?.status() ?? 0;
            if (status >= 400) {
              if (status < 500 && status !== 408 && status !== 429) request.noRetry = true;
              throw new Error(`HTTP ${status}`);
            }
            const declared = Number(response?.headers()['content-length']);
            if (Number.isFinite(declared) && declared > ctx.maxResponseBytes) {
              request.noRetry = true;
              throw new Error(`Response exceeds the maximum size of ${ctx.maxResponseBytes} bytes`);
            }
            const wait = config.execution.waitForSelector;
            if (wait) {
              await page.waitForSelector(toPlaywrightSelector(wait), { timeout: timeoutMs, state: 'attached' });
            } else {
              await page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => undefined);
            }
            const html = await page.content();
            const size = core.recordBytes(html);
            if (size > ctx.maxResponseBytes) {
              request.noRetry = true;
              throw new Error(`Response exceeds the maximum size of ${ctx.maxResponseBytes} bytes`);
            }
            const meta = request.userData as unknown as PageMeta;
            const finalUrl = page.url();
            const next = core.handlePage(html, finalUrl, meta);
            sink.pageProcessed(finalUrl, meta.kind === 'start');
            if (meta.kind === 'start') startUrlsProcessed++;
            if (next.length && !sink.itemLimitReached) {
              const res = await crawler.addRequests(next.map((n) => ({ url: n.url, userData: n.userData })));
              const added = res.addedRequests.filter((r) => !r.wasAlreadyPresent).length;
              if (added) sink.urlsEnqueued(added);
            }
            if (sink.itemLimitReached) crawler.stop('maxItems');
          } finally {
            release(key);
          }
        },

        errorHandler: async ({ request }, error) => {
          release(request.uniqueKey);
          if (error instanceof SkipRequestError) return;
          sink.log(
            'warn',
            `Attempt ${(request.retryCount ?? 0) + 1} failed: ${ctx.redactor.redact(errMessage(error))}`,
            request.url,
          );
        },

        failedRequestHandler: async ({ request }, error) => {
          release(request.uniqueKey);
          if (error instanceof SkipRequestError && !error.counts) return;
          sink.pageFailed(
            request.url,
            ctx.redactor.redact(errMessage(error)),
            (request.userData as unknown as PageMeta).kind === 'start',
          );
        },
      },
      crawlee,
    );

    const initial = core.startRequests();
    sink.urlsEnqueued(initial.length);
    await driveCrawler(
      crawler,
      initial.map((r) => ({ url: r.url, userData: r.userData })),
      signal,
      async () => {
        for (const r of releases.values()) r();
        // After an abort in-flight requests may still touch the queue; the
        // per-run in-memory storage is simply garbage collected instead.
        if (!signal.aborted) await queue.drop();
      },
    );
    return { startUrlsProcessed };
  }
}
