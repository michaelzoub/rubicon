# @rubicon-caliga/agent-sdk

Client SDK for autonomous agents that consume **metered article streams** through the Rubicon x402 streaming endpoint. The agent opens a budgeted stream, pays per word chunk with x402 nanopayments, receives article words over SSE, and can stop once it has enough information.

## Flow

```
Agent SDK  ──POST /v1/sessions────────────────────▶  x402 Streaming Endpoint
    │       ◀── quote + article + paymentRequired ──┤
    ├──────POST /v1/sessions/:id/payments──────────▶│ verify + settle
    │       (signed x402 payment per word chunk)     │
    │       ◀── SSE: article.chunk, article.usage ───┤
    └──────POST /v1/sessions/:id/abort─────────────▶│ stop anytime
```

You call the Rubicon endpoint directly. There is no provider SDK.

## Quick Start

```ts
import { AgentClient, CircleGatewayPaymentEngine, StaticPaymentEngine } from "@rubicon-caliga/agent-sdk";

const privateKey = process.env.CIRCLE_PRIVATE_KEY as `0x${string}` | undefined;
const client = new AgentClient({
  baseUrl: process.env.GATEWAY_BASE_URL ?? "http://localhost:8787",
  paymentEngine: privateKey
    ? new CircleGatewayPaymentEngine({ chain: "arcTestnet", privateKey, rpcUrl: process.env.CIRCLE_RPC_URL })
    : new StaticPaymentEngine(),
});

const session = await client.startArticleStream({
  articleId: "rubicon-streaming-001",
  budget: { currency: "USDC", maxAmountAtomic: "50000" },
  metadata: { agent: "demo" },
});

const stop = client.stream(session.sessionId, (event) => {
  console.log(event);
  if (event.type === "session.closed" || event.type === "session.aborted") {
    stop();
  }
});

await client.sendPayment(session);
```

## API

- `startArticleStream(req)` opens a stream session. `startSession(req)` is also available as the lower-level protocol name.
- `sendPayment(session)` signs and sends payment for `session.quote.chargePerChunkAtomic`.
- `sendRawPayment(sessionId, payment)` sends a pre-built payment payload.
- `stream(sessionId, onEvent)` opens the SSE stream.
- `abort(sessionId, reason?)` cancels the stream.

## Key Types

```ts
interface StartSessionRequest {
  articleId?: string;
  query?: string;
  budget: { currency: "USDC"; maxAmountAtomic: `${bigint}` };
  metadata?: Record<string, unknown>;
}

interface StartSessionResponse {
  sessionId: string;
  article: {
    articleId: string;
    authorUsername: string;
    title: string;
    totalWords: number;
    maxPriceAtomic: `${bigint}`;
  };
  quote: {
    currency: "USDC";
    chunkWords: number;
    meteringUnit: "word";
    unitPriceAtomic: `${bigint}`;
    gatewayFeeBps: number;
    chargePerWordAtomic: `${bigint}`;
    chargePerChunkAtomic: `${bigint}`;
  };
  paymentRequired?: unknown;
  paymentChunkWords: number;
  expiresAt: string;
}
```

## Local Run

```bash
pnpm dev:gateway
pnpm dev:agent
```

Dev mode uses `StaticPaymentEngine`. Real mode uses `CircleGatewayPaymentEngine` when `CIRCLE_PRIVATE_KEY` is set on the agent and `AUTHOR_WALLET_REGISTRY` maps the article author to an Arc wallet on the gateway.
