/**
 * A small batching buffer that defers expensive work (Circle settlement) off the
 * request path. Items are settled when the buffer reaches `batchSize` or after
 * `intervalMs` elapses, whichever comes first. Within a flush, items settle
 * concurrently, so settling N bundle authorizations costs roughly one round-trip
 * instead of N serial ones. Enqueue happens only after the corresponding bundle
 * transaction commits.
 *
 * The queue never throws to the caller: `settle` is expected to handle and
 * report its own outcomes. A failing `settle` does not stop the queue from
 * draining the rest of the batch.
 */
export interface SettlementQueueOptions<T> {
  batchSize: number;
  intervalMs: number;
  settle: (item: T) => Promise<void>;
}

export class SettlementQueue<T> {
  private readonly buffer: T[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;

  constructor(private readonly options: SettlementQueueOptions<T>) {}

  /** Queue one item. Triggers an immediate flush once the batch is full. */
  enqueue(item: T): void {
    this.buffer.push(item);
    if (this.buffer.length >= this.options.batchSize) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.options.intervalMs);
      // Never keep the process alive solely for a pending settlement flush.
      this.timer.unref?.();
    }
  }

  /**
   * Settle everything currently buffered. Concurrent calls coalesce onto the
   * in-flight flush; items enqueued during a flush are drained by a follow-up.
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.flushing) {
      return this.flushing;
    }
    if (this.buffer.length === 0) {
      return;
    }
    const batch = this.buffer.splice(0, this.buffer.length);
    this.flushing = this.settleBatch(batch).finally(() => {
      this.flushing = undefined;
    });
    await this.flushing;
    // Anything enqueued while we were settling gets its own flush.
    if (this.buffer.length > 0) {
      await this.flush();
    }
  }

  /** Flush until the buffer is empty and no flush is in flight (shutdown). */
  async drain(): Promise<void> {
    while (this.buffer.length > 0 || this.flushing) {
      await this.flush();
    }
  }

  private async settleBatch(batch: T[]): Promise<void> {
    // allSettled so one failing settlement neither rejects the batch nor leaks an
    // unhandled rejection through the fire-and-forget `void flush()` path.
    await Promise.allSettled(batch.map((item) => this.options.settle(item)));
  }
}
