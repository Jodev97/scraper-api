import type { EffectiveLimits, ExtractedItem, LogEntry } from '../contract/schemas.js';
import type { LogLevel, RunSink } from '../engines/types.js';
import { computeDedupeKey } from '../extraction/extract.js';
import type { Redactor } from '../security/redact.js';
import type { RunStore } from '../store/run-store.js';
import { byteLength, nowIso } from '../util/misc.js';

export const BATCH = {
  maxItems: 200,
  maxItemBytes: 512 * 1024,
  maxLogs: 100,
  intervalMs: 2000,
  /** Safety valve against a page that logs on every element. */
  maxLogEntries: 5000,
} as const;

export interface RecorderOptions {
  store: RunStore;
  runId: string;
  context: Record<string, unknown>;
  limits: EffectiveLimits;
  redactor: Redactor;
  maxItemBytes: number;
  dedupeKeyFields?: string[];
  intervalMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * Worker-side `RunSink`: assigns `seq`, persists items to Redis, batches
 * items / log lines, throttles progress, and publishes everything as events
 * (in order) on the worker -> api stream.
 */
export class RunRecorder implements RunSink {
  pagesProcessed = 0;
  pagesFailed = 0;
  itemsExtracted = 0;
  lastSeq = 0;
  bytesDownloaded = 0;
  peakMemoryBytes = 0;
  lastPageError: string | null = null;

  private enqueued = 0;
  private itemBuf: ExtractedItem[] = [];
  private itemBufBytes = 0;
  private logBuf: LogEntry[] = [];
  private logSeq = 0;
  private logsDropped = false;
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private limitsLogged = new Set<string>();
  private lastProgress = '';
  private _itemLimitReached = false;

  constructor(private readonly o: RecorderOptions) {
    this.timer = setInterval(() => this.tick(), o.intervalMs ?? BATCH.intervalMs);
    this.timer.unref?.();
  }

  get itemLimitReached(): boolean {
    return this._itemLimitReached;
  }

  private get queuedUrls(): number {
    return Math.max(0, this.enqueued - this.pagesProcessed - this.pagesFailed);
  }

  /** Serialises all emissions so webhooks of a run keep their order. */
  private run(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((e) => this.o.onError?.(e));
  }

  // ---------------------------------------------------------------- RunSink

  addItem(sourceUrl: string, data: Record<string, unknown>): 'added' | 'limit' | 'too-large' {
    if (this.closed) return 'limit';
    if (this.itemsExtracted >= this.o.limits.maxItems) {
      this.limitReached('maxItems');
      return 'limit';
    }
    const size = byteLength(JSON.stringify(data));
    if (size > this.o.maxItemBytes) {
      this.log('warn', `Item skipped: ${size} bytes exceeds the ${this.o.maxItemBytes}-byte item limit`, sourceUrl);
      return 'too-large';
    }
    const item: ExtractedItem = {
      seq: this.lastSeq + 1,
      sourceUrl,
      data,
      dedupeKey: computeDedupeKey(data, this.o.dedupeKeyFields),
    };
    this.lastSeq = item.seq;
    this.itemsExtracted++;
    this.itemBuf.push(item);
    this.itemBufBytes += size + 200;
    if (this.itemBuf.length >= BATCH.maxItems || this.itemBufBytes >= BATCH.maxItemBytes) this.flushItems();
    if (this.itemsExtracted >= this.o.limits.maxItems) {
      this._itemLimitReached = true;
      this.limitReached('maxItems');
    }
    return 'added';
  }

  log(level: LogLevel, message: string, url?: string): void {
    if (this.closed) return;
    if (this.logSeq >= BATCH.maxLogEntries) {
      if (!this.logsDropped) {
        this.logsDropped = true;
        this.pushLog('warn', `Log limit of ${BATCH.maxLogEntries} entries reached; further entries are dropped`);
      }
      return;
    }
    this.pushLog(level, message, url);
  }

  private pushLog(level: LogLevel, message: string, url?: string): void {
    const entry: LogEntry = {
      seq: ++this.logSeq,
      level,
      message: this.o.redactor.redact(message).slice(0, 2000),
      ...(url ? { url: this.o.redactor.redact(url) } : {}),
      at: nowIso(),
    };
    this.logBuf.push(entry);
    if (this.logBuf.length >= BATCH.maxLogs) this.flushLogs();
  }

  pageProcessed(_url: string, _isStart: boolean): void {
    this.pagesProcessed++;
  }

  pageFailed(url: string, reason: string, _isStart: boolean): void {
    this.pagesFailed++;
    this.lastPageError = reason;
    this.log('error', `Page failed: ${reason}`, url);
  }

  urlsEnqueued(count: number): void {
    this.enqueued += count;
  }

  addBytes(n: number): void {
    this.bytesDownloaded += n;
  }

  limitReached(limit: 'maxPages' | 'maxItems' | 'maxDepth'): void {
    if (this.limitsLogged.has(limit)) return;
    this.limitsLogged.add(limit);
    const value = this.o.limits[limit];
    this.log('warn', `Limit reached: ${limit}=${value}. The crawl stopped early; results so far are kept.`);
  }

  // --------------------------------------------------------------- emission

  flushItems(): void {
    if (this.itemBuf.length === 0) return;
    const items = this.itemBuf;
    this.itemBuf = [];
    this.itemBufBytes = 0;
    this.run(async () => {
      await this.o.store.addItems(this.o.runId, items);
      await this.syncCounters(items[items.length - 1]!.seq);
      await this.o.store.publishEvent(this.o.runId, 'run.items', this.o.context, {
        fromSeq: items[0]!.seq,
        toSeq: items[items.length - 1]!.seq,
        items,
      });
    });
  }

  flushLogs(): void {
    if (this.logBuf.length === 0) return;
    const entries = this.logBuf;
    this.logBuf = [];
    this.run(async () => {
      await this.o.store.publishEvent(this.o.runId, 'run.log', this.o.context, { entries });
    });
  }

  private async syncCounters(lastSeqPersisted = this.lastSeq): Promise<void> {
    await this.o.store.setCounters(this.o.runId, {
      pagesProcessed: this.pagesProcessed,
      pagesFailed: this.pagesFailed,
      itemsExtracted: this.itemsExtracted,
      lastSeq: lastSeqPersisted,
    });
  }

  private tick(): void {
    this.peakMemoryBytes = Math.max(this.peakMemoryBytes, process.memoryUsage().rss);
    this.flushItems();
    this.flushLogs();
    const snapshot = JSON.stringify([this.pagesProcessed, this.pagesFailed, this.itemsExtracted, this.queuedUrls]);
    if (snapshot !== this.lastProgress) {
      this.lastProgress = snapshot;
      const data = {
        pagesProcessed: this.pagesProcessed,
        pagesFailed: this.pagesFailed,
        itemsExtracted: this.itemsExtracted,
        queuedUrls: this.queuedUrls,
      };
      this.run(async () => {
        await this.syncCounters();
        await this.o.store.publishEvent(this.o.runId, 'run.progress', this.o.context, data);
      });
    }
  }

  /** Flushes everything and waits until it has been published. */
  async finish(): Promise<void> {
    this.peakMemoryBytes = Math.max(this.peakMemoryBytes, process.memoryUsage().rss);
    this.flushItems();
    this.flushLogs();
    await this.chain;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** Drops everything buffered and stops the timer (simulated crash / teardown). */
  abandon(): void {
    this.closed = true;
    this.itemBuf = [];
    this.logBuf = [];
    if (this.timer) clearInterval(this.timer);
  }

  /** Queues an arbitrary event after everything already buffered. */
  async publishAfterFlush(fn: () => Promise<void>): Promise<void> {
    this.run(fn);
    await this.chain;
  }
}
