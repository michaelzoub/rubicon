import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReadReceipt, RubiconClient, RunOptions } from "@rubicon-caliga/agent-sdk/agent-client";
import type { ArticleSummary, SellerSectionAssessment } from "@rubicon-caliga/core";
import { parseArgs } from "./args.js";
import { CliError } from "./errors.js";
import { assessGoalFit, MIN_GOAL_FIT_EXPECTED_VALUE, runBuy, type CommandRuntime } from "./quickstart.js";
import { listReceipts, loadReceipt } from "./receipts.js";

test("buy follows seller value-per-word ranking instead of the introduction", async () => {
  const fixture = setup([
    assessment("intro", 0.8, 8),
    assessment("practical", 0.75, 2),
  ]);
  await runBuy(fixture.runtime);
  assert.equal(fixture.runs[0]?.sectionId, "practical");
});

test("buy switches sections after marginal seller value remains insufficient", async () => {
  const fixture = setup([assessment("practical", 0.7, 2), assessment("counterarguments", 0.6, 2)]);
  const result = await runBuy(fixture.runtime);
  assert.deepEqual(fixture.runs.map((run) => run.sectionId), ["practical", "counterarguments"]);
  assert.equal((result.events as Array<{ type: string }>).filter((event) => event.type === "strategy.reassessed").length, 2);
});

test("buy clamps partial reads to remaining budget before payment", async () => {
  const fixture = setup([assessment("practical", 0.9, 1)], { price: "100", budgetAtomic: "250" });
  const result = await runBuy(fixture.runtime);
  assert.equal(fixture.runs[0]?.maxSpendAtomic, "200");
  assert.equal(fixture.runs[0]?.maxWords, 2);
  assert.equal((result.result as { amountPaidAtomic: string }).amountPaidAtomic, "200");
});

test("buy never invokes payment when minimum useful content exceeds the cap", async () => {
  const fixture = setup([assessment("practical", 0.9, 3)], { price: "100", budgetAtomic: "250" });
  await assert.rejects(() => runBuy(fixture.runtime), (error) => error instanceof CliError && error.code === "BUDGET_TOO_SMALL");
  assert.equal(fixture.runs.length, 0);
});

test("buy rejects a receipt that would exceed the approved cumulative cap", async () => {
  const fixture = setup([assessment("practical", 0.6, 1), assessment("counterarguments", 0.6, 1)], { maliciousOvercharge: true });
  await assert.rejects(() => runBuy(fixture.runtime), (error) => error instanceof CliError && error.code === "BUDGET_INVARIANT");
});

test("buy avoids duplicate section purchases", async () => {
  const duplicate = assessment("practical", 0.6, 1);
  const fixture = setup([duplicate, duplicate]);
  await runBuy(fixture.runtime);
  assert.deepEqual(fixture.runs.map((run) => run.sectionId), ["practical"]);
});

test("buy persists receipts and verifies they can be loaded", async () => {
  const fixture = setup([assessment("practical", 0.9, 1)]);
  const result = await runBuy(fixture.runtime);
  const [id] = (result.result as { receiptIds: string[] }).receiptIds;
  assert.equal((await loadReceipt(id!)).receipt.articleId, "article_1");
  assert.ok((result.events as Array<{ type: string }>).some((event) => event.type === "receipt.verified"));
});

test("buy can purchase the whole article as one buyer-selected unit", async () => {
  const fixture = setup([assessment("practical", 0.9, 1)]);
  fixture.runtime.parsed = parseArgs(["buy", "--first", "--goal", "complete practical details", "--max-atomic", "100", "--granularity", "article"]);
  await runBuy(fixture.runtime);
  assert.equal(fixture.runs.length, 1);
  assert.equal(fixture.runs[0]?.sectionId, "full-article");
  assert.equal(fixture.runs[0]?.granularity, "article");
  assert.equal(fixture.runs[0]?.maxWords, undefined);
});

test("buy forwards an explicit numeric granularity", async () => {
  const fixture = setup([assessment("practical", 0.9, 10)]);
  fixture.runtime.parsed = parseArgs(["buy", "--first", "--goal", "practical answer", "--max-atomic", "100", "--granularity", "10"]);
  await runBuy(fixture.runtime);
  assert.equal(fixture.runs[0]?.granularity, 10);
});

test("buy reports wallet setup failures before payment", async () => {
  const fixture = setup([assessment("practical", 0.9, 1)], { paymentMode: "circle-cli" });
  await assert.rejects(
    () => runBuy(fixture.runtime, { circleRunner: async () => { throw new Error("spawn circle ENOENT"); } }),
    (error) => error instanceof CliError && error.code === "MISSING_CLI",
  );
  assert.equal(fixture.runs.length, 0);
});

test("negative control: thermodynamics goal against a decentralized-training-only catalog creates zero sessions and payments", async () => {
  const circleCalls: string[][] = [];
  const progress: Array<Record<string, unknown>> = [];
  const fixture = setup([assessment("distributed-optimization", 0.9, 25, "Covers decentralized model training.")], {
    goal: "explain the second law of thermodynamics and entropy",
    article: decentralizedTrainingArticle(),
    sellerMessage: "I recommend the distributed optimization section.",
    paymentMode: "circle-cli",
    budgetAtomic: "100000",
  });
  const result = await runBuy(fixture.runtime, {
    circleRunner: async (_command, args) => {
      circleCalls.push(args);
      return JSON.stringify({ ok: true });
    },
    onProgress: (event) => progress.push(event),
  });

  const final = result.result as Record<string, unknown>;
  assert.equal(result.outcome, "NO_RELEVANT_ARTICLE");
  assert.equal(final.outcome, "NO_RELEVANT_ARTICLE");
  assert.equal(final.amountPaidAtomic, "0");
  assert.equal(final.wordsRead, 0);
  assert.equal(final.stopReason, "no_relevant_article");
  assert.deepEqual(final.receiptIds, []);
  assert.deepEqual(final.receipts, []);
  assert.deepEqual(final.availableTitles, ["Scaling Decentralized Training"]);
  assert.match(String(final.report), /Available titles: Scaling Decentralized Training/);
  // The pre-consultation gate proves zero seller conversations, purchase sessions, payments, wallet calls, and receipts.
  assert.equal(fixture.consultations.length, 0);
  assert.equal(fixture.runs.length, 0);
  assert.equal(circleCalls.length, 0);
  assert.deepEqual(await listReceipts(), []);
  assert.equal(progress.filter((event) => String(event.type).startsWith("payment.")).length, 0);
  const gate = (result.events as Array<Record<string, unknown>>).find((event) => event.type === "goalfit.gate");
  assert.equal(gate?.decision, "stop_zero_spend");
});

test("negative control: gate stops on low seller expectedValue even without an explicit irrelevance statement", async () => {
  const fixture = setup([assessment("bitcoin-halving", 0.12, 25)], {
    goal: "explain bitcoin halving",
    article: cryptoArticle(),
  });
  const result = await runBuy(fixture.runtime);
  assert.equal(result.outcome, "NO_RELEVANT_ARTICLE");
  assert.equal((result.result as { amountPaidAtomic: string }).amountPaidAtomic, "0");
  assert.equal(fixture.runs.length, 0);
  const gate = (result.events as Array<Record<string, unknown>>).find((event) => event.type === "goalfit.gate");
  assert.equal(gate?.reason, "below_relevance_threshold");
});

test("negative control: a seller recommendation cannot authorize payment when the seller says the content is unrelated", async () => {
  const fixture = setup([assessment("bitcoin-halving", 0.9, 5)], {
    goal: "explain bitcoin thermodynamics",
    article: cryptoArticle(),
    sellerMessage: "I recommend bitcoin-halving, but this article is unrelated to thermodynamics and cannot answer that goal.",
  });
  const result = await runBuy(fixture.runtime);
  assert.equal(result.outcome, "NO_RELEVANT_ARTICLE");
  assert.equal(fixture.runs.length, 0);
  const gate = (result.events as Array<Record<string, unknown>>).find((event) => event.type === "goalfit.gate");
  assert.equal(gate?.reason, "seller_declared_unrelated");
});

test("goal-fit gate blocks full-article granularity purchases the same way", async () => {
  const fixture = setup([assessment("bitcoin-halving", 0.12, 25)], {
    goal: "explain the second law of thermodynamics",
    article: cryptoArticle(),
  });
  fixture.runtime.parsed = parseArgs(["buy", "--first", "--goal", "explain the second law of thermodynamics", "--max-atomic", "100", "--granularity", "article"]);
  const result = await runBuy(fixture.runtime);
  assert.equal(result.outcome, "NO_RELEVANT_ARTICLE");
  assert.equal(fixture.runs.length, 0);
});

test("goal-fit gate lets relevant purchases proceed and never buys below-floor sections", async () => {
  const fixture = setup([assessment("practical", 0.8, 2), assessment("counterarguments", 0.12, 1)]);
  const result = await runBuy(fixture.runtime);
  assert.deepEqual(fixture.runs.map((run) => run.sectionId), ["practical"]);
  assert.equal(result.outcome, undefined);
  assert.ok(BigInt((result.result as { amountPaidAtomic: string }).amountPaidAtomic) > 0n);
});

test("purchase one intent allows at most one article and one purchase session", async () => {
  const fixture = setup([assessment("practical", 0.8, 1), assessment("counterarguments", 0.7, 1)], {
    goal: "purchase one practical article",
  });
  await runBuy(fixture.runtime);
  assert.equal(fixture.runs.length, 1);
  assert.equal(new Set(fixture.runs.map((run) => run.articleId)).size, 1);
});

test("emits live progress for seller consultation, payment, and receipt verification", async () => {
  const fixture = setup([assessment("practical", 0.9, 1)]);
  const progress: Array<Record<string, unknown>> = [];
  await runBuy(fixture.runtime, { onProgress: (event) => progress.push(event) });
  const lifecycle = progress.filter((event) => [
    "seller.consultation.started",
    "seller.consultation.completed",
    "payment.started",
    "payment.completed",
    "receipt.verification.started",
    "receipt.verification.completed",
  ].includes(String(event.type))).map((event) => event.type);
  assert.deepEqual(lifecycle, [
    "seller.consultation.started",
    "seller.consultation.completed",
    "payment.started",
    "payment.completed",
    "receipt.verification.started",
    "receipt.verification.completed",
  ]);
});

test("assessGoalFit treats seller confirmation as required and metadata selection as provisional", () => {
  const article = cryptoArticle();
  const navigation = {
    articleId: article.articleId,
    sections: article.sections,
    sellerAgent: {
      recommendedSectionId: "bitcoin-halving",
      alternativeSectionIds: [],
      sectionAssessments: [assessment("bitcoin-halving", 0.12, 25)],
      rationale: "Halving history.",
      safeHints: [],
      withheld: [],
    },
    stopConditions: [],
  };
  const fit = assessGoalFit({ article, goal: "explain the second law of thermodynamics", navigation, messages: [] });
  assert.equal(fit.metadataRelevance, 0);
  assert.equal(fit.sufficient, false);
  assert.equal(fit.bestSellerExpectedValue, 0.12);
  assert.equal(fit.minimumExpectedValue, MIN_GOAL_FIT_EXPECTED_VALUE);
});

function assessment(sectionId: string, expectedValue: number, minimumUsefulWords: number, rationale?: string): SellerSectionAssessment {
  return { sectionId, expectedValue, minimumUsefulWords, rationale: rationale ?? `${sectionId} details` };
}

function cryptoArticle(): ArticleSummary {
  return {
    articleId: "article_crypto", creatorId: "creator_1", creatorUsername: "creator", title: "Crypto Market Cycles", author: "Satoshi", state: "live",
    totalWords: 500, pricePerWordAtomic: "400", maxArticlePriceAtomic: "200000",
    sections: [
      { sectionId: "bitcoin-halving", heading: "Bitcoin halving history", level: 1, wordStart: 0, wordCount: 250 },
      { sectionId: "defi-yield", heading: "DeFi yield strategies", level: 1, wordStart: 250, wordCount: 250 },
    ],
  };
}

function decentralizedTrainingArticle(): ArticleSummary {
  return {
    articleId: "article_training", creatorId: "creator_1", creatorUsername: "creator", title: "Scaling Decentralized Training", author: "Ada", state: "live",
    totalWords: 500, pricePerWordAtomic: "400", maxArticlePriceAtomic: "200000",
    sections: [
      { sectionId: "distributed-optimization", heading: "Distributed optimization", level: 1, wordStart: 0, wordCount: 250 },
      { sectionId: "network-topology", heading: "Network topology", level: 1, wordStart: 250, wordCount: 250 },
    ],
  };
}

function setup(assessments: SellerSectionAssessment[], options: { price?: `${bigint}`; budgetAtomic?: `${bigint}`; maliciousOvercharge?: boolean; paymentMode?: string; goal?: string; article?: ArticleSummary; sellerMessage?: string } = {}) {
  process.env.HOME = mkdtempSync(join(tmpdir(), "rubicon-buy-test-"));
  const price = options.price ?? "1";
  const article: ArticleSummary = options.article ?? {
    articleId: "article_1", creatorId: "creator_1", creatorUsername: "creator", title: "Useful Field Guide", author: "Ada", state: "live",
    totalWords: 30, pricePerWordAtomic: price, maxArticlePriceAtomic: `${BigInt(price) * 30n}`,
    sections: [
      { sectionId: "intro", heading: "Introduction", level: 1, wordStart: 0, wordCount: 10 },
      { sectionId: "practical", heading: "Practical details", level: 1, wordStart: 10, wordCount: 10 },
      { sectionId: "counterarguments", heading: "Counterarguments", level: 1, wordStart: 20, wordCount: 10 },
    ],
  };
  const navigation = { articleId: article.articleId, sections: article.sections, sellerAgent: { recommendedSectionId: assessments[0]?.sectionId ?? "intro", alternativeSectionIds: assessments.slice(1).map((item) => item.sectionId), sectionAssessments: assessments, rationale: "Seller ranking", safeHints: [], withheld: [] }, stopConditions: [] };
  const runs: RunOptions[] = [];
  const consultations: string[] = [];
  const client = {
    async getRepository() { return { repository: "articles" as const, articles: [article] }; },
    async startConversation() {
      consultations.push(article.articleId);
      const messages = options.sellerMessage
        ? [{ id: "message_1", role: "seller" as const, content: options.sellerMessage, createdAt: new Date().toISOString() }]
        : [];
      return { conversationId: "conversation_1", articleId: article.articleId, article, navigation, messages };
    },
    async run(input: RunOptions) {
      runs.push(input);
      const words = input.maxWords ?? 1;
      const allowed = BigInt(input.maxSpendAtomic!);
      const paid = options.maliciousOvercharge ? allowed + 1n : BigInt(words) * BigInt(article.pricePerWordAtomic);
      return receipt(input.sectionId!, words, `${paid}`, runs.length);
    },
  } as unknown as RubiconClient;
  const runtime: CommandRuntime = {
    parsed: parseArgs(["buy", "--first", "--goal", options.goal ?? "practical answer", "--max-atomic", options.budgetAtomic ?? "100"]),
    config: { gatewayUrl: "https://rubicon.test" }, gatewayUrl: "https://rubicon.test", paymentMode: options.paymentMode ?? "static", client,
  };
  return { runtime, runs, consultations };
}

function receipt(sectionId: string, words: number, amount: `${bigint}`, index: number): ReadReceipt {
  return { sessionId: `session_${index}`, articleId: "article_1", conversationId: "conversation_1", wordsRead: words, amountPaidAtomic: amount, payments: [], transactionHashes: [], settlementIds: [], text: `${sectionId} purchased content`, completed: words >= 10, stopReason: words >= 10 ? "article_completed" : "max_words" };
}
