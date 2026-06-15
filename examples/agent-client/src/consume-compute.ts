import {
  AgentClient,
  CircleGatewayPaymentEngine,
  StaticPaymentEngine,
} from "@rubicon-caliga/agent-sdk";

// Consume metered compute from the mock-compute provider through the Rubicon
// x402 streaming gateway.
//
//   pnpm --filter @rubicon-caliga/agent-example consume
//
// Reads CIRCLE_PRIVATE_KEY / CIRCLE_CHAIN / CIRCLE_RPC_URL and GATEWAY_BASE_URL
// from the root .env. With a private key set, heartbeats settle real testnet
// USDC against the gateway's configured seller; without one it falls back to
// the no-money StaticPaymentEngine (only accepted by a dev-mode gateway).
//
// IMPORTANT: you point the SDK at the GATEWAY (:8787), never at the provider
// (:8790) directly — the gateway brokers payment and proxies the provider via
// providerId. The provider streams output back through the gateway.

const privateKey = process.env.CIRCLE_PRIVATE_KEY as `0x${string}` | undefined;

// Safety rails so a stuck job can't silently drain the budget.
const MAX_HEARTBEATS = Number(process.env.CONSUME_MAX_HEARTBEATS ?? "30");
const BUDGET_ATOMIC = process.env.CONSUME_BUDGET_ATOMIC ?? "50000"; // 0.05 USDC ceiling

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

const session = await client.startSession({
  providerId: "mock-compute",
  input: { prompt: "stream a small metered job" },
  budget: { currency: "USDC", maxAmountAtomic: BUDGET_ATOMIC as `${bigint}` },
  metadata: { agent: "consume-compute" },
});

console.log("[consume] session started:", {
  sessionId: session.sessionId,
  state: session.state,
  chargePerIntervalAtomic: session.quote.chargePerIntervalAtomic,
  intervalMs: session.heartbeatIntervalMs,
  expiresAt: session.expiresAt,
});

let paidAtomic = 0n;
let heartbeats = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function shutdown(code: number): never {
  if (timer) clearInterval(timer);
  console.log(
    `[consume] done — heartbeats=${heartbeats} paidAtomic=${paidAtomic} ` +
      `(~${Number(paidAtomic) / 1_000_000} USDC)`,
  );
  process.exit(code);
}

// Subscribe BEFORE paying so we observe every update from the provider.
const stop = client.stream(session.sessionId, (event) => {
  switch (event.type) {
    case "provider.output":
      console.log("[output]", JSON.stringify(event.chunk));
      break;
    case "provider.usage":
      console.log("[usage]", JSON.stringify(event.usage));
      break;
    case "session.heartbeat_accepted":
      paidAtomic = BigInt(event.paidAtomic);
      console.log(
        `[heartbeat] accepted paidAtomic=${event.paidAtomic}` +
          (event.transferId ? ` transfer=${event.transferId}` : ""),
      );
      break;
    case "provider.completed":
      console.log("[completed]", JSON.stringify(event.result));
      break;
    case "provider.error":
      console.error("[provider.error]", event.message);
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

async function beat(): Promise<void> {
  if (heartbeats >= MAX_HEARTBEATS) {
    console.log(`[consume] reached MAX_HEARTBEATS=${MAX_HEARTBEATS}; aborting session`);
    if (timer) clearInterval(timer);
    await client.abort(session.sessionId, "client max heartbeats reached").catch(() => {});
    stop();
    shutdown(0);
  }
  heartbeats += 1;
  try {
    await client.sendHeartbeat(session);
  } catch (err) {
    console.error("[heartbeat] failed:", err);
    if (timer) clearInterval(timer);
    stop();
    shutdown(1);
  }
}

// Pay the first heartbeat immediately, then one per interval.
await beat();
timer = setInterval(() => void beat(), session.heartbeatIntervalMs);
