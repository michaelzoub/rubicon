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
import { analyticsConfigFromEnv } from "./analytics/config.js";
import { AnalyticsOutboxRepository } from "./analytics/outbox-repository.js";
import { ClickHouseAnalyticsClient } from "./analytics/clickhouse-client.js";
import { AnalyticsWorker } from "./analytics/worker.js";
import type { AnalyticsHealth } from "./analytics/types.js";
import { activateEnvironmentVariables, loadGatewayEnvironment } from "./config.js";

const environment = loadGatewayEnvironment();
activateEnvironmentVariables(environment.env);
const env = environment.env;
const appEnv = environment.appEnv;
const port = Number(env.GATEWAY_PORT ?? env.PORT ?? 8787);
const gatewayBaseUrl = environment.publicUrl;
const gatewayFeeBps = Number(env.GATEWAY_FEE_BPS ?? 0);
const sessionTtlMs = Number(env.SESSION_TTL_MS ?? 15 * 60_000);

// Reuse warm TLS connections for outbound Circle settlement calls.
if (await installKeepAliveDispatcher()) {
  startupLog("info", "gateway.keep_alive_dispatcher_installed");
}

let articleRepository: PublishedArticleRepository;
let ledger: LedgerRepository;
const analyticsConfig = analyticsConfigFromEnv(env);
let analyticsWorker: AnalyticsWorker | undefined;
let analyticsHealth = async (): Promise<AnalyticsHealth> => ({
  enabled: false,
  backlogSize: 0,
  poisonEventCount: 0,
  workerRunning: false,
});

if (env.RUBICON_ARTICLES === "demo") {
  articleRepository = createDemoArticleRepository(env);
  startupLog("info", "gateway.article_repository_selected", { adapter: "in-memory-demo" });
} else {
  articleRepository = new SupabasePublishedArticleRepository(createSupabaseClientFromEnv(env));
  startupLog("info", "gateway.article_repository_selected", { adapter: "supabase" });
}

const databaseUrl = env.DATABASE_URL;
if (databaseUrl) {
  // Runtime sessions, conversations, payments, and receipts remain in Postgres.
  const { assertRailwayCompatibleDatabaseUrl, createPgPool, describeDatabaseUrl, runMigrations, PostgresLedgerRepository } =
    await import("./repositories/postgres.js");
  assertRailwayCompatibleDatabaseUrl(databaseUrl);
  startupLog("info", "gateway.database_configured", { database: describeDatabaseUrl(databaseUrl) });
  const pool = createPgPool(databaseUrl);
  if (env.RUN_MIGRATIONS === "true") {
    await runMigrations(pool);
  }
  ledger = new PostgresLedgerRepository(pool);
  startupLog("info", "gateway.ledger_selected", { adapter: "postgres" });
  const outbox = new AnalyticsOutboxRepository(pool);
  if (analyticsConfig.enabled) {
    analyticsWorker = new AnalyticsWorker(
      analyticsConfig,
      outbox,
      new ClickHouseAnalyticsClient(analyticsConfig),
    );
    analyticsWorker.start();
    startupLog("info", "gateway.analytics_worker_started", { clickhouseDatabase: analyticsConfig.clickhouseDatabase });
  } else if (env.ANALYTICS_ENABLED === "true") {
    startupLog("error", "gateway.analytics_worker_disabled", { reason: "clickhouse_url_missing" });
  }
  analyticsHealth = () => outbox.health(
    analyticsConfig.maxAttempts,
    analyticsWorker?.isRunning ?? false,
    analyticsConfig.enabled,
  );
} else {
  ledger = new InMemoryLedgerRepository();
  startupLog("info", "gateway.ledger_selected", { adapter: "in-memory" });
}

const paymentVerifier: PaymentVerifier =
  env.RUBICON_PAYMENTS === "circle"
    ? new CircleX402PaymentVerifier({
        facilitatorUrl: env.CIRCLE_FACILITATOR_URL ?? GATEWAY_API_URL,
        networks: env.CIRCLE_X402_NETWORKS?.split(",").map((n) => toCaip2Network(n.trim())).filter(Boolean) ?? [
          ACTIVE_X402_NETWORK,
        ],
        arcPrivateMainnet: env.CIRCLE_ARC_PRIVATE_MAINNET === "true",
        maxTimeoutSeconds: env.CIRCLE_X402_MAX_TIMEOUT_SECONDS
          ? Number(env.CIRCLE_X402_MAX_TIMEOUT_SECONDS)
          : undefined,
        gatewayBaseUrl,
        synchronousSettlement: env.CIRCLE_SYNCHRONOUS_SETTLEMENT === "true",
        settlementBatchSize: env.CIRCLE_SETTLEMENT_BATCH_SIZE
          ? Number(env.CIRCLE_SETTLEMENT_BATCH_SIZE)
          : undefined,
        settlementBatchIntervalMs: env.CIRCLE_SETTLEMENT_BATCH_INTERVAL_MS
          ? Number(env.CIRCLE_SETTLEMENT_BATCH_INTERVAL_MS)
          : undefined,
        appEnv,
        // Persist provider evidence only after Circle returns a real reference.
        onSettled: async (outcome) => {
          const providerReference = outcome.transferId
            ?? outcome.settlementId
            ?? outcome.settlementIds?.[0]
            ?? outcome.transactionHash
            ?? outcome.transactionHashes?.[0];
          if (!ledger.recordSettlementRange) {
            return;
          }
          try {
            await ledger.recordSettlementRange({
              provider: "circle-x402",
              status: outcome.success ? "completed" : "failed",
              idempotencyKey: providerReference
                ? `circle-x402:${providerReference}:${outcome.success ? "completed" : "failed"}`
                : `circle-x402:${outcome.sessionId}:${outcome.startSequence}-${outcome.endSequence}:failed`,
              sessionId: outcome.sessionId,
              startSequence: outcome.startSequence,
              endSequence: outcome.endSequence,
              settlementId: outcome.settlementId,
              settlementIds: outcome.settlementIds,
              transferId: outcome.transferId,
              transactionHash: outcome.transactionHash,
              transactionHashes: outcome.transactionHashes,
              buyerWalletAddress: outcome.buyerWalletAddress,
            });
          } catch (error) {
            startupLog("error", "gateway.settlement_evidence_persist_failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      })
    : new DevelopmentPaymentVerifier();

const gateway = createGateway({
  articleRepository,
  ledger,
  sellerAgent: createSellerAgent(env),
  paymentVerifier,
  sessionTtlMs,
  gatewayFeeBps,
  gatewayBaseUrl,
  queryEmbedder: createQueryEmbedder(env),
  analyticsHealth,
  appEnv,
  env,
});

gateway.addHook("onClose", async () => {
  await analyticsWorker?.stop();
});

await gateway.listen({ port, host: "0.0.0.0" });

function createDemoArticleRepository(runtimeEnv: NodeJS.ProcessEnv): InMemoryPublishedArticleRepository {
  const creatorId = runtimeEnv.DEMO_CREATOR_ID ?? "creator_demo";
  return new InMemoryPublishedArticleRepository({
    articles: [
      {
        id: runtimeEnv.DEMO_ARTICLE_ID ?? "article_demo",
        creatorId,
        creatorUsername: runtimeEnv.DEMO_CREATOR_USERNAME ?? "demo",
        title: "Field Guide to Metered Reading",
        author: runtimeEnv.DEMO_AUTHOR ?? "Rubicon Demo",
        pricePerWordAtomic: BigInt(runtimeEnv.PRICE_PER_WORD_ATOMIC ?? "1"),
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
        address: (runtimeEnv.DEMO_CREATOR_WALLET ?? "0x2222222222222222222222222222222222222222") as `0x${string}`,
        network: ACTIVE_X402_NETWORK,
      },
    ],
  });
}

function createSellerAgent(runtimeEnv: NodeJS.ProcessEnv): DefaultSellerAgent {
  const apiKey = runtimeEnv.OPENAI_API_KEY;
  if (!apiKey) {
    return new DefaultSellerAgent();
  }
  const model = runtimeEnv.OPENAI_MODEL ?? "gpt-5.4-mini";
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

function startupLog(
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  console[level](JSON.stringify({ level, event, appEnv, ...fields }));
}
