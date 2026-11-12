export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const nowIso = (): string => new Date().toISOString();

export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Counting semaphore with FIFO waiters. */
export class Semaphore {
  private waiters: Array<() => void> = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };
  }
}

export function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}
