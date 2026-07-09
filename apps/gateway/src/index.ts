import { createGateway } from "./server.js";
import { ACTIVE_X402_NETWORK, GATEWAY_API_URL, toCaip2Network } from "./chain.js";
import { CircleX402PaymentVerifier } from "./payments/x402-circle.js";
import { DevelopmentPaymentVerifier, type PaymentVerifier } from "./payments/types.js";
import { InMemoryLedgerRepository, InMemoryPublishedArticleRepository } from "./repositories/in-memory.js";
import { createSupabaseClientFromEnv, SupabasePublishedArticleRepository } from "./repositories/supabase.js";
import type { LedgerRepository, PublishedArticleRepository } from "./repositories/types.js";
import { DefaultSellerAgent } from "./seller-agent/seller-agent.js";
import { TextCompletionSellerModelProvider } from "./seller-agent/model-provider.js";
import { createQueryEmbedder } from "./search/embed-query.js";
import { installKeepAliveDispatcher } from "./http-agent.js";

const port = Number(process.env.GATEWAY_PORT ?? process.env.PORT ?? 8787);
const gatewayBaseUrl = process.env.GATEWAY_BASE_URL ?? `http://localhost:${port}`;
const gatewayFeeBps = Number(process.env.GATEWAY_FEE_BPS ?? 0);
const sessionTtlMs = Number(process.env.SESSION_TTL_MS ?? 15 * 60_000);

// Reuse warm TLS connections for outbound Circle settlement calls.
if (await installKeepAliveDispatcher()) {
  console.log("[gateway] installed keep-alive HTTP dispatcher");
}

let articleRepository: PublishedArticleRepository;
let ledger: LedgerRepository;

if (process.env.RUBICON_ARTICLES === "demo") {
  articleRepository = createDemoArticleRepository();
  console.log("[gateway] using in-memory demo article (RUBICON_ARTICLES=demo)");
} else {
  articleRepository = new SupabasePublishedArticleRepository(createSupabaseClientFromEnv());
  console.log("[gateway] using Supabase for published articles");
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  // Runtime sessions, conversations, payments, and receipts remain in Postgres.
  const { assertRailwayCompatibleDatabaseUrl, createPgPool, describeDatabaseUrl, runMigrations, PostgresLedgerRepository } =
    await import("./repositories/postgres.js");
  assertRailwayCompatibleDatabaseUrl(databaseUrl);
  console.log(`[gateway] DATABASE_URL ${describeDatabaseUrl(databaseUrl)}`);
  const pool = createPgPool(databaseUrl);
  if (process.env.RUN_MIGRATIONS === "true") {
    await runMigrations(pool);
  }
  ledger = new PostgresLedgerRepository(pool);
  console.log("[gateway] using Postgres runtime persistence");
} else {
  ledger = new InMemoryLedgerRepository();
  console.log("[gateway] using in-memory runtime ledger");
}

const paymentVerifier: PaymentVerifier =
  process.env.RUBICON_PAYMENTS === "circle"
    ? new CircleX402PaymentVerifier({
        facilitatorUrl: process.env.CIRCLE_FACILITATOR_URL ?? GATEWAY_API_URL,
        networks: process.env.CIRCLE_X402_NETWORKS?.split(",").map((n) => toCaip2Network(n.trim())).filter(Boolean) ?? [
          ACTIVE_X402_NETWORK,
        ],
        arcPrivateMainnet: process.env.CIRCLE_ARC_PRIVATE_MAINNET === "true",
        maxTimeoutSeconds: process.env.CIRCLE_X402_MAX_TIMEOUT_SECONDS
          ? Number(process.env.CIRCLE_X402_MAX_TIMEOUT_SECONDS)
          : undefined,
        gatewayBaseUrl,
        synchronousSettlement: process.env.CIRCLE_SYNCHRONOUS_SETTLEMENT === "true",
        settlementBatchSize: process.env.CIRCLE_SETTLEMENT_BATCH_SIZE
          ? Number(process.env.CIRCLE_SETTLEMENT_BATCH_SIZE)
          : undefined,
        settlementBatchIntervalMs: process.env.CIRCLE_SETTLEMENT_BATCH_INTERVAL_MS
          ? Number(process.env.CIRCLE_SETTLEMENT_BATCH_INTERVAL_MS)
          : undefined,
        // Backfill the persisted receipt with Circle's transfer UUID once the
        // batched settlement clears behind the stream.
        onSettled: async (outcome) => {
          if (!outcome.success || !ledger.updatePaymentSettlement) {
            return;
          }
          try {
            await ledger.updatePaymentSettlement({
              sessionId: outcome.sessionId,
              sequence: outcome.sequence,
              settlementId: outcome.settlementId,
              settlementIds: outcome.settlementIds,
              transferId: outcome.transferId,
              transactionHash: outcome.transactionHash,
              transactionHashes: outcome.transactionHashes,
              buyerWalletAddress: outcome.buyerWalletAddress,
            });
          } catch (error) {
            console.error("[gateway] failed to backfill settlement", error);
          }
        },
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
  queryEmbedder: createQueryEmbedder(),
});

await gateway.listen({ port, host: "0.0.0.0" });

function createDemoArticleRepository(): InMemoryPublishedArticleRepository {
  const creatorId = process.env.DEMO_CREATOR_ID ?? "creator_demo";
  return new InMemoryPublishedArticleRepository({
    articles: [
      {
        id: process.env.DEMO_ARTICLE_ID ?? "article_demo",
        creatorId,
        creatorUsername: process.env.DEMO_CREATOR_USERNAME ?? "demo",
        title: "Field Guide to Metered Reading",
        author: process.env.DEMO_AUTHOR ?? "Rubicon Demo",
        pricePerWordAtomic: BigInt(process.env.PRICE_PER_WORD_ATOMIC ?? "1"),
        body: [
          "# Field Guide to Metered Reading",
          "",
          "## Summary",
          "Rubicon streams paid articles word by word so buyer agents pay only for the words they actually receive under one cumulative budget cap.",
          "",
          "## How sessions work",
          "A buyer opens a session with a hard spending cap, the gateway returns payment terms, and each delivered bundle is settled against that authorization before the next one starts.",
          "",
          "## Practical details",
          "Receipts record the amount paid, words read, and settlement identifiers so an agent can verify after the fact exactly what its budget bought.",
          "",
          "## Conclusion",
          "Metered reading keeps autonomous purchases inspectable: a fixed cap going in, verifiable receipts coming out, and no payment ever exceeding the remaining budget.",
        ].join("\n"),
      },
    ],
    wallets: [
      {
        creatorId,
        address: (process.env.DEMO_CREATOR_WALLET ?? "0x2222222222222222222222222222222222222222") as `0x${string}`,
        network: ACTIVE_X402_NETWORK,
      },
    ],
  });
}

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
