#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { RubiconClient } from "@rubicon-caliga/agent-sdk/agent-client";
import { parseUsdcToAtomic, settlementNetworkInfo, type ArticleSectionSummary, type ArticleSummary, type StreamMode } from "@rubicon-caliga/core";
import { parseArgs, booleanFlag, stringFlag, type ParsedArgs } from "./args.js";
import { configPath, HOSTED_GATEWAY_URL, readConfig, writeConfig, type RubiconCliConfig } from "./config.js";
import { CliError, toCliError } from "./errors.js";
import { assertNoLegacyGranularityConflict, granularityFlag } from "./granularity.js";
import {
  articleJson,
  formatAtomic,
  humanArticle,
  humanNavigation,
  humanReceipt,
  humanReceiptSummary,
  printJson,
  printJsonEvent,
  readReceiptSummaryJson,
  recommendedReadCommandFor,
  receiptSummaryJson,
} from "./format.js";
import { selectPaymentEngine, type PaymentMode } from "./payments.js";
import { createRequire } from "node:module";
import { runLogin } from "./login.js";
import { runBuy, runDoctor, runQuickstartRead } from "./quickstart.js";
import { listReceipts, loadReceipt, saveReceipt } from "./receipts.js";

// createRequire instead of a JSON import attribute so older Node versions fail
// with the engines message rather than a SyntaxError before any output.
const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };

interface Runtime {
  parsed: ParsedArgs;
  json: boolean;
  config: RubiconCliConfig;
  gatewayUrl: string;
  apiKey?: string;
  paymentMode: PaymentMode;
  circleChain?: string;
  client: RubiconClient;
}

const STARTUP_EVENT_COMMANDS = new Set(["buy", "quickstart-read", "doctor", "read", "login"]);

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const json = booleanFlag(parsed.flags, "json");
  if (json && STARTUP_EVENT_COMMANDS.has(parsed.positionals[0] ?? "")) {
    printJson({ type: "startup", message: "loading Rubicon CLI" });
  }

  try {
    const config = await readConfig();
    const gatewayUrl =
      stringFlag(parsed.flags, "gateway-url") ??
      process.env.RUBICON_GATEWAY_URL ??
      config.gatewayUrl ??
      HOSTED_GATEWAY_URL;
    const apiKey = stringFlag(parsed.flags, "api-key") ?? process.env.RUBICON_AGENT_API_KEY ?? config.apiKey;
    const payment = selectPaymentEngine({
      requestedMode: stringFlag(parsed.flags, "payment-mode"),
      gatewayUrl,
      config,
    });
    const client = new RubiconClient({
      baseUrl: gatewayUrl,
      authorization: apiKey ? `Bearer ${apiKey}` : undefined,
      paymentEngine: payment.engine,
      requestTimeoutMs: requestTimeoutMs(),
    });
    await dispatch({ parsed, json, config, gatewayUrl, apiKey, paymentMode: payment.mode, circleChain: payment.circleChain, client });
  } catch (error) {
    const cliError = toCliError(error);
    if (json) {
      printJson({
        success: false,
        error: {
          code: cliError.code,
          message: cliError.message,
          ...(cliError.recovery ? { recovery: cliError.recovery } : {}),
          ...(cliError.details ? { details: cliError.details } : {}),
        },
      });
    } else {
      process.stderr.write(`Error: ${cliError.message}\n`);
    }
    process.exitCode = cliError.exitCode;
  }
}

async function dispatch(runtime: Runtime): Promise<void> {
  const [command, subcommand, ...rest] = runtime.parsed.positionals;

  if (booleanFlag(runtime.parsed.flags, "version") || command === "version") {
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }

  if (!command || command === "help" || booleanFlag(runtime.parsed.flags, "help")) {
    showHelp(runtime.json);
    return;
  }

  if (command === "doctor") {
    printJson(await runDoctor(runtime, { cliVersion: packageJson.version }));
    return;
  }
  if (command === "quickstart-read") {
    printJson(await runQuickstartRead(runtime, { onProgress: runtime.json ? (event) => printJsonEvent("progress", event) : undefined }));
    return;
  }
  if (command === "buy") {
    printJson(await runBuy(runtime, { onProgress: runtime.json ? (event) => printJsonEvent("progress", event) : undefined }));
    return;
  }
  if (command === "login") {
    printJson(await runLogin({ parsed: runtime.parsed, config: runtime.config }));
    return;
  }
  if (command === "repository") {
    await repository(runtime);
    return;
  }
  if (command === "search") {
    await search(runtime, subcommand);
    return;
  }
  if (command === "article" && subcommand === "show") {
    await articleShow(runtime, rest[0]);
    return;
  }
  if (command === "article" && subcommand === "navigation") {
    await articleNavigation(runtime, rest[0]);
    return;
  }
  if (command === "read") {
    await readArticle(runtime, subcommand);
    return;
  }
  if (command === "receipts" && subcommand === "list") {
    await receiptsList(runtime);
    return;
  }
  if (command === "receipts" && subcommand === "show") {
    await receiptsShow(runtime, rest[0]);
    return;
  }
  if (command === "config" && subcommand === "show") {
    await configShow(runtime);
    return;
  }
  if (command === "config" && subcommand === "set") {
    await configSet(runtime, rest[0], rest[1]);
    return;
  }

  throw new CliError("UNKNOWN_COMMAND", `Unknown command: ${runtime.parsed.positionals.join(" ")}`);
}

async function repository(runtime: Runtime): Promise<void> {
  const response = await runtime.client.getRepository();
  if (runtime.json) {
    printJson({ success: true, repository: response.repository, articles: response.articles.map(articleJson) });
    return;
  }
  if (response.articles.length === 0) {
    process.stdout.write("No public articles found.\n");
    return;
  }
  process.stdout.write(
    response.articles
      .map((article) => `${article.articleId} | ${article.title} | ${article.author} | ${article.totalWords} words`)
      .join("\n") + "\n",
  );
}

async function search(runtime: Runtime, query: string | undefined): Promise<void> {
  if (!query) throw new CliError("MISSING_QUERY", "rubicon search requires a query.");
  const response = await runtime.client.getRepository();
  const matches = response.articles.filter((article) => matchesQuery(article, query));
  if (runtime.json) {
    printJson({ success: true, query, articles: matches.map(articleJson) });
    return;
  }
  if (matches.length === 0) {
    process.stdout.write("No matches.\n");
    return;
  }
  process.stdout.write(matches.map((article) => `${article.articleId} | ${article.title} | ${article.author}`).join("\n") + "\n");
}

async function articleShow(runtime: Runtime, articleId: string | undefined): Promise<void> {
  const article = await findArticle(runtime, articleId);
  if (runtime.json) {
    printJson({ success: true, article: articleJson(article) });
    return;
  }
  process.stdout.write(`${humanArticle(article)}\n`);
}

async function articleNavigation(runtime: Runtime, articleId: string | undefined): Promise<void> {
  if (!articleId) throw new CliError("MISSING_ARTICLE_ID", "rubicon article navigation requires an article id.");
  const goal = stringFlag(runtime.parsed.flags, "goal");
  if (!goal) throw new CliError("MISSING_GOAL", "rubicon article navigation requires --goal.");
  const response = await runtime.client.getNavigation(articleId, goal);
  const recommendedReadCommand = recommendedReadCommandFor(
    response.article.articleId,
    response.navigation.sellerAgent.recommendedSectionId,
  );
  if (runtime.json) {
    printJson({ success: true, article: articleJson(response.article), navigation: response.navigation, recommendedReadCommand });
    return;
  }
  process.stdout.write(`${humanArticle(response.article)}\n\n${humanNavigation(response.navigation)}\n`);
}

async function readArticle(runtime: Runtime, articleId: string | undefined): Promise<void> {
  if (!articleId) throw new CliError("MISSING_ARTICLE_ID", "rubicon read requires an article id.");
  const maxSpendAtomic = parseBudget(runtime.parsed);
  const goal = stringFlag(runtime.parsed.flags, "goal");
  const sectionId = sectionFlag(runtime.parsed);
  const stopAfterSection = booleanFlag(runtime.parsed.flags, "stop-after-section");
  const summary = booleanFlag(runtime.parsed.flags, "summary") || booleanFlag(runtime.parsed.flags, "receipt-summary");
  const granularity = granularityFlag(runtime.parsed);
  assertNoLegacyGranularityConflict(runtime.parsed, granularity);
  const chunkWords = granularity === undefined ? chunkWordsFlag(runtime.parsed) : undefined;
  const streamMode = granularity === undefined ? streamModeFlag(runtime.parsed) : "bundled";
  const maxWordsFlag = stringFlag(runtime.parsed.flags, "max-words");
  const maxWords = maxWordsFlag === undefined ? undefined : Number(maxWordsFlag);
  if (maxWords !== undefined && (!Number.isInteger(maxWords) || maxWords < 1)) {
    throw new CliError("INVALID_MAX_WORDS", "--max-words must be a positive integer.");
  }
  if ((granularity === "section" || granularity === "article") && maxWords !== undefined) {
    throw new CliError("MULTIPLE_GRANULARITIES", `--granularity ${granularity} cannot be combined with --max-words.`);
  }
  if (granularity === "section" && !sectionId && !goal) {
    throw new CliError("MISSING_SECTION", "--granularity section requires --section/--section-id or --goal.");
  }
  if (stopAfterSection && !sectionId && !goal) {
    throw new CliError("MISSING_SECTION", "--stop-after-section requires --section/--section-id or --goal.");
  }
  if (sectionId) {
    await validateSection(runtime, articleId, sectionId);
  }

  if (booleanFlag(runtime.parsed.flags, "dry-run")) {
    await dryRun(runtime, articleId, maxSpendAtomic, goal, maxWords, sectionId, stopAfterSection, chunkWords, streamMode, granularity);
    return;
  }

  let finalReceipt = undefined;
  let storedReceipt = undefined;
  let currentSessionId: string | undefined;
  let cancelled = false;
  const abortOnSigint = (): void => {
    cancelled = true;
    process.exitCode = 130;
    if (!runtime.json) {
      process.stderr.write("\nCancelling read and aborting the active session...\n");
    }
    if (currentSessionId) {
      void runtime.client.abort(currentSessionId, "agent_cancelled").catch(() => {});
    }
  };
  process.once("SIGINT", abortOnSigint);

  const stream = runtime.client.read({
    articleId,
    goal,
    sectionId,
    maxSpendAtomic,
    maxWords,
    chunkWords,
    granularity,
    streamMode,
    metadata: stopAfterSection ? { stopAfterSection: true } : undefined,
  });

  try {
    for await (const event of stream) {
      if (event.type === "session.started") {
        currentSessionId = event.session.sessionId;
      }
      if (runtime.json && !summary) {
        printJsonEvent("event", { event });
        if (event.type === "article.completed") {
          finalReceipt = event.receipt;
        }
        continue;
      }

      if (runtime.json && summary) {
        if (event.type === "article.completed") {
          finalReceipt = event.receipt;
        }
        continue;
      }

      switch (event.type) {
        case "seller.message":
          if (!summary) process.stdout.write(`Seller: ${event.content}\n\n`);
          break;
        case "session.started":
          if (!summary) process.stdout.write(`Session: ${event.session.sessionId}\n\n`);
          break;
        case "article.word":
          if (!summary) process.stdout.write(`${event.word} `);
          break;
        case "article.bundle":
        case "article.chunk":
          if (!summary) process.stdout.write(`${event.words.map((entry) => entry.word).join(" ")} `);
          break;
        case "article.error":
          process.stderr.write(`\nError: ${event.message}\n`);
          break;
        case "article.completed":
          finalReceipt = event.receipt;
          if (!summary) {
            process.stdout.write(`\n\n${humanReceipt(event.receipt)}\n`);
          }
          break;
        case "article.usage":
          break;
      }

      if (cancelled) {
        break;
      }
    }
  } finally {
    process.removeListener("SIGINT", abortOnSigint);
  }

  if (finalReceipt) {
    storedReceipt = await saveReceipt(finalReceipt);
    if (runtime.json && !summary) {
      printJson({ type: "receipt.saved", success: true, receiptId: storedReceipt.receiptId, savedAt: storedReceipt.savedAt, receipt: storedReceipt.receipt });
    } else if (!runtime.json && !summary) {
      process.stdout.write(`Receipt ID: ${storedReceipt.receiptId}\n`);
    }
  }

  if (summary && finalReceipt) {
    if (runtime.json) {
      printJson({
        success: true,
        receiptId: storedReceipt?.receiptId,
        savedAt: storedReceipt?.savedAt,
        receipt: readReceiptSummaryJson(finalReceipt),
      });
    } else {
      process.stdout.write(`${humanReceiptSummary(finalReceipt, storedReceipt?.receiptId)}\n`);
    }
  }
}

async function dryRun(
  runtime: Runtime,
  articleId: string,
  maxSpendAtomic: `${bigint}`,
  goal: string | undefined,
  maxWords: number | undefined,
  sectionId: string | undefined,
  stopAfterSection: boolean,
  chunkWords: number | undefined,
  streamMode: StreamMode,
  granularity: import("@rubicon-caliga/agent-sdk/agent-client").ReadGranularity | undefined,
): Promise<void> {
  const article = await findArticle(runtime, articleId);
  const navigation = goal && !sectionId ? await runtime.client.getNavigation(articleId, goal).catch(() => undefined) : undefined;
  const effectiveSectionId = granularity === "article" ? "full-article" : sectionId ?? navigation?.navigation.sellerAgent.recommendedSectionId;
  const effectiveSection = effectiveSectionId ? findSection(article, effectiveSectionId) : undefined;
  const estimatedWords = Math.min(maxWords ?? Number.MAX_SAFE_INTEGER, effectiveSection?.wordCount ?? article.totalWords);
  const estimatedMaxCostAtomic = BigInt(article.pricePerWordAtomic) * BigInt(estimatedWords);
  const budgetAtomic = BigInt(maxSpendAtomic);
  const networkInfo = settlementNetworkInfo(article.paymentTerms?.network);
  const fundingMethod = article.paymentTerms?.fundingMethod ?? networkInfo.fundingMethod;
  const balanceCheck = {
    checked: false,
    sufficient: undefined,
    reason: "Live Circle Gateway balance is not checked during dry-run.",
  };
  const budgetSufficiency = {
    sufficientForEstimatedMax: budgetAtomic >= estimatedMaxCostAtomic,
    estimatedMaxCostAtomic: `${estimatedMaxCostAtomic}`,
    estimatedMaxCostUsdc: formatAtomic(`${estimatedMaxCostAtomic}`),
    estimatedWords,
  };
  if (runtime.json) {
    printJson({
      success: true,
      dryRun: true,
      gatewayUrl: runtime.gatewayUrl,
      paymentMode: runtime.paymentMode,
      circleChain: article.paymentTerms?.circleChain ?? networkInfo.circleChain ?? runtime.circleChain,
      budget: {
        maxSpendAtomic,
        maxSpendUsdc: formatAtomic(maxSpendAtomic),
        maxWords,
      },
      goal,
      sectionId,
      recommendedSectionId: navigation?.navigation.sellerAgent.recommendedSectionId,
      effectiveSectionId,
      readStartsAt: effectiveSectionId ? `section:${effectiveSectionId}` : "full-article",
      stopAfterSection,
      chunkWords,
      granularity,
      streamMode,
      fundingMethod,
      estimatedMax: budgetSufficiency,
      walletBalance: balanceCheck,
      article: articleJson(article),
    });
    return;
  }

  process.stdout.write(
    [
      "Dry run: no paid read started.",
      `Gateway: ${runtime.gatewayUrl}`,
      `Payment mode: ${runtime.paymentMode}`,
      article.paymentTerms?.circleChain ?? networkInfo.circleChain ?? runtime.circleChain
        ? `Circle chain: ${article.paymentTerms?.circleChain ?? networkInfo.circleChain ?? runtime.circleChain}`
        : undefined,
      `Budget: ${formatAtomic(maxSpendAtomic)} USDC (${maxSpendAtomic} atomic)`,
      `Estimated max for ${effectiveSectionId ? effectiveSectionId : "full article"}: ${formatAtomic(`${estimatedMaxCostAtomic}`)} USDC (${estimatedWords.toLocaleString("en-US")} words)`,
      `Budget covers estimate: ${budgetSufficiency.sufficientForEstimatedMax ? "yes" : "no"}`,
      `Wallet balance check: not checked`,
      fundingMethod ? `Funding: ${fundingMethod}` : undefined,
      maxWords ? `Max words: ${maxWords}` : undefined,
      goal ? `Goal: ${goal}` : undefined,
      navigation?.navigation.sellerAgent.recommendedSectionId ? `Recommended section: ${navigation.navigation.sellerAgent.recommendedSectionId}` : undefined,
      `Read starts at: ${effectiveSectionId ? `section ${effectiveSectionId}` : "full article"}`,
      sectionId ? `Section: ${sectionId}` : undefined,
      stopAfterSection ? "Stop after section: yes" : undefined,
      `Stream mode: ${streamMode}`,
      granularity !== undefined ? `Granularity: ${granularity === 1 ? "word" : granularity}` : undefined,
      streamMode === "bundled" ? `Bundle words: ${chunkWords ?? 32}` : undefined,
      "",
      humanArticle(article),
      "",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
  );
}

async function receiptsList(runtime: Runtime): Promise<void> {
  const limit = limitFlag(runtime.parsed);
  const receipts = (await listReceipts()).slice(0, limit);
  const summary = booleanFlag(runtime.parsed.flags, "summary") || booleanFlag(runtime.parsed.flags, "receipt-summary");
  if (runtime.json) {
    printJson({ success: true, receipts: summary ? receipts.map(receiptSummaryJson) : receipts });
    return;
  }
  if (receipts.length === 0) {
    process.stdout.write("No local receipts found.\n");
    return;
  }
  process.stdout.write(
    receipts
      .map(
        (stored) =>
          `${stored.receiptId} | ${stored.savedAt} | ${stored.receipt.articleId} | ${formatAtomic(stored.receipt.amountPaidAtomic)} USDC`,
      )
      .join("\n") + "\n",
  );
}

async function receiptsShow(runtime: Runtime, receiptId: string | undefined): Promise<void> {
  if (!receiptId) throw new CliError("MISSING_RECEIPT_ID", "rubicon receipts show requires a receipt id.");
  const stored = await loadReceipt(receiptId);
  const summary = booleanFlag(runtime.parsed.flags, "summary") || booleanFlag(runtime.parsed.flags, "receipt-summary");
  if (runtime.json) {
    printJson({ success: true, ...(summary ? receiptSummaryJson(stored) : stored) });
    return;
  }
  if (summary) {
    process.stdout.write(`${humanReceiptSummary(stored.receipt, stored.receiptId)}\n`);
    return;
  }
  process.stdout.write(`Receipt ID: ${stored.receiptId}\nSaved: ${stored.savedAt}\n${humanReceipt(stored.receipt)}\n`);
}

async function configShow(runtime: Runtime): Promise<void> {
  const shown = {
    configPath: configPath(),
    gatewayUrl: runtime.config.gatewayUrl,
    apiKey: runtime.config.apiKey ? "set" : undefined,
    paymentMode: runtime.config.paymentMode,
    circleChain: runtime.config.circleChain,
    agentWalletAddress: runtime.config.agentWalletAddress,
    effective: {
      gatewayUrl: runtime.gatewayUrl,
      apiKey: runtime.apiKey ? "set" : undefined,
      paymentMode: runtime.paymentMode,
      circleChain: runtime.circleChain,
    },
  };
  if (runtime.json) {
    printJson({ success: true, config: shown });
    return;
  }
  process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
}

async function configSet(runtime: Runtime, key: string | undefined, value: string | undefined): Promise<void> {
  if (!key || !value) throw new CliError("MISSING_CONFIG_VALUE", "rubicon config set requires a key and value.");
  const next = { ...runtime.config };
  switch (key) {
    case "gateway-url":
      next.gatewayUrl = value;
      break;
    case "api-key":
      next.apiKey = value;
      break;
    case "payment-mode":
      if (value !== "static" && value !== "circle-cli") {
        throw new CliError("INVALID_PAYMENT_MODE", "payment-mode must be static or circle-cli.");
      }
      next.paymentMode = value;
      break;
    case "circle-chain":
      next.circleChain = value;
      break;
    case "agent-wallet-address":
      if (!value.startsWith("0x")) throw new CliError("INVALID_ADDRESS", "agent-wallet-address must start with 0x.");
      next.agentWalletAddress = value as `0x${string}`;
      break;
    default:
      throw new CliError("UNKNOWN_CONFIG_KEY", `Unknown config key: ${key}`);
  }
  await mkdir(dirname(configPath()), { recursive: true, mode: 0o700 });
  await writeConfig(next);
  if (runtime.json) {
    printJson({ success: true, configPath: configPath(), key });
    return;
  }
  process.stdout.write(`Updated ${key} in ${configPath()}\n`);
}

async function findArticle(runtime: Runtime, articleId: string | undefined): Promise<ArticleSummary> {
  if (!articleId) throw new CliError("MISSING_ARTICLE_ID", "Article id is required.");
  const repository = await runtime.client.getRepository();
  const article = repository.articles.find((candidate) => candidate.articleId === articleId);
  if (!article) throw new CliError("ARTICLE_NOT_FOUND", `Article not found: ${articleId}`);
  return article;
}

// A stalled gateway response must not hang the CLI indefinitely: an external
// supervisor that kills a hung process emits no JSON and leaves the caller
// with no evidence of whether a payment settled. Let operators tune the ceiling
// via env var; the SDK applies its own 60s default when this is unset.
function requestTimeoutMs(): number | undefined {
  const raw = process.env.RUBICON_REQUEST_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function parseBudget(parsed: ParsedArgs): `${bigint}` {
  const maxUsdc = stringFlag(parsed.flags, "max-usdc");
  const maxAtomic = stringFlag(parsed.flags, "max-atomic");
  if (!maxUsdc && !maxAtomic) {
    throw new CliError("MISSING_BUDGET", "rubicon read requires --max-usdc or --max-atomic.");
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

function sectionFlag(parsed: ParsedArgs): string | undefined {
  const section = stringFlag(parsed.flags, "section");
  const sectionId = stringFlag(parsed.flags, "section-id");
  if (section && sectionId && section !== sectionId) {
    throw new CliError("MULTIPLE_SECTIONS", "Use either --section or --section-id, not both.");
  }
  return section ?? sectionId;
}

function limitFlag(parsed: ParsedArgs): number | undefined {
  const rawLimit = stringFlag(parsed.flags, "limit");
  if (rawLimit === undefined) return undefined;
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CliError("INVALID_LIMIT", "--limit must be a positive integer.");
  }
  return limit;
}

function chunkWordsFlag(parsed: ParsedArgs): number | undefined {
  const fast = booleanFlag(parsed.flags, "fast");
  const mode = stringFlag(parsed.flags, "mode");
  if (mode !== undefined && mode !== "batch" && mode !== "word") {
    throw new CliError("INVALID_READ_MODE", "--mode must be batch or word.");
  }
  const rawChunkWords = stringFlag(parsed.flags, "chunk-words");
  if (rawChunkWords === undefined) return fast || mode === "batch" ? 32 : undefined;
  const chunkWords = Number(rawChunkWords);
  if (!Number.isInteger(chunkWords) || chunkWords < 1) {
    throw new CliError("INVALID_CHUNK_WORDS", "--chunk-words must be a positive integer.");
  }
  return Math.min(chunkWords, 256);
}

function streamModeFlag(parsed: ParsedArgs): StreamMode {
  const streamMode = stringFlag(parsed.flags, "stream-mode");
  const legacyMode = stringFlag(parsed.flags, "mode");
  const perWord = booleanFlag(parsed.flags, "per-word");
  if (streamMode !== undefined && streamMode !== "bundled" && streamMode !== "word") {
    throw new CliError("INVALID_STREAM_MODE", "--stream-mode must be bundled or word.");
  }
  if (perWord && streamMode === "bundled") {
    throw new CliError("INVALID_STREAM_MODE", "--per-word cannot be combined with --stream-mode bundled.");
  }
  if ((perWord || legacyMode === "word" || streamMode === "word") && stringFlag(parsed.flags, "chunk-words") !== undefined) {
    throw new CliError("INVALID_STREAM_MODE", "Per-word mode cannot be combined with --chunk-words.");
  }
  return perWord || legacyMode === "word" ? "word" : streamMode ?? "bundled";
}

function findSection(article: ArticleSummary, sectionId: string): ArticleSectionSummary | undefined {
  return article.sections.find((section) => section.sectionId === sectionId);
}

async function validateSection(runtime: Runtime, articleId: string, sectionId: string): Promise<void> {
  const article = await findArticle(runtime, articleId);
  if (!article.sections.some((section) => section.sectionId === sectionId)) {
    throw new CliError("SECTION_NOT_FOUND", `Section not found for ${articleId}: ${sectionId}`);
  }
}

function matchesQuery(article: ArticleSummary, query: string): boolean {
  const haystack = [
    article.articleId,
    article.title,
    article.author,
    article.creatorUsername,
    ...article.sections.map((section) => section.heading),
    ...article.sections.map((section) => section.sectionId),
  ]
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

function showHelp(json: boolean): void {
  const usage = [
    "rubicon buy --goal \"<goal>\" --max-usdc 0.10 [--granularity word|10|section|article] --json",
    "rubicon login <email> [--testnet] --json",
    "rubicon login --request <request-id> --otp <code> [--testnet] --json",
    "rubicon repository",
    "rubicon doctor --json",
    "rubicon search \"<query>\"",
    "rubicon article show <article-id>",
    "rubicon article navigation <article-id> --goal \"<goal>\"",
    "rubicon read <article-id> --max-usdc 0.10 [--goal \"...\"] [--section <section-id>] [--granularity word|10|section|article] [--max-words 50] [--summary] [--dry-run]",
    "rubicon receipts list [--limit 10] [--summary]",
    "rubicon receipts show <receipt-id> [--summary]",
    "rubicon config show",
    "rubicon config set gateway-url <url>",
    "rubicon config set api-key <key>",
  ];
  if (json) {
    printJson({ success: true, usage });
    return;
  }
  process.stdout.write(`${usage.join("\n")}\n`);
}

await main();
