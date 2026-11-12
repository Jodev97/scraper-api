import { applyQueryParams } from '../contract/validate.js';
import {
  extractFirstLink,
  extractItems,
  extractLinks,
  parsePage,
} from '../extraction/extract.js';
import { byteLength } from '../util/misc.js';
import type { EngineContext } from './types.js';

export interface CrawlRequest {
  url: string;
  userData: PageMeta;
}

export interface PageMeta {
  depth: number;
  /** start: configured start URL; page: pagination; detail: followed link. */
  kind: 'start' | 'page' | 'detail';
  [key: string]: unknown;
}

/** Thrown to abort a request without retrying (and without counting it). */
export class SkipRequestError extends Error {
  constructor(
    message: string,
    public readonly counts: boolean,
  ) {
    super(message);
    this.name = 'SkipRequestError';
  }
}

export class DomainGate {
  private readonly state = new Map<string, { active: number; nextAt: number; waiters: Array<() => void> }>();
  constructor(
    private readonly maxPerDomain: number,
    private readonly delayMs: number,
  ) {}

  /** Waits for a slot on `host` and for the politeness delay. Returns release(). */
  async acquire(host: string, signal?: AbortSignal): Promise<() => void> {
    let st = this.state.get(host);
    if (!st) {
      st = { active: 0, nextAt: 0, waiters: [] };
      this.state.set(host, st);
    }
    while (st.active >= this.maxPerDomain) {
      if (signal?.aborted) throw new Error('aborted');
      await new Promise<void>((r) => st!.waiters.push(r));
    }
    st.active++;
    const now = Date.now();
    const startAt = Math.max(now, st.nextAt);
    st.nextAt = startAt + this.delayMs;
    if (startAt > now) await new Promise((r) => setTimeout(r, startAt - now));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      st!.active--;
      st!.waiters.shift()?.();
    };
  }
}

const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** Engine-independent crawl logic: what to fetch first, what a page yields. */
export class CrawlCore {
  /** Hostnames secrets may be sent to (those of the start URLs). */
  readonly secretHosts: Set<string>;
  private claimed = 0;
  readonly gate: DomainGate;

  constructor(readonly ctx: EngineContext) {
    this.gate = new DomainGate(ctx.maxConcurrencyPerDomain, ctx.config.execution.delayMs);
    this.secretHosts = new Set(this.startRequests().map((r) => hostOf(r.url)));
  }

  startRequests(): CrawlRequest[] {
    const { config, limits } = this.ctx;
    const out: CrawlRequest[] = config.startUrls.map((u) => ({
      url: applyQueryParams(u, config.queryParams),
      userData: { depth: 0, kind: 'start' },
    }));
    const p = config.navigation.pagination;
    if (p.type === 'urlPattern') {
      for (let n = p.from, i = 0; n <= p.to && out.length < limits.maxPages + config.startUrls.length; n += p.step, i++) {
        out.push({
          url: applyQueryParams(p.template.replaceAll('{page}', String(n)), config.queryParams),
          userData: { depth: 0, kind: 'page' },
        });
      }
    }
    return out;
  }

  /** Reserves a page slot against `maxPages`. Call once per page, first attempt. */
  claimPage(): boolean {
    if (this.claimed >= this.ctx.limits.maxPages) {
      this.ctx.sink.limitReached('maxPages');
      return false;
    }
    this.claimed++;
    return true;
  }

  /** Headers to add for a request to `url` (config headers + scoped secrets). */
  headersFor(url: string): Record<string, string> {
    const h: Record<string, string> = { ...this.ctx.config.headers };
    if (this.secretHosts.has(hostOf(url))) Object.assign(h, this.ctx.secrets?.headers ?? {});
    return h;
  }

  /** Cookie header value of the secret cookies that apply to `url`. */
  cookieHeaderFor(url: string): string | undefined {
    const cookies = this.ctx.secrets?.cookies;
    if (!cookies?.length) return undefined;
    const host = new URL(url).hostname.toLowerCase();
    const pairs = cookies
      .filter((c) => {
        const d = c.domain.toLowerCase().replace(/^\./, '');
        return host === d || host.endsWith(`.${d}`);
      })
      .map((c) => `${c.name}=${c.value}`);
    return pairs.length ? pairs.join('; ') : undefined;
  }

  /**
   * Extracts items from a fetched page and returns the requests to enqueue.
   * `url` is the final URL (after redirects).
   */
  handlePage(html: string, url: string, meta: PageMeta): CrawlRequest[] {
    const { sink, config, limits } = this.ctx;
    const page = parsePage(html, url);
    try {
      const out = extractItems(page, config.extraction);
      if (out.candidates === 0) sink.log('info', 'No elements matched the item selector', url);
      else if (out.skipped > 0) sink.log('debug', `${out.skipped} of ${out.candidates} candidates skipped (missing required fields)`, url);
      for (const it of out.items) {
        if (sink.itemLimitReached) break;
        const r = sink.addItem(url, it.data);
        if (r === 'limit') break;
      }

      const next: CrawlRequest[] = [];
      if (this.ctx.singlePage) return next;

      const p = config.navigation.pagination;
      if (p.type === 'nextLink' && meta.kind !== 'detail') {
        const link = extractFirstLink(page, p.selector);
        if (link && link !== url) next.push({ url: link, userData: { depth: meta.depth, kind: 'page' } });
      }
      const follow = config.navigation.followLinks;
      if (follow) {
        if (meta.depth >= limits.maxDepth) {
          if (extractLinks(page, follow.selector).length > 0) sink.limitReached('maxDepth');
        } else {
          for (const link of extractLinks(page, follow.selector)) {
            if (follow.sameDomainOnly && hostOf(link) !== hostOf(url)) continue;
            next.push({ url: link, userData: { depth: meta.depth + 1, kind: 'detail' } });
          }
        }
      }
      return next;
    } finally {
      page.close();
    }
  }

  recordBytes(html: string | Buffer): number {
    const n = typeof html === 'string' ? byteLength(html) : html.length;
    this.ctx.sink.addBytes(n);
    return n;
  }
}
