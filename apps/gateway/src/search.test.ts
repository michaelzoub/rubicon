import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createGateway } from "./server.js";
import {
  InMemoryLedgerRepository,
  InMemoryPublishedArticleRepository,
  type ArticleFixture,
} from "./repositories/in-memory.js";
import type { SearchResponse } from "@rubicon-caliga/core";

const PRICE = 5n;

function meteredArticle(overrides: Partial<ArticleFixture> = {}): ArticleFixture {
  return {
    id: "art-metered",
    creatorId: "creator-a",
    creatorUsername: "alice",
    title: "Field Guide to Metered Reading",
    author: "Alice",
    state: "live",
    pricePerWordAtomic: PRICE,
    body: [
      "# Field Guide to Metered Reading",
      "## Summary",
      "Rubicon streams paid articles word by word.",
      "## How sessions work",
      "A buyer opens a session with a hard spending cap.",
      "## Conclusion",
      "Metered reading keeps autonomous purchases inspectable.",
    ].join("\n"),
    ...overrides,
  };
}

function setup(articles: ArticleFixture[] = [meteredArticle()]): { app: FastifyInstance } {
  const published = new InMemoryPublishedArticleRepository({
    articles,
    wallets: [{ creatorId: "creator-a", address: "0x000000000000000000000000000000000000aaaa", network: "eip155:5042002" }],
  });
  const ledger = new InMemoryLedgerRepository();
  const app = createGateway({
    articleRepository: published,
    ledger,
    sessionTtlMs: 60_000,
    gatewayBaseUrl: "http://test",
    logger: false,
  });
  return { app };
}

test("search returns ranked lexical results with mode and score", async () => {
  const { app } = setup();
  const res = await app.inject({ method: "GET", url: "/v1/search?q=metered+reading" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as SearchResponse;
  assert.equal(body.query, "metered reading");
  assert.equal(body.mode, "lexical");
  assert.ok(body.results.length > 0);
  const top = body.results[0]!;
  assert.equal(top.article.articleId, "art-metered");
  assert.ok(top.score > 0 && top.score <= 1);
  assert.ok(top.matchedSections.length > 0);
  await app.close();
});

test("search returns empty results for an unmatched query", async () => {
  const { app } = setup();
  const res = await app.inject({ method: "GET", url: "/v1/search?q=quantum+chromodynamics" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as SearchResponse;
  assert.equal(body.mode, "lexical");
  assert.deepEqual(body.results, []);
  await app.close();
});

test("search respects limit parameter", async () => {
  const { app } = setup([
    meteredArticle({ id: "art-1" }),
    meteredArticle({ id: "art-2", title: "Metered Reading Guide Two" }),
  ]);
  const res = await app.inject({ method: "GET", url: "/v1/search?q=metered+reading&limit=1" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as SearchResponse;
  assert.equal(body.results.length, 1);
  await app.close();
});

test("search rejects missing q with 400", async () => {
  const { app } = setup();
  const res = await app.inject({ method: "GET", url: "/v1/search" });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { error: string }).error, "missing_query");
  await app.close();
});

test("repository without q is unchanged (same shape and order)", async () => {
  const { app } = setup();
  const res = await app.inject({ method: "GET", url: "/v1/repository" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { repository: string; articles: Array<{ articleId: string; score?: number }> };
  assert.equal(body.repository, "articles");
  assert.equal(body.articles.length, 1);
  // No score fields in the repository response.
  assert.equal(body.articles[0]?.score, undefined);
  await app.close();
});

test("repository with q ranks results but keeps the same shape", async () => {
  const { app } = setup([
    meteredArticle({ id: "art-relevant", title: "Metered Reading Sessions" }),
    meteredArticle({ id: "art-irrelevant", title: "Quantum Physics Primer", body: "# Quantum Physics\n## Intro\nUnrelated content." }),
  ]);
  const res = await app.inject({ method: "GET", url: "/v1/repository?q=metered+reading" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { repository: string; articles: Array<{ articleId: string; score?: number }> };
  assert.equal(body.repository, "articles");
  // Only the matching article should be returned.
  assert.equal(body.articles.length, 1);
  assert.equal(body.articles[0]?.articleId, "art-relevant");
  // No score fields — thin alias.
  assert.equal(body.articles[0]?.score, undefined);
  await app.close();
});
