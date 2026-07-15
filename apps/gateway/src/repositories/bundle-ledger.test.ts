import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord } from "@rubicon-caliga/core";
import { InMemoryLedgerRepository } from "./in-memory.js";

test("one 20-word request creates one bundle, one payment, and one sanitized outbox event", async () => {
  const ledger = new InMemoryLedgerRepository();
  const session = makeSession();
  await ledger.createSession(session);
  const words = Array.from({ length: 20 }, (_, sequence) => ({ sequence, word: `private-${sequence}` }));
  const first = await ledger.recordPaidBundle({
    accessMode: "paid",
    bundleId: "bundle-20",
    idempotencyKey: "request-20",
    sessionId: session.id,
    creatorId: session.creatorId,
    articleId: session.articleId,
    sectionId: session.sectionId,
    bundleSequence: 0,
    startSequence: 0,
    words,
    pricePerWordAtomic: 2n,
    grossAmountAtomic: 40n,
    creatorAmountAtomic: 40n,
    rubiconFeeAtomic: 0n,
    paymentId: "payment-20",
    authorizationReference: "authorization-20",
  });

  assert.equal(first.duplicate, false);
  assert.equal(first.bundle.wordsCount, 20);
  assert.equal((await ledger.listDeliveries(session.id)).length, 20);
  assert.equal((await ledger.listPayments(session.id)).length, 1);
  assert.equal(ledger.listAnalyticsEvents().length, 1);
  assert.equal(JSON.stringify(ledger.listAnalyticsEvents()).includes("private-"), false);

  const duplicate = await ledger.recordPaidBundle({
    accessMode: "paid",
    bundleId: "ignored-bundle",
    idempotencyKey: "request-20",
    sessionId: session.id,
    creatorId: session.creatorId,
    articleId: session.articleId,
    bundleSequence: 0,
    startSequence: 0,
    words,
    pricePerWordAtomic: 2n,
    grossAmountAtomic: 40n,
    creatorAmountAtomic: 40n,
    rubiconFeeAtomic: 0n,
    paymentId: "ignored-payment",
    authorizationReference: "authorization-20",
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.bundle.bundleId, "bundle-20");
  assert.equal((await ledger.listPayments(session.id)).length, 1);
  assert.equal(ledger.listAnalyticsEvents().length, 1);
});

test("one settlement can cover multiple bundles and retries do not duplicate events", async () => {
  const ledger = new InMemoryLedgerRepository();
  const session = makeSession();
  await ledger.createSession(session);
  for (let bundleSequence = 0; bundleSequence < 2; bundleSequence += 1) {
    const start = bundleSequence * 2;
    await ledger.recordPaidBundle({
      accessMode: "paid",
      bundleId: `bundle-${bundleSequence}`,
      idempotencyKey: `request-${bundleSequence}`,
      sessionId: session.id,
      creatorId: session.creatorId,
      articleId: session.articleId,
      bundleSequence,
      startSequence: start,
      words: [{ sequence: start, word: "secret" }, { sequence: start + 1, word: "secret" }],
      pricePerWordAtomic: 1n,
      grossAmountAtomic: 2n,
      creatorAmountAtomic: 2n,
      rubiconFeeAtomic: 0n,
      paymentId: `payment-${bundleSequence}`,
      authorizationReference: `authorization-${bundleSequence}`,
    });
  }
  const settlement = {
    provider: "circle-x402",
    status: "completed" as const,
    idempotencyKey: "settlement-1-completed",
    sessionId: session.id,
    startSequence: 0,
    endSequence: 3,
    transferId: "transfer-1",
  };
  await ledger.recordSettlementRange(settlement);
  await ledger.recordSettlementRange(settlement);
  const settlementEvents = ledger.listAnalyticsEvents().filter((event) => event.eventType === "settlement_changed");
  assert.equal(settlementEvents.length, 1);
  assert.deepEqual(settlementEvents[0]?.bundleIds, ["bundle-0", "bundle-1"]);
});

test("settlement outcomes without provider evidence create no settlement event", async () => {
  const ledger = new InMemoryLedgerRepository();
  const session = makeSession();
  await ledger.createSession(session);
  await ledger.recordPaidBundle({
    accessMode: "paid",
    bundleId: "bundle-pending",
    idempotencyKey: "request-pending",
    sessionId: session.id,
    creatorId: session.creatorId,
    articleId: session.articleId,
    bundleSequence: 0,
    startSequence: 0,
    words: [{ sequence: 0, word: "secret" }],
    pricePerWordAtomic: 1n,
    grossAmountAtomic: 1n,
    creatorAmountAtomic: 1n,
    rubiconFeeAtomic: 0n,
    paymentId: "payment-pending",
    authorizationReference: "authorization-pending",
  });
  await ledger.recordSettlementRange({
    provider: "circle-x402",
    status: "failed",
    idempotencyKey: "no-provider-reference",
    sessionId: session.id,
    startSequence: 0,
    endSequence: 0,
  });
  assert.equal(ledger.listAnalyticsEvents().filter((event) => event.eventType === "settlement_changed").length, 0);
  assert.equal((await ledger.getBundleByIdempotencyKey("request-pending"))?.bundle.paymentStatus, "failed");
});

function makeSession(): SessionRecord {
  const now = new Date("2026-07-15T00:00:00.000Z");
  return {
    id: "session-bundle-test",
    articleId: "article-1",
    creatorId: "creator-1",
    accessMode: "paid",
    sectionId: "section-1",
    budget: { currency: "USDC", maxAmountAtomic: "1000" },
    pricePerWordAtomic: 1n,
    gatewayFeeBps: 0,
    sellerWallet: "0x1111111111111111111111111111111111111111",
    metadata: {},
    state: "open",
    wordsPaid: 0,
    wordsDelivered: 0,
    paidAtomic: 0n,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date("2026-07-16T00:00:00.000Z"),
  };
}
