/**
 * A tiny async mutex: `run` executes callbacks one at a time, in call order.
 * The lock is released when the callback settles, including when it throws.
 * No Zotero dependency, so it can be unit-tested in Node.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  /** True while a callback is running or queued. */
  get locked() {
    return this.pending > 0;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending++;
    try {
      await prev;
      return await fn();
    } finally {
      this.pending--;
      release();
    }
  }
}
