import type { ScrapingEngine } from './types.js';

/** Engines available in this worker process. */
export class EngineRegistry {
  private readonly engines = new Map<string, ScrapingEngine>();

  register(engine: ScrapingEngine): this {
    if (this.engines.has(engine.name)) throw new Error(`Engine "${engine.name}" already registered`);
    this.engines.set(engine.name, engine);
    return this;
  }

  get(name: string): ScrapingEngine | undefined {
    return this.engines.get(name);
  }

  names(): string[] {
    return [...this.engines.keys()];
  }

  list(): ScrapingEngine[] {
    return [...this.engines.values()];
  }
}

/** Engines every deployment is expected to offer (used by the API when no worker has registered yet). */
export const BUILTIN_ENGINE_NAMES = ['http', 'browser'] as const;

export const runQueueName = (engine: string): string => `scraper-runs-${engine}`;
export const PREVIEW_QUEUE = 'scraper-preview';
export const ENGINES_HASH = 'scraper:engines';
export const BULL_PREFIX = 'scraper-bull';
