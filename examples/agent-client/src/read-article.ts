import {
  AgentClient,
  CircleGatewayPaymentEngine,
  StaticPaymentEngine,
} from "@rubicon-caliga/agent-sdk";

// Read an article from the Rubicon x402 streaming endpoint.
//
//   pnpm --filter @rubicon-caliga/agent-example consume
//
// Reads CIRCLE_PRIVATE_KEY / CIRCLE_CHAIN / CIRCLE_RPC_URL and GATEWAY_BASE_URL
// from the root .env. With a private key set, payments settle real testnet USDC
// against the article author's configured wallet; without one it falls back to
// the no-money StaticPaymentEngine accepted by a dev-mode gateway.

const privateKey = process.env.CIRCLE_PRIVATE_KEY as `0x${string}` | undefined;

const MAX_PAYMENTS = Number(process.env.CONSUME_MAX_PAYMENTS ?? "30");
const STOP_AFTER_WORDS = Number(process.env.CONSUME_STOP_AFTER_WORDS ?? "75");
const BUDGET_ATOMIC = process.env.CONSUME_BUDGET_ATOMIC ?? "50000";

const client = new AgentClient({
  baseUrl: process.env.GATEWAY_BASE_URL ?? "http://localhost:8787",
  paymentEngine: privateKey
    ? new CircleGatewayPaymentEngine({
        chain: (process.env.CIRCLE_CHAIN ?? "arcTestnet") as never,
        privateKey,
        rpcUrl: process.env.CIRCLE_RPC_URL,
      })
    : new StaticPaymentEngine(),
});

console.log(
  `[consume] mode=${privateKey ? "real-x402" : "static-dev-shim"} ` +
    `gateway=${process.env.GATEWAY_BASE_URL ?? "http://localhost:8787"}`,
);

const session = await client.startArticleStream({
  articleId: process.env.DEMO_ARTICLE_ID ?? "rubicon-streaming-001",
  budget: { currency: "USDC", maxAmountAtomic: BUDGET_ATOMIC as `${bigint}` },
  metadata: { agent: "read-article-example" },
});

console.log("[consume] session started:", {
  sessionId: session.sessionId,
  article: session.article.title,
  chargePerWordAtomic: session.quote.chargePerWordAtomic,
  chargePerChunkAtomic: session.quote.chargePerChunkAtomic,
  paymentChunkWords: session.paymentChunkWords,
  expiresAt: session.expiresAt,
});

let paidAtomic = 0n;
let payments = 0;
let wordsStreamed = 0;
let paymentInFlight = false;
let streamClosed = false;

function shutdown(code: number): never {
  streamClosed = true;
  console.log(
    `[consume] done payments=${payments} words=${wordsStreamed} paidAtomic=${paidAtomic} ` +
      `(~${Number(paidAtomic) / 1_000_000} USDC)`,
  );
  process.exit(code);
}

const stop = client.stream(session.sessionId, (event) => {
  switch (event.type) {
    case "article.chunk":
      console.log("[chunk]", event.text);
      break;
    case "article.usage":
      wordsStreamed = event.wordsStreamed;
      console.log("[usage]", JSON.stringify(event.usage));
      if (wordsStreamed >= STOP_AFTER_WORDS) {
        console.log(`[consume] read ${wordsStreamed} words; stopping early`);
        void client.abort(session.sessionId, "agent has enough information").finally(() => {
          stop();
          shutdown(0);
        });
        return;
      }
      void pay();
      break;
    case "session.payment_accepted":
      paidAtomic = BigInt(event.paidAtomic);
      console.log(
        `[payment] accepted paidAtomic=${event.paidAtomic} wordsUnlocked=${event.wordsUnlocked}` +
          (event.transferId ? ` transfer=${event.transferId}` : ""),
      );
      break;
    case "article.completed":
      console.log("[completed]", JSON.stringify(event));
      break;
    case "article.error":
      console.error("[article.error]", event.message);
      break;
    case "session.closed":
    case "session.aborted":
      console.log(`[${event.type}]`, "reason" in event ? event.reason : "");
      stop();
      shutdown(0);
      break;
    default:
      console.log("[event]", JSON.stringify(event));
  }
});

async function pay(): Promise<void> {
  if (paymentInFlight || streamClosed) {
    return;
  }
  if (payments >= MAX_PAYMENTS) {
    console.log(`[consume] reached MAX_PAYMENTS=${MAX_PAYMENTS}; aborting session`);
    await client.abort(session.sessionId, "client max payments reached").catch(() => {});
    stop();
    shutdown(0);
  }
  paymentInFlight = true;
  payments += 1;
  try {
    await client.sendPayment(session);
  } catch (err) {
    console.error("[payment] failed:", err);
    stop();
    shutdown(1);
  } finally {
    paymentInFlight = false;
  }
}

await pay();
