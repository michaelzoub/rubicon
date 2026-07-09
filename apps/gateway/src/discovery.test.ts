import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createGateway } from "./server.js";
import {
  InMemoryLedgerRepository,
  InMemoryPublishedArticleRepository,
  type ArticleFixture,
} from "./repositories/in-memory.js";

const CREATOR_WALLET = "0x000000000000000000000000000000000000aaaa";

// intro [0,3) summary [3,4) body [7,5) — see markdown below.
function article(): ArticleFixture {
  return {
    id: "art-sel",
    creatorId: "creator-a",
    creatorUsername: "alice",
    title: "Selection Guide",
    author: "Alice",
    state: "live",
    // Free so streaming needs no payment payload — these tests isolate the
    // selection-to-words logic, not the payment path.
    accessMode: "free",
    pricePerWordAtomic: 0n,
    body: [
      "# Selection Guide", // 2 words: [0,2)
      "## Alpha",           // heading
      "alpha one two",      // alpha body
      "## Bravo",           // heading
      "bravo three four five", // bravo body
    ].join("\n"),
  };
}

function setup(articles: ArticleFixture[] = [article()]): { app: FastifyInstance } {
  const published = new InMemoryPublishedArticleRepository({
    articles,
    wallets: [{ creatorId: "creator-a", address: CREATOR_WALLET, network: "eip155:5042002" }],
  });
  const app = createGateway({
    articleRepository: published,
    ledger: new InMemoryLedgerRepository(),
    sessionTtlMs: 60_000,
    gatewayBaseUrl: "http://test",
    logger: false,
    version: "9.9.9",
  });
  return { app };
}

test("GET /openapi.json is a valid AgentCash discovery document", async () => {
  const { app } = setup();
  const res = await app.inject({ method: "GET", url: "/openapi.json" });
  assert.equal(res.statusCode, 200);
  const doc = res.json() as any;
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.info.version, "9.9.9");
  assert.ok(typeof doc.info["x-guidance"] === "string" && doc.info["x-guidance"].length > 0);
  // Payable operation carries x-payment-info (protocols + dynamic price) and a 402.
  const op = doc.paths["/v1/sessions"].post;
  assert.deepEqual(op["x-payment-info"].protocols, [{ x402: {} }]);
  assert.equal(op["x-payment-info"].price.mode, "dynamic");
  assert.equal(op["x-payment-info"].price.currency, "USD");
  assert.ok(op.responses["402"]);
  // Every invocable route exposes an input schema (requestBody or parameters).
  assert.ok(op.requestBody.content["application/json"].schema);
  assert.ok(Array.isArray(doc.paths["/v1/search"].get.parameters));
  // Free routes declare an auth mode (unprotected => security: []).
  assert.deepEqual(doc.paths["/v1/repository"].get.security, []);
});

test("openapi.json advertises no hardcoded recipient address (payTo resolved per-article at runtime)", async () => {
  const { app } = setup();
  const doc = (await app.inject({ method: "GET", url: "/openapi.json" })).json() as any;
  assert.ok(!/0x[0-9a-fA-F]{40}/.test(JSON.stringify(doc)), "discovery doc must not hardcode a wallet address");
});

test("unauthenticated probe of the paid endpoint returns 402 before body validation", async () => {
  const { app } = setup();
  for (const body of [undefined, {}, { articleId: "art-sel" }]) {
    const res = await app.inject({ method: "POST", url: "/v1/sessions", payload: body });
    assert.equal(res.statusCode, 402, `probe ${JSON.stringify(body)} should 402`);
    assert.equal((res.json() as any).error, "payment_required");
  }
});

test("word-range selection meters and delivers only the selected words", async () => {
  // Plain body so word indices are unambiguous: one=0 ... ten=9.
  const plain: ArticleFixture = {
    id: "art-plain",
    creatorId: "creator-a",
    creatorUsername: "alice",
    title: "Plain",
    author: "Alice",
    state: "live",
    accessMode: "free",
    pricePerWordAtomic: 0n,
    body: "one two three four five six seven eight nine ten",
  };
  const { app } = setup([plain]);
  const open = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    payload: { articleId: "art-plain", wordStart: 5, wordCount: 4, budget: { currency: "USDC", maxAmountAtomic: "100" } },
  });
  assert.equal(open.statusCode, 201);
  const sessionId = (open.json() as any).sessionId;
  const stream = await app.inject({
    method: "POST",
    url: `/v1/sessions/${sessionId}/stream`,
    payload: { maxWords: 10, idempotencyKey: `${sessionId}:0:10` },
  });
  // range [5, 9) => six seven eight nine
  assert.deepEqual((stream.json() as any).words.map((w: any) => w.word), ["six", "seven", "eight", "nine"]);
});

test("multi-section selection delivers the union in document order", async () => {
  const { app } = setup();
  // sections: selection-guide (title), alpha (alpha one two), bravo (bravo three four five)
  const open = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    payload: { articleId: "art-sel", sectionIds: ["bravo", "alpha"], budget: { currency: "USDC", maxAmountAtomic: "100" } },
  });
  assert.equal(open.statusCode, 201);
  const sessionId = (open.json() as any).sessionId;
  const stream = await app.inject({
    method: "POST",
    url: `/v1/sessions/${sessionId}/stream`,
    payload: { maxWords: 20, idempotencyKey: `${sessionId}:0:20` },
  });
  const words = (stream.json() as any).words.map((w: any) => w.word);
  // alpha comes before bravo in the article regardless of input order.
  assert.deepEqual(words, ["alpha", "one", "two", "bravo", "three", "four", "five"]);
});

test("unknown section in a selection returns 404 section_not_found", async () => {
  const { app } = setup();
  const res = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    payload: { articleId: "art-sel", sectionIds: ["ghost"], budget: { currency: "USDC", maxAmountAtomic: "100" } },
  });
  assert.equal(res.statusCode, 404);
  assert.equal((res.json() as any).error, "section_not_found");
});
