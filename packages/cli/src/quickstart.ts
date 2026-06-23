import { parseUsdcToAtomic, settlementNetworkInfo, type ArticleSummary, type StreamMode } from "@rubicon-caliga/core";
import type { ReadReceipt, RubiconClient } from "@rubicon-caliga/agent-sdk";
import { stringFlag, type ParsedArgs } from "./args.js";
import {
  circleAgentWallet,
  circleAuthStatus,
  classifyCircleError,
  circleGatewayBalance,
  circleGatewayFaucet,
  circleGuidance,
  circleVersion,
  type CircleRunner,
} from "./circle.js";
import { HOSTED_GATEWAY_URL, writeConfig, type RubiconCliConfig } from "./config.js";
import { CliError } from "./errors.js";
import { articleJson, formatAtomic } from "./format.js";
import { loadReceipt, saveReceipt } from "./receipts.js";

export interface CommandRuntime {
  parsed: ParsedArgs;
  config: RubiconCliConfig;
  gatewayUrl: string;
  paymentMode: string;
  circleChain?: string;
  client: RubiconClient;
}

export interface CommandDeps {
  fetch?: typeof fetch;
  circleRunner?: CircleRunner;
  circleCommand?: string;
  cliVersion?: string;
}

interface CheckResult {
  name: string;
  ok: boolean;
  status: "ok" | "warning" | "error";
  value?: unknown;
  guidance?: string;
}

export async function runDoctor(runtime: CommandRuntime, deps: CommandDeps = {}): Promise<Record<string, unknown>> {
  const checks: CheckResult[] = [];
  checks.push({
    name: "cliVersion",
    ok: true,
    status: "ok",
    value: deps.cliVersion ?? "unknown",
  });
  checks.push({
    name: "gatewayConfig",
    ok: Boolean(runtime.config.gatewayUrl || process.env.RUBICON_GATEWAY_URL || runtime.gatewayUrl),
    status: runtime.config.gatewayUrl || process.env.RUBICON_GATEWAY_URL ? "ok" : "warning",
    value: runtime.gatewayUrl,
    guidance:
      runtime.config.gatewayUrl || process.env.RUBICON_GATEWAY_URL
        ? undefined
        : `No gateway config found; using hosted default ${HOSTED_GATEWAY_URL}. Run rubicon config set gateway-url <url> to pin it.`,
  });

  try {
    const fetcher = deps.fetch ?? fetch;
    const response = await fetcher(`${runtime.gatewayUrl}/health`);
    checks.push({
      name: "gatewayReachability",
      ok: response.ok,
      status: response.ok ? "ok" : "error",
      value: { status: response.status },
      guidance: response.ok ? undefined : "Gateway health check failed. Confirm the URL and network access.",
    });
  } catch (error) {
    checks.push({
      name: "gatewayReachability",
      ok: false,
      status: "error",
      value: errorMessage(error),
      guidance: "Gateway is not reachable from this context. Retry in a network-capable shell or configure a reachable gateway.",
    });
  }

  await addCircleCheck(checks, "circleCli", () => circleVersion(circleInput(runtime, deps)));
  await addCircleCheck(checks, "circleAuth", () => circleAuthStatus(circleInput(runtime, deps)));

  const chain = runtime.circleChain ?? runtime.config.circleChain ?? "ARC-TESTNET";
  let walletAddress: `0x${string}` | undefined;
  await addCircleCheck(checks, "arcTestnetWallet", async () => {
    const wallet = await circleAgentWallet({
      ...circleInput(runtime, deps),
      chain,
      configuredAddress: runtime.config.agentWalletAddress ?? envAddress("CIRCLE_AGENT_WALLET_ADDRESS"),
    });
    walletAddress = wallet.address;
    return wallet.address;
  });

  if (walletAddress) {
    await addCircleCheck(checks, "arcTestnetBalance", async () => circleGatewayBalance({ ...circleInput(runtime, deps), chain, address: walletAddress! }));
  } else {
    checks.push({
      name: "arcTestnetBalance",
      ok: false,
      status: "warning",
      guidance: "Balance check skipped because no Arc Testnet Agent Wallet was found.",
    });
  }

  const balance = checks.find((check) => check.name === "arcTestnetBalance")?.value as { balanceAtomic?: `${bigint}` } | undefined;
  checks.push({
    name: "testnetTokenStatus",
    ok: Boolean(balance?.balanceAtomic && BigInt(balance.balanceAtomic) > 0n),
    status: balance?.balanceAtomic && BigInt(balance.balanceAtomic) > 0n ? "ok" : "warning",
    value: balance?.balanceAtomic ? { balanceAtomic: balance.balanceAtomic, balanceUsdc: formatAtomic(balance.balanceAtomic) } : undefined,
    guidance:
      balance?.balanceAtomic && BigInt(balance.balanceAtomic) > 0n
        ? undefined
        : "Arc Testnet reads can be funded with `circle wallet fund --address <addr> --chain ARC-TESTNET --token usdc --output json`. Do not send mainnet funds for testnet articles.",
  });

  return {
    success: checks.every((check) => check.status !== "error"),
    gatewayUrl: runtime.gatewayUrl,
    paymentMode: runtime.paymentMode,
    checks,
  };
}

export async function runQuickstartRead(runtime: CommandRuntime, deps: CommandDeps = {}): Promise<Record<string, unknown>> {
  return runBuy(runtime, deps);
}

export async function runBuy(runtime: CommandRuntime, deps: CommandDeps = {}): Promise<Record<string, unknown>> {
  if (runtime.parsed.positionals[1] !== "--first" && !runtime.parsed.flags.first) {
    throw new CliError("MISSING_FIRST", "rubicon buy currently requires --first.");
  }
  const goal = stringFlag(runtime.parsed.flags, "goal");
  if (!goal) throw new CliError("MISSING_GOAL", "rubicon buy requires --goal.");
  const maxSpendAtomic = parseQuickstartBudget(runtime.parsed);
  const approvedBudgetUsdc = formatAtomic(maxSpendAtomic);
  const events: Array<Record<string, unknown>> = [];
  const wroteGatewayConfig = await ensureGatewayConfig(runtime);
  const repository = await runtime.client.getRepository();
  const article = [...repository.articles]
    .filter((candidate) => candidate.state === "live")
    .sort((left, right) => articleRelevance(right, goal) - articleRelevance(left, goal))[0];
  if (!article) throw new CliError("NO_ARTICLES", "No public articles are available from the configured gateway.");
  events.push({ type: "article.selected", articleId: article.articleId, basis: "safe_metadata_relevance" });

  const consultation = await runtime.client.startConversation({
    articleId: article.articleId,
    goal,
    message: `For the exact goal "${goal}", rank the best sections, their expected value, minimum useful word count, and alternatives. Prefer concise self-contained sections and preserve budget for conclusions, counterarguments, or practical details when useful.`,
  });
  const navigation = consultation.navigation;
  events.push({ type: "seller.consulted", conversationId: consultation.conversationId, inferenceSource: "safe_metadata", sellerAgent: navigation.sellerAgent });
  const ranked = rankSectionPlans(article, navigation.sellerAgent);
  if (ranked.length === 0) throw new CliError("NO_RELEVANT_SECTIONS", "The seller agent did not identify a purchasable section.");

  const networkInfo = settlementNetworkInfo(article.paymentTerms?.network);
  const chain = article.paymentTerms?.circleChain ?? networkInfo.circleChain ?? runtime.circleChain ?? "ARC-TESTNET";
  const environment = article.paymentTerms?.environment ?? networkInfo.environment;
  let circleWalletAddress: `0x${string}` | undefined;
  let balanceAtomic: `${bigint}` | undefined;

  if (runtime.paymentMode === "circle-cli") {
    try {
      await circleAuthStatus(circleInput(runtime, deps));
      const wallet = await circleAgentWallet({
        ...circleInput(runtime, deps),
        chain,
        configuredAddress: runtime.config.agentWalletAddress ?? envAddress("CIRCLE_AGENT_WALLET_ADDRESS"),
      });
      circleWalletAddress = wallet.address;
      let balance = await circleGatewayBalance({ ...circleInput(runtime, deps), chain, address: wallet.address });
      balanceAtomic = balance.balanceAtomic;
      if (BigInt(balance.balanceAtomic) < BigInt(maxSpendAtomic)) {
        if (environment !== "testnet") {
          throw new CliError("INSUFFICIENT_FUNDS", "Wallet balance is below the dry-run estimate. Refusing to suggest mainnet funding for this article.");
        }
        await circleGatewayFaucet({ ...circleInput(runtime, deps), chain, address: wallet.address });
        balance = await circleGatewayBalance({ ...circleInput(runtime, deps), chain, address: wallet.address });
        balanceAtomic = balance.balanceAtomic;
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      const guidance = circleGuidance(error) ?? circleGuidance(classifyCircleError(error));
      if (guidance) throw new CliError(guidance.code.toUpperCase(), `${guidance.message} ${guidance.guidance}`);
      throw error;
    }
  }

  let spent = 0n;
  let wordsRead = 0;
  let purchasedText = "";
  const visited = new Set<string>();
  const storedReceipts: Array<{ receiptId: string; savedAt: string; receipt: ReadReceipt }> = [];
  for (const plan of ranked) {
    if (visited.has(plan.sectionId)) continue;
    const remaining = BigInt(maxSpendAtomic) - spent;
    const affordableWords = Number(remaining / BigInt(article.pricePerWordAtomic));
    if (affordableWords < 1 || affordableWords < plan.minimumUsefulWords) {
      events.push({ type: "section.skipped", sectionId: plan.sectionId, reason: "insufficient_remaining_budget", remainingAtomic: `${remaining}` });
      continue;
    }
    const section = article.sections.find((candidate) => candidate.sectionId === plan.sectionId)!;
    const reserveWords = reserveWordsForLater(ranked, plan.sectionId, visited, affordableWords);
    const maxWords = Math.min(section.wordCount, Math.max(plan.minimumUsefulWords, affordableWords - reserveWords));
    const sessionCap = BigInt(maxWords) * BigInt(article.pricePerWordAtomic);
    if (sessionCap > remaining) throw new CliError("BUDGET_INVARIANT", "Refusing payment because the section cap exceeds the remaining approved budget.");
    events.push({ type: "section.selected", sectionId: plan.sectionId, expectedValue: plan.expectedValue, minimumUsefulWords: plan.minimumUsefulWords, informationValuePerPaidWord: plan.score, sessionCapAtomic: `${sessionCap}` });
    let lastBundleWords = 0;
    const receipt = await runtime.client.run({
      articleId: article.articleId,
      goal,
      conversationId: consultation.conversationId,
      sectionId: plan.sectionId,
      maxSpendAtomic: `${sessionCap}`,
      maxWords,
      chunkWords: Math.min(32, maxWords),
      streamMode: "bundled" as StreamMode,
      metadata: { autonomousBuy: true, stopAfterSection: true },
      onEvent(event) {
        if (event.type !== "article.bundle") return;
        lastBundleWords = event.wordsRead;
        const adequate = plan.expectedValue >= 0.75 && event.wordsRead >= plan.minimumUsefulWords;
        events.push({
          type: "strategy.reassessed",
          trigger: "paid_bundle",
          sectionId: plan.sectionId,
          adequatelyAnswered: adequate,
          sectionWordsRead: event.wordsRead,
          inferenceSource: "seller_metadata_plus_purchased_bundle",
        });
      },
      stopWhen({ wordsRead: currentWords }) {
        return plan.expectedValue >= 0.75 && currentWords >= plan.minimumUsefulWords;
      },
    });
    if (BigInt(receipt.amountPaidAtomic) > sessionCap || spent + BigInt(receipt.amountPaidAtomic) > BigInt(maxSpendAtomic)) {
      throw new CliError("BUDGET_INVARIANT", "Payment receipt exceeds the approved cumulative budget.");
    }
    spent += BigInt(receipt.amountPaidAtomic);
    wordsRead += receipt.wordsRead;
    purchasedText = [purchasedText, receipt.text].filter(Boolean).join("\n\n");
    visited.add(plan.sectionId);
    const stored = await saveReceipt(receipt);
    const verified = await loadReceipt(stored.receiptId);
    if (verified.receipt.amountPaidAtomic !== receipt.amountPaidAtomic || verified.receipt.sessionId !== receipt.sessionId) {
      throw new CliError("RECEIPT_VERIFICATION_FAILED", `Saved receipt ${stored.receiptId} could not be verified.`);
    }
    storedReceipts.push(stored);
    events.push({ type: "receipt.verified", receiptId: stored.receiptId, sectionId: plan.sectionId, cumulativeSpendAtomic: `${spent}` });
    const adequate = plan.expectedValue >= 0.75 && receipt.wordsRead >= plan.minimumUsefulWords;
    if (lastBundleWords !== receipt.wordsRead) {
      events.push({ type: "strategy.reassessed", trigger: "paid_section", adequatelyAnswered: adequate, remainingAtomic: `${BigInt(maxSpendAtomic) - spent}`, inferenceSource: "seller_metadata_plus_purchase_completion" });
    }
    if (adequate) break;
  }
  if (storedReceipts.length === 0) throw new CliError("BUDGET_TOO_SMALL", "The remaining budget cannot fund the seller's minimum useful word count for any section.");
  return {
    success: true,
    gatewayUrl: runtime.gatewayUrl,
    gatewayConfigured: wroteGatewayConfig || Boolean(runtime.config.gatewayUrl || process.env.RUBICON_GATEWAY_URL),
    selectedArticle: articleJson(article),
    events,
    navigation,
    wallet: {
      chain,
      environment,
      circleWalletAddress,
      balanceAtomic,
      balanceUsdc: balanceAtomic ? formatAtomic(balanceAtomic) : undefined,
    },
    result: {
      articleId: article.articleId, title: article.title, author: article.author, goal,
      approvedBudgetUsdc, amountPaidAtomic: `${spent}`, amountPaidUsdc: formatAtomic(`${spent}`), wordsRead,
      purchasedInformation: purchasedText,
      metadataInference: "Article and section selection used only public metadata and seller-agent guidance.",
      receiptIds: storedReceipts.map((stored) => stored.receiptId),
      receipts: storedReceipts.map((stored) => finalReceiptJson({ receipt: stored.receipt, article, receiptId: stored.receiptId, goal, approvedBudgetUsdc, circleWalletAddress })),
      completed: events.some((event) => event.type === "strategy.reassessed" && event.adequatelyAnswered === true),
      stopReason: spent >= BigInt(maxSpendAtomic)
        ? "budget_reached"
        : events.some((event) => event.type === "strategy.reassessed" && event.adequatelyAnswered === true)
          ? "goal_adequately_answered"
          : "seller_options_exhausted",
    },
  };
}

function articleRelevance(article: ArticleSummary, goal: string): number {
  const terms = goal.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2);
  const text = [article.title, ...article.sections.map((section) => section.heading)].join(" ").toLowerCase();
  return terms.filter((term) => text.includes(term)).length;
}

function rankSectionPlans(article: ArticleSummary, seller: Awaited<ReturnType<RubiconClient["getNavigation"]>>["navigation"]["sellerAgent"]) {
  const assessments = seller.sectionAssessments ?? [seller.recommendedSectionId, ...seller.alternativeSectionIds].map((sectionId, index) => ({ sectionId, expectedValue: Math.max(0.25, 0.9 - index * 0.25), minimumUsefulWords: 1, rationale: seller.rationale }));
  return assessments.flatMap((assessment) => {
    const section = article.sections.find((candidate) => candidate.sectionId === assessment.sectionId);
    if (!section || section.sectionId === "full-article") return [];
    const minimumUsefulWords = Math.max(1, Math.min(section.wordCount, assessment.minimumUsefulWords));
    return [{ ...assessment, minimumUsefulWords, score: assessment.expectedValue / minimumUsefulWords }];
  }).sort((left, right) => right.score - left.score || right.expectedValue - left.expectedValue);
}

function reserveWordsForLater(plans: ReturnType<typeof rankSectionPlans>, current: string, visited: Set<string>, affordable: number): number {
  const useful = plans.find((plan) => plan.sectionId !== current && !visited.has(plan.sectionId) && /conclusion|counter|practical|implementation|detail/i.test(plan.sectionId + " " + plan.rationale));
  return useful && affordable > useful.minimumUsefulWords * 2 ? useful.minimumUsefulWords : 0;
}

async function ensureGatewayConfig(runtime: CommandRuntime): Promise<boolean> {
  if (runtime.config.gatewayUrl || process.env.RUBICON_GATEWAY_URL) return false;
  runtime.config.gatewayUrl = runtime.gatewayUrl;
  await writeConfig(runtime.config);
  return true;
}

export function finalReceiptJson(input: {
  receipt: ReadReceipt;
  article: ArticleSummary;
  receiptId: string;
  goal: string;
  approvedBudgetUsdc: string;
  circleWalletAddress?: `0x${string}`;
}): Record<string, unknown> {
  const paymentIds = input.receipt.payments.map((payment) => payment.paymentId).filter(Boolean);
  const buyerWalletAddress = input.receipt.buyerWalletAddress;
  const mismatch =
    buyerWalletAddress && input.circleWalletAddress && buyerWalletAddress.toLowerCase() !== input.circleWalletAddress.toLowerCase();
  return {
    articleId: input.article.articleId,
    title: input.article.title,
    author: input.article.author,
    sessionId: input.receipt.sessionId,
    receiptId: input.receiptId,
    goal: input.goal,
    approvedBudgetUsdc: input.approvedBudgetUsdc,
    amountPaidAtomic: input.receipt.amountPaidAtomic,
    amountPaidUsdc: formatAtomic(input.receipt.amountPaidAtomic),
    wordsRead: input.receipt.wordsRead,
    completed: input.receipt.completed,
    stopReason: input.receipt.stopReason,
    paymentIds,
    settlementIds: input.receipt.settlementIds,
    transactionHashes: input.receipt.transactionHashes,
    buyerWalletAddress,
    circleWalletAddress: input.circleWalletAddress,
    walletAddressMismatchExplanation: mismatch
      ? "Circle CLI signs with the Agent Wallet, while x402/Gateway receipts can show the Gateway backing EOA that actually authorizes settlement."
      : undefined,
  };
}

function parseQuickstartBudget(parsed: ParsedArgs): `${bigint}` {
  const maxUsdc = stringFlag(parsed.flags, "max-usdc");
  const maxAtomic = stringFlag(parsed.flags, "max-atomic");
  if (!maxUsdc && !maxAtomic) {
    throw new CliError("MISSING_BUDGET", "rubicon buy refuses paid reads without explicit --max-usdc or --max-atomic.");
  }
  if (maxUsdc && maxAtomic) {
    throw new CliError("MULTIPLE_BUDGETS", "Use either --max-usdc or --max-atomic, not both.");
  }
  if (maxAtomic) {
    if (!/^\d+$/.test(maxAtomic)) throw new CliError("INVALID_BUDGET", "--max-atomic must be an integer.");
    return maxAtomic as `${bigint}`;
  }
  try {
    return `${parseUsdcToAtomic(maxUsdc!)}` as `${bigint}`;
  } catch {
    throw new CliError("INVALID_BUDGET", "--max-usdc must be a decimal USDC amount.");
  }
}

async function addCircleCheck(checks: CheckResult[], name: string, task: () => Promise<unknown>): Promise<void> {
  try {
    checks.push({ name, ok: true, status: "ok", value: await task() });
  } catch (error) {
    const guidance = circleGuidance(error) ?? circleGuidance(classifyCircleError(error));
    checks.push({
      name,
      ok: false,
      status: name === "circleCli" ? "error" : "warning",
      value: errorMessage(error),
      guidance: guidance?.guidance ?? "Check Circle CLI setup and retry.",
    });
  }
}

function circleInput(_runtime: CommandRuntime, deps: CommandDeps): { command?: string; runner?: CircleRunner } {
  return { command: deps.circleCommand, runner: deps.circleRunner };
}

function envAddress(name: string): `0x${string}` | undefined {
  const value = process.env[name];
  return value?.startsWith("0x") ? (value as `0x${string}`) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
