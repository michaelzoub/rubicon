---
name: rubicon
version: 1.0.0
description: Set up Rubicon for AI agents - consume pay-per-word articles through the buyer SDK and local or hosted gateway
homepage: https://github.com/michaelzoub/rubicon
---

# Rubicon For AI Agents

Rubicon lets an AI agent read paid articles one word at a time. The buyer agent
opens a budgeted session, pays for each delivered word, stops when it has enough
information, and receives a final receipt. Use the SDK for normal integrations;
do not hand-wire the HTTP session/payment/abort routes unless the user asks for
a custom protocol test.

## Decision Flow

When a user asks you to test or integrate Rubicon:

1. **Use the SDK first** — prefer `@rubicon-caliga/agent-sdk` and
   `rubicon.run(...)` for the full flow.
2. **Use local SDK installs for local tests** — if the package is not published,
   install it from the local repo path instead of npm.
3. **Pass the gateway URL explicitly** — use the hosted Rubicon gateway
   `https://rubicon-caligagateway-production.up.railway.app` unless the user is
   deliberately running a local gateway.
4. **Use lower-level SDK methods only for custom flows** — `startSession`,
   `payForWord`, `abort`, and `streamEvents` exist, but the happy path is
   `run(...)`.

## Quick Start: Local Gateway + Local SDK

From the Rubicon repo:

```bash
pnpm install
pnpm --filter @rubicon-caliga/agent-sdk build
GATEWAY_PORT=8788 pnpm dev:gateway
```

Keep the gateway running.

From the agent project that should consume Rubicon:

```bash
pnpm add /Users/michaelzoubkoff/Documents/rubicon/packages/agent-sdk
```

Then run:

```ts
import Rubicon from "@rubicon-caliga/agent-sdk";

const rubicon = new Rubicon({
  baseUrl: "http://localhost:8788",
});

const receipt = await rubicon.run({
  articleId: "rubicon-streaming-001",
  goal: "Find the resale-fee clause",
  maxSpendAtomic: "20000",
  onWord: (word) => {
    process.stdout.write(`${word} `);
  },
});

console.log("\nreceipt:", receipt);
```

Expected result: words stream to stdout, followed by a receipt containing
`sessionId`, `articleId`, `wordsRead`, `amountPaidAtomic`, `payments`,
`transactionHashes`, `text`, `completed`, and `stopReason`.

## Quick Start: Published SDK

When `@rubicon-caliga/agent-sdk` is published, install it normally:

```bash
pnpm add @rubicon-caliga/agent-sdk
```

Use the hosted gateway URL provided by the user or environment:

```ts
import Rubicon from "@rubicon-caliga/agent-sdk";

const rubicon = new Rubicon({
  baseUrl: process.env.RUBICON_GATEWAY_URL ?? "https://rubicon-caligagateway-production.up.railway.app",
  authorization: process.env.RUBICON_AGENT_API_KEY
    ? `Bearer ${process.env.RUBICON_AGENT_API_KEY}`
    : undefined,
});

const receipt = await rubicon.run({
  articleId: "rubicon-streaming-001",
  goal: "Find the resale-fee clause",
  maxSpendAtomic: "20000",
});
```

## SDK Surface

Primary method:

```ts
rubicon.run({
  articleId,
  goal,
  maxSpendAtomic,
  stopWhen,
  onWord,
  onEvent,
});
```

Streaming method:

```ts
for await (const event of rubicon.read(options)) {
  // session.started, seller.message, article.word, article.usage, article.completed
}
```

Lower-level methods for custom flows:

```ts
rubicon.getRepository()
rubicon.getNavigation(articleId, goal)
rubicon.startConversation(input)
rubicon.sendConversationMessage(conversationId, message)
rubicon.startSession(request)
rubicon.payForWord(sessionId, payment)
rubicon.abort(sessionId, reason)
rubicon.streamEvents(sessionId, onEvent)
```

`payForWord` returns one released word plus a per-word `payment` receipt. The
same receipt is mirrored in the gateway's `PAYMENT-RESPONSE` header.

## Payment Modes

Development mode uses `StaticPaymentEngine` and settles no real funds. This is
the default when no payment engine is passed.

Production/testnet settlement uses `CircleGatewayPaymentEngine`:

```ts
import Rubicon, { CircleGatewayPaymentEngine } from "@rubicon-caliga/agent-sdk";

const rubicon = new Rubicon({
  baseUrl: process.env.RUBICON_GATEWAY_URL ?? "https://rubicon-caligagateway-production.up.railway.app",
  authorization: process.env.RUBICON_AGENT_API_KEY
    ? `Bearer ${process.env.RUBICON_AGENT_API_KEY}`
    : undefined,
  paymentEngine: new CircleGatewayPaymentEngine({
    chain: "arcTestnet",
    privateKey: process.env.CIRCLE_PRIVATE_KEY as `0x${string}`,
    rpcUrl: process.env.CIRCLE_RPC_URL,
  }),
});
```

## Hosted Gateway Environment

On Railway, set:

```bash
RUBICON_GATEWAY_URL=https://rubicon-caligagateway-production.up.railway.app
RUBICON_AGENT_API_KEY=your-shared-buyer-agent-secret
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.4-mini
RUBICON_PAYMENTS=circle
CIRCLE_FACILITATOR_URL=https://gateway-api-testnet.circle.com
CIRCLE_X402_NETWORKS=eip155:5042002
```

`RUBICON_AGENT_API_KEY` protects the Rubicon HTTP API. `OPENAI_API_KEY` powers
the hosted seller agent's navigation/conversation model.

## Buyer Budget Confirmation

Before starting a paid Rubicon read, ask the user what maximum budget they
approve for the specific article/data request. Do not guess the budget, infer it
from wallet balance, or start paying just because credentials are configured.
Use the user's confirmed limit as `maxSpendAtomic` or `budget.maxAmountAtomic`,
and stop as soon as the task is satisfied or the approved budget would be
exceeded.

## Troubleshooting

If the gateway fails with `EADDRINUSE`, the port is already in use. Pick another
port and use the same URL in the SDK:

```bash
GATEWAY_PORT=8790 pnpm dev:gateway
```

```ts
const rubicon = new Rubicon({
  baseUrl: "http://localhost:8790",
});
```

If the agent project cannot resolve `@rubicon-caliga/agent-sdk`, install the
local SDK path for local testing:

```bash
pnpm add /Users/michaelzoubkoff/Documents/rubicon/packages/agent-sdk
```

If SDK behavior or types are stale, rebuild the SDK in the Rubicon repo, then
reinstall it in the agent project:

```bash
pnpm --filter @rubicon-caliga/agent-sdk build
```

If the request is about the raw HTTP protocol, see the gateway endpoints:

- `GET /v1/repository`
- `GET /v1/articles/:articleId/navigation`
- `POST /v1/seller-agent/conversations`
- `POST /v1/sessions`
- `POST /v1/sessions/:sessionId/payments`
- `GET /v1/sessions/:sessionId/events`
- `POST /v1/sessions/:sessionId/abort`
