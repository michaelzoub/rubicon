import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createGateway } from "./server.js";
import { encodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import {
  InMemoryLedgerRepository,
  InMemoryPublishedArticleRepository,
  type ArticleFixture,
} from "./repositories/in-memory.js";
import { resolveSupabaseConfigFromEnv, SupabasePublishedArticleRepository, type SupabaseReader } from "./repositories/supabase.js";
import { assertRailwayCompatibleDatabaseUrl, describeDatabaseUrl, resolvePgPoolConfig } from "./repositories/postgres.js";
import type { StartSessionResponse, StreamPaymentResponse } from "@rubicon-caliga/core";
import type { PaymentVerifier } from "./payments/types.js";

const PRICE = 5n; // atomic USDC per word
const PLAIN_BODY = Array.from({ length: 200 }, (_, index) => `w${index + 1}`).join(" ");
const PLAIN_WORDS = PLAIN_BODY.split(" ");

function plainArticle(overrides: Partial<ArticleFixture> = {}): ArticleFixture {
  return {
    id: "art-plain",
    creatorId: "creator-a",
    creatorUsername: "alice",
    title: "Plain Article",
    author: "Alice",
    state: "live",
    pricePerWordAtomic: PRICE,
    body: PLAIN_BODY,
    ...overrides,
  };
}

function setup(input?: {
  articles?: ArticleFixture[];
  wallets?: { creatorId: string; address: `0x${string}`; network?: string; verified?: boolean }[];
  gatewayFeeBps?: number;
  paymentVerifier?: PaymentVerifier;
}): {
  app: FastifyInstance;
  published: InMemoryPublishedArticleRepository;
  ledger: InMemoryLedgerRepository;
} {
  const published = new InMemoryPublishedArticleRepository({
    articles: input?.articles ?? [plainArticle()],
    wallets:
      input?.wallets?.map((wallet) => ({
        creatorId: wallet.creatorId,
        address: wallet.address,
        network: wallet.network ?? "eip155:5042002",
        verified: wallet.verified ?? true,
      })) ?? [
        { creatorId: "creator-a", address: "0x000000000000000000000000000000000000aaaa", network: "eip155:5042002", verified: true },
      ],
  });
  const ledger = new InMemoryLedgerRepository();
  const app = createGateway({
    articleRepository: published,
    ledger,
    sessionTtlMs: 60_000,
    gatewayFeeBps: input?.gatewayFeeBps ?? 0,
    gatewayBaseUrl: "http://test",
    paymentVerifier: input?.paymentVerifier,
    logger: false,
  });
  return { app, published, ledger };
}

async function startSession(app: FastifyInstance, articleId = "art-plain", maxAmountAtomic = "1000000"): Promise<StartSessionResponse> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    payload: { articleId, budget: { currency: "USDC", maxAmountAtomic } },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as StartSessionResponse;
}

async function pay(
  app: FastifyInstance,
  sessionId: string,
  opts?: { payload?: Record<string, unknown>; key?: string },
) {
  return app.inject({
    method: "POST",
    url: `/v1/sessions/${sessionId}/payments`,
    payload: { paymentPayload: opts?.payload ?? {}, idempotencyKey: opts?.key },
  });
}

interface FakeCreatorRow {
  id: string;
  username: string;
}

interface FakeSectionRow {
  id: string;
  article_id: string;
  section_id: string;
  heading: string;
  level: number;
  word_start: number;
  word_count: number;
  ordinal: number;
}

interface FakeArticleRow {
  id: string;
  creator_id: string;
  title: string;
  author: string;
  state: string;
  access_mode: "free" | "paid";
  price_per_word_atomic: string;
  max_article_price_atomic: string | null;
  total_words: number;
  revision: number;
  seller_agent_config: null;
  body: string;
  created_at: string;
  updated_at: string;
}

interface FakeWalletRow {
  creator_id: string;
  address: string;
  network: string;
  verified: boolean;
}

class FakeSupabase implements SupabaseReader {
  creators: FakeCreatorRow[] = [{ id: "creator-db", username: "dbalice" }];
  articles: FakeArticleRow[] = [
    {
      id: "art-db",
      creator_id: "creator-db",
      title: "Database Article",
      author: "DB Alice",
      state: "live",
      access_mode: "paid",
      price_per_word_atomic: "7",
      max_article_price_atomic: null,
      total_words: 6,
      revision: 1,
      seller_agent_config: null,
      body: "one two three four five six",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  ];
  sections: FakeSectionRow[] = [
    { id: "sec-late", article_id: "art-db", section_id: "later", heading: "Later", level: 2, word_start: 3, word_count: 3, ordinal: 2 },
    { id: "sec-start", article_id: "art-db", section_id: "start", heading: "Start", level: 1, word_start: 0, word_count: 3, ordinal: 1 },
  ];
  wallets: FakeWalletRow[] = [
    { creator_id: "creator-db", address: "0x0000000000000000000000000000000000000db0", network: "eip155:5042002", verified: true },
  ];
  error: { message: string; details?: string } | null = null;

  from<T = unknown>(table: string) {
    return new FakeSupabaseQuery<T>(this, table);
  }

  rpc<T = unknown>(_fn: string, _args: Record<string, unknown>): Promise<{ data: T | null; error: { message: string; details?: string } | null }> {
    return Promise.resolve({ data: null, error: null });
  }

  rowsFor(table: string): unknown[] {
    if (this.error) {
      return [];
    }
    if (table === "articles") {
      return this.articles.map((article) => ({
        ...article,
        creator: this.creators.find((creator) => creator.id === article.creator_id) ?? null,
        sections: this.sections.filter((section) => section.article_id === article.id),
      }));
    }
    if (table === "article_sections") {
      return this.sections;
    }
    if (table === "creator_wallets") {
      return this.wallets;
    }
    return [];
  }
}

class FakeSupabaseQuery<T> implements PromiseLike<{ data: T[] | null; error: { message: string; details?: string } | null }> {
  private readonly filters: Array<{ column: string; value: unknown }> = [];
  private readonly orders: Array<{ column: string; ascending: boolean }> = [];
  private limitCount: number | undefined;

  constructor(
    private readonly db: FakeSupabase,
    private readonly table: string,
  ) {}

  select(): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ column, value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orders.push({ column, ascending: options?.ascending ?? true });
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  then<TResult1 = { data: T[] | null; error: { message: string; details?: string } | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: T[] | null; error: { message: string; details?: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute(): { data: T[] | null; error: { message: string; details?: string } | null } {
    if (this.db.error) {
      return { data: null, error: this.db.error };
    }
    let rows = this.db.rowsFor(this.table);
    for (const filter of this.filters) {
      rows = rows.filter((row) => valueFor(row, filter.column) === filter.value);
    }
    for (const order of this.orders) {
      rows = [...rows].sort((a, b) => {
        const left = valueFor(a, order.column);
        const right = valueFor(b, order.column);
        return (Number(left) - Number(right)) * (order.ascending ? 1 : -1);
      });
    }
    if (this.limitCount !== undefined) {
      rows = rows.slice(0, this.limitCount);
    }
    return { data: rows as T[], error: null };
  }
}

function valueFor(row: unknown, column: string): unknown {
  return (row as Record<string, unknown>)[column];
}

test("1: one accepted word payment releases exactly one word", async () => {
  const { app, ledger } = setup();
  const session = await startSession(app);
  const res = await pay(app, session.sessionId);
  assert.equal(res.statusCode, 200);
  const body = res.json() as StreamPaymentResponse;
  assert.equal(body.wordsDelivered, 1);
  assert.equal(body.word, PLAIN_WORDS[0]);
  assert.equal(body.paidAtomic, `${PRICE}`);
  assert.equal((await ledger.listDeliveries(session.sessionId)).length, 1);
  await app.close();
});

test("free session creation needs no wallet and never creates a payment requirement", async () => {
  let requirementCalls = 0;
  let verificationCalls = 0;
  const { app, ledger } = setup({
    articles: [plainArticle({ accessMode: "free", pricePerWordAtomic: 0n, body: "free words here" })],
    wallets: [],
    paymentVerifier: {
      async createPaymentRequired() {
        requirementCalls += 1;
        throw new Error("free content entered payment requirement creation");
      },
      async verify() {
        verificationCalls += 1;
        throw new Error("free content entered payment verification");
      },
    },
  });

  const session = await startSession(app, "art-plain", "0");
  assert.equal(session.accessMode, "free");
  assert.equal(session.wordPaymentAtomic, "0");
  assert.equal(session.wordsAuthorized, 3);
  assert.equal(session.paymentRequired, undefined);
  assert.equal(session.authorizationRequired, undefined);
  assert.equal(session.article.paymentTerms, undefined);
  assert.equal(requirementCalls, 0);
  assert.equal(verificationCalls, 0);
  assert.equal((await ledger.getSession(session.sessionId))?.sellerWallet, undefined);
  await app.close();
});

test("free per-word reads are idempotent usage records with no payment rows", async () => {
  let verificationCalls = 0;
  let flushCalls = 0;
  const { app, ledger } = setup({
    articles: [plainArticle({ accessMode: "free", pricePerWordAtomic: 0n, body: "alpha beta" })],
    wallets: [],
    paymentVerifier: {
      async verify() {
        verificationCalls += 1;
        throw new Error("free content entered payment verification");
      },
      async flush() {
        flushCalls += 1;
        throw new Error("free content entered payment settlement flush");
      },
    },
  });
  const session = await startSession(app, "art-plain", "0");
  const first = await app.inject({
    method: "POST",
    url: `/v1/sessions/${session.sessionId}/payments`,
    payload: { idempotencyKey: "free-word-0" },
  });
  const retry = await app.inject({
    method: "POST",
    url: `/v1/sessions/${session.sessionId}/payments`,
    payload: { idempotencyKey: "free-word-0" },
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(retry.json(), first.json());
  const body = first.json() as StreamPaymentResponse;
  assert.equal(body.word, "alpha");
  assert.equal(body.priceAtomic, "0");
  assert.equal(body.wordsPaid, 0);
  assert.equal(body.wordsDelivered, 1);
  assert.equal(body.paidAtomic, "0");
  assert.equal(body.payment, undefined);
  assert.equal(body.transactionHash, undefined);
  assert.equal(body.settlementId, undefined);
  assert.equal(verificationCalls, 0);
  assert.equal(flushCalls, 0);
  assert.equal((await ledger.listDeliveries(session.sessionId)).length, 1);
  assert.equal((await ledger.listPayments(session.sessionId)).length, 0);
  await app.close();
});

test("free chunk, section, and full-article reads deliver exact ranges without payment", async () => {
  const sections = [
    { id: "s1", articleId: "art-plain", sectionId: "first", heading: "First", level: 1, wordStart: 0, wordCount: 3, ordinal: 0 },
    { id: "s2", articleId: "art-plain", sectionId: "second", heading: "Second", level: 1, wordStart: 3, wordCount: 3, ordinal: 1 },
  ];
  let verificationCalls = 0;
  let flushCalls = 0;
  const { app, ledger } = setup({
    articles: [plainArticle({ accessMode: "free", pricePerWordAtomic: 0n, body: "one two three four five six", sections })],
    wallets: [],
    paymentVerifier: {
      async verify() {
        verificationCalls += 1;
        throw new Error("free content entered payment verification");
      },
      async flush() {
        flushCalls += 1;
        throw new Error("free content entered payment settlement flush");
      },
    },
  });

  const sectionResponse = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    payload: { articleId: "art-plain", sectionId: "second", budget: { currency: "USDC", maxAmountAtomic: "0" } },
  });
  assert.equal(sectionResponse.statusCode, 201, sectionResponse.body);
  const sectionSession = sectionResponse.json() as StartSessionResponse;
  const sectionRead = await app.inject({
    method: "POST",
    url: `/v1/sessions/${sectionSession.sessionId}/stream`,
    payload: { maxWords: 99, idempotencyKey: "free-section" },
  });
  const sectionBody = sectionRead.json() as { text: string; wordsDelivered: number; wordsPaid: number; paidAtomic: string; payment?: unknown; completed: boolean };
  assert.equal(sectionBody.text, "four five six");
  assert.equal(sectionBody.wordsDelivered, 3);
  assert.equal(sectionBody.wordsPaid, 0);
  assert.equal(sectionBody.paidAtomic, "0");
  assert.equal(sectionBody.payment, undefined);
  assert.equal(sectionBody.completed, true);

  const fullSession = await startSession(app, "art-plain", "0");
  const firstChunk = await app.inject({
    method: "POST",
    url: `/v1/sessions/${fullSession.sessionId}/stream`,
    payload: { maxWords: 2, idempotencyKey: "free-chunk" },
  });
  assert.equal((firstChunk.json() as { text: string }).text, "one two");
  const firstChunkRetry = await app.inject({
    method: "POST",
    url: `/v1/sessions/${fullSession.sessionId}/stream`,
    payload: { maxWords: 2, idempotencyKey: "free-chunk" },
  });
  assert.deepEqual(firstChunkRetry.json(), firstChunk.json());
  assert.equal((await ledger.listDeliveries(fullSession.sessionId)).length, 2);
  const rest = await app.inject({
    method: "POST",
    url: `/v1/sessions/${fullSession.sessionId}/stream`,
    payload: { maxWords: 99, idempotencyKey: "free-rest" },
  });
  assert.equal((rest.json() as { text: string; completed: boolean }).text, "three four five six");
  assert.equal((rest.json() as { completed: boolean }).completed, true);
  assert.equal(verificationCalls, 0);
  assert.equal(flushCalls, 0);
  assert.equal((await ledger.listDeliveries(fullSession.sessionId)).length, 6);
  assert.equal((await ledger.listPayments(fullSession.sessionId)).length, 0);
  await app.close();
});

test("free access is explicit: inaccessible states stay hidden and zero-priced paid content is rejected", async () => {
  const hidden = (["draft", "paused", "deleted"] as const).map((state) =>
    plainArticle({ id: `free-${state}`, state, accessMode: "free", pricePerWordAtomic: 0n }),
  );
  const { app } = setup({
    articles: [...hidden, plainArticle({ id: "unpriced-paid", accessMode: "paid", pricePerWordAtomic: 0n })],
  });
  for (const article of hidden) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { articleId: article.id, budget: { currency: "USDC", maxAmountAtomic: "0" } },
    });
    assert.equal(response.statusCode, 404);
  }
  const unpriced = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    payload: { articleId: "unpriced-paid", budget: { currency: "USDC", maxAmountAtomic: "0" } },
  });
  assert.equal(unpriced.statusCode, 409);
  assert.deepEqual(unpriced.json(), { error: "article_pricing_not_configured" });
  await app.close();
});

test("public articles expose seller payment terms", async () => {
  const { app } = setup();
  const res = await app.inject({ method: "GET", url: "/v1/repository" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { articles: Array<{ paymentTerms?: Record<string, unknown> }> };
  assert.equal(body.articles[0]?.paymentTerms?.asset, "USDC");
  assert.equal(body.articles[0]?.paymentTerms?.network, "eip155:5042002");
  assert.equal(body.articles[0]?.paymentTerms?.circleChain, "ARC-TESTNET");
  assert.equal(body.articles[0]?.paymentTerms?.environment, "testnet");
  assert.match(String(body.articles[0]?.paymentTerms?.fundingMethod), /testnet faucet/);
  assert.equal(body.articles[0]?.paymentTerms?.payTo, "0x000000000000000000000000000000000000aaaa");
  assert.equal(body.articles[0]?.paymentTerms?.meteringUnit, "word");
  await app.close();
});

test("session returns exactly one next-word x402 requirement with ARC-TESTNET terms", async () => {
  const payTo = "0x000000000000000000000000000000000000aaaa";
  const { app } = setup({
    paymentVerifier: {
      async createPaymentRequired(input) {
        const sequence = input.session.wordsDelivered;
        return {
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "eip155:5042002",
              amount: `${PRICE}`,
              asset: "USDC",
              payTo,
              extra: {
                sessionId: input.session.id,
                articleId: input.article.id,
                sequence,
                meteringUnit: "word",
                amountAtomic: `${input.wordPaymentAtomic}`,
                asset: "USDC",
                network: "eip155:5042002",
                payTo,
                expiresAt: input.session.expiresAt.toISOString(),
                nonce: `${input.session.id}:${sequence}`,
                idempotencyKey: `${input.session.id}:${sequence}`,
              },
            },
          ],
          rubicon: {
            sessionId: input.session.id,
            articleId: input.article.id,
            sequence,
            meteringUnit: "word",
            amountAtomic: `${input.wordPaymentAtomic}`,
            asset: "USDC",
            network: "eip155:5042002",
            payTo,
            expiresAt: input.session.expiresAt.toISOString(),
            nonce: `${input.session.id}:${sequence}`,
            idempotencyKey: `${input.session.id}:${sequence}`,
          },
        };
      },
      async verify(input) {
        return {
          accepted: true,
          amountAtomic: `${PRICE}`,
          network: "eip155:5042002",
          payTo,
          transferId: `test_${input.session.id}`,
        };
      },
    },
  });
  const session = await startSession(app, "art-plain", "20000");
  const required = session.paymentRequired as {
    accepts: unknown[];
    rubicon: {
      sessionId: string;
      articleId: string;
      sequence: number;
      meteringUnit: string;
      amountAtomic: string;
      asset: string;
      network: string;
      payTo: string;
      expiresAt: string;
      nonce: string;
      idempotencyKey: string;
    };
  };
  assert.equal(required.accepts.length, 1);
  assert.deepEqual(required.rubicon, {
    sessionId: session.sessionId,
    articleId: "art-plain",
    sequence: 0,
    meteringUnit: "word",
    amountAtomic: `${PRICE}`,
    asset: "USDC",
    network: "eip155:5042002",
    payTo,
    expiresAt: session.expiresAt,
    nonce: `${session.sessionId}:0`,
    idempotencyKey: `${session.sessionId}:0`,
  });
  const res = await pay(app, session.sessionId, { key: `${session.sessionId}:0` });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as StreamPaymentResponse).wordsDelivered, 1);
  await app.close();
});

test("payment endpoint returns a standard x402 challenge before a payment is supplied", async () => {
  const { app } = setup();
  const session = await startSession(app);
  const res = await app.inject({
    method: "POST",
    url: `/v1/sessions/${session.sessionId}/payments`,
  });

  assert.equal(res.statusCode, 402);
  assert.equal(res.headers["payment-required"], encodePaymentRequiredHeader(session.paymentRequired as never));
  assert.deepEqual(res.json(), session.paymentRequired);
  await app.close();
});

test("payment endpoint can be inspected with GET as a standard x402 challenge", async () => {
  const { app } = setup();
  const session = await startSession(app);
  const res = await app.inject({
    method: "GET",
    url: `/v1/sessions/${session.sessionId}/payments`,
  });

  assert.equal(res.statusCode, 402);
  assert.equal(res.headers["payment-required"], encodePaymentRequiredHeader(session.paymentRequired as never));
  assert.deepEqual(res.json(), session.paymentRequired);
  await app.close();
});

test("payment endpoint inspection keeps missing sessions explicit", async () => {
  const { app } = setup();
  const res = await app.inject({
    method: "GET",
    url: "/v1/sessions/missing-session/payments",
  });

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: "session_not_found" });
  await app.close();
});

test("payment endpoint accepts a standard x402 payment signature header", async () => {
  const { app, ledger } = setup();
  const session = await startSession(app);
  const paymentRequired = session.paymentRequired as {
    accepts: Array<{
      scheme: string;
      network: string;
      amount: string;
      asset: string;
      payTo: string;
      maxTimeoutSeconds: number;
      extra: Record<string, unknown>;
    }>;
  };
  const paymentPayload = {
    x402Version: 2,
    accepted: paymentRequired.accepts[0]!,
    payload: {},
  };

  const res = await app.inject({
    method: "POST",
    url: `/v1/sessions/${session.sessionId}/payments`,
    headers: {
      "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentPayload as never),
    },
  });

  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as StreamPaymentResponse;
  assert.equal(body.wordsDelivered, 1);
  assert.equal(body.word, PLAIN_WORDS[0]);
  assert.equal((await ledger.listDeliveries(session.sessionId)).length, 1);
  await app.close();
});

test("payment verifier receives the exact requirement snapshot issued at session start", async () => {
  const issuedRequirement = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:5042002",
        amount: `${PRICE}`,
        payTo: "0x000000000000000000000000000000000000aaaa",
        extra: { author: "Alice", meteringUnit: "word" },
      },
    ],
  };
  let verifiedRequirement: unknown;
  const { app } = setup({
    paymentVerifier: {
      async createPaymentRequired() {
        return issuedRequirement;
      },
      async verify(input) {
        verifiedRequirement = input.session.paymentRequired;
        return {
          accepted: true,
          amountAtomic: `${PRICE}`,
          network: "eip155:5042002",
          payTo: "0x000000000000000000000000000000000000aaaa",
          transferId: `test_${input.session.id}`,
        };
      },
    },
  });

  const session = await startSession(app);
  assert.deepEqual(session.paymentRequired, issuedRequirement);

  const res = await pay(app, session.sessionId);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(verifiedRequirement, issuedRequirement);
  await app.close();
});

test("payment responses include transaction hashes when verifier returns them", async () => {
  const transactionHash = "0xabc123";
  const network = "eip155:5042002";
  const payTo = "0x1111111111111111111111111111111111111111";
  const { app } = setup({
    paymentVerifier: {
      async verify() {
        return {
          accepted: true,
          amountAtomic: `${PRICE}`,
          network,
          payTo,
          transactionHash,
          transactionHashes: [transactionHash],
          settlementId: "gw-settle-1",
          settlementIds: ["gw-settle-1"],
          buyerWalletAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          transferId: transactionHash,
        };
      },
    },
  });
  const session = await startSession(app);
  const res = await pay(app, session.sessionId);
  const body = res.json() as StreamPaymentResponse;
  assert.equal(body.transactionHash, transactionHash);
  assert.deepEqual(body.transactionHashes, [transactionHash]);
  assert.equal(body.transferId, transactionHash);
  assert.equal(body.payment?.meteringUnit, "word");
  assert.equal(body.payment?.sequence, 0);
  assert.equal(body.payment?.amountAtomic, `${PRICE}`);
  assert.equal(body.payment?.currency, "USDC");
  assert.equal(body.payment?.network, network);
  assert.equal(body.payment?.payTo, payTo);
  assert.equal(body.payment?.transactionHash, transactionHash);
  assert.deepEqual(body.payment?.transactionHashes, [transactionHash]);
  assert.equal(body.payment?.settlementId, "gw-settle-1");
  assert.deepEqual(body.payment?.settlementIds, ["gw-settle-1"]);
  assert.equal(body.payment?.buyerWalletAddress, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.deepEqual(JSON.parse(String(res.headers["payment-response"])), body.payment);
  await app.close();
});

test("payment responses do not label Gateway transfer ids as transaction hashes", async () => {
  const transferId = "3c90c3cc-0d44-4b50-8888-8dd25736052a";
  const { app } = setup({
    paymentVerifier: {
      async verify() {
        return {
          accepted: true,
          amountAtomic: `${PRICE}`,
          network: "eip155:5042002",
          payTo: "0x1111111111111111111111111111111111111111",
          settlementId: transferId,
          settlementIds: [transferId],
          buyerWalletAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          transferId,
        };
      },
    },
  });
  const session = await startSession(app);
  const res = await pay(app, session.sessionId);
  const body = res.json() as StreamPaymentResponse;

  assert.equal(body.transactionHash, undefined);
  assert.equal(body.transactionHashes, undefined);
  assert.equal(body.transferId, transferId);
  assert.equal(body.settlementId, transferId);
  assert.deepEqual(body.settlementIds, [transferId]);
  assert.equal(body.payment?.transactionHash, undefined);
  assert.equal(body.payment?.transferId, transferId);
  assert.equal(body.payment?.settlementId, transferId);
  await app.close();
});

test("agent API key protects v1 routes when configured", async () => {
  const previous = process.env.RUBICON_AGENT_API_KEY;
  process.env.RUBICON_AGENT_API_KEY = "test-agent-key";
  const { app } = setup();
  try {
    const unauthorized = await app.inject({
      method: "GET",
      url: "/v1/repository",
    });
    assert.equal(unauthorized.statusCode, 401);

    const authorized = await app.inject({
      method: "GET",
      url: "/v1/repository",
      headers: { authorization: "Bearer test-agent-key" },
    });
    assert.equal(authorized.statusCode, 200);

    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
  } finally {
    if (previous === undefined) {
      delete process.env.RUBICON_AGENT_API_KEY;
    } else {
      process.env.RUBICON_AGENT_API_KEY = previous;
    }
    await app.close();
  }
});

test("repository endpoint returns live article records from Supabase", async () => {
  const supabase = new FakeSupabase();
  supabase.articles.push({
    ...supabase.articles[0]!,
    id: "art-draft-db",
    state: "draft",
    title: "Draft Database Article",
  });
  const app = createGateway({
    articleRepository: new SupabasePublishedArticleRepository(supabase),
    ledger: new InMemoryLedgerRepository(),
    sessionTtlMs: 60_000,
    gatewayBaseUrl: "http://test",
    logger: false,
  });

  const response = await app.inject({ method: "GET", url: "/v1/repository" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    repository: "articles",
    articles: [
      {
        articleId: "art-db",
        creatorId: "creator-db",
        creatorUsername: "dbalice",
        title: "Database Article",
        author: "DB Alice",
        state: "live",
        accessMode: "paid",
        totalWords: 6,
        pricePerWordAtomic: "7",
        maxArticlePriceAtomic: "42",
        paymentTerms: {
          asset: "USDC",
          network: "eip155:5042002",
          networkLabel: "Arc Testnet",
          circleChain: "ARC-TESTNET",
          environment: "testnet",
          fundingMethod:
            "Circle testnet funds on ARC-TESTNET. Use Circle's testnet faucet / Gateway testnet funding flow; do not send mainnet fiat or crypto.",
          payTo: "0x0000000000000000000000000000000000000db0",
          pricePerWordAtomic: "7",
          meteringUnit: "word",
        },
        sections: [
          { sectionId: "start", heading: "Start", level: 1, wordStart: 0, wordCount: 3 },
          { sectionId: "later", heading: "Later", level: 2, wordStart: 3, wordCount: 3 },
        ],
      },
    ],
  });
  await app.close();
});

test("article records clamp drifted total_words and section ranges to the sliceable body", async () => {
  // Stored counts have drifted past the actual body: total_words says 6 and the
  // "later" section claims words 3..5, but the body only holds 3 words. Left
  // unclamped, a buyer would sign an authorization for more words than the
  // gateway can ever slice and the EIP-3009 value would exceed delivery.
  const supabase = new FakeSupabase();
  supabase.articles[0]!.body = "one two three";
  supabase.articles[0]!.total_words = 6;
  const repo = new SupabasePublishedArticleRepository(supabase);

  const article = await repo.getPublishedArticle("art-db");
  assert.ok(article);
  // totalWords is derived from the tokenized body, not the stored 6.
  assert.equal(article.totalWords, 3);
  assert.equal(article.words.length, 3);

  const start = article.sections.find((section) => section.sectionId === "start");
  const later = article.sections.find((section) => section.sectionId === "later");
  // The in-range section is untouched; the drifted one is clamped so its range
  // never exceeds what the gateway can slice (wordStart 3 leaves 0 words).
  assert.deepEqual({ wordStart: start?.wordStart, wordCount: start?.wordCount }, { wordStart: 0, wordCount: 3 });
  assert.deepEqual({ wordStart: later?.wordStart, wordCount: later?.wordCount }, { wordStart: 3, wordCount: 0 });

  // A section starting fully past the body collapses to an empty range at the end.
  supabase.articles[0]!.body = "only one";
  const shrunk = await repo.getPublishedArticle("art-db");
  const startShrunk = shrunk?.sections.find((section) => section.sectionId === "start");
  assert.deepEqual({ wordStart: startShrunk?.wordStart, wordCount: startShrunk?.wordCount }, { wordStart: 0, wordCount: 2 });
  const laterShrunk = shrunk?.sections.find((section) => section.sectionId === "later");
  assert.deepEqual({ wordStart: laterShrunk?.wordStart, wordCount: laterShrunk?.wordCount }, { wordStart: 2, wordCount: 0 });
});

test("Supabase env config prefers the service-role key and falls back to anon", () => {
  // Service-role key wins when present — the server-side gateway reads directly,
  // bypassing RLS.
  assert.deepEqual(
    resolveSupabaseConfigFromEnv({
      SUPABASE_URL: "https://project.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    }),
    { url: "https://project.supabase.co", key: "service-role-key" },
  );

  // An anon/publishable key alone still works when RLS grants anon access.
  assert.deepEqual(
    resolveSupabaseConfigFromEnv({
      SUPABASE_URL: "https://project.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    }),
    { url: "https://project.supabase.co", key: "anon-key" },
  );

  assert.throws(
    () => resolveSupabaseConfigFromEnv({ SUPABASE_URL: "https://project.supabase.co" }),
    /Missing required Supabase environment variable/,
  );
});

test("Railway DATABASE_URL rejects Supabase direct Postgres hosts", () => {
  assert.throws(
    () =>
      assertRailwayCompatibleDatabaseUrl(
        "postgresql://postgres:secret@db.project-ref.supabase.co:5432/postgres?sslmode=no-verify",
        { RAILWAY_ENVIRONMENT: "production" },
      ),
    /connection pooler URL/,
  );

  assert.doesNotThrow(() =>
    assertRailwayCompatibleDatabaseUrl(
      "postgresql://postgres.project-ref:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=no-verify",
      { RAILWAY_ENVIRONMENT: "production" },
    ),
  );

  assert.doesNotThrow(() =>
    assertRailwayCompatibleDatabaseUrl(
      "postgresql://postgres:secret@db.project-ref.supabase.co:5432/postgres?sslmode=require",
      {},
    ),
  );
});

test("Railway DATABASE_URL rejects placeholder hosts before pg tries DNS", () => {
  assert.throws(() => assertRailwayCompatibleDatabaseUrl("base", { RAILWAY_ENVIRONMENT: "production" }), /full PostgreSQL/);
  assert.throws(
    () => assertRailwayCompatibleDatabaseUrl("postgresql://postgres:secret@base:5432/postgres", { RAILWAY_ENVIRONMENT: "production" }),
    /host `base`/,
  );
});

test("Supabase pooler DATABASE_URL disables pg certificate chain verification", () => {
  assert.deepEqual(
    resolvePgPoolConfig(
      "postgresql://postgres.project-ref:secret@aws-0-ca-central-1.pooler.supabase.com:5432/postgres?sslmode=require",
    ),
    {
      connectionString:
        "postgresql://postgres.project-ref:secret@aws-0-ca-central-1.pooler.supabase.com:5432/postgres?sslmode=require",
      ssl: { rejectUnauthorized: false },
    },
  );

  assert.deepEqual(
    resolvePgPoolConfig("postgresql://postgres:secret@localhost:5432/postgres?sslmode=require"),
    {
      connectionString: "postgresql://postgres:secret@localhost:5432/postgres?sslmode=require",
    },
  );
});

test("database URL diagnostics redact secrets", () => {
  assert.equal(
    describeDatabaseUrl(
      "postgresql://postgres.project-ref:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=no-verify",
    ),
    "host=aws-0-us-west-2.pooler.supabase.com port=5432 database=postgres user=postgres.project-ref sslmode=no-verify",
  );
});

test("repository endpoint reflects Supabase record changes without recreating the app", async () => {
  const supabase = new FakeSupabase();
  const app = createGateway({
    articleRepository: new SupabasePublishedArticleRepository(supabase),
    ledger: new InMemoryLedgerRepository(),
    sessionTtlMs: 60_000,
    gatewayBaseUrl: "http://test",
    logger: false,
  });

  const first = await app.inject({ method: "GET", url: "/v1/repository" });
  assert.equal(first.statusCode, 200);
  assert.equal((first.json() as { articles: Array<{ title: string }> }).articles[0]?.title, "Database Article");

  supabase.articles[0]!.title = "Database Article Updated In Supabase";
  supabase.sections.reverse();

  const second = await app.inject({ method: "GET", url: "/v1/repository" });
  assert.equal(second.statusCode, 200);
  const article = (second.json() as { articles: Array<{ title: string; sections: Array<{ sectionId: string }> }> }).articles[0];
  assert.equal(article?.title, "Database Article Updated In Supabase");
  assert.deepEqual(article?.sections.map((section) => section.sectionId), ["start", "later"]);
  await app.close();
});

test("repository endpoint returns a safe 500 when Supabase fails", async () => {
  const supabase = new FakeSupabase();
  supabase.error = { message: "permission denied for table articles", details: "internal schema detail" };
  const app = createGateway({
    articleRepository: new SupabasePublishedArticleRepository(supabase),
    ledger: new InMemoryLedgerRepository(),
    sessionTtlMs: 60_000,
    gatewayBaseUrl: "http://test",
    logger: false,
  });

  const response = await app.inject({ method: "GET", url: "/v1/repository" });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), {
    error: "repository_unavailable",
    message: "Unable to load the article repository.",
  });
  assert.ok(!response.body.includes("permission denied"));
  assert.ok(!response.body.includes("internal schema detail"));
  await app.close();
});

test("2: ten payments release exactly ten words", async () => {
  const { app, ledger } = setup();
  const session = await startSession(app);
  for (let i = 0; i < 10; i += 1) {
    const res = await pay(app, session.sessionId);
    assert.equal(res.statusCode, 200);
  }
  const deliveries = await ledger.listDeliveries(session.sessionId);
  assert.equal(deliveries.length, 10);
  assert.deepEqual(deliveries.map((d) => d.word), PLAIN_WORDS.slice(0, 10));
  await app.close();
});

test("chunk stream releases several words from one authorization and returns one bundle receipt", async () => {
  const { app, ledger } = setup();
  const session = await startSession(app);
  const res = await app.inject({
    method: "POST",
    url: `/v1/sessions/${session.sessionId}/stream`,
    payload: {
      paymentPayload: { amountAtomic: `${PRICE * 5n}` },
      maxWords: 5,
      idempotencyKey: "chunk-1",
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    words: Array<{ word: string }>;
    wordsDelivered: number;
    paidAtomic: string;
    payment: { amountAtomic: string; wordsDelivered: number; pricePerWordAtomic: string; text: string };
  };
  assert.deepEqual(body.words.map((entry) => entry.word), PLAIN_WORDS.slice(0, 5));
  assert.equal(body.wordsDelivered, 5);
  assert.equal(body.paidAtomic, `${PRICE * 5n}`);
  assert.equal(body.payment.amountAtomic, `${PRICE * 5n}`);
  assert.equal(body.payment.wordsDelivered, 5);
  assert.equal(body.payment.pricePerWordAtomic, `${PRICE}`);
  assert.equal(body.payment.text, PLAIN_WORDS.slice(0, 5).join(" "));
  const deliveries = await ledger.listDeliveries(session.sessionId);
  assert.equal(deliveries.length, 5);
  const payments = await ledger.listPayments(session.sessionId);
  assert.equal(payments.length, 5);
  assert.ok(payments.every((payment) => payment.amountAtomic === `${PRICE}`));
  await app.close();
});

test("chunk stream clamps requested bundle to remaining article words before verification", async () => {
  const shortBody = Array.from({ length: 15 }, (_, index) => `s${index + 1}`).join(" ");
  const { app } = setup({ articles: [plainArticle({ body: shortBody })] });
  const session = await startSession(app);
  const res = await app.inject({
    method: "POST",
    url: `/v1/sessions/${session.sessionId}/stream`,
    payload: {
      paymentPayload: { amountAtomic: `${PRICE * 15n}` },
      maxWords: 32,
      idempotencyKey: "short-bundle",
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { words: Array<{ word: string }>; payment: { amountAtomic: string; wordsDelivered: number }; completed: boolean };
  assert.equal(body.words.length, 15);
  assert.equal(body.payment.amountAtomic, `${PRICE * 15n}`);
  assert.equal(body.payment.wordsDelivered, 15);
  assert.equal(body.completed, true);
  await app.close();
});

test("chunk stream clamps bundle to remaining session budget before verification", async () => {
  const { app } = setup();
  const session = await startSession(app, "art-plain", `${PRICE * 3n}`);
  const res = await app.inject({
    method: "POST",
    url: `/v1/sessions/${session.sessionId}/stream`,
    payload: {
      paymentPayload: { amountAtomic: `${PRICE * 3n}` },
      maxWords: 32,
      idempotencyKey: "budget-bundle",
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { words: Array<{ word: string }>; paidAtomic: string; payment: { amountAtomic: string; wordsDelivered: number } };
  assert.equal(body.words.length, 3);
  assert.equal(body.paidAtomic, `${PRICE * 3n}`);
  assert.equal(body.payment.amountAtomic, `${PRICE * 3n}`);
  assert.equal(body.payment.wordsDelivered, 3);
  await app.close();
});

test("chunk stream clamps bundle to explicit maxWords", async () => {
  const { app } = setup();
  const session = await startSession(app);
  const res = await app.inject({
    method: "POST",
    url: `/v1/sessions/${session.sessionId}/stream`,
    payload: {
      paymentPayload: { amountAtomic: `${PRICE * 7n}` },
      maxWords: 7,
      idempotencyKey: "max-words-bundle",
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { words: Array<{ word: string }>; payment: { amountAtomic: string; wordsDelivered: number } };
  assert.equal(body.words.length, 7);
  assert.equal(body.payment.amountAtomic, `${PRICE * 7n}`);
  assert.equal(body.payment.wordsDelivered, 7);
  await app.close();
});

test("chunk stream can authorize a complete article larger than the legacy 256-word limit", async () => {
  const words = Array.from({ length: 300 }, (_, index) => `long${index + 1}`);
  const { app } = setup({ articles: [plainArticle({ body: words.join(" ") })] });
  const session = await startSession(app, "art-plain", `${PRICE * 300n}`);
  const res = await app.inject({
    method: "POST",
    url: `/v1/sessions/${session.sessionId}/stream`,
    payload: {
      paymentPayload: { amountAtomic: `${PRICE * 300n}` },
      maxWords: 300,
      idempotencyKey: "whole-article",
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { words: Array<{ word: string }>; payment: { amountAtomic: string; wordsDelivered: number }; completed: boolean };
  assert.equal(body.words.length, 300);
  assert.equal(body.payment.amountAtomic, `${PRICE * 300n}`);
  assert.equal(body.payment.wordsDelivered, 300);
  assert.equal(body.completed, true);
  await app.close();
});

test("3: stopping after 137 words charges exactly 137 × price per word", async () => {
  const { app, ledger } = setup();
  const session = await startSession(app);
  let last: StreamPaymentResponse | undefined;
  for (let i = 0; i < 137; i += 1) {
    last = (await pay(app, session.sessionId)).json() as StreamPaymentResponse;
  }
  assert.equal(last?.wordsDelivered, 137);
  assert.equal(last?.paidAtomic, `${PRICE * 137n}`);
  const earnings = await ledger.earningsForArticle("art-plain");
  assert.equal(earnings.wordsDelivered, 137);
  assert.equal(earnings.creatorAmountAtomic, `${PRICE * 137n}`);
  await app.close();
});

test("4: a failed payment releases no word", async () => {
  const { app, ledger } = setup();
  const session = await startSession(app);
  const res = await pay(app, session.sessionId, { payload: { reject: true } });
  assert.equal(res.statusCode, 402);
  assert.equal((await ledger.listDeliveries(session.sessionId)).length, 0);
  const reloaded = await ledger.getSession(session.sessionId);
  assert.equal(reloaded?.wordsDelivered, 0);
  await app.close();
});

test("5: a duplicate request does not release or charge for the word twice", async () => {
  const { app, ledger } = setup();
  const session = await startSession(app);
  const first = (await pay(app, session.sessionId, { key: "dup-key" })).json() as StreamPaymentResponse;
  const second = (await pay(app, session.sessionId, { key: "dup-key" })).json() as StreamPaymentResponse;
  assert.equal(first.word, second.word);
  assert.equal(second.wordsDelivered, 1);
  assert.equal(second.paidAtomic, `${PRICE}`);
  assert.equal(first.payment?.paymentId, second.payment?.paymentId);
  assert.deepEqual(first.payment?.transactionHashes, second.payment?.transactionHashes);
  assert.equal((await ledger.listDeliveries(session.sessionId)).length, 1);
  await app.close();
});

test("6: the seller agent does not expose unpaid body content", async () => {
  const secret = "SECRETLEAKTOKEN";
  const article = plainArticle({
    id: "art-secret",
    body: `# Findings\nThe ${secret} clause says resale is prohibited forever and the conclusion is hidden.`,
  });
  const { app } = setup({ articles: [article] });

  const nav = await app.inject({ method: "GET", url: "/v1/articles/art-secret/navigation?goal=findings" });
  assert.equal(nav.statusCode, 200);
  assert.ok(!nav.body.includes(secret), "navigation must not leak unpaid body");

  const convo = await app.inject({
    method: "POST",
    url: "/v1/seller-agent/conversations",
    payload: { articleId: "art-secret", goal: "what does the clause say", message: "what does the clause say?" },
  });
  assert.equal(convo.statusCode, 201);
  assert.ok(!convo.body.includes(secret), "conversation must not leak unpaid body");
  await app.close();
});

test("7: a creator cannot access another creator's article (ownership is loaded from storage)", async () => {
  const { app, published, ledger } = setup({
    articles: [
      plainArticle({ id: "art-a", creatorId: "creator-a", creatorUsername: "alice" }),
      plainArticle({ id: "art-b", creatorId: "creator-b", creatorUsername: "bob" }),
    ],
    wallets: [
      { creatorId: "creator-a", address: "0x000000000000000000000000000000000000aaaa" },
      { creatorId: "creator-b", address: "0x000000000000000000000000000000000000bbbb" },
    ],
  });

  const articleB = await published.getPublishedArticle("art-b");
  assert.equal(articleB?.creatorId, "creator-b");

  // A buyer cannot redirect settlement: the seller wallet is derived from the
  // article's stored creator, never from buyer input.
  const session = await startSession(app, "art-b");
  const stored = await ledger.getSession(session.sessionId);
  assert.equal(stored?.creatorId, "creator-b");
  assert.equal(stored?.sellerWallet, "0x000000000000000000000000000000000000bbbb");
  assert.notEqual(
    (await published.getCreatorWallet("creator-a"))?.address,
    (await published.getCreatorWallet("creator-b"))?.address,
  );
  await app.close();
});

test("8: a draft article is unavailable to public buyer agents", async () => {
  const { app } = setup({ articles: [plainArticle({ id: "art-draft", state: "draft" })] });
  const repo = await app.inject({ method: "GET", url: "/v1/repository" });
  assert.equal((repo.json() as { articles: unknown[] }).articles.length, 0);
  assert.equal((await app.inject({ method: "GET", url: "/v1/articles/art-draft/navigation" })).statusCode, 404);
  const session = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    payload: { articleId: "art-draft", budget: { currency: "USDC", maxAmountAtomic: "1000" } },
  });
  assert.equal(session.statusCode, 404);
  await app.close();
});

test("9: a paused article cannot start new sessions", async () => {
  const { app } = setup({ articles: [plainArticle({ id: "art-paused", state: "paused" })] });
  const session = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    payload: { articleId: "art-paused", budget: { currency: "USDC", maxAmountAtomic: "1000" } },
  });
  assert.equal(session.statusCode, 404);
  await app.close();
});

test("10: gateway fee is zero", async () => {
  const { app, ledger } = setup();
  const session = await startSession(app);
  assert.equal(session.gatewayFeeBps, 0);
  assert.equal(session.wordPaymentAtomic, session.pricePerWordAtomic);
  await pay(app, session.sessionId);
  const payments = await ledger.listPayments(session.sessionId);
  assert.equal(payments[0]?.rubiconFeeAtomic, "0");
  assert.equal(payments[0]?.creatorAmountAtomic, `${PRICE}`);
  await app.close();
});

test("11: creator earnings equal the full Rubicon word subtotal", async () => {
  const { app, ledger } = setup();
  const session = await startSession(app);
  const n = 23;
  for (let i = 0; i < n; i += 1) {
    await pay(app, session.sessionId);
  }
  const byArticle = await ledger.earningsForArticle("art-plain");
  const byCreator = await ledger.earningsForCreator("creator-a");
  assert.equal(byArticle.creatorAmountAtomic, `${PRICE * BigInt(n)}`);
  assert.equal(byArticle.rubiconFeeAtomic, "0");
  assert.equal(byCreator.creatorAmountAtomic, `${PRICE * BigInt(n)}`);
  await app.close();
});

test("12: dashboard-created articles become available after publishing", async () => {
  const { app, published } = setup({ articles: [plainArticle({ id: "art-pub", state: "draft" })] });

  // Draft: not in the public repository, cannot be navigated.
  assert.equal((await app.inject({ method: "GET", url: "/v1/repository" }).then((r) => (r.json() as { articles: unknown[] }).articles.length)), 0);

  // rubicon-marketing publishes it (writes state=live to shared storage).
  published.upsertArticle(plainArticle({ id: "art-pub", state: "live" }));

  const repo = (await app.inject({ method: "GET", url: "/v1/repository" })).json() as {
    articles: { articleId: string }[];
  };
  assert.ok(repo.articles.some((a) => a.articleId === "art-pub"));
  assert.equal((await app.inject({ method: "GET", url: "/v1/articles/art-pub/navigation" })).statusCode, 200);
  await app.close();
});

test("budget exhaustion stops releasing words", async () => {
  const { app } = setup();
  // Budget covers exactly 3 words.
  const session = await startSession(app, "art-plain", `${PRICE * 3n}`);
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await pay(app, session.sessionId)).statusCode, 200);
  }
  const overflow = await pay(app, session.sessionId);
  assert.equal(overflow.statusCode, 402);
  assert.equal((overflow.json() as { error: string }).error, "budget_exhausted");
  await app.close();
});
