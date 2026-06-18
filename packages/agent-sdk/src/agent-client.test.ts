import { test } from "node:test";
import assert from "node:assert/strict";
import { RubiconClient } from "./agent-client.js";
import type { AgentPaymentEngine } from "./payment-engine.js";

const paymentEngine: AgentPaymentEngine = {
  async createWordPayment() {
    return { paymentPayload: { ok: true } };
  },
};

const chunkPaymentEngine: AgentPaymentEngine = {
  async createWordPayment() {
    throw new Error("word fallback should not be used");
  },
  async createChunkPayment(_session, input) {
    return {
      paymentPayload: { amountAtomic: `${input.maxWords}` },
      maxWords: input.maxWords,
    };
  },
};

test("run receipt preserves Gateway settlement receipt fields", async () => {
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith("/v1/sessions")) {
      return jsonResponse({
        sessionId: "session_1",
        state: "active",
        article: article(),
        navigation: navigation(),
        pricePerWordAtomic: "1",
        maxArticlePriceAtomic: "10",
        conversationId: "conversation_1",
        wordPaymentAtomic: "1",
        gatewayFeeBps: 0,
        paymentRequired: { scheme: "exact" },
        expiresAt: "2026-06-18T12:00:00.000Z",
        wordsPaid: 0,
        wordsDelivered: 0,
        paidAtomic: "0",
      });
    }
    if (url.endsWith("/v1/sessions/session_1/payments")) {
      return jsonResponse({
        accepted: true,
        sequence: 0,
        word: "Rubicon",
        priceAtomic: "1",
        wordsPaid: 1,
        wordsDelivered: 1,
        paidAtomic: "1",
        completed: true,
        transactionHashes: [],
        settlementIds: ["settlement_1"],
        payment: {
          paymentId: "payment_1",
          sessionId: "session_1",
          articleId: "article_1",
          sequence: 0,
          meteringUnit: "word",
          amountAtomic: "1",
          currency: "USDC",
          network: "eip155:5042002",
          payTo: "0x3333333333333333333333333333333333333333",
          transactionHashes: [],
          settlementIds: ["settlement_1"],
          buyerWalletAddress: "0x2222222222222222222222222222222222222222",
          settledAt: "2026-06-18T12:00:00.000Z",
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  const client = new RubiconClient({
    baseUrl: "http://rubicon.test",
    paymentEngine,
    fetch: fetcher,
  });

  const receipt = await client.run({
    articleId: "article_1",
    maxSpendAtomic: "10",
  });

  assert.deepEqual(receipt.transactionHashes, []);
  assert.deepEqual(receipt.settlementIds, ["settlement_1"]);
  assert.equal(receipt.buyerWalletAddress, "0x2222222222222222222222222222222222222222");
  assert.equal(receipt.sellerPayTo, "0x3333333333333333333333333333333333333333");
  assert.equal(receipt.network, "eip155:5042002");
});

test("run can consume chunk stream while preserving per-word receipt fields", async () => {
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url.endsWith("/v1/sessions")) {
      return jsonResponse({
        sessionId: "session_1",
        state: "active",
        article: article(),
        navigation: navigation(),
        pricePerWordAtomic: "1",
        maxArticlePriceAtomic: "10",
        conversationId: "conversation_1",
        wordPaymentAtomic: "1",
        gatewayFeeBps: 0,
        paymentRequired: { accepts: [{ amount: "1" }] },
        expiresAt: "2026-06-18T12:00:00.000Z",
        wordsPaid: 0,
        wordsDelivered: 0,
        paidAtomic: "0",
      });
    }
    if (url.endsWith("/v1/sessions/session_1/stream")) {
      const body = JSON.parse(String(init?.body)) as { maxWords: number };
      assert.equal(body.maxWords, 3);
      return jsonResponse({
        accepted: true,
        words: [
          { sequence: 0, word: "Rubicon", priceAtomic: "1", payment: payment(0, "Rubicon") },
          { sequence: 1, word: "streams", priceAtomic: "1", payment: payment(1, "streams") },
          { sequence: 2, word: "chunks", priceAtomic: "1", payment: payment(2, "chunks") },
        ],
        text: "Rubicon streams chunks",
        wordsPaid: 3,
        wordsDelivered: 3,
        paidAtomic: "3",
        completed: true,
        settlementIds: ["settlement_chunk"],
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  const client = new RubiconClient({
    baseUrl: "http://rubicon.test",
    paymentEngine: chunkPaymentEngine,
    fetch: fetcher,
  });

  const receipt = await client.run({
    articleId: "article_1",
    maxSpendAtomic: "10",
    chunkWords: 3,
  });

  assert.equal(receipt.text, "Rubicon streams chunks");
  assert.equal(receipt.wordsRead, 3);
  assert.equal(receipt.amountPaidAtomic, "3");
  assert.equal(receipt.payments.length, 3);
  assert.deepEqual(receipt.settlementIds, ["settlement_chunk"]);
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function article() {
  return {
    articleId: "article_1",
    creatorId: "creator_1",
    creatorUsername: "creator",
    title: "Title",
    author: "Author",
    state: "published",
    totalWords: 1,
    pricePerWordAtomic: "1",
    maxArticlePriceAtomic: "1",
    sections: [],
  };
}

function navigation() {
  return {
    articleId: "article_1",
    sections: [],
    sellerAgent: {
      recommendedSectionId: "intro",
      alternativeSectionIds: [],
      rationale: "",
      safeHints: [],
      withheld: [],
    },
    stopConditions: [],
  };
}

function payment(sequence: number, word: string) {
  return {
    paymentId: `payment_${sequence}`,
    sessionId: "session_1",
    articleId: "article_1",
    sequence,
    meteringUnit: "word",
    amountAtomic: "1",
    currency: "USDC",
    settledAt: "2026-06-18T12:00:00.000Z",
    word,
  };
}
