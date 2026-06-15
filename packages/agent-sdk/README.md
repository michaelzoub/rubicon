# @rubicon-caliga/agent-sdk

Client SDK for autonomous agents that consume **metered compute** through the Rubicon
x402 streaming gateway. The agent opens a budgeted session, pays per interval with x402
nanopayments (USDC on Arc), and streams provider output until the job completes, the
budget is exhausted, or the agent cancels.

This README is self-contained: you should be able to write a working client from it with
no other context.

## The flow

```
Agent (this SDK)  ──POST /v1/sessions──────────▶  Gateway  ──start job──▶  Provider
        │                                            │                        │
        │  ◀──── quote + paymentRequired ────────────┤                        │
        │                                            │                        │
        ├──POST /v1/sessions/:id/heartbeats────────▶ │ verify+settle (Circle) │
        │      (signed x402 payment, every interval) │                        │
        │                                            │  ◀── output/usage ──────┤
        │  ◀──── SSE: GET /v1/sessions/:id/events ───┤                        │
        │        (provider.output, ...completed)     │                        │
```

You call the gateway. The gateway talks to the provider and to Circle. You never call the
provider directly.

## Install

Inside this monorepo, depend on it as a workspace package:

```jsonc
// package.json
"dependencies": {
  "@rubicon-caliga/agent-sdk": "workspace:*",
  "@rubicon-caliga/core": "workspace:*"   // shared types (Budget, GatewayEvent, ...)
}
```

Then `pnpm install`. Requires Node 20+ (uses the `eventsource` package for SSE).

## Quick start (copy-paste)

```ts
import { AgentClient, StaticPaymentEngine, CircleGatewayPaymentEngine } from "@rubicon-caliga/agent-sdk";

// 1. Construct a client. Pick a payment engine (see below).
const privateKey = process.env.CIRCLE_PRIVATE_KEY as `0x${string}` | undefined;
const client = new AgentClient({
  baseUrl: process.env.GATEWAY_BASE_URL ?? "http://localhost:8787",
  paymentEngine: privateKey
    ? new CircleGatewayPaymentEngine({ chain: "arcTestnet", privateKey, rpcUrl: process.env.CIRCLE_RPC_URL })
    : new StaticPaymentEngine(), // dev shim: no real money
});

// 2. Open a budgeted session.
const session = await client.startSession({
  providerId: "mock-compute",
  input: { prompt: "stream a small metered job" },
  budget: { currency: "USDC", maxAmountAtomic: "50000" }, // 0.05 USDC ceiling
  metadata: { agent: "demo" },
});

// 3. Subscribe to the event stream BEFORE paying, so you see every update.
const stop = client.stream(session.sessionId, (event) => {
  console.log(event);
  if (event.type === "session.closed" || event.type === "session.aborted") {
    stop();
    process.exit(0);
  }
});

// 4. Pay a heartbeat every interval. Each heartbeat is signed by the payment engine.
const timer = setInterval(() => {
  client.sendHeartbeat(session).catch((err) => {
    console.error(err);
    clearInterval(timer);
    stop();
    process.exit(1);
  });
}, session.heartbeatIntervalMs);

await client.sendHeartbeat(session); // pay the first one immediately
```

## API

### `new AgentClient(options)`

| option | type | notes |
|---|---|---|
| `baseUrl` | `string` | Gateway origin, e.g. `http://localhost:8787` |
| `paymentEngine` | `AgentPaymentEngine` | how heartbeats are signed (see below) |
| `fetch?` | `typeof fetch` | override (defaults to global `fetch`) |

Methods:

- **`startSession(req: StartSessionRequest): Promise<StartSessionResponse>`** — opens a
  session; returns the quote and (in real mode) `paymentRequired`, the x402 terms.
- **`sendHeartbeat(session: StartSessionResponse): Promise<void>`** — asks the payment
  engine to sign a payment for `session.quote.chargePerIntervalAtomic`, then POSTs it.
  Throws if the gateway rejects (e.g. budget exhausted, invalid payment).
- **`sendRawHeartbeat(sessionId, heartbeat): Promise<void>`** — send a pre-built
  `PaymentHeartbeatRequest` yourself (advanced).
- **`stream(sessionId, onEvent): () => void`** — opens the SSE stream; returns a function
  that closes it. Call it on terminal events.
- **`abort(sessionId, reason?): Promise<void>`** — cancel the session.

### Payment engines

```ts
interface AgentPaymentEngine {
  createHeartbeat(session: StartSessionResponse): Promise<PaymentHeartbeatRequest>;
}
```

- **`StaticPaymentEngine(network = "eip155:5042002")`** — development shim. Emits an
  unsigned `development-static` payload the gateway accepts only when it has no Circle
  seller configured. No real money. Use this to test plumbing.
- **`CircleGatewayPaymentEngine({ chain, privateKey, rpcUrl? })`** — real x402. Signs the
  gateway's `paymentRequired` terms with Circle's batch scheme against your funded Circle
  Gateway USDC balance. `chain` is a Circle `SupportedChainName` (e.g. `"arcTestnet"`),
  `rpcUrl` is optional on Arc testnet.

### Key types (from `@rubicon-caliga/core`)

```ts
interface StartSessionRequest {
  providerId: string;
  input: unknown;
  budget: { currency: "USDC"; maxAmountAtomic: `${bigint}` }; // atomic: 1 USDC = 1_000_000
  metadata?: Record<string, unknown>;
}

interface StartSessionResponse {
  sessionId: string;
  state: "quoted" | "active" | "closing" | "completed" | "aborted" | "expired";
  quote: {
    currency: "USDC"; intervalMs: number; meteringUnit: "second" | "token" | "image" | "request" | "custom";
    unitPriceAtomic: `${bigint}`; gatewayFeeBps: number; chargePerIntervalAtomic: `${bigint}`;
  };
  paymentRequired?: unknown;     // x402 terms, present in real mode
  heartbeatIntervalMs: number;   // how often to call sendHeartbeat
  expiresAt: string;             // ISO timestamp
}

type GatewayEvent =
  | { type: "session.started"; sessionId: string; state: SessionState; quote: PriceQuote }
  | { type: "session.heartbeat_accepted"; sessionId: string; paidAtomic: `${bigint}`; transferId?: string }
  | { type: "provider.output"; sessionId: string; chunk: unknown }
  | { type: "provider.usage"; sessionId: string; usage: UsageReport }
  | { type: "provider.completed"; sessionId: string; result: unknown }
  | { type: "provider.error"; sessionId: string; message: string }
  | { type: "session.aborted"; sessionId: string; reason: string }
  | { type: "session.closed"; sessionId: string; reason: string };
```

## Running against a local gateway

The SDK needs a gateway (and a provider behind it). From the repo root, in separate
terminals:

```bash
pnpm dev:gateway     # http://localhost:8787
pnpm dev:provider    # provider behind the gateway
pnpm dev:agent       # the example client (examples/agent-client)
```

- **Dev mode** (no `CIRCLE_SELLER_ADDRESS` on the gateway, no `CIRCLE_PRIVATE_KEY` on the
  agent): uses the static shim, no money moves.
- **Real mode**: set `CIRCLE_SELLER_ADDRESS` (gateway) and `CIRCLE_PRIVATE_KEY` (agent),
  fund the buyer's Circle Gateway balance, and heartbeats settle real testnet USDC.

See the repo root `README.md` and `docs/protocol.md` for the gateway HTTP contract.
```
