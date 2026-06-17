import { readFile } from "node:fs/promises";
import { createGateway } from "./server.js";
import { CircleX402PaymentVerifier } from "./payments/x402-circle.js";
import { DevelopmentPaymentVerifier, type PaymentVerifier } from "./payments/types.js";
import {
  InMemoryLedgerRepository,
  InMemoryPublishedArticleRepository,
} from "./repositories/in-memory.js";
import type { LedgerRepository, PublishedArticleRepository } from "./repositories/types.js";
import { DefaultSellerAgent } from "./seller-agent/seller-agent.js";
import { TextCompletionSellerModelProvider } from "./seller-agent/model-provider.js";

const port = Number(process.env.GATEWAY_PORT ?? process.env.PORT ?? 8787);
const gatewayBaseUrl = process.env.GATEWAY_BASE_URL ?? `http://localhost:${port}`;
const gatewayFeeBps = Number(process.env.GATEWAY_FEE_BPS ?? 0);
const sessionTtlMs = Number(process.env.SESSION_TTL_MS ?? 15 * 60_000);

let articleRepository: PublishedArticleRepository;
let ledger: LedgerRepository;

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  // Production: shared Postgres storage authored through rubicon-marketing.
  const { createPgPool, runMigrations, PostgresPublishedArticleRepository, PostgresLedgerRepository } =
    await import("./repositories/postgres.js");
  const pool = createPgPool(databaseUrl);
  if (process.env.RUN_MIGRATIONS === "true") {
    await runMigrations(pool);
  }
  articleRepository = new PostgresPublishedArticleRepository(pool);
  ledger = new PostgresLedgerRepository(pool);
  console.log("[gateway] using Postgres persistence");
} else {
  // Development fixtures — local testing only, not production data.
  const body = process.env.DEMO_ARTICLE_CONTENT?.trim()
    ? process.env.DEMO_ARTICLE_CONTENT
    : await readFile(new URL("./demo-article.md", import.meta.url), "utf8");
  const creatorId = process.env.DEMO_CREATOR_ID ?? "rubicon-demo";
  const walletAddress = (process.env.DEMO_CREATOR_WALLET ??
    "0x000000000000000000000000000000000000dEaD") as `0x${string}`;
  const published = new InMemoryPublishedArticleRepository({
    articles: [
      {
        id: process.env.DEMO_ARTICLE_ID ?? "rubicon-streaming-001",
        creatorId,
        creatorUsername: process.env.DEMO_CREATOR_USERNAME ?? "rubicon-demo",
        title: process.env.DEMO_ARTICLE_TITLE ?? "Rubicon streams articles by the word",
        author: process.env.DEMO_AUTHOR ?? "Rubicon Demo",
        state: "live",
        pricePerWordAtomic: BigInt(process.env.PRICE_PER_WORD_ATOMIC ?? "1"),
        body,
      },
    ],
    wallets: [
      {
        creatorId,
        address: walletAddress,
        network: process.env.CIRCLE_X402_NETWORKS?.split(",")[0]?.trim() ?? "eip155:5042002",
        verified: true,
      },
    ],
  });
  articleRepository = published;
  ledger = new InMemoryLedgerRepository();
  console.log("[gateway] using in-memory development fixtures");
}

const paymentVerifier: PaymentVerifier =
  process.env.RUBICON_PAYMENTS === "circle"
    ? new CircleX402PaymentVerifier({
        facilitatorUrl: process.env.CIRCLE_FACILITATOR_URL,
        networks: process.env.CIRCLE_X402_NETWORKS?.split(",").map((n) => n.trim()).filter(Boolean),
        arcPrivateMainnet: process.env.CIRCLE_ARC_PRIVATE_MAINNET === "true",
        gatewayBaseUrl,
      })
    : new DevelopmentPaymentVerifier();

const gateway = createGateway({
  articleRepository,
  ledger,
  sellerAgent: createSellerAgent(),
  paymentVerifier,
  sessionTtlMs,
  gatewayFeeBps,
  gatewayBaseUrl,
});

await gateway.listen({ port, host: "0.0.0.0" });

function createSellerAgent(): DefaultSellerAgent {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new DefaultSellerAgent();
  }
  const model = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
  return new DefaultSellerAgent(
    new TextCompletionSellerModelProvider(`openai:${model}`, async ({ system, prompt }) => {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          instructions: system,
          input: prompt,
          max_output_tokens: 600,
          store: false,
        }),
      });
      if (!response.ok) {
        throw new Error(`OpenAI seller model failed: ${response.status} ${await response.text()}`);
      }
      const body = (await response.json()) as {
        output_text?: string;
        output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
      };
      return (
        body.output_text ??
        body.output
          ?.flatMap((item) => item.content ?? [])
          .find((content) => content.type === "output_text" && typeof content.text === "string")
          ?.text ??
        ""
      );
    }),
  );
}
