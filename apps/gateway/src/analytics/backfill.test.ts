import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { readBundleCommittedEvent } from "../repositories/postgres.js";
import type { AnalyticsOutboxRepository } from "./outbox-repository.js";
import { backfillBundleAnalytics, toBundleEvent } from "./backfill.js";
import type { AnalyticsEvent } from "./types.js";

test("bundle backfill emits the same deterministic event as live ingestion", () => {
  const event = toBundleEvent(bundleRow());
  assert.deepEqual(event, readBundleCommittedEvent({
    bundleId: "bundle-1",
    idempotencyKey: "request-1",
    sessionId: "session-1",
    creatorId: "creator-1",
    articleId: "article-1",
    accessMode: "paid",
    sectionId: "section-1",
    bundleSequence: 0,
    startSequence: 0,
    endSequence: 19,
    wordsCount: 20,
    pricePerWordAtomic: "2",
    grossAmountAtomic: "40",
    creatorAmountAtomic: "36",
    rubiconFeeAtomic: "4",
    paymentId: "payment-1",
    authorizationReference: "authorization-1",
    buyerWalletAddress: "0x00000000000000000000000000000000000000AA",
    paymentStatus: "authorized",
    words: [],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  }));
  assert.notEqual(event.buyerAgentHash, "0x00000000000000000000000000000000000000AA");
  assert.equal(event.buyerAgentHash?.length, 64);
});

test("backfill covers bundles and settlement evidence with resumable deterministic events", async () => {
  const appended: AnalyticsEvent[] = [];
  let queryNumber = 0;
  const pool = {
    query: async () => {
      queryNumber += 1;
      if (queryNumber === 1) return { rows: [bundleRow()] };
      return { rows: [{
        id: "settlement-1",
        idempotency_key: "settlement-attempt-1",
        provider_reference: "transfer-1",
        status: "completed",
        created_at: "2026-07-15T00:01:00.000Z",
        bundle_ids: ["bundle-1"],
        creator_id: "creator-1",
        article_id: "article-1",
        session_id: "session-1",
        creator_amount_atomic: "36",
      }] };
    },
  } as unknown as Pool;
  const outbox = {
    appendBackfillEvent: async (event: AnalyticsEvent) => {
      appended.push(event);
      return true;
    },
  } as unknown as AnalyticsOutboxRepository;

  const result = await backfillBundleAnalytics(pool, outbox, {
    dryRun: false,
    batchSize: 10,
  });

  assert.equal(result.scanned, 2);
  assert.equal(result.inserted, 2);
  assert.deepEqual(appended.map((event) => event.eventId), [
    "read_bundle:bundle-1:v1",
    "settlement:settlement-attempt-1:v1",
  ]);
  assert.equal(appended[1]?.eventType, "settlement_changed");
  if (appended[1]?.eventType === "settlement_changed") {
    assert.equal(appended[1].settledCreatorAmountAtomicDelta, "36");
  }
  const cursor = JSON.parse(Buffer.from(result.lastCursor!, "base64url").toString("utf8")) as Record<string, unknown>;
  assert.equal(cursor.phase, "settlements");
  assert.equal(cursor.id, "settlement-1");
});

function bundleRow() {
  return {
    bundle_id: "bundle-1",
    creator_id: "creator-1",
    article_id: "article-1",
    session_id: "session-1",
    access_mode: "paid" as const,
    section_id: "section-1",
    start_sequence: 0,
    end_sequence: 19,
    words_count: 20,
    gross_amount_atomic: "40",
    creator_amount_atomic: "36",
    rubicon_fee_atomic: "4",
    buyer_wallet_address: "0x00000000000000000000000000000000000000AA",
    created_at: "2026-07-15T00:00:00.000Z",
  };
}
