import type { ErrorCode, PreviewJobData, PreviewResult, RunJobData, RunView } from '../contract/schemas.js';
import type { EngineRegistry } from '../engines/registry.js';
import type { RunSink, LogLevel } from '../engines/types.js';
import { computeDedupeKey } from '../extraction/extract.js';
import { Redactor } from '../security/redact.js';
import type { SsrfGuard } from '../security/ssrf.js';
import type { RunStore } from '../store/run-store.js';
import { errMessage, nowIso } from '../util/misc.js';
import { RunRecorder } from './recorder.js';

export type AbortReason = 'cancel' | 'timeout' | 'shutdown' | 'crash';

export interface ExecutorDeps {
  store: RunStore;
  registry: EngineRegistry;
  guard: SsrfGuard;
  proxyUrl: string;
  userAgent: string;
  maxResponseBytes: number;
  maxItemBytes: number;
  maxConcurrencyPerDomain: number;
  leaseTtlSec: number;
  recorderIntervalMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

interface ActiveRun {
  controller: AbortController;
  reason: AbortReason | null;
  done: Promise<void>;
}

export class RunExecutor {
  private readonly active = new Map<string, ActiveRun>();
  private crashed = false;

  constructor(private readonly d: ExecutorDeps) {}

  get activeCount(): number {
    return this.active.size;
  }

  activeIds(): string[] {
    return [...this.active.keys()];
  }

  /** Aborts a run owned by this process. Returns false if it is not running here. */
  abort(runId: string, reason: AbortReason): boolean {
    const a = this.active.get(runId);
    if (!a) return false;
    a.reason ??= reason;
    a.controller.abort();
    return true;
  }

  abortAll(reason: AbortReason): void {
    for (const id of this.active.keys()) this.abort(id, reason);
  }

  /** Test hook: behave as if the process had been killed (no finalisation). */
  simulateCrash(): void {
    this.crashed = true;
    this.abortAll('crash');
  }

  async waitIdle(timeoutMs: number): Promise<boolean> {
    const all = Promise.all([...this.active.values()].map((a) => a.done)).then(() => true);
    const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs));
    return Promise.race([all, timeout]);
  }

  // ---------------------------------------------------------------- run job

  async execute(job: RunJobData): Promise<void> {
    const { runId } = job;
    const { store } = this.d;
    if (this.active.has(runId)) return;

    // Lease first, so the orphan reaper never sees a running run without one.
    await store.heartbeat(runId, this.d.leaseTtlSec);
    const startedAt = nowIso();
    const started = await store.transition(runId, 'running', { startedAt });
    if (!started) {
      const view = await store.getView(runId);
      if (view?.status === 'running') {
        // The job was redelivered after a worker died mid-run: never resume.
        await this.failOrphan(view);
      } else {
        await store.expireRun(runId); // cancelled while queued, or unknown
      }
      return;
    }

    const controller = new AbortController();
    const entry: ActiveRun = { controller, reason: null, done: Promise.resolve() };
    let resolveDone!: () => void;
    entry.done = new Promise<void>((r) => (resolveDone = r));
    this.active.set(runId, entry);

    const redactor = new Redactor(job.secrets);
    const recorder = new RunRecorder({
      store,
      runId,
      context: job.context,
      limits: job.limits,
      redactor,
      maxItemBytes: this.d.maxItemBytes,
      ...(job.config.dedupeKeyFields ? { dedupeKeyFields: job.config.dedupeKeyFields } : {}),
      ...(this.d.recorderIntervalMs ? { intervalMs: this.d.recorderIntervalMs } : {}),
      onError: (e) => this.d.log?.('error', `recorder failure for run ${runId}: ${errMessage(e)}`),
    });

    const timers: NodeJS.Timeout[] = [];
    try {
      await recorder.publishAfterFlush(async () => {
        await store.publishEvent(runId, 'run.started', job.context, { startedAt });
      });

      for (const w of job.warnings) recorder.log('warn', w);
      recorder.log(
        'info',
        `Run started (engine=${job.config.engine}, maxPages=${job.limits.maxPages}, maxDepth=${job.limits.maxDepth}, maxItems=${job.limits.maxItems}, maxDurationSec=${job.limits.maxDurationSec}, maxConcurrency=${job.limits.maxConcurrency})`,
      );

      timers.push(
        setInterval(() => {
          void store.heartbeat(runId, this.d.leaseTtlSec).catch(() => undefined);
        }, Math.max(500, (this.d.leaseTtlSec * 1000) / 3)),
        setInterval(() => {
          void store
            .isCancelRequested(runId)
            .then((c) => c && this.abort(runId, 'cancel'))
            .catch(() => undefined);
        }, 1000),
        setTimeout(() => this.abort(runId, 'timeout'), job.limits.maxDurationSec * 1000),
      );
      // A cancel requested before we subscribed/started.
      if (await store.isCancelRequested(runId)) this.abort(runId, 'cancel');

      let outcomeError: unknown = null;
      let startUrlsProcessed = 0;
      const engine = this.d.registry.get(job.config.engine);
      if (!engine) {
        outcomeError = new Error(`Engine "${job.config.engine}" is not available in this worker`);
      } else if (!controller.signal.aborted) {
        try {
          const outcome = await engine.run({
            config: job.config,
            limits: job.limits,
            ...(job.secrets ? { secrets: job.secrets } : {}),
            signal: controller.signal,
            sink: recorder,
            guard: this.d.guard,
            proxyUrl: this.d.proxyUrl,
            userAgent: this.d.userAgent,
            redactor,
            maxResponseBytes: this.d.maxResponseBytes,
            maxConcurrencyPerDomain: this.d.maxConcurrencyPerDomain,
          });
          startUrlsProcessed = outcome.startUrlsProcessed;
        } catch (e) {
          if (!controller.signal.aborted) outcomeError = e;
        }
      }

      if (this.crashed) {
        recorder.abandon(); // pretend we were SIGKILLed: leave the run as "running"
        return;
      }

      // ---- decide the final state
      const reason = entry.reason;
      let status: 'completed' | 'failed' | 'cancelled';
      let error: { code: ErrorCode; message: string } | undefined;
      if (reason === 'cancel') {
        status = 'cancelled';
        recorder.log('info', 'Run cancelled');
      } else if (reason === 'timeout') {
        status = 'failed';
        error = { code: 'TIMEOUT', message: `Run exceeded maxDurationSec (${job.limits.maxDurationSec}s)` };
        recorder.log('error', error.message);
      } else if (reason === 'shutdown') {
        status = 'failed';
        error = { code: 'WORKER_RESTARTED', message: 'The worker shut down before the run finished' };
        recorder.log('error', error.message);
      } else if (outcomeError) {
        status = 'failed';
        error = { code: 'INTERNAL_ERROR', message: redactor.redact(errMessage(outcomeError)) };
        recorder.log('error', `Internal error: ${error.message}`);
      } else if (startUrlsProcessed === 0) {
        status = 'failed';
        error = {
          code: 'START_URLS_FAILED',
          message: `No start URL could be processed${recorder.lastPageError ? `: ${recorder.lastPageError}` : ''}`,
        };
        recorder.log('error', error.message);
      } else {
        status = 'completed';
        recorder.log('info', `Run completed: ${recorder.pagesProcessed} pages, ${recorder.itemsExtracted} items`);
      }

      await recorder.finish(); // flush items + logs (in order) before the terminal event
      const finishedAt = nowIso();
      const applied = await store.transition(runId, status, {
        finishedAt,
        pagesProcessed: recorder.pagesProcessed,
        pagesFailed: recorder.pagesFailed,
        itemsExtracted: recorder.itemsExtracted,
        lastSeq: recorder.lastSeq,
        stats: {
          durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
          bytesDownloaded: recorder.bytesDownloaded,
          peakMemoryBytes: recorder.peakMemoryBytes,
        },
        ...(error ? { error } : {}),
      });
      if (applied) await this.publishTerminal(runId, job.context, status);
    } catch (e) {
      this.d.log?.('error', `run ${runId} crashed: ${errMessage(e)}`);
      await this.finalizeInternalError(runId, job.context, recorder, errMessage(e));
    } finally {
      for (const t of timers) {
        clearInterval(t);
        clearTimeout(t);
      }
      this.active.delete(runId);
      resolveDone();
    }
  }

  private async finalizeInternalError(
    runId: string,
    context: Record<string, unknown>,
    recorder: RunRecorder,
    message: string,
  ): Promise<void> {
    if (this.crashed) return;
    try {
      await recorder.finish();
      const ok = await this.d.store.transition(runId, 'failed', {
        finishedAt: nowIso(),
        pagesProcessed: recorder.pagesProcessed,
        pagesFailed: recorder.pagesFailed,
        itemsExtracted: recorder.itemsExtracted,
        lastSeq: recorder.lastSeq,
        error: { code: 'INTERNAL_ERROR', message },
      });
      if (ok) await this.publishTerminal(runId, context, 'failed');
    } catch (e) {
      this.d.log?.('error', `could not finalize run ${runId}: ${errMessage(e)}`);
    }
  }

  private async publishTerminal(
    runId: string,
    context: Record<string, unknown>,
    status: 'completed' | 'failed' | 'cancelled',
  ): Promise<void> {
    const view = await this.d.store.getView(runId);
    await this.d.store.publishEvent(runId, `run.${status}`, context, view);
  }

  // ---------------------------------------------------- orphan / restart logic

  private async failOrphan(view: RunView): Promise<void> {
    const ok = await this.d.store.transition(view.runId, 'failed', {
      finishedAt: nowIso(),
      pagesProcessed: view.pagesProcessed,
      pagesFailed: view.pagesFailed,
      itemsExtracted: view.itemsExtracted,
      lastSeq: view.lastSeq,
      error: { code: 'WORKER_RESTARTED', message: 'The worker restarted while the run was in progress' },
    });
    if (ok) await this.publishTerminal(view.runId, view.context, 'failed');
  }

  /**
   * Fails every `running` run whose lease expired (its worker died). Safe to
   * run from several workers: the transition is atomic, so exactly one emits
   * the `run.failed` event.
   */
  async reapOrphans(): Promise<number> {
    let n = 0;
    for (const runId of await this.d.store.activeRunIds()) {
      if (this.active.has(runId)) continue;
      if (await this.d.store.hasLease(runId)) continue;
      const view = await this.d.store.getView(runId);
      if (!view) {
        await this.d.store.expireRun(runId);
        continue;
      }
      if (view.status !== 'running') {
        await this.d.store.expireRun(runId);
        continue;
      }
      await this.failOrphan(view);
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------------ preview

  async preview(job: PreviewJobData): Promise<PreviewResult> {
    const engine = this.d.registry.get(job.config.engine);
    if (!engine) throw new Error(`Engine "${job.config.engine}" is not available`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    const redactor = new Redactor(job.secrets);

    const items: PreviewResult['items'] = [];
    const logs: PreviewResult['logs'] = [];
    let found = 0;
    const failure: { reason: string | null } = { reason: null };
    const sink: RunSink = {
      get itemLimitReached() {
        return false;
      },
      addItem: (sourceUrl, data) => {
        found++;
        if (items.length < job.maxItems) {
          items.push({ sourceUrl, data, dedupeKey: computeDedupeKey(data, job.config.dedupeKeyFields) });
        }
        return 'added';
      },
      log: (level: LogLevel, message: string) => {
        if (logs.length < 100) logs.push({ level, message: redactor.redact(message) });
      },
      pageProcessed: () => undefined,
      pageFailed: (_u, reason) => {
        failure.reason = reason;
      },
      urlsEnqueued: () => undefined,
      addBytes: () => undefined,
      limitReached: () => undefined,
    };

    const config = {
      ...job.config,
      startUrls: [job.url],
      queryParams: {},
      navigation: { pagination: { type: 'none' as const } },
      execution: { ...job.config.execution, maxRetries: 0, delayMs: 0 },
    };
    try {
      const outcome = await engine.run({
        config,
        limits: { maxPages: 1, maxDepth: 0, maxItems: job.maxItems, maxDurationSec: 45, maxConcurrency: 1 },
        ...(job.secrets ? { secrets: job.secrets } : {}),
        signal: controller.signal,
        sink,
        guard: this.d.guard,
        proxyUrl: this.d.proxyUrl,
        userAgent: this.d.userAgent,
        redactor,
        maxResponseBytes: this.d.maxResponseBytes,
        maxConcurrencyPerDomain: this.d.maxConcurrencyPerDomain,
        singlePage: true,
      });
      if (outcome.startUrlsProcessed === 0) {
        throw new Error(failure.reason ?? (controller.signal.aborted ? 'Preview timed out' : 'The page could not be processed'));
      }
    } finally {
      clearTimeout(timer);
    }
    return { url: job.url, items, itemsFound: found, logs };
  }
}
