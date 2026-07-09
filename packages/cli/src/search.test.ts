import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReadReceipt, RubiconClient, RunOptions } from "@rubicon-caliga/agent-sdk/agent-client";
import type { ArticleSummary, SearchResponse, SellerSectionAssessment } from "@rubicon-caliga/core";
import { parseArgs } from "./args.js";
import { runBuy, MIN_SEARCH_CONFIDENCE, type CommandRuntime } from "./quickstart.js";

const DEFAULT_ARTICLE: ArticleSummary = {
  articleId: "article_1",
  creatorId: "creator_1",
  creatorUsername: "creator",
  title: "Metered Reading Guide",
  author: "Ada",
  state: "live",
  accessMode: "paid",
  totalWords: 30,
  pricePerWordAtomic: "1",
  maxArticlePriceAtomic: "30",
  sections: [
    { sectionId: "intro", heading: "Introduction", level: 1, wordStart: 0, wordCount: 10 },
    { sectionId: "practical", heading: "Practical details", level: 1, wordStart: 10, wordCount: 10 },
  ],
};

function searchResponse(score: number, article: ArticleSummary = DEFAULT_ARTICLE): SearchResponse {
  return {
    query: "test",
    mode: "lexical",
    results: score > 0
      ? [{ article, score, matchedSections: [{ sectionId: "practical", heading: "Practical details", score }] }]
      : [],
  };
}

function setup(options: { searchScore?: number; minConfidence?: string; envMinConfidence?: string; article?: ArticleSummary; assessments?: SellerSectionAssessment[] } = {}): {
  runtime: CommandRuntime;
  runs: RunOptions[];
  consultations: string[];
} {
  process.env.HOME = mkdtempSync(join(tmpdir(), "rubicon-search-test-"));
  const article = options.article ?? DEFAULT_ARTICLE;
  const assessments = options.assessments ?? [{ sectionId: "practical", expectedValue: 0.9, minimumUsefulWords: 1, rationale: "practical" }];
  const navigation = {
    articleId: article.articleId,
    sections: article.sections,
    sellerAgent: {
      recommendedSectionId: assessments[0]?.sectionId ?? "intro",
      alternativeSectionIds: [],
      sectionAssessments: assessments,
      rationale: "Seller ranking",
      safeHints: [],
      withheld: [],
    },
    stopConditions: [],
  };
  const runs: RunOptions[] = [];
  const consultations: string[] = [];
  const searchScore = options.searchScore ?? 0.8;

  const argv = ["buy", "--first", "--goal", "practical answer", "--max-atomic", "100"];
  if (options.minConfidence) {
    argv.push("--min-confidence", options.minConfidence);
  }

  if (options.envMinConfidence !== undefined) {
    process.env.RUBICON_MIN_CONFIDENCE = options.envMinConfidence;
  } else {
    delete process.env.RUBICON_MIN_CONFIDENCE;
  }

  const client = {
    async getRepository() { return { repository: "articles" as const, articles: [article] }; },
    async search() { return searchResponse(searchScore, article); },
    async startConversation() {
      consultations.push(article.articleId);
      return {
        conversationId: "conversation_1",
        articleId: article.articleId,
        article,
        navigation,
        messages: [],
      };
    },
    async run(input: RunOptions) {
      runs.push(input);
      const words = input.maxWords ?? 1;
      return {
        sessionId: "session_1", articleId: article.articleId, conversationId: "conversation_1",
        wordsRead: words, amountPaidAtomic: `${BigInt(words)}`, payments: [], transactionHashes: [], settlementIds: [],
        text: "practical content", completed: true, stopReason: "article_completed" as const,
      } satisfies ReadReceipt;
    },
  } as unknown as RubiconClient;

  const runtime: CommandRuntime = {
    parsed: parseArgs(argv),
    config: {},
    gatewayUrl: "https://rubicon.test",
    paymentMode: "static",
    client,
  };
  return { runtime, runs, consultations };
}

test("search gate stops with zero spend when top score is below the confidence floor", async () => {
  const { runtime, runs, consultations } = setup({ searchScore: 0.2 });
  const result = await runBuy(runtime);
  assert.equal(result.outcome, "NO_RELEVANT_ARTICLE");
  assert.equal((result.result as { amountPaidAtomic: string }).amountPaidAtomic, "0");
  assert.equal(runs.length, 0);
  assert.equal(consultations.length, 0);
  const gate = (result.events as Array<Record<string, unknown>>).find((event) => event.type === "goalfit.gate");
  assert.equal(gate?.decision, "stop_zero_spend");
  assert.equal(gate?.reason, "below_confidence_floor");
  assert.equal(gate?.topScore, 0.2);
  assert.equal(gate?.minConfidence, MIN_SEARCH_CONFIDENCE);
});

test("search gate stops when search returns no results", async () => {
  const { runtime, runs, consultations } = setup({ searchScore: 0 });
  const result = await runBuy(runtime);
  assert.equal(result.outcome, "NO_RELEVANT_ARTICLE");
  assert.equal(runs.length, 0);
  assert.equal(consultations.length, 0);
  const gate = (result.events as Array<Record<string, unknown>>).find((event) => event.type === "goalfit.gate");
  assert.equal(gate?.decision, "stop_zero_spend");
  assert.equal(gate?.topScore, 0);
});

test("search gate proceeds when top score meets the confidence floor", async () => {
  const { runtime, runs, consultations } = setup({ searchScore: 0.5 });
  const result = await runBuy(runtime);
  assert.equal(result.outcome, undefined);
  assert.equal(runs.length, 1);
  assert.equal(consultations.length, 1);
  const selected = (result.events as Array<Record<string, unknown>>).find((event) => event.type === "article.selected");
  assert.equal(selected?.basis, "semantic_search");
  assert.equal(selected?.searchScore, 0.5);
  assert.equal(selected?.searchMode, "lexical");
});

test("search gate proceeds at the exact floor boundary", async () => {
  const { runtime, runs } = setup({ searchScore: MIN_SEARCH_CONFIDENCE });
  const result = await runBuy(runtime);
  assert.equal(result.outcome, undefined);
  assert.equal(runs.length, 1);
});

test("--min-confidence flag overrides the floor", async () => {
  const { runtime, runs, consultations } = setup({ searchScore: 0.4, minConfidence: "0.5" });
  const result = await runBuy(runtime);
  // 0.4 < 0.5 → stop
  assert.equal(result.outcome, "NO_RELEVANT_ARTICLE");
  assert.equal(runs.length, 0);
  assert.equal(consultations.length, 0);
  const gate = (result.events as Array<Record<string, unknown>>).find((event) => event.type === "goalfit.gate");
  assert.equal(gate?.minConfidence, 0.5);
});

test("RUBICON_MIN_CONFIDENCE env overrides the floor", async () => {
  const { runtime, runs, consultations } = setup({ searchScore: 0.4, envMinConfidence: "0.45" });
  const result = await runBuy(runtime);
  assert.equal(result.outcome, "NO_RELEVANT_ARTICLE");
  assert.equal(runs.length, 0);
  assert.equal(consultations.length, 0);
  const gate = (result.events as Array<Record<string, unknown>>).find((event) => event.type === "goalfit.gate");
  assert.equal(gate?.minConfidence, 0.45);
});

test("search gate does not start a payment session when below floor", async () => {
  const { runtime, runs } = setup({ searchScore: 0.1 });
  const result = await runBuy(runtime);
  const events = result.events as Array<Record<string, unknown>>;
  assert.equal(events.filter((event) => String(event.type).startsWith("payment.")).length, 0);
  assert.equal(runs.length, 0);
});
