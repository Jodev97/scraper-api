import { describe, expect, it } from 'vitest';
import { loadEnv, globalLimits, EnvError } from '../../src/config/env.js';
import { ApiError } from '../../src/contract/schemas.js';
import { parseScrapeConfig, resolveLimits, applyQueryParams } from '../../src/contract/validate.js';
import { SsrfGuard } from '../../src/security/ssrf.js';
import { Redactor } from '../../src/security/redact.js';
import { safeEqual, signWebhook, verifyWebhookSignature } from '../../src/security/crypto.js';
import crypto from 'node:crypto';

const guard = new SsrfGuard({ resolver: async () => [{ address: '93.184.216.34', family: 4 }] });
const engines = ['http', 'browser'];

const validConfig = () => ({
  version: 1,
  engine: 'http',
  startUrls: ['https://ejemplo.com/productos'],
  queryParams: { orden: 'precio' },
  headers: { 'Accept-Language': 'es' },
  extraction: {
    mode: 'list',
    itemSelector: { type: 'css', value: '.producto' },
    fields: [
      { key: 'titulo', selector: { type: 'css', value: 'h2' }, attr: 'text', required: true },
      { key: 'precio', selector: { type: 'xpath', value: ".//span[@class='precio']" }, attr: 'text', transform: 'number' },
      { key: 'url', selector: { type: 'css', value: 'a' }, attr: 'href', transform: 'absoluteUrl' },
    ],
  },
  navigation: {
    pagination: { type: 'nextLink', selector: { type: 'css', value: 'a.siguiente' } },
    followLinks: { selector: { type: 'css', value: 'a.detalle' }, sameDomainOnly: true },
  },
  execution: { requestTimeoutSec: 30, maxRetries: 2, delayMs: 500, waitForSelector: null },
  dedupeKeyFields: ['url'],
});

function expectApiError(fn: () => unknown, status: number, code?: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(status);
    if (code) expect((e as ApiError).code).toBe(code);
    return;
  }
  throw new Error('expected ApiError');
}

describe('config validation', () => {
  it('accepts the example config from the spec and applies defaults', () => {
    const c = parseScrapeConfig(validConfig(), { engines, guard });
    expect(c.engine).toBe('http');
    const min = parseScrapeConfig(
      {
        version: 1,
        startUrls: ['https://ejemplo.com/'],
        extraction: { mode: 'single', fields: [{ key: 'a', selector: { type: 'css', value: 'h1' } }] },
      },
      { engines, guard },
    );
    expect(min.engine).toBe('http');
    expect(min.extraction.fields[0]).toMatchObject({ attr: 'text', transform: 'trim', required: false });
    expect(min.execution).toEqual({ requestTimeoutSec: 30, maxRetries: 2, delayMs: 500, waitForSelector: null });
    expect(min.navigation.pagination).toEqual({ type: 'none' });
  });

  it('rejects unknown versions with 422', () => {
    for (const version of [2, 0, '1', undefined, null]) {
      expectApiError(() => parseScrapeConfig({ ...validConfig(), version }, { engines, guard }), 422, 'UNSUPPORTED_CONFIG_VERSION');
    }
  });

  it('rejects malformed configs with 400', () => {
    const bad = (mut: (c: any) => void) => {
      const c = validConfig();
      mut(c);
      expectApiError(() => parseScrapeConfig(c, { engines, guard }), 400, 'VALIDATION_ERROR');
    };
    bad((c) => (c.startUrls = []));
    bad((c) => delete c.extraction);
    bad((c) => delete c.extraction.itemSelector); // list needs itemSelector
    bad((c) => (c.extraction.fields = []));
    bad((c) => c.extraction.fields.push({ ...c.extraction.fields[0] })); // duplicate key
    bad((c) => (c.extraction.fields[0].transform = 'nope'));
    bad((c) => (c.extraction.fields[0].selector.type = 'regex'));
    bad((c) => (c.navigation.pagination = { type: 'urlPattern', template: 'https://x.com/p', from: 1, to: 2 })); // no {page}
    bad((c) => (c.navigation.pagination = { type: 'urlPattern', template: 'https://x.com/{page}', from: 5, to: 2 }));
    bad((c) => (c.execution.maxRetries = -1));
    expectApiError(() => parseScrapeConfig('x', { engines, guard }), 400);
  });

  it('rejects unknown engines and invalid selectors with 422', () => {
    expectApiError(() => parseScrapeConfig({ ...validConfig(), engine: 'puppeteer' }, { engines, guard }), 422, 'UNKNOWN_ENGINE');
    const c: any = validConfig();
    c.extraction.itemSelector.value = 'div[';
    expectApiError(() => parseScrapeConfig(c, { engines, guard }), 422, 'INVALID_SELECTOR');
    const x: any = validConfig();
    x.extraction.fields[1].selector.value = '//a[';
    expectApiError(() => parseScrapeConfig(x, { engines, guard }), 422, 'INVALID_SELECTOR');
  });

  it('rejects start URLs that are statically forbidden', () => {
    for (const u of ['http://localhost/', 'http://127.0.0.1/', 'file:///etc/passwd', 'http://u:p@example.com/', 'http://169.254.169.254/']) {
      const c: any = validConfig();
      c.startUrls = [u];
      expectApiError(() => parseScrapeConfig(c, { engines, guard }), 422, 'URL_NOT_ALLOWED');
    }
  });

  it('accepts urlPattern pagination', () => {
    const c: any = validConfig();
    c.navigation.pagination = { type: 'urlPattern', template: 'https://ejemplo.com/p/{page}', from: 1, to: 5 };
    const out = parseScrapeConfig(c, { engines, guard });
    expect(out.navigation.pagination).toMatchObject({ type: 'urlPattern', step: 1 });
  });

  it('merges queryParams without overriding existing ones', () => {
    expect(applyQueryParams('https://a.com/x?o=1', { o: '2', p: '3' })).toBe('https://a.com/x?o=1&p=3');
  });
});

describe('limits', () => {
  const g = { maxPages: 100, maxDepth: 3, maxItems: 1000, maxDurationSec: 600, maxConcurrency: 4, maxResponseBytes: 1, maxItemBytes: 1 };
  it('clamps to global maxima and reports each clamp', () => {
    const r = resolveLimits({ maxPages: 500, maxDepth: 2, maxItems: 5000, maxDurationSec: 900, maxConcurrency: 4 }, g);
    expect(r.limits).toEqual({ maxPages: 100, maxDepth: 2, maxItems: 1000, maxDurationSec: 600, maxConcurrency: 4 });
    expect(r.clamped).toHaveLength(3);
    expect(r.clamped.join('\n')).toMatch(/maxPages=500/);
  });
  it('defaults missing limits to the global maxima', () => {
    const r = resolveLimits(undefined, g);
    expect(r.limits.maxPages).toBe(100);
    expect(r.clamped).toEqual([]);
  });
});

describe('environment validation', () => {
  const base = {
    REDIS_URL: 'redis://localhost:6379',
    MAX_CONCURRENT_RUNS: '4',
    MAX_CONCURRENT_BROWSER_RUNS: '2',
    MAX_PAGES_PER_RUN: '500',
    MAX_DEPTH: '3',
    MAX_ITEMS_PER_RUN: '10000',
    MAX_RUN_DURATION_SEC: '900',
  };
  const api = {
    ...base,
    SCRAPER_API_KEY: 'k'.repeat(32),
    NOPXUS_WEBHOOK_URL: 'http://nopxus:3000/api/webhooks/scraper',
    NOPXUS_WEBHOOK_SECRET: 's'.repeat(32),
  };
  it('loads a valid API env with defaults', () => {
    const e = loadEnv('api', api);
    expect(e.PORT).toBe(3000);
    expect(e.RESULT_TTL_HOURS).toBe(72);
    expect(e.MAX_RESPONSE_BYTES).toBe(10 * 1024 * 1024);
    expect(globalLimits(e).maxPages).toBe(500);
  });
  it('names every missing mandatory variable', () => {
    try {
      loadEnv('api', {});
      throw new Error('should fail');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const msg = (e as Error).message;
      for (const k of ['REDIS_URL', 'MAX_CONCURRENT_RUNS', 'SCRAPER_API_KEY', 'NOPXUS_WEBHOOK_URL', 'NOPXUS_WEBHOOK_SECRET', 'MAX_PAGES_PER_RUN']) {
        expect(msg).toContain(k);
      }
    }
  });
  it('does not require the API key or webhook settings in the worker', () => {
    expect(() => loadEnv('worker', base)).not.toThrow();
  });
  it('rejects weak secrets and bad numbers', () => {
    expect(() => loadEnv('api', { ...api, SCRAPER_API_KEY: 'short' })).toThrow(/SCRAPER_API_KEY/);
    expect(() => loadEnv('api', { ...api, MAX_DEPTH: 'abc' })).toThrow(/MAX_DEPTH/);
  });
});

describe('webhook signature', () => {
  const secret = 'whsec_test_secret_value';
  const body = JSON.stringify({ version: 1, hello: 'wörld' });
  it('is HMAC-SHA256 hex over "<timestamp>.<raw body>"', () => {
    const ts = '1700000000';
    const expected = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    expect(signWebhook(secret, ts, body)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });
  it('verifies and rejects tampering', () => {
    const sig = signWebhook(secret, '1700000000', body);
    expect(verifyWebhookSignature(secret, '1700000000', body, sig)).toBe(true);
    expect(verifyWebhookSignature(secret, '1700000001', body, sig)).toBe(false);
    expect(verifyWebhookSignature(secret, '1700000000', body + ' ', sig)).toBe(false);
    expect(verifyWebhookSignature('other', '1700000000', body, sig)).toBe(false);
    expect(verifyWebhookSignature(secret, '1700000000', body, 'abc')).toBe(false);
  });
  it('safeEqual handles different lengths', () => {
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('a', 'ab')).toBe(false);
  });
});

describe('Redactor', () => {
  const r = new Redactor({
    headers: { 'X-Api-Key': 'sup3r-s3cret-key', Authorization: 'Bearer tok_abcdef123' },
    cookies: [{ name: 's', value: 'cookieValue987', domain: 'a.com' }],
  });
  it('removes secret values wherever they appear', () => {
    const out = r.redact('failed with sup3r-s3cret-key and cookieValue987 plus tok_abcdef123');
    expect(out).not.toMatch(/sup3r|cookieValue987|tok_abcdef123/);
  });
  it('redacts Authorization/Cookie/Set-Cookie header values even if not declared secret', () => {
    const out = r.redact('headers: Authorization: Basic Zm9vOmJhcg==\nCookie: a=b; c=d\nSet-Cookie: x=y; Path=/');
    expect(out).not.toMatch(/Zm9vOmJhcg|a=b|x=y/);
    expect(out).toContain('[REDACTED]');
    expect(r.redact('{"authorization":"Bearer zzz"}')).not.toContain('zzz');
  });
  it('leaves harmless text alone', () => {
    expect(r.redact('fetched https://a.com/x in 20ms')).toBe('fetched https://a.com/x in 20ms');
  });
});
