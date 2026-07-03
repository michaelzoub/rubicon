import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReadReceipt, RubiconClient } from "@rubicon-caliga/agent-sdk/agent-client";
import type { ArticleSummary } from "@rubicon-caliga/core";
import { parseArgs } from "./args.js";
import { CliError } from "./errors.js";
import { finalReceiptJson, runDoctor, runQuickstartRead, type CommandRuntime } from "./quickstart.js";

test("doctor reports missing gateway config and Circle CLI missing", async () => {
  const runtime = runtimeFor();
  const result = await runDoctor(runtime, {
    cliVersion: "0.1.1",
    fetch: okFetch,
    circleRunner: async () => {
      throw new Error("spawn circle ENOENT");
    },
  });

  const checks = result.checks as Array<{ name: string; status: string; guidance?: string }>;
  assert.equal(checks.find((check) => check.name === "gatewayConfig")?.status, "warning");
  assert.match(checks.find((check) => check.name === "gatewayConfig")?.guidance ?? "", /hosted default/);
  assert.equal(checks.find((check) => check.name === "circleCli")?.status, "error");
  assert.match(checks.find((check) => check.name === "circleCli")?.guidance ?? "", /Install Circle CLI/);
});

test("doctor explains Circle CLI not logged in and sandbox network failures", async () => {
  const notLoggedIn = await runDoctor(runtimeFor(), {
    fetch: okFetch,
    circleRunner: async (_command, args) => {
      if (args[0] === "--version") return "circle 1.0.0";
      throw new Error("unauthorized: please login");
    },
  });
  const notLoggedChecks = notLoggedIn.checks as Array<{ name: string; guidance?: string }>;
  assert.match(notLoggedChecks.find((check) => check.name === "circleAuth")?.guidance ?? "", /login/);

  const networkFailure = await runDoctor(runtimeFor(), {
    fetch: (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch,
    circleRunner: async () => "circle 1.0.0",
  });
  const networkChecks = networkFailure.checks as Array<{ name: string; guidance?: string }>;
  assert.match(networkChecks.find((check) => check.name === "gatewayReachability")?.guidance ?? "", /network-capable/);
});

test("quickstart refuses paid reads without explicit budget", async () => {
  await assert.rejects(
    () => runQuickstartRead(runtimeFor({ argv: ["quickstart-read", "--first", "--goal", "answer"] })),
    (error) => error instanceof CliError && error.code === "MISSING_BUDGET",
  );
});

test("quickstart detects expired OTP request IDs", async () => {
  await assert.rejects(
    () =>
      runQuickstartRead(runtimeFor(), {
        circleRunner: async (_command, args) => {
          if (args[0] === "wallet" && args[1] === "status") throw new Error("OTP request id expired");
          return circleOutput(args, "1000000");
        },
      }),
    (error) => error instanceof CliError && error.code === "OTP_EXPIRED" && /fresh Circle auth OTP/.test(error.message),
  );
});

test("quickstart stops when dry-run estimate exceeds budget", async () => {
  await assert.rejects(
    () => runQuickstartRead(runtimeFor({ article: article({ pricePerWordAtomic: "1000000" }) }), {
      circleRunner: async (_command, args) => circleOutput(args, "1000000"),
    }),
    (error) => error instanceof CliError && error.code === "BUDGET_TOO_SMALL",
  );
});

test("quickstart uses existing Arc Testnet balance without faucet", async () => {
  const calls: string[][] = [];
  const result = await runQuickstartRead(runtimeFor(), {
    circleRunner: async (_command, args) => {
      calls.push(args);
      return circleOutput(args, "1000000");
    },
  });

  assert.equal((result.result as Record<string, unknown>).amountPaidAtomic, "2");
  assert.equal(calls.some((args) => args[0] === "gateway" && args[1] === "faucet"), false);
  assert.equal(calls.some((args) => args[0] === "auth"), false);
});

test("quickstart faucet-funds only the testnet path when needed", async () => {
  const calls: string[][] = [];
  let funded = false;
  const result = await runQuickstartRead(runtimeFor(), {
    circleRunner: async (_command, args) => {
      calls.push(args);
      if (args[0] === "wallet" && args[1] === "fund") {
        funded = true;
        return JSON.stringify({ ok: true });
      }
      return circleOutput(args, funded ? "1000000" : "0");
    },
  });

  assert.equal(calls.some((args) => args[0] === "wallet" && args[1] === "fund" && args.includes("--token") && args.includes("usdc")), true);
  assert.equal(calls.some((args) => args[0] === "gateway" && args[1] === "faucet"), false);
  assert.equal((result.wallet as Record<string, unknown>).balanceAtomic, "1000000");
});

test("hosted buyer flow uses only Circle 0.0.6-compatible wallet commands and stays under cap", async () => {
  const calls: string[][] = [];
  const result = await runQuickstartRead(runtimeFor({
    argv: ["buy", "--first", "--goal", "find and summarize the first available article", "--max-usdc", "0.01", "--json"],
  }), {
    circleRunner: async (_command, args) => {
      calls.push(args);
      return circleOutput(args, "1000000");
    },
  });

  const output = result as Record<string, unknown>;
  const final = output.result as Record<string, unknown>;
  assert.equal(calls.some((args) => args[0] === "auth"), false);
  assert.equal(calls.some((args) => args[0] === "gateway" && args[1] === "faucet"), false);
  assert.equal(calls.some((args) => args[0] === "wallet" && args[1] === "status" && args.includes("--type") && args.includes("agent") && args.includes("--testnet")), true);
  assert.ok(BigInt(String(final.amountPaidAtomic)) <= 10_000n);
  assert.equal(final.approvedBudgetUsdc, "0.01");
  assert.equal(final.articleId, "article_1");
  assert.deepEqual(final.receiptIds, ["session_1-article_1"]);
  assert.equal((final.receipts as Array<Record<string, unknown>>)[0]?.sessionId, "session_1");
  assert.deepEqual((final.receipts as Array<Record<string, unknown>>)[0]?.paymentIds, ["payment_1"]);
});

test("quickstart refuses to suggest mainnet funding", async () => {
  await assert.rejects(
    () =>
      runQuickstartRead(runtimeFor({ article: article({ environment: "mainnet", network: "eip155:1", circleChain: "ETH" }) }), {
        circleRunner: async (_command, args) => circleOutput(args, "0"),
      }),
    (error) => error instanceof CliError && error.code === "INSUFFICIENT_FUNDS" && /Refusing to suggest mainnet funding/.test(error.message),
  );
});

test("final receipt schema includes buyer/Circle wallet mismatch explanation", () => {
  const shaped = finalReceiptJson({
    article: article(),
    receipt: receipt(),
    receiptId: "receipt_1",
    goal: "answer",
    approvedBudgetUsdc: "0.01",
    circleWalletAddress: "0x1111111111111111111111111111111111111111",
  });

  assert.deepEqual(Object.keys(shaped), [
    "articleId",
    "title",
    "author",
    "sessionId",
    "receiptId",
    "goal",
    "approvedBudgetUsdc",
    "amountPaidAtomic",
    "amountPaidUsdc",
    "wordsRead",
    "completed",
    "stopReason",
    "paymentIds",
    "settlementIds",
    "transactionHashes",
    "buyerWalletAddress",
    "circleWalletAddress",
    "walletAddressMismatchExplanation",
  ]);
  assert.match(String(shaped.walletAddressMismatchExplanation), /Gateway backing EOA/);
});

function runtimeFor(input: { argv?: string[]; article?: ArticleSummary } = {}): CommandRuntime {
  process.env.HOME = mkdtempSync(join(tmpdir(), "rubicon-cli-test-"));
  const articleFixture = input.article ?? article();
  const navigationFixture = {
    articleId: articleFixture.articleId,
    sections: articleFixture.sections,
    sellerAgent: {
      recommendedSectionId: "intro",
      alternativeSectionIds: [],
      rationale: "Start here.",
      safeHints: [],
      withheld: [],
    },
    stopConditions: [],
  };
  const client = {
    async getRepository() {
      return { repository: "articles" as const, articles: [articleFixture] };
    },
    async getNavigation() {
      return {
        article: articleFixture,
        navigation: navigationFixture,
      };
    },
    async startConversation() {
      return {
        conversationId: "conversation_1",
        articleId: articleFixture.articleId,
        article: articleFixture,
        navigation: navigationFixture,
        messages: [{ id: "message_1", role: "seller", content: "Start here.", recommendedSectionId: "intro", createdAt: new Date().toISOString() }],
      };
    },
    async run() {
      return receipt();
    },
  } as unknown as RubiconClient;
  return {
    parsed: parseArgs(input.argv ?? ["quickstart-read", "--first", "--goal", "answer", "--max-usdc", "0.01"]),
    config: {},
    gatewayUrl: "https://rubicon.test",
    paymentMode: "circle-cli",
    circleChain: "ARC-TESTNET",
    client,
  };
}

function article(input: {
  pricePerWordAtomic?: `${bigint}`;
  network?: string;
  circleChain?: string;
  environment?: "testnet" | "mainnet" | "unknown";
} = {}): ArticleSummary {
  return {
    articleId: "article_1",
    creatorId: "creator_1",
    creatorUsername: "creator",
    title: "Rubicon Field Notes",
    author: "Ada",
    state: "live",
    totalWords: 2,
    pricePerWordAtomic: input.pricePerWordAtomic ?? "1",
    maxArticlePriceAtomic: `${BigInt(input.pricePerWordAtomic ?? "1") * 2n}` as `${bigint}`,
    paymentTerms: {
      asset: "USDC",
      network: input.network ?? "eip155:5042002",
      circleChain: input.circleChain ?? "ARC-TESTNET",
      environment: input.environment ?? "testnet",
      fundingMethod: "Circle testnet faucet.",
      payTo: "0x3333333333333333333333333333333333333333",
      pricePerWordAtomic: input.pricePerWordAtomic ?? "1",
      meteringUnit: "word",
    },
    sections: [{ sectionId: "intro", heading: "Intro", level: 1, wordStart: 0, wordCount: 2 }],
  };
}

function receipt(): ReadReceipt {
  return {
    sessionId: "session_1",
    articleId: "article_1",
    conversationId: "conversation_1",
    wordsRead: 2,
    amountPaidAtomic: "2",
    payments: [
      {
        paymentId: "payment_1",
        sessionId: "session_1",
        articleId: "article_1",
        sequence: 0,
        meteringUnit: "word",
        amountAtomic: "2",
        currency: "USDC",
        settlementIds: ["settlement_1"],
        transactionHashes: ["0xtx"],
        buyerWalletAddress: "0x2222222222222222222222222222222222222222",
        settledAt: "2026-06-19T12:00:00.000Z",
      },
    ],
    transactionHashes: ["0xtx"],
    settlementIds: ["settlement_1"],
    buyerWalletAddress: "0x2222222222222222222222222222222222222222",
    sellerPayTo: "0x3333333333333333333333333333333333333333",
    network: "eip155:5042002",
    text: "hello world",
    completed: true,
    stopReason: "article_completed",
  };
}

function circleOutput(args: string[], balanceAtomic: `${bigint}`): string {
  if (args[0] === "--version") return "circle 1.0.0";
  if (args[0] === "wallet" && args[1] === "status") return JSON.stringify({ data: { testnet: { tokenStatus: "VALID" }, mainnet: { tokenStatus: "VALID" } } });
  if (args[0] === "wallet") {
    return JSON.stringify({ data: { wallets: [{ address: "0x1111111111111111111111111111111111111111" }] } });
  }
  if (args[0] === "gateway" && args[1] === "balance") {
    return JSON.stringify({ data: { balanceAtomic, backingEOA: "0x2222222222222222222222222222222222222222" } });
  }
  return JSON.stringify({ ok: true });
}

const okFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
