import {
  CircleAgentWalletEngine,
  CircleCliGatewayPaymentEngine,
  RubiconClient,
  StaticPaymentEngine,
  type AgentPaymentEngine,
} from "@rubicon-caliga/agent-sdk";

// Read an article from Rubicon, paying one word at a time.
//
//   pnpm --filter @rubicon-caliga/agent-example consume
//
// Payment engine is chosen from the environment:
//   1. Circle CLI + Agent Wallet signs each word custodially — no raw key.
//   2. Circle API-backed Agent Wallet custody for server-side integrations.
//   3. Otherwise the no-money StaticPaymentEngine, for a dev-mode gateway.
// Both Circle paths settle real testnet USDC to the creator's verified wallet.
// The buyer stops as soon as it has enough.

const baseUrl = process.env.GATEWAY_BASE_URL ?? "http://localhost:8787";
const articleId = process.env.CONSUME_ARTICLE_ID;
const goal = process.env.CONSUME_GOAL ?? "Understand how Rubicon meters and charges per word";
const maxSpendAtomic = (process.env.CONSUME_BUDGET_ATOMIC ?? "50000") as `${bigint}`;
const stopAfterWords = Number(process.env.CONSUME_STOP_AFTER_WORDS ?? "75");

if (!articleId) {
  throw new Error("CONSUME_ARTICLE_ID must be set to a live article id from /v1/repository");
}

const agentWalletId = process.env.CIRCLE_AGENT_WALLET_ID;
const agentWalletAddress = process.env.CIRCLE_AGENT_WALLET_ADDRESS as `0x${string}` | undefined;
const circleApiKey = process.env.CIRCLE_API_KEY;
const circleEntitySecret = process.env.CIRCLE_ENTITY_SECRET;

let paymentEngine: AgentPaymentEngine;
let mode: string;
if (process.env.CIRCLE_CLI_PAYMENT === "1" || (agentWalletAddress && !circleApiKey)) {
  paymentEngine = new CircleCliGatewayPaymentEngine({
    walletAddress: agentWalletAddress,
    chain: process.env.CIRCLE_CLI_CHAIN ?? "ARC-TESTNET",
  });
  mode = "circle-cli-gateway";
} else if (agentWalletId && circleApiKey && circleEntitySecret) {
  paymentEngine = new CircleAgentWalletEngine({
    apiKey: circleApiKey!,
    entitySecret: circleEntitySecret!,
    walletId: agentWalletId!,
    walletAddress: agentWalletAddress,
    baseUrl: process.env.CIRCLE_API_BASE_URL,
  });
  mode = "circle-agent-wallet";
} else {
  paymentEngine = new StaticPaymentEngine();
  mode = "static-dev-shim";
}

const rubicon = new RubiconClient({ baseUrl, paymentEngine });

console.log(`[consume] mode=${mode} gateway=${baseUrl}`);

const stream = rubicon.read({
  articleId,
  goal,
  maxSpendAtomic,
  // Stop when we've read enough — here, a simple word cap stands in for
  // "the buyer agent has enough information".
  stopWhen: ({ wordsRead }) => wordsRead >= stopAfterWords,
});

for await (const event of stream) {
  switch (event.type) {
    case "session.started":
      console.log("[session]", {
        sessionId: event.session.sessionId,
        article: event.session.article.title,
        pricePerWordAtomic: event.session.pricePerWordAtomic,
        wordPaymentAtomic: event.session.wordPaymentAtomic,
        maxArticlePriceAtomic: event.session.maxArticlePriceAtomic,
      });
      break;
    case "seller.message":
      console.log("[seller]", event.content);
      break;
    case "article.word":
      console.log(`[word #${event.sequence}]`, event.word);
      break;
    case "article.completed":
      console.log("[receipt]", {
        wordsRead: event.receipt.wordsRead,
        amountPaidAtomic: event.receipt.amountPaidAtomic,
        usdc: Number(event.receipt.amountPaidAtomic) / 1_000_000,
        stopReason: event.receipt.stopReason,
      });
      break;
    case "article.error":
      console.error("[error]", event.message);
      break;
  }
}
