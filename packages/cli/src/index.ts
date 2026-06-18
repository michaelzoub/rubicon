#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { RubiconClient } from "@rubicon-caliga/agent-sdk";
import { parseUsdcToAtomic, type ArticleSummary } from "@rubicon-caliga/core";
import { parseArgs, booleanFlag, stringFlag, type ParsedArgs } from "./args.js";
import { configPath, HOSTED_GATEWAY_URL, readConfig, writeConfig, type RubiconCliConfig } from "./config.js";
import { CliError, toCliError } from "./errors.js";
import {
  articleJson,
  formatAtomic,
  humanArticle,
  humanNavigation,
  humanReceipt,
  printJson,
  printJsonEvent,
} from "./format.js";
import { selectPaymentEngine, type PaymentMode } from "./payments.js";
import { listReceipts, loadReceipt, saveReceipt } from "./receipts.js";

interface Runtime {
  parsed: ParsedArgs;
  json: boolean;
  config: RubiconCliConfig;
  gatewayUrl: string;
  apiKey?: string;
  paymentMode: PaymentMode;
  client: RubiconClient;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const json = booleanFlag(parsed.flags, "json");

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
    });
    await dispatch({ parsed, json, config, gatewayUrl, apiKey, paymentMode: payment.mode, client });
  } catch (error) {
    const cliError = toCliError(error);
    if (json) {
      printJson({ success: false, error: { code: cliError.code, message: cliError.message } });
    } else {
      process.stderr.write(`Error: ${cliError.message}\n`);
    }
    process.exitCode = cliError.exitCode;
  }
}

async function dispatch(runtime: Runtime): Promise<void> {
  const [command, subcommand, ...rest] = runtime.parsed.positionals;

  if (!command || command === "help" || booleanFlag(runtime.parsed.flags, "help")) {
    showHelp(runtime.json);
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
  if (runtime.json) {
    printJson({ success: true, article: articleJson(response.article), navigation: response.navigation });
    return;
  }
  process.stdout.write(`${humanArticle(response.article)}\n\n${humanNavigation(response.navigation)}\n`);
}

async function readArticle(runtime: Runtime, articleId: string | undefined): Promise<void> {
  if (!articleId) throw new CliError("MISSING_ARTICLE_ID", "rubicon read requires an article id.");
  const maxSpendAtomic = parseBudget(runtime.parsed);
  const goal = stringFlag(runtime.parsed.flags, "goal");
  const maxWordsFlag = stringFlag(runtime.parsed.flags, "max-words");
  const maxWords = maxWordsFlag === undefined ? undefined : Number(maxWordsFlag);
  if (maxWords !== undefined && (!Number.isInteger(maxWords) || maxWords < 1)) {
    throw new CliError("INVALID_MAX_WORDS", "--max-words must be a positive integer.");
  }

  if (booleanFlag(runtime.parsed.flags, "dry-run")) {
    await dryRun(runtime, articleId, maxSpendAtomic, goal, maxWords);
    return;
  }

  let finalReceipt = undefined;
  const stream = runtime.client.read({
    articleId,
    goal,
    maxSpendAtomic,
    maxWords,
  });

  for await (const event of stream) {
    if (runtime.json) {
      printJsonEvent("event", { event });
      if (event.type === "article.completed") {
        finalReceipt = event.receipt;
      }
      continue;
    }

    switch (event.type) {
      case "seller.message":
        process.stdout.write(`Seller: ${event.content}\n\n`);
        break;
      case "session.started":
        process.stdout.write(`Session: ${event.session.sessionId}\n\n`);
        break;
      case "article.word":
        process.stdout.write(`${event.word} `);
        break;
      case "article.error":
        process.stderr.write(`\nError: ${event.message}\n`);
        break;
      case "article.completed":
        finalReceipt = event.receipt;
        process.stdout.write(`\n\n${humanReceipt(event.receipt)}\n`);
        break;
      case "article.usage":
        break;
    }
  }

  if (finalReceipt) {
    const stored = await saveReceipt(finalReceipt);
    if (runtime.json) {
      printJson({ type: "receipt.saved", success: true, receiptId: stored.receiptId, savedAt: stored.savedAt, receipt: stored.receipt });
    }
  }
}

async function dryRun(
  runtime: Runtime,
  articleId: string,
  maxSpendAtomic: `${bigint}`,
  goal: string | undefined,
  maxWords: number | undefined,
): Promise<void> {
  const article = await findArticle(runtime, articleId);
  if (runtime.json) {
    printJson({
      success: true,
      dryRun: true,
      gatewayUrl: runtime.gatewayUrl,
      paymentMode: runtime.paymentMode,
      budget: {
        maxSpendAtomic,
        maxSpendUsdc: formatAtomic(maxSpendAtomic),
        maxWords,
      },
      goal,
      article: articleJson(article),
    });
    return;
  }

  process.stdout.write(
    [
      "Dry run: no paid read started.",
      `Gateway: ${runtime.gatewayUrl}`,
      `Payment mode: ${runtime.paymentMode}`,
      `Budget: ${formatAtomic(maxSpendAtomic)} USDC (${maxSpendAtomic} atomic)`,
      maxWords ? `Max words: ${maxWords}` : undefined,
      goal ? `Goal: ${goal}` : undefined,
      "",
      humanArticle(article),
      "",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
  );
}

async function receiptsList(runtime: Runtime): Promise<void> {
  const receipts = await listReceipts();
  if (runtime.json) {
    printJson({ success: true, receipts });
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
  if (runtime.json) {
    printJson({ success: true, ...stored });
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
    "rubicon repository",
    "rubicon search \"<query>\"",
    "rubicon article show <article-id>",
    "rubicon article navigation <article-id> --goal \"<goal>\"",
    "rubicon read <article-id> --max-usdc 0.10 [--goal \"...\"] [--max-words 50] [--dry-run]",
    "rubicon receipts list",
    "rubicon receipts show <receipt-id>",
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
