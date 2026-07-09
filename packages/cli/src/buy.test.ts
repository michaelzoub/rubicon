import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReadReceipt, RubiconClient, RunOptions } from "@rubicon-caliga/agent-sdk/agent-client";
import type { ArticleSummary, SellerSectionAssessment } from "@rubicon-caliga/core";
import { lexicalSearch } from "@rubicon-caliga/core";
import { parseArgs } from "./args.js";
import { CliError } from "./errors.js";
import { loadOperation } from "./operations.js";
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
  await assert.rejects(() => runBuy(fixture.runtime), (error) => error instanceof CliError && error.code === "BUDGET_TOO_LOW_FOR_SUMMARY");
  assert.equal(fixture.runs.length, 0);
});

test("buy reads an explicit free article with a zero cap and never invokes Circle", async () => {
  const freeArticle: ArticleSummary = {
    articleId: "article_1",
    creatorId: "creator_1",
    creatorUsername: "creator",
    title: "Useful Field Guide",
    author: "Ada",
    state: "live",
    accessMode: "free",
    totalWords: 10,
    pricePerWordAtomic: "0",
    maxArticlePriceAtomic: "0",
    sections: [{ sectionId: "practical", heading: "Practical details", level: 1, wordStart: 0, wordCount: 10 }],
  };
  const circleCalls: string[][] = [];
  const fixture = setup([assessment("practical", 0.9, 2)], {
    article: freeArticle,
    paymentMode: "circle-cli",
    budgetAtomic: "0",
  });
  const result = await runBuy(fixture.runtime, {
    circleRunner: async (_command, args) => {
      circleCalls.push(args);
      throw new Error("free read invoked Circle");
    },
  });
  const outcome = result.result as {
    amountPaidAtomic: string;
    amountPaidUsdc: string;
    wordsRead: number;
    purchasedInformation: string;
    receipts: Array<{
      amountPaidAtomic: string;
      amountPaidUsdc: string;
      paymentIds: string[];
      settlementIds: string[];
      transactionHashes: string[];
      buyerWalletAddress?: string;
      circleWalletAddress?: string;
    }>;
  };
  assert.equal(circleCalls.length, 0);
  assert.equal(fixture.runs[0]?.maxSpendAtomic, "0");
  assert.equal(outcome.amountPaidAtomic, "0");
  assert.equal(outcome.amountPaidUsdc, "0");
  assert.equal(outcome.wordsRead, 10);
  assert.equal(outcome.purchasedInformation, "practical purchased content");
  const freeReceipt = outcome.receipts[0]!;
  assert.equal(freeReceipt.amountPaidAtomic, "0");
  assert.equal(freeReceipt.amountPaidUsdc, "0");
  assert.deepEqual(freeReceipt.paymentIds, []);
  assert.deepEqual(freeReceipt.settlementIds, []);
  assert.deepEqual(freeReceipt.transactionHashes, []);
  assert.equal(freeReceipt.buyerWalletAddress, undefined);
  assert.equal(freeReceipt.circleWalletAddress, undefined);
  assert.equal((result as { wallet?: unknown }).wallet, undefined);
  const events = result.events as Array<{ type: string }>;
  assert.ok(events.some((event) => event.type === "free_read.started"));
  assert.ok(events.some((event) => event.type === "free_read.completed"));
  assert.ok(!events.some((event) => event.type === "payment.started" || event.type === "payment.completed"));
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

test("buy preserves redacted Circle diagnostics when a Circle command fails transiently", async () => {
  const fixture = setup([assessment("practical", 0.9, 1)], { paymentMode: "circle-cli" });
  const failure = Object.assign(new Error("Command failed with exit code 1"), {
    code: 1,
    stdout: '{"status":"degraded"}',
    stderr: "503 upstream timeout; token=super-secret-value",
  });
  await assert.rejects(
    () => runBuy(fixture.runtime, { circleRunner: async () => { throw failure; } }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "COMMAND_FAILED");
      const circle = (error.details as { circle: Record<string, unknown> }).circle;
      assert.equal(circle.command, "circle");
      assert.deepEqual(circle.args, ["wallet", "status", "--type", "agent", "--output", "json"]);
      assert.equal(circle.exitCode, 1);
      assert.match(String(circle.stdout), /degraded/);
      assert.match(String(circle.stderr), /503 upstream timeout/);
      assert.ok(!String(circle.stderr).includes("super-secret-value"));
      return true;
    },
  );
  assert.equal(fixture.runs.length, 0);
});

test("buy stops with BUDGET_TOO_LOW_FOR_SUMMARY before any Circle invocation when no useful section fits", async () => {
  const circleCalls: string[][] = [];
  const fixture = setup([assessment("practical", 0.9, 5)], { paymentMode: "circle-cli", price: "100", budgetAtomic: "250" });
  await assert.rejects(
    () => runBuy(fixture.runtime, {
      circleRunner: async (_command, args) => {
        circleCalls.push(args);
        return JSON.stringify({ ok: true });
      },
    }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "BUDGET_TOO_LOW_FOR_SUMMARY");
      const details = error.details as Record<string, unknown>;
      assert.equal(details.budgetAtomic, "250");
      assert.equal(details.cheapestMinimumUsefulWords, 5);
      assert.equal(details.cheapestMinimumCostAtomic, "500");
      return true;
    },
  );
  assert.equal(circleCalls.length, 0);
  assert.equal(fixture.runs.length, 0);
  assert.deepEqual(await listReceipts(), []);
});

test("buy retries safely after an ambiguous payment failure without duplicate payment or cap reset", async () => {
  const fixture = setup([assessment("practical", 0.9, 1)]);
  const client = fixture.runtime.client as unknown as { run: (input: RunOptions) => Promise<ReadReceipt> };
  const originalRun = client.run.bind(fixture.runtime.client);
  let failNext = true;
  client.run = async (input: RunOptions) => {
    if (failNext) {
      failNext = false;
      throw new Error("socket hang up");
    }
    return originalRun(input);
  };

  const failure = await runBuy(fixture.runtime).then(
    () => assert.fail("expected PAYMENT_AMBIGUOUS"),
    (error) => error as CliError,
  );
  assert.ok(failure instanceof CliError);
  assert.equal(failure.code, "PAYMENT_AMBIGUOUS");
  const operationId = (failure.details as { operationId: string }).operationId;
  assert.ok(operationId.startsWith("op_"));
  assert.equal((await loadOperation(operationId))?.status, "ambiguous");
  assert.equal(fixture.runs.length, 0);
  assert.deepEqual(await listReceipts(), []);

  const retryProgress: Array<Record<string, unknown>> = [];
  const retry = await runBuy(fixture.runtime, { onProgress: (event) => retryProgress.push(event) });
  const retryResult = retry.result as { amountPaidAtomic: string; receiptIds: string[] };
  assert.equal(fixture.runs.length, 1);
  assert.equal(retryProgress.find((event) => event.type === "payment.started")?.operationId, operationId);
  const completedOperation = await loadOperation(operationId);
  assert.equal(completedOperation?.status, "completed");
  assert.equal(completedOperation?.attempts, 2);
  assert.ok(BigInt(retryResult.amountPaidAtomic) > 0n);

  const thirdProgress: Array<Record<string, unknown>> = [];
  const third = await runBuy(fixture.runtime, { onProgress: (event) => thirdProgress.push(event) });
  const thirdResult = third.result as { amountPaidAtomic: string; receiptIds: string[]; operations: Array<{ reused: boolean; operationId: string }> };
  assert.equal(fixture.runs.length, 1);
  assert.equal(thirdProgress.filter((event) => event.type === "payment.started").length, 0);
  assert.equal(thirdProgress.find((event) => event.type === "payment.reused")?.operationId, operationId);
  assert.equal(thirdResult.amountPaidAtomic, retryResult.amountPaidAtomic);
  assert.deepEqual(thirdResult.receiptIds, retryResult.receiptIds);
  assert.deepEqual(thirdResult.operations, [{ operationId, sectionId: "practical", status: "completed", reused: true, receiptId: retryResult.receiptIds[0] }]);
  assert.equal((await listReceipts()).length, 1);
});

test("buy treats a resolved-but-aborted read as an ambiguous payment instead of a zero-spend success", async () => {
  const fixture = setup([assessment("practical", 0.9, 1)]);
  const client = fixture.runtime.client as unknown as { run: (input: RunOptions) => Promise<ReadReceipt> };
  client.run = async (input: RunOptions) => {
    fixture.runs.push(input);
    // A mid-stream network failure inside read() resolves with an "aborted"
    // receipt (empty text, zero paid) rather than rejecting.
    return {
      sessionId: "session_aborted", articleId: "article_1", conversationId: "conversation_1",
      wordsRead: 0, amountPaidAtomic: "0", payments: [], transactionHashes: [], settlementIds: [],
      text: "", completed: false, stopReason: "aborted",
    };
  };

  const failure = await runBuy(fixture.runtime).then(
    () => assert.fail("expected PAYMENT_AMBIGUOUS"),
    (error) => error as CliError,
  );
  assert.ok(failure instanceof CliError);
  assert.equal(failure.code, "PAYMENT_AMBIGUOUS");
  const operationId = (failure.details as { operationId: string }).operationId;
  assert.ok(operationId.startsWith("op_"));
  assert.equal((await loadOperation(operationId))?.status, "ambiguous");
  // No misleading success receipt is persisted for an ambiguous payment.
  assert.deepEqual(await listReceipts(), []);
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
    articleId: "article_crypto", creatorId: "creator_1", creatorUsername: "creator", title: "Crypto Market Cycles", author: "Satoshi", state: "live", accessMode: "paid",
    totalWords: 500, pricePerWordAtomic: "400", maxArticlePriceAtomic: "200000",
    sections: [
      { sectionId: "bitcoin-halving", heading: "Bitcoin halving history", level: 1, wordStart: 0, wordCount: 250 },
      { sectionId: "defi-yield", heading: "DeFi yield strategies", level: 1, wordStart: 250, wordCount: 250 },
    ],
  };
}

function decentralizedTrainingArticle(): ArticleSummary {
  return {
    articleId: "article_training", creatorId: "creator_1", creatorUsername: "creator", title: "Scaling Decentralized Training", author: "Ada", state: "live", accessMode: "paid",
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
    articleId: "article_1", creatorId: "creator_1", creatorUsername: "creator", title: "Useful Field Guide", author: "Ada", state: "live", accessMode: "paid",
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
    async search(query: string, options?: { limit?: number }) {
      return { query, mode: "lexical" as const, results: lexicalSearch([article], query, options?.limit ?? 20) };
    },
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

// --- Conditional testnet funding regression tests -------------------------
//
// The buyer must fund from the testnet faucet only when the usable Gateway
// payment balance cannot cover the pending payment, never on every buy, and it
// must survive a rate-limited (429) faucet whenever the wallet already holds
// usable funds.

const BUYER_WALLET = "0xb161c2306a4f58ca41c4c0b10544d953c8af26b7";

const FAUCET_429 = Object.assign(new Error("Faucet drip failed (429): API rate limit error"), { code: 1 });

function fundingRunner(options: { balances: `${bigint}`[]; onFaucet?: () => void }) {
  const calls: Array<{ command: string; args: string[] }> = [];
  let balanceIndex = 0;
  const runner = async (command: string, args: string[]): Promise<string> => {
    calls.push({ command, args });
    if (args[0] === "wallet" && args[1] === "status") return JSON.stringify({ status: "active", loggedIn: true });
    if (args[0] === "wallet" && args[1] === "list") return JSON.stringify({ wallets: [{ address: BUYER_WALLET }] });
    if (args[0] === "gateway" && args[1] === "balance") {
      const value = options.balances[Math.min(balanceIndex, options.balances.length - 1)]!;
      balanceIndex += 1;
      return JSON.stringify({ data: { balanceAtomic: value } });
    }
    if (args[0] === "wallet" && args[1] === "fund") {
      options.onFaucet?.();
      return JSON.stringify({ ok: true, funded: true });
    }
    return JSON.stringify({ ok: true });
  };
  const faucetCalls = () => calls.filter((call) => call.args[0] === "wallet" && call.args[1] === "fund").length;
  return { runner, calls, faucetCalls };
}

function testnetArticle(options: { minimumUsefulWords?: number } = {}): ArticleSummary {
  return {
    articleId: "article_1", creatorId: "creator_1", creatorUsername: "creator", title: "Useful Field Guide", author: "Ada", state: "live", accessMode: "paid",
    totalWords: 30, pricePerWordAtomic: "1", maxArticlePriceAtomic: "30",
    paymentTerms: {
      asset: "USDC", network: "eip155:5042002", networkLabel: "Arc Testnet", circleChain: "ARC-TESTNET", environment: "testnet",
      payTo: "0x0000000000000000000000000000000000000001", pricePerWordAtomic: "1", meteringUnit: "word",
    },
    sections: [
      { sectionId: "intro", heading: "Introduction", level: 1, wordStart: 0, wordCount: 10 },
      { sectionId: "practical", heading: "Practical details", level: 1, wordStart: 10, wordCount: 10 },
      { sectionId: "counterarguments", heading: "Counterarguments", level: 1, wordStart: 20, wordCount: 10 },
    ],
  };
}

function fundingFixture(minimumUsefulWords = 1) {
  return setup([assessment("practical", 0.9, minimumUsefulWords)], {
    article: testnetArticle(),
    paymentMode: "circle-cli",
    goal: "practical answer",
  });
}

test("funding: an existing sufficient Gateway balance never triggers a faucet drip", async () => {
  const fixture = fundingFixture();
  const circle = fundingRunner({ balances: ["1000000"] });
  const result = await runBuy(fixture.runtime, { circleRunner: circle.runner });
  assert.equal(circle.faucetCalls(), 0);
  assert.equal(fixture.runs.length, 1);
  assert.ok(BigInt((result.result as { amountPaidAtomic: string }).amountPaidAtomic) > 0n);
});

test("funding: an insufficient balance triggers exactly one faucet call, then the buy proceeds", async () => {
  const fixture = fundingFixture();
  const circle = fundingRunner({ balances: ["0", "1000000"] });
  const result = await runBuy(fixture.runtime, { circleRunner: circle.runner });
  assert.equal(circle.faucetCalls(), 1);
  assert.equal(fixture.runs.length, 1);
  assert.ok(BigInt((result.result as { amountPaidAtomic: string }).amountPaidAtomic) > 0n);
});

test("funding: a faucet 429 with any positive usable balance still lets the spend happen", async () => {
  // Pending payment needs 5 atomic, but the wallet only holds 2 after the 429.
  // Per the buyer contract, a rate-limited faucet must not abort a purchase the
  // wallet can partially fund — the budget loop clamps each read to what remains.
  const fixture = fundingFixture(5);
  const circle = fundingRunner({ balances: ["0", "2"], onFaucet: () => { throw FAUCET_429; } });
  const result = await runBuy(fixture.runtime, { circleRunner: circle.runner });
  assert.equal(circle.faucetCalls(), 1);
  assert.equal(fixture.runs.length, 1);
  assert.ok(BigInt((result.result as { amountPaidAtomic: string }).amountPaidAtomic) > 0n);
  const events = result.events as Array<{ type: string }>;
  assert.ok(events.some((event) => event.type === "funding.faucet.rate_limited"));
});

test("funding: a faucet 429 with no usable balance returns FUNDING_RATE_LIMITED with zero spend", async () => {
  const fixture = fundingFixture();
  const circle = fundingRunner({ balances: ["0", "0"], onFaucet: () => { throw FAUCET_429; } });
  const failure = await runBuy(fixture.runtime, { circleRunner: circle.runner }).then(
    () => assert.fail("expected FUNDING_RATE_LIMITED"),
    (error) => error as CliError,
  );
  assert.ok(failure instanceof CliError);
  assert.equal(failure.code, "FUNDING_RATE_LIMITED");
  const details = failure.details as { retryAfterSeconds: number; approvedBudgetUsdc: string };
  assert.ok(details.retryAfterSeconds > 0);
  // The original cumulative cap is preserved in the recovery command.
  assert.match(String(failure.recovery), /--max-usdc/);
  assert.equal(circle.faucetCalls(), 1);
  // Zero spend: no session and no receipt were created.
  assert.equal(fixture.runs.length, 0);
  assert.deepEqual(await listReceipts(), []);
});

test("funding: a valid Circle login is never treated as a login-recovery condition", async () => {
  const fixture = fundingFixture();
  const circle = fundingRunner({ balances: ["1000000"] });
  const progress: Array<Record<string, unknown>> = [];
  const result = await runBuy(fixture.runtime, { circleRunner: circle.runner, onProgress: (event) => progress.push(event) });
  // The buy completes; nothing reclassified the valid session as NOT_LOGGED_IN.
  assert.ok(BigInt((result.result as { amountPaidAtomic: string }).amountPaidAtomic) > 0n);
  assert.ok(circle.calls.some((call) => call.args[0] === "wallet" && call.args[1] === "status"));
  assert.ok(!progress.some((event) => String(event.type).includes("not_logged_in")));
});

// --- Circle CLI 0.0.6 gateway-balance shape regressions -------------------
//
// These exercise the exact JSON the real Circle CLI emits (decimal `total` plus
// per-network `balances[]`), the shape that previously parsed to 0 and forced a
// needless faucet call / FUNDING_RATE_LIMITED for an already-funded wallet.

const REAL_BACKING_EOA = "0x92cb35294b2e8df793039a49bc94a476350477ed";

function arcGatewayBalanceJson(options: { total?: string; balance?: string; address?: string } = {}): string {
  return JSON.stringify({
    data: {
      message: `Gateway balance: ${options.total ?? "1.1382"} USDC`,
      address: options.address ?? BUYER_WALLET,
      backingEOA: REAL_BACKING_EOA,
      total: options.total ?? "1.1382",
      token: "USDC",
      balances: [{ network: "Arc Testnet", domain: 26, balance: options.balance ?? "1.138200" }],
    },
  });
}

function realShapeRunner(options: { balanceJson?: (index: number) => string; onFaucet?: () => void } = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  let balanceIndex = 0;
  const runner = async (command: string, args: string[]): Promise<string> => {
    calls.push({ command, args });
    if (args[0] === "wallet" && args[1] === "status") return JSON.stringify({ status: "active", loggedIn: true });
    if (args[0] === "wallet" && args[1] === "list") return JSON.stringify({ wallets: [{ address: BUYER_WALLET }] });
    if (args[0] === "gateway" && args[1] === "balance") {
      const json = options.balanceJson?.(balanceIndex) ?? arcGatewayBalanceJson();
      balanceIndex += 1;
      return json;
    }
    if (args[0] === "wallet" && args[1] === "fund") {
      options.onFaucet?.();
      return JSON.stringify({ ok: true, funded: true });
    }
    return JSON.stringify({ ok: true });
  };
  const faucetCalls = () => calls.filter((call) => call.args[0] === "wallet" && call.args[1] === "fund").length;
  return { runner, calls, faucetCalls };
}

function mainnetArticle(): ArticleSummary {
  return {
    articleId: "article_1", creatorId: "creator_1", creatorUsername: "creator", title: "Useful Field Guide", author: "Ada", state: "live", accessMode: "paid",
    totalWords: 30, pricePerWordAtomic: "1", maxArticlePriceAtomic: "30",
    paymentTerms: {
      asset: "USDC", network: "eip155:5042002", networkLabel: "Arc", circleChain: "ARC", environment: "mainnet",
      payTo: "0x0000000000000000000000000000000000000001", pricePerWordAtomic: "1", meteringUnit: "word",
    },
    sections: [
      { sectionId: "intro", heading: "Introduction", level: 1, wordStart: 0, wordCount: 10 },
      { sectionId: "practical", heading: "Practical details", level: 1, wordStart: 10, wordCount: 10 },
      { sectionId: "counterarguments", heading: "Counterarguments", level: 1, wordStart: 20, wordCount: 10 },
    ],
  };
}

test("funding: the real Circle 0.0.6 gateway shape recognizes 1.1382 USDC and skips the faucet", async () => {
  const fixture = fundingFixture();
  const circle = realShapeRunner();
  const result = await runBuy(fixture.runtime, { circleRunner: circle.runner });
  assert.equal(circle.faucetCalls(), 0);
  assert.equal(fixture.runs.length, 1);
  const wallet = result.wallet as { balanceAtomic: string; balanceUsdc: string };
  assert.equal(wallet.balanceAtomic, "1138200");
  assert.equal(wallet.balanceUsdc, "1.1382");
  const events = result.events as Array<{ type: string; balanceAtomic?: string; sufficient?: boolean }>;
  const check = events.find((event) => event.type === "funding.check");
  assert.equal(check?.balanceAtomic, "1138200");
  assert.equal(check?.sufficient, true);
  assert.ok(BigInt((result.result as { amountPaidAtomic: string }).amountPaidAtomic) > 0n);
});

test("funding: a Gateway balance reported for a different profile fails GATEWAY_PROFILE_MISMATCH", async () => {
  const fixture = fundingFixture();
  const circle = realShapeRunner({
    balanceJson: () => arcGatewayBalanceJson({ address: "0x00000000000000000000000000000000000000ff" }),
  });
  const failure = await runBuy(fixture.runtime, { circleRunner: circle.runner }).then(
    () => assert.fail("expected GATEWAY_PROFILE_MISMATCH"),
    (error) => error as CliError,
  );
  assert.ok(failure instanceof CliError);
  assert.equal(failure.code, "GATEWAY_PROFILE_MISMATCH");
  assert.equal(circle.faucetCalls(), 0);
  assert.equal(fixture.runs.length, 0);
});

test("funding: an empty mainnet Gateway balance returns GATEWAY_DEPOSIT_REQUIRED without a faucet", async () => {
  const fixture = setup([assessment("practical", 0.9, 1)], {
    article: mainnetArticle(),
    paymentMode: "circle-cli",
    goal: "practical answer",
  });
  const circle = realShapeRunner({ balanceJson: () => arcGatewayBalanceJson({ total: "0", balance: "0.000000" }) });
  const failure = await runBuy(fixture.runtime, { circleRunner: circle.runner }).then(
    () => assert.fail("expected GATEWAY_DEPOSIT_REQUIRED"),
    (error) => error as CliError,
  );
  assert.ok(failure instanceof CliError);
  assert.equal(failure.code, "GATEWAY_DEPOSIT_REQUIRED");
  assert.equal(circle.faucetCalls(), 0);
  assert.equal(fixture.runs.length, 0);
  const details = failure.details as { backingEOA: string; balanceAtomic: string };
  assert.equal(details.balanceAtomic, "0");
  assert.equal(details.backingEOA, REAL_BACKING_EOA);
});
