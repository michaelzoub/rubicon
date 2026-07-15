import { randomUUID } from "node:crypto";
import type { AnalyticsConfig } from "./config.js";
import type { ClickHouseAnalyticsClient } from "./clickhouse-client.js";
import type { AnalyticsOutboxRepository } from "./outbox-repository.js";

export class AnalyticsWorker {
  readonly workerId = `analytics-${process.pid}-${randomUUID()}`;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private running = false;
  private stopping = false;

  constructor(
    private readonly config: AnalyticsConfig,
    private readonly outbox: AnalyticsOutboxRepository,
    private readonly clickhouse: ClickHouseAnalyticsClient,
  ) {}

  get isRunning(): boolean {
    return this.running && !this.stopping;
  }

  start(): void {
    if (!this.config.enabled || this.running) return;
    this.running = true;
    this.schedule(0);
  }

  async runOnce(): Promise<number> {
    const rows = await this.outbox.claim({
      workerId: this.workerId,
      limit: this.config.batchSize,
      maxAttempts: this.config.maxAttempts,
      leaseTimeoutMs: this.config.leaseTimeoutMs,
    });
    if (rows.length === 0) return 0;
    try {
      await this.clickhouse.insert(rows);
      await this.outbox.markProcessed(this.workerId, rows.map((row) => row.id));
    } catch (error) {
      await this.outbox.markFailed(this.workerId, rows, error, this.config.maxAttempts);
      throw error;
    }
    return rows.length;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
    await this.outbox.releaseClaims(this.workerId).catch(() => {});
    this.running = false;
  }

  private schedule(delay: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      const inFlight = this.tick();
      this.inFlight = inFlight;
      void inFlight.finally(() => {
        if (this.inFlight === inFlight) this.inFlight = undefined;
      });
    }, delay);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    try {
      const count = await this.runOnce();
      this.schedule(count >= this.config.batchSize ? 0 : this.config.flushIntervalMs);
    } catch (error) {
      // Never propagate ClickHouse/outbox failures into the gateway request path.
      console.error("[analytics] ingestion batch failed", error instanceof Error ? error.message : String(error));
      this.schedule(this.config.flushIntervalMs);
    }
  }
}
