import { CircleGatewayPaymentEngine, RubiconClient, StaticPaymentEngine } from "@rubicon-caliga/agent-sdk";

// Read an article from Rubicon, paying one word at a time.
//
//   pnpm --filter @rubicon-caliga/agent-example consume
//
// With CIRCLE_PRIVATE_KEY set, each word settles real testnet USDC to the
// creator's verified wallet; without one it uses the no-money StaticPaymentEngine
// accepted by a dev-mode gateway. The buyer stops as soon as it has enough.

const privateKey = process.env.CIRCLE_PRIVATE_KEY as `0x${string}` | undefined;
const baseUrl = process.env.GATEWAY_BASE_URL ?? "http://localhost:8787";
const articleId = process.env.DEMO_ARTICLE_ID ?? "rubicon-streaming-001";
const goal = process.env.CONSUME_GOAL ?? "Understand how Rubicon meters and charges per word";
const maxSpendAtomic = (process.env.CONSUME_BUDGET_ATOMIC ?? "50000") as `${bigint}`;
const stopAfterWords = Number(process.env.CONSUME_STOP_AFTER_WORDS ?? "75");

const rubicon = new RubiconClient({
  baseUrl,
  paymentEngine: privateKey
    ? new CircleGatewayPaymentEngine({
        chain: (process.env.CIRCLE_CHAIN ?? "arcTestnet") as never,
        privateKey,
        rpcUrl: process.env.CIRCLE_RPC_URL,
      })
    : new StaticPaymentEngine(),
});

console.log(`[consume] mode=${privateKey ? "real-x402" : "static-dev-shim"} gateway=${baseUrl}`);

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
