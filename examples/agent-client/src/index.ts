import { RubiconClient, StaticPaymentEngine, CircleGatewayPaymentEngine } from "@rubicon-caliga/agent-sdk";

// Minimal end-to-end demo: discover an article, then read it word by word.

const privateKey = process.env.CIRCLE_PRIVATE_KEY as `0x${string}` | undefined;
const baseUrl = process.env.GATEWAY_BASE_URL ?? "http://localhost:8787";

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

const { articles } = await rubicon.getRepository();
const article = articles[0];
if (!article) {
  throw new Error("No live articles available in the Rubicon repository");
}
console.log("reading", article.title, `(${article.pricePerWordAtomic} atomic USDC/word)`);

const receipt = await rubicon.run({
  articleId: article.articleId,
  goal: "Summarize the article",
  maxSpendAtomic: "50000",
  maxWords: 40,
  onWord: (word) => {
    process.stdout.write(`${word} `);
  },
});

console.log("\n--", receipt.stopReason, receipt.wordsRead, "words");
