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
      "## Alpha", // heading
      "alpha one two", // alpha body
      "## Bravo", // heading
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

test("GET /openapi.json describes the complete public gateway surface", async () => {
  const { app } = setup();
  const res = await app.inject({ method: "GET", url: "/openapi.json" });
  assert.equal(res.statusCode, 200);
  const doc = res.json() as any;
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.info.title, "Rubicon");
  assert.equal(doc.info.version, "9.9.9");
  assert.ok(typeof doc.info["x-guidance"] === "string" && doc.info["x-guidance"].length > 0);
  for (const path of [
    "/openapi.json",
    "/health",
    "/v1/endpoints",
    "/v1/repository",
    "/v1/articles",
    "/v1/search",
    "/v1/articles/{articleId}/navigation",
    "/v1/seller-agent/conversations",
    "/v1/seller-agent/conversations/{conversationId}/messages",
    "/v1/sessions",
    "/v1/sessions/{sessionId}/stream",
    "/v1/sessions/{sessionId}/payments",
    "/v1/sessions/{sessionId}/events",
    "/v1/sessions/{sessionId}/abort",
  ]) {
    assert.ok(doc.paths[path], `${path} is present`);
  }
  // Free and control-plane operations must not accidentally inherit auth.
  assert.deepEqual(doc.paths["/v1/repository"].get.security, []);
  assert.deepEqual(doc.paths["/v1/sessions"].post.security, []);
  // Stateful operations describe both their request and successful response.
  assert.ok(doc.paths["/v1/sessions"].post.requestBody.content["application/json"].schema);
  assert.ok(doc.paths["/v1/sessions"].post.responses["201"].content["application/json"].schema);
  assert.ok(doc.components.schemas.StartSessionRequest);
});

test("discovery only advertises the AgentCash Base purchase route when a writer has a verified Base wallet", async () => {
  const paid: ArticleFixture = {
    id: "art-base",
    creatorId: "creator-a",
    creatorUsername: "alice",
    title: "Base-ready Guide",
    author: "Alice",
    state: "live",
    accessMode: "paid",
    pricePerWordAtomic: 100n,
    body: "one two three",
  };
  const { app } = setup([paid]);
  const doc = (await app.inject({ method: "GET", url: "/openapi.json" })).json() as any;
  assert.ok(
    !doc.paths["/v1/x402/articles/{articleId}"],
    "Arc-only creator wallet must not be advertised as Base-payable",
  );
  await app.close();
});

test("Rubicon's x402scan icon serves the marketing w_logo on white", async () => {
  const { app } = setup();
  const res = await app.inject({ method: "GET", url: "/w_logo.svg" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] ?? "", /image\/svg\+xml/);
  assert.match(res.body, /<rect width="1500" height="1500" fill="#fff"\/>/);
  assert.match(res.body, /stroke="#121212"/);
  await app.close();
});

test("openapi.json advertises no hardcoded recipient address (payTo resolved per-article at runtime)", async () => {
  const { app } = setup();
  const doc = (await app.inject({ method: "GET", url: "/openapi.json" })).json() as any;
  assert.ok(
    !/0x[0-9a-fA-F]{40}/.test(JSON.stringify(doc)),
    "discovery doc must not hardcode a wallet address",
  );
});

test("unauthenticated probe of the paid endpoint returns 402 before body validation", async () => {
  const { app } = setup();
  for (const body of [undefined, {}, { articleId: "art-sel" }]) {
    const res = await app.inject({ method: "POST", url: "/v1/sessions", payload: body });
    assert.equal(res.statusCode, 402, `probe ${JSON.stringify(body)} should 402`);
    assert.equal((res.json() as any).error, "payment_required");
  }
});

test("x402scan schema-synthesized probe (placeholder budget cap) gets an x402 402 challenge", async () => {
  // x402scan fills required fields from the OpenAPI schema, so a `type: string`
  // budget cap arrives as a non-numeric placeholder. A paid deployment must
  // answer such a probe with a real x402 challenge (accepts[]), never a 404.
  const paid: ArticleFixture = {
    id: "art-paid",
    creatorId: "creator-a",
    creatorUsername: "alice",
    title: "Paid Guide",
    author: "Alice",
    state: "live",
    accessMode: "paid",
    pricePerWordAtomic: 100n,
    body: "one two three four five",
  };
  const { app } = setup([paid]);
  const res = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    payload: { articleId: "string", budget: { currency: "USDC", maxAmountAtomic: "string" } },
  });
  assert.equal(res.statusCode, 402);
  const challenge = res.json() as any;
  assert.ok(
    Array.isArray(challenge.accepts) && challenge.accepts.length > 0,
    "challenge carries accepts[]",
  );
  // Atomic units, never decimal dollars (x402scan "Malformed Runtime Amount").
  assert.match(String(challenge.accepts[0].amount), /^\d+$/);
  assert.ok(res.headers["payment-required"], "PAYMENT-REQUIRED header is set");
});

test("a well-formed open of an unknown article still 404s (not a discovery probe)", async () => {
  const { app } = setup();
  const res = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    payload: { articleId: "does-not-exist", budget: { currency: "USDC", maxAmountAtomic: "100" } },
  });
  assert.equal(res.statusCode, 404);
  assert.equal((res.json() as any).error, "article_not_available");
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
    payload: {
      articleId: "art-plain",
      wordStart: 5,
      wordCount: 4,
      budget: { currency: "USDC", maxAmountAtomic: "100" },
    },
  });
  assert.equal(open.statusCode, 201);
  const sessionId = (open.json() as any).sessionId;
  const stream = await app.inject({
    method: "POST",
    url: `/v1/sessions/${sessionId}/stream`,
    payload: { maxWords: 10, idempotencyKey: `${sessionId}:0:10` },
  });
  // range [5, 9) => six seven eight nine
  assert.deepEqual(
    (stream.json() as any).words.map((w: any) => w.word),
    ["six", "seven", "eight", "nine"],
  );
});

test("multi-section selection delivers the union in document order", async () => {
  const { app } = setup();
  // sections: selection-guide (title), alpha (alpha one two), bravo (bravo three four five)
  const open = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    payload: {
      articleId: "art-sel",
      sectionIds: ["bravo", "alpha"],
      budget: { currency: "USDC", maxAmountAtomic: "100" },
    },
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
    payload: {
      articleId: "art-sel",
      sectionIds: ["ghost"],
      budget: { currency: "USDC", maxAmountAtomic: "100" },
    },
  });
  assert.equal(res.statusCode, 404);
  assert.equal((res.json() as any).error, "section_not_found");
});
