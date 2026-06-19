import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import type { SessionRecord } from "@rubicon-caliga/core";
import type { PaymentRequirements } from "@x402/core/types";
import { SettlementQueue } from "./settlement-queue.js";
import {
  CircleX402PaymentVerifier,
  type ResourceServerLike,
  type SettlementOutcome,
} from "./x402-circle.js";

// ---------------------------------------------------------------------------
// SettlementQueue
// ---------------------------------------------------------------------------

test("SettlementQueue flushes immediately once the batch is full", async () => {
  const settled: number[] = [];
  const queue = new SettlementQueue<number>({
    batchSize: 3,
    intervalMs: 10_000, // long enough that only the size trigger can fire
    settle: async (item) => {
      settled.push(item);
    },
  });

  queue.enqueue(1);
  queue.enqueue(2);
  assert.deepEqual(settled, [], "should not flush before the batch is full");
  queue.enqueue(3);
  await queue.drain();
  assert.deepEqual(settled.sort(), [1, 2, 3]);
});

test("SettlementQueue flushes after the interval even when not full", async () => {
  const settled: number[] = [];
  const queue = new SettlementQueue<number>({
    batchSize: 100,
    intervalMs: 5,
    settle: async (item) => {
      settled.push(item);
    },
  });

  queue.enqueue(42);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(settled, [42]);
});

test("SettlementQueue.drain waits for all settlements, isolating failures", async () => {
  const settled: number[] = [];
  const queue = new SettlementQueue<number>({
    batchSize: 10,
    intervalMs: 5,
    settle: async (item) => {
      if (item === 2) {
        throw new Error("boom");
      }
      settled.push(item);
    },
  });

  queue.enqueue(1);
  queue.enqueue(2);
  queue.enqueue(3);
  await queue.drain();
  // The throwing item neither blocks nor crashes the others.
  assert.deepEqual(settled.sort(), [1, 3]);
});

// ---------------------------------------------------------------------------
// CircleX402PaymentVerifier verify-gate
// ---------------------------------------------------------------------------

const REQUIREMENT: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:5042002",
  asset: "USDC",
  amount: "1",
  payTo: "0x000000000000000000000000000000000000aaaa",
  maxTimeoutSeconds: 604_900,
  extra: {},
} as unknown as PaymentRequirements;

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session_1",
    articleId: "art-1",
    creatorId: "creator-a",
    wordsDelivered: 0,
    paymentRequired: { accepts: [REQUIREMENT] },
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as unknown as SessionRecord;
}

function makeResourceServer(overrides: Partial<ResourceServerLike> = {}): ResourceServerLike {
  return {
    initialize: async () => {},
    findMatchingRequirements: (available) => available[0],
    verifyPayment: async () => ({ isValid: true, payer: "0x00000000000000000000000000000000000000bb" }),
    settlePayment: async () => ({ success: true, transaction: "transfer-uuid", payer: "0x00000000000000000000000000000000000000bb" }),
    createPaymentRequiredResponse: async () => ({}) as never,
    buildPaymentRequirementsFromOptions: async () => [],
    ...overrides,
  };
}

const payment = { paymentPayload: { x402Version: 2, payload: {}, accepted: {} } } as never;

test("verify-gate releases the word on a valid authorization without settling on-path", async () => {
  let settleCalls = 0;
  const outcomes: SettlementOutcome[] = [];
  const verifier = new CircleX402PaymentVerifier({
    onSettled: (outcome) => {
      outcomes.push(outcome);
    },
    resourceServer: makeResourceServer({
      settlePayment: async () => {
        settleCalls += 1;
        return { success: true, transaction: "transfer-uuid", payer: "0x00000000000000000000000000000000000000bb" };
      },
    }),
  });

  const result = await verifier.verify({ session: makeSession(), wordPaymentAtomic: 1n, payment });
  assert.equal(result.accepted, true);
  assert.equal(result.amountAtomic, "1");
  assert.equal(result.buyerWalletAddress, "0x00000000000000000000000000000000000000bb");
  // Settlement is deferred — no settle on the response path, no UUID yet.
  assert.equal(settleCalls, 0);
  assert.equal(result.settlementId, undefined);
  assert.equal(result.transferId, undefined);

  // It settles behind the stream and backfills the receipt via onSettled.
  await verifier.flush();
  assert.equal(settleCalls, 1);
  assert.equal(outcomes.length, 1);
  const outcome = outcomes[0]!;
  assert.equal(outcome.success, true);
  assert.equal(outcome.sequence, 0);
  assert.equal(outcome.transferId, "transfer-uuid");
});

test("verify-gate rejects an invalid authorization and never queues settlement", async () => {
  let settleCalls = 0;
  const verifier = new CircleX402PaymentVerifier({
    resourceServer: makeResourceServer({
      verifyPayment: async () => ({ isValid: false, invalidReason: "insufficient_funds" }),
      settlePayment: async () => {
        settleCalls += 1;
        return { success: true, transaction: "x" };
      },
    }),
  });

  const result = await verifier.verify({ session: makeSession(), wordPaymentAtomic: 1n, payment });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "insufficient_funds");
  await verifier.flush();
  assert.equal(settleCalls, 0);
});

test("a failed batched settlement halts further words in the session", async () => {
  const outcomes: SettlementOutcome[] = [];
  const verifier = new CircleX402PaymentVerifier({
    onSettled: (outcome) => {
      outcomes.push(outcome);
    },
    resourceServer: makeResourceServer({
      settlePayment: async () => ({ success: false, errorReason: "balance_drained", transaction: "" }),
    }),
  });

  // First word verifies and is released.
  const first = await verifier.verify({ session: makeSession({ wordsDelivered: 0 }), wordPaymentAtomic: 1n, payment });
  assert.equal(first.accepted, true);

  // Its settlement fails behind the stream.
  await verifier.flush();
  assert.equal(outcomes.length, 1);
  const failure = outcomes[0]!;
  assert.equal(failure.success, false);
  assert.equal(failure.reason, "balance_drained");

  // The next word for the same session is refused, capping unsettled exposure.
  const second = await verifier.verify({ session: makeSession({ wordsDelivered: 1 }), wordPaymentAtomic: 1n, payment });
  assert.equal(second.accepted, false);
  assert.equal(second.reason, "prior_settlement_failed");
});

test("synchronousSettlement settles inline and returns the transfer id immediately", async () => {
  let settleCalls = 0;
  const verifier = new CircleX402PaymentVerifier({
    synchronousSettlement: true,
    resourceServer: makeResourceServer({
      settlePayment: async () => {
        settleCalls += 1;
        return { success: true, transaction: "inline-uuid", payer: "0x00000000000000000000000000000000000000bb" };
      },
    }),
  });

  const result = await verifier.verify({ session: makeSession(), wordPaymentAtomic: 1n, payment });
  assert.equal(result.accepted, true);
  assert.equal(settleCalls, 1);
  assert.equal(result.transferId, "inline-uuid");
  assert.equal(result.settlementId, "inline-uuid");
});

// ---------------------------------------------------------------------------
// Chunk/bundle requirement matching (regression for
// payment_does_not_match_session_terms on the default bundled stream mode)
// ---------------------------------------------------------------------------

// Faithful re-implementation of @x402/core's `paymentRequirementsMatchAccepted`:
// requirement core must deep-equal the signed payload's accepted core, and the
// requirement's `extra` must be a subset of the signed `extra`. The default test
// double returns `available[0]`, which masks the real matching behavior.
function matchesAccepted(required: Record<string, unknown>, accepted: Record<string, unknown>): boolean {
  const { extra: requiredExtra, ...requiredCore } = required;
  const { extra: acceptedExtra, ...acceptedCore } = accepted;
  if (!isDeepStrictEqual(requiredCore, acceptedCore)) return false;
  if (requiredExtra === undefined) return true;
  return objectContainsSubset(requiredExtra, acceptedExtra);
}

function objectContainsSubset(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    return isDeepStrictEqual(expected, actual);
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }
  const actualRecord = actual as Record<string, unknown>;
  return Object.entries(expected as Record<string, unknown>).every(([key, value]) => {
    if (!Object.prototype.hasOwnProperty.call(actualRecord, key)) return value === undefined;
    return objectContainsSubset(value, actualRecord[key]);
  });
}

const faithfulMatcher: ResourceServerLike["findMatchingRequirements"] = (available, payload) =>
  available.find((requirement) =>
    matchesAccepted(
      requirement as unknown as Record<string, unknown>,
      (payload as unknown as { accepted: Record<string, unknown> }).accepted,
    ),
  );

const PER_WORD_REQUIREMENT = {
  scheme: "exact",
  network: "eip155:5042002",
  asset: "USDC",
  amount: "1",
  payTo: "0x000000000000000000000000000000000000aaaa",
  maxTimeoutSeconds: 604_900,
  extra: {
    sessionId: "session_1",
    articleId: "art-1",
    sequence: 0,
    meteringUnit: "word",
    amountAtomic: "1",
    asset: "USDC",
    payTo: "0x000000000000000000000000000000000000aaaa",
    nonce: "session_1:0",
    idempotencyKey: "session_1:0",
  },
} as unknown as PaymentRequirements;

test("verify accepts a chunk authorization whose signed extra is chunk-scoped", async () => {
  const verifier = new CircleX402PaymentVerifier({
    resourceServer: makeResourceServer({ findMatchingRequirements: faithfulMatcher }),
  });

  // The buyer signs a 5-word chunk: amount and extra are overridden the way the
  // agent SDK's `withChunkRequirement` does, including chunk-scoped nonce/key.
  const chunkAccepted = {
    ...PER_WORD_REQUIREMENT,
    amount: "5",
    extra: {
      ...(PER_WORD_REQUIREMENT.extra as Record<string, unknown>),
      amountAtomic: "5",
      maxWords: 5,
      sequence: 0,
      authorizationMode: "chunk",
      nonce: "session_1:0:5",
      idempotencyKey: "session_1:0:5",
    },
  };
  const chunkPayment = {
    paymentPayload: { x402Version: 2, accepted: chunkAccepted, payload: {} },
  } as never;

  const session = makeSession({
    paymentRequired: { accepts: [PER_WORD_REQUIREMENT] },
    pricePerWordAtomic: 1n,
    gatewayFeeBps: 0,
  } as Partial<SessionRecord>);

  // Server passes the whole-chunk amount (wordPaymentAtomic * maxWords) as `wordPaymentAtomic`.
  const result = await verifier.verify({ session, wordPaymentAtomic: 5n, payment: chunkPayment });
  assert.equal(result.accepted, true, result.accepted ? "" : `rejected: ${result.reason}`);
  assert.equal(result.amountAtomic, "5");
});
