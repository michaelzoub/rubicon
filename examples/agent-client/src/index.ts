import {
  CircleAgentWalletEngine,
  RubiconClient,
  StaticPaymentEngine,
} from "@rubicon-caliga/agent-sdk";

// Minimal end-to-end demo: discover an article, then read it word by word.

const baseUrl = process.env.GATEWAY_BASE_URL ?? "http://localhost:8787";
const agentWalletId = process.env.CIRCLE_AGENT_WALLET_ID;
const circleApiKey = process.env.CIRCLE_API_KEY;
const circleEntitySecret = process.env.CIRCLE_ENTITY_SECRET;

const hasAgentWallet = Boolean(agentWalletId && circleApiKey && circleEntitySecret);

const paymentEngine =
  hasAgentWallet
    ? new CircleAgentWalletEngine({
        apiKey: circleApiKey!,
        entitySecret: circleEntitySecret!,
        walletId: agentWalletId!,
        walletAddress: process.env.CIRCLE_AGENT_WALLET_ADDRESS as `0x${string}` | undefined,
        baseUrl: process.env.CIRCLE_API_BASE_URL,
      })
    : new StaticPaymentEngine();

const rubicon = new RubiconClient({
  baseUrl,
  paymentEngine,
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
