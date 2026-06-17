import { createGateway } from "./server.js";
import { ACTIVE_X402_NETWORK, GATEWAY_API_URL, toCaip2Network } from "./chain.js";
import { CircleX402PaymentVerifier } from "./payments/x402-circle.js";
import { DevelopmentPaymentVerifier, type PaymentVerifier } from "./payments/types.js";
import { InMemoryLedgerRepository } from "./repositories/in-memory.js";
import { createSupabaseClientFromEnv, SupabasePublishedArticleRepository } from "./repositories/supabase.js";
import type { LedgerRepository, PublishedArticleRepository } from "./repositories/types.js";
import { DefaultSellerAgent } from "./seller-agent/seller-agent.js";
import { TextCompletionSellerModelProvider } from "./seller-agent/model-provider.js";

const port = Number(process.env.GATEWAY_PORT ?? process.env.PORT ?? 8787);
const gatewayBaseUrl = process.env.GATEWAY_BASE_URL ?? `http://localhost:${port}`;
const gatewayFeeBps = Number(process.env.GATEWAY_FEE_BPS ?? 0);
const sessionTtlMs = Number(process.env.SESSION_TTL_MS ?? 15 * 60_000);

let articleRepository: PublishedArticleRepository;
let ledger: LedgerRepository;

articleRepository = new SupabasePublishedArticleRepository(createSupabaseClientFromEnv());
console.log("[gateway] using Supabase for published articles");

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  // Runtime sessions, conversations, payments, and receipts remain in Postgres.
  const { createPgPool, runMigrations, PostgresLedgerRepository } = await import("./repositories/postgres.js");
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
