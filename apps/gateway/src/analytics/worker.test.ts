import assert from "node:assert/strict";
import test from "node:test";
import type { AnalyticsConfig } from "./config.js";
import type { AnalyticsOutboxRepository } from "./outbox-repository.js";
import type { ClickHouseAnalyticsClient } from "./clickhouse-client.js";
import type { OutboxRow } from "./types.js";
import { AnalyticsWorker } from "./worker.js";

const config: AnalyticsConfig = {
  enabled: true,
  clickhouseUrl: "http://clickhouse.invalid",
  clickhouseDatabase: "default",
  batchSize: 100,
  flushIntervalMs: 1_000,
  maxAttempts: 3,
  leaseTimeoutMs: 60_000,
};

test("ClickHouse failure leaves outbox rows retryable and never marks them processed", async () => {
  const row = makeRow();
  let processed = false;
  let failed = false;
  const outbox = {
    claim: async () => [row],
    markProcessed: async () => { processed = true; },
    markFailed: async () => { failed = true; },
    releaseClaims: async () => {},
  } as unknown as AnalyticsOutboxRepository;
  const clickhouse = {
    insert: async () => { throw new Error("clickhouse_down"); },
  } as unknown as ClickHouseAnalyticsClient;
  const worker = new AnalyticsWorker(config, outbox, clickhouse);

  await assert.rejects(() => worker.runOnce(), /clickhouse_down/);
  assert.equal(processed, false);
  assert.equal(failed, true);
});

test("outbox rows are marked processed only after a confirmed batch insert", async () => {
  const row = makeRow();
  const order: string[] = [];
  const outbox = {
    claim: async () => [row],
    markProcessed: async () => { order.push("processed"); },
    markFailed: async () => { order.push("failed"); },
    releaseClaims: async () => {},
  } as unknown as AnalyticsOutboxRepository;
  const clickhouse = {
    insert: async () => { order.push("inserted"); },
  } as unknown as ClickHouseAnalyticsClient;
  const worker = new AnalyticsWorker(config, outbox, clickhouse);

  assert.equal(await worker.runOnce(), 1);
  assert.deepEqual(order, ["inserted", "processed"]);
});

function makeRow(): OutboxRow {
  return {
    id: "outbox-1",
    eventId: "read_bundle:bundle-1:v1",
    eventType: "read_bundle_committed",
    eventVersion: 1,
    aggregateKey: "bundle-1",
    occurredAt: "2026-07-15T00:00:00.000Z",
    attempts: 1,
    payload: {
      eventId: "read_bundle:bundle-1:v1",
      eventVersion: 1,
      eventType: "read_bundle_committed",
      occurredAt: "2026-07-15T00:00:00.000Z",
      bundleId: "bundle-1",
      creatorId: "creator-1",
      articleId: "article-1",
      sessionId: "session-1",
      accessMode: "paid",
      startSequence: 0,
      endSequence: 19,
      wordsCount: 20,
      grossAmountAtomic: "20",
      creatorAmountAtomic: "20",
      rubiconFeeAtomic: "0",
    },
  };
}
