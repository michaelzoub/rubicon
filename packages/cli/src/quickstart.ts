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
import { saveReceipt } from "./receipts.js";

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
        : "Arc Testnet reads can be funded with the Circle testnet faucet / Gateway testnet funding flow. Do not send mainnet funds for testnet articles.",
  });

  return {
    success: checks.every((check) => check.status !== "error"),
    gatewayUrl: runtime.gatewayUrl,
    paymentMode: runtime.paymentMode,
    checks,
  };
}

export async function runQuickstartRead(runtime: CommandRuntime, deps: CommandDeps = {}): Promise<Record<string, unknown>> {
  if (runtime.parsed.positionals[1] !== "--first" && !runtime.parsed.flags.first) {
    throw new CliError("MISSING_FIRST", "rubicon quickstart-read currently requires --first.");
  }
  const goal = stringFlag(runtime.parsed.flags, "goal");
  if (!goal) throw new CliError("MISSING_GOAL", "rubicon quickstart-read requires --goal.");
  const maxSpendAtomic = parseQuickstartBudget(runtime.parsed);
  const approvedBudgetUsdc = formatAtomic(maxSpendAtomic);
  const wroteGatewayConfig = await ensureGatewayConfig(runtime);
  const repository = await runtime.client.getRepository();
  const article = repository.articles[0];
  if (!article) throw new CliError("NO_ARTICLES", "No public articles are available from the configured gateway.");

  const navigation = await runtime.client.getNavigation(article.articleId, goal);
  const sectionId = navigation.navigation.sellerAgent.recommendedSectionId;
  const estimate = estimateRead(article, sectionId, maxSpendAtomic);
  if (!estimate.withinBudget) {
    throw new CliError(
      "DRY_RUN_OVER_BUDGET",
      `Dry-run estimate is ${formatAtomic(estimate.estimatedMaxCostAtomic)} USDC, which exceeds the approved ${approvedBudgetUsdc} USDC budget.`,
    );
  }

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
      if (BigInt(balance.balanceAtomic) < BigInt(estimate.estimatedMaxCostAtomic)) {
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

  const receipt = await runtime.client.run({
    articleId: article.articleId,
    goal,
    sectionId,
    maxSpendAtomic,
    chunkWords: 32,
    streamMode: "bundled" as StreamMode,
    metadata: { quickstart: true, stopAfterSection: true },
  });
  const stored = await saveReceipt(receipt);
  return {
    success: true,
    gatewayUrl: runtime.gatewayUrl,
    gatewayConfigured: wroteGatewayConfig || Boolean(runtime.config.gatewayUrl || process.env.RUBICON_GATEWAY_URL),
    selectedArticle: articleJson(article),
    navigation: navigation.navigation,
    dryRun: {
      ...estimate,
      estimatedMaxCostUsdc: formatAtomic(estimate.estimatedMaxCostAtomic),
    },
    wallet: {
      chain,
      environment,
      circleWalletAddress,
      balanceAtomic,
      balanceUsdc: balanceAtomic ? formatAtomic(balanceAtomic) : undefined,
    },
    receiptId: stored.receiptId,
    savedAt: stored.savedAt,
    receipt: finalReceiptJson({
      receipt,
      article,
      receiptId: stored.receiptId,
      goal,
      approvedBudgetUsdc,
      circleWalletAddress,
    }),
  };
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

function estimateRead(article: ArticleSummary, sectionId: string | undefined, maxSpendAtomic: `${bigint}`): {
  sectionId?: string;
  estimatedWords: number;
  estimatedMaxCostAtomic: `${bigint}`;
  withinBudget: boolean;
} {
  const section = sectionId ? article.sections.find((candidate) => candidate.sectionId === sectionId) : undefined;
  const estimatedWords = section?.wordCount ?? article.totalWords;
  const estimatedMaxCostAtomic = `${BigInt(article.pricePerWordAtomic) * BigInt(estimatedWords)}` as `${bigint}`;
  return {
    sectionId,
    estimatedWords,
    estimatedMaxCostAtomic,
    withinBudget: BigInt(maxSpendAtomic) >= BigInt(estimatedMaxCostAtomic),
  };
}

function parseQuickstartBudget(parsed: ParsedArgs): `${bigint}` {
  const maxUsdc = stringFlag(parsed.flags, "max-usdc");
  const maxAtomic = stringFlag(parsed.flags, "max-atomic");
  if (!maxUsdc && !maxAtomic) {
    throw new CliError("MISSING_BUDGET", "rubicon quickstart-read refuses paid reads without explicit --max-usdc or --max-atomic.");
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
