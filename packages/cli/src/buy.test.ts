import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReadReceipt, RubiconClient, RunOptions } from "@rubicon-caliga/agent-sdk";
import type { ArticleSummary, SellerSectionAssessment } from "@rubicon-caliga/core";
import { parseArgs } from "./args.js";
import { CliError } from "./errors.js";
import { runBuy, type CommandRuntime } from "./quickstart.js";
import { loadReceipt } from "./receipts.js";

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

test("buy reports wallet setup failures before payment", async () => {
  const fixture = setup([assessment("practical", 0.9, 1)], { paymentMode: "circle-cli" });
  await assert.rejects(
    () => runBuy(fixture.runtime, { circleRunner: async () => { throw new Error("spawn circle ENOENT"); } }),
    (error) => error instanceof CliError && error.code === "MISSING_CLI",
  );
  assert.equal(fixture.runs.length, 0);
});

function assessment(sectionId: string, expectedValue: number, minimumUsefulWords: number): SellerSectionAssessment {
  return { sectionId, expectedValue, minimumUsefulWords, rationale: `${sectionId} details` };
}

function setup(assessments: SellerSectionAssessment[], options: { price?: `${bigint}`; budgetAtomic?: `${bigint}`; maliciousOvercharge?: boolean; paymentMode?: string } = {}) {
  process.env.HOME = mkdtempSync(join(tmpdir(), "rubicon-buy-test-"));
  const price = options.price ?? "1";
  const article: ArticleSummary = {
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
  const client = {
    async getRepository() { return { repository: "articles" as const, articles: [article] }; },
    async startConversation() { return { conversationId: "conversation_1", articleId: article.articleId, article, navigation, messages: [] }; },
    async run(input: RunOptions) {
      runs.push(input);
      const words = input.maxWords ?? 1;
      const allowed = BigInt(input.maxSpendAtomic!);
      const paid = options.maliciousOvercharge ? allowed + 1n : BigInt(words) * BigInt(price);
      return receipt(input.sectionId!, words, `${paid}`, runs.length);
    },
  } as unknown as RubiconClient;
  const runtime: CommandRuntime = {
    parsed: parseArgs(["buy", "--first", "--goal", "practical answer", "--max-atomic", options.budgetAtomic ?? "100"]),
    config: { gatewayUrl: "https://rubicon.test" }, gatewayUrl: "https://rubicon.test", paymentMode: options.paymentMode ?? "static", client,
  };
  return { runtime, runs };
}

function receipt(sectionId: string, words: number, amount: `${bigint}`, index: number): ReadReceipt {
  return { sessionId: `session_${index}`, articleId: "article_1", conversationId: "conversation_1", wordsRead: words, amountPaidAtomic: amount, payments: [], transactionHashes: [], settlementIds: [], text: `${sectionId} purchased content`, completed: words >= 10, stopReason: words >= 10 ? "article_completed" : "max_words" };
}
