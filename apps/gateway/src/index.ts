import { createGateway } from "./server.js";
import { CircleX402PaymentVerifier } from "./payments/x402-circle.js";
import type { AuthorRecord } from "./server.js";
import { readFile } from "node:fs/promises";

const port = Number(process.env.GATEWAY_PORT ?? 8787);
const gatewayBaseUrl = process.env.GATEWAY_BASE_URL ?? `http://localhost:${port}`;
const authors = parseAuthorRegistry(process.env.AUTHOR_WALLET_REGISTRY);
const hasAuthorWallets = authors.length > 0;
const demoArticleContent = process.env.DEMO_ARTICLE_CONTENT?.trim()
  ? process.env.DEMO_ARTICLE_CONTENT
  : await readFile(new URL("./demo-article.md", import.meta.url), "utf8");

const gateway = createGateway({
  gatewayBaseUrl,
  sellerAgentApiKey: process.env.SELLER_AGENT_API_KEY,
  paymentChunkWords: Number(process.env.PAYMENT_CHUNK_WORDS ?? 25),
  sessionTtlMs: 15 * 60_000,
  gatewayFeeBps: Number(process.env.GATEWAY_FEE_BPS ?? 250),
  paymentVerifier: hasAuthorWallets
    ? new CircleX402PaymentVerifier({
        facilitatorUrl: process.env.CIRCLE_FACILITATOR_URL,
        networks: process.env.CIRCLE_X402_NETWORKS?.split(",").map((network) => network.trim()).filter(Boolean),
        arcPrivateMainnet: process.env.CIRCLE_ARC_PRIVATE_MAINNET === "true",
      })
    : undefined,
  authors,
  articles: [
    {
      articleId: process.env.DEMO_ARTICLE_ID ?? "rubicon-streaming-001",
      authorUsername: process.env.DEMO_AUTHOR_USERNAME ?? "rubicon-demo",
      title: "Rubicon streams articles by the word",
      pricePerWordAtomic: BigInt(process.env.PRICE_PER_WORD_ATOMIC ?? "1"),
      content: demoArticleContent,
    },
  ],
});

await gateway.listen({ port, host: "0.0.0.0" });

function parseAuthorRegistry(value: string | undefined): AuthorRecord[] {
  if (!value?.trim()) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [authorUsername, walletAddress] = entry.split(":");
      if (!authorUsername || !isEvmAddress(walletAddress)) {
        throw new Error(`Invalid AUTHOR_WALLET_REGISTRY entry: ${entry}`);
      }
      return { authorUsername, walletAddress };
    });
}

function isEvmAddress(value: string | undefined): value is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(value ?? "");
}
