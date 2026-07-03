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
        article: article(3),
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
          { sequence: 0, word: "Rubicon", priceAtomic: "1" },
          { sequence: 1, word: "streams", priceAtomic: "1" },
          { sequence: 2, word: "chunks", priceAtomic: "1" },
        ],
        text: "Rubicon streams chunks",
        wordsPaid: 3,
        wordsDelivered: 3,
        paidAtomic: "3",
        completed: true,
        settlementIds: ["settlement_chunk"],
        payment: {
          ...payment(0, "Rubicon streams chunks"),
          amountAtomic: "3",
          bundleSequence: 0,
          wordsDelivered: 3,
          pricePerWordAtomic: "1",
          text: "Rubicon streams chunks",
        },
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
    granularity: 3,
  });

  assert.equal(receipt.text, "Rubicon streams chunks");
  assert.equal(receipt.wordsRead, 3);
  assert.equal(receipt.amountPaidAtomic, "3");
  assert.equal(receipt.payments.length, 1);
  assert.equal(receipt.payments[0]?.amountAtomic, "3");
  assert.equal(receipt.payments[0]?.wordsDelivered, 3);
  assert.deepEqual(receipt.settlementIds, ["settlement_chunk"]);
});

test("free run accepts a zero cap, skips the payment engine, and returns an exact zero-spend receipt", async () => {
  let paymentCalls = 0;
  const rejectingPaymentEngine: AgentPaymentEngine = {
    async createWordPayment() {
      paymentCalls += 1;
      throw new Error("free read invoked word payment");
    },
    async createChunkPayment() {
      paymentCalls += 1;
      throw new Error("free read invoked chunk payment");
    },
  };
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url.endsWith("/v1/sessions")) {
      return jsonResponse({
        sessionId: "free_session",
        state: "open",
        accessMode: "free",
        article: { ...article(3), accessMode: "free", pricePerWordAtomic: "0", maxArticlePriceAtomic: "0" },
        navigation: navigation(),
        pricePerWordAtomic: "0",
        maxArticlePriceAtomic: "0",
        conversationId: "free_conversation",
        wordPaymentAtomic: "0",
        gatewayFeeBps: 0,
        expiresAt: "2026-06-18T12:00:00.000Z",
        wordsAuthorized: 3,
        wordsPaid: 0,
        wordsDelivered: 0,
        paidAtomic: "0",
      });
    }
    if (url.endsWith("/v1/sessions/free_session/stream")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.maxWords, 3);
      assert.equal(body.paymentPayload, undefined);
      return jsonResponse({
        accepted: true,
        words: [
          { sequence: 0, word: "free", priceAtomic: "0" },
          { sequence: 1, word: "and", priceAtomic: "0" },
          { sequence: 2, word: "clear", priceAtomic: "0" },
        ],
        text: "free and clear",
        wordsPaid: 0,
        wordsDelivered: 3,
        paidAtomic: "0",
        completed: true,
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  const client = new RubiconClient({ baseUrl: "http://rubicon.test", paymentEngine: rejectingPaymentEngine, fetch: fetcher });
  const receipt = await client.run({ articleId: "article_1", maxSpendAtomic: "0", granularity: "article" });
  assert.equal(paymentCalls, 0);
  assert.equal(receipt.text, "free and clear");
  assert.equal(receipt.wordsRead, 3);
  assert.equal(receipt.amountPaidAtomic, "0");
  assert.deepEqual(receipt.payments, []);
  assert.deepEqual(receipt.transactionHashes, []);
  assert.deepEqual(receipt.settlementIds, []);
  assert.equal(receipt.buyerWalletAddress, undefined);
  assert.equal(receipt.sellerPayTo, undefined);
  assert.equal(receipt.network, undefined);
  assert.equal(receipt.completed, true);
});

test("read defaults to bundled mode and clamps bundle size to remaining article words", async () => {
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url.endsWith("/v1/sessions")) {
      return jsonResponse({
        sessionId: "session_1",
        state: "active",
        article: article(15),
        navigation: navigation(),
        pricePerWordAtomic: "1",
        maxArticlePriceAtomic: "15",
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
      assert.equal(body.maxWords, 15);
      return jsonResponse({
        accepted: true,
        words: Array.from({ length: 15 }, (_, sequence) => ({ sequence, word: `w${sequence + 1}`, priceAtomic: "1" })),
        text: Array.from({ length: 15 }, (_, index) => `w${index + 1}`).join(" "),
        wordsPaid: 15,
        wordsDelivered: 15,
        paidAtomic: "15",
        completed: true,
        payment: { ...payment(0, "bundle"), amountAtomic: "15", wordsDelivered: 15, pricePerWordAtomic: "1" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  const client = new RubiconClient({ baseUrl: "http://rubicon.test", paymentEngine: { ...chunkPaymentEngine, createWordPayment: paymentEngine.createWordPayment }, fetch: fetcher });
  const events = [];
  for await (const event of client.read({ articleId: "article_1", maxSpendAtomic: "100", granularity: "article" })) {
    events.push(event.type);
  }
  assert.deepEqual(events, ["session.started", "article.bundle", "article.usage", "article.completed"]);
});

test("bundled mode clamps bundle size to budget and max words", async () => {
  const seenMaxWords: number[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url.endsWith("/v1/sessions")) {
      return jsonResponse({
        sessionId: "session_1",
        state: "active",
        article: article(100),
        navigation: navigation(),
        pricePerWordAtomic: "2",
        maxArticlePriceAtomic: "200",
        conversationId: "conversation_1",
        wordPaymentAtomic: "2",
        gatewayFeeBps: 0,
        paymentRequired: { accepts: [{ amount: "2" }] },
        expiresAt: "2026-06-18T12:00:00.000Z",
        wordsPaid: 0,
        wordsDelivered: 0,
        paidAtomic: "0",
      });
    }
    if (url.endsWith("/v1/sessions/session_1/stream")) {
      const body = JSON.parse(String(init?.body)) as { maxWords: number };
      seenMaxWords.push(body.maxWords);
      return jsonResponse({
        accepted: true,
        words: Array.from({ length: body.maxWords }, (_, sequence) => ({ sequence, word: `w${sequence + 1}`, priceAtomic: "2" })),
        text: "ok",
        wordsPaid: body.maxWords,
        wordsDelivered: body.maxWords,
        paidAtomic: `${body.maxWords * 2}`,
        completed: true,
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  const client = new RubiconClient({
    baseUrl: "http://rubicon.test",
    paymentEngine: { ...chunkPaymentEngine, createWordPayment: paymentEngine.createWordPayment },
    fetch: fetcher,
  });
  await client.run({ articleId: "article_1", maxSpendAtomic: "12", maxWords: 10 });
  assert.deepEqual(seenMaxWords, [6]);
});

test("explicit word stream mode keeps legacy word events", async () => {
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith("/v1/sessions")) {
      return jsonResponse({
        sessionId: "session_1",
        state: "active",
        article: article(1),
        navigation: navigation(),
        pricePerWordAtomic: "1",
        maxArticlePriceAtomic: "1",
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
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  const client = new RubiconClient({
    baseUrl: "http://rubicon.test",
    paymentEngine: { ...chunkPaymentEngine, createWordPayment: paymentEngine.createWordPayment },
    fetch: fetcher,
  });
  const events = [];
  for await (const event of client.read({ articleId: "article_1", maxSpendAtomic: "10", streamMode: "word" })) {
    events.push(event.type);
  }
  assert.deepEqual(events, ["session.started", "article.word", "article.usage", "article.completed"]);
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function article(totalWords = 1) {
  return {
    articleId: "article_1",
    creatorId: "creator_1",
    creatorUsername: "creator",
    title: "Title",
    author: "Author",
    state: "published",
    accessMode: "paid",
    totalWords,
    pricePerWordAtomic: "1",
    maxArticlePriceAtomic: `${totalWords}`,
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
