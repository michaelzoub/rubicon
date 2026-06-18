---
name: rubicon
version: 1.0.0
description: Set up Rubicon for AI agents - consume pay-per-word articles through the buyer SDK and hosted gateway
homepage: https://github.com/michaelzoub/rubicon
---

# Rubicon For AI Agents

Rubicon lets an AI agent read paid articles one word at a time. The buyer opens
a budgeted session, pays for each delivered word, stops when it has enough
information, and receives a final receipt.

Use the SDK for normal integrations. Do not hand-wire the HTTP
session/payment/abort routes unless the user asks for a custom protocol test.
Do not request, store, export, infer, or use raw private keys for normal
Rubicon paid reads.

## Decision Flow

1. **Use the SDK first** — prefer `@rubicon-caliga/agent-sdk` and
   `rubicon.run(...)`.
2. **Use Circle CLI custody for real reads** — prefer
   `CircleCliGatewayPaymentEngine`, which signs through Circle CLI / Agent
   Wallet custody.
3. **Pass the gateway URL explicitly** — use the hosted Rubicon gateway unless
   the user is deliberately running a local gateway.
4. **Confirm the budget before spending** — use the user's exact approved limit
   as `maxSpendAtomic`.

Hosted gateway:

```text
https://rubicon-caligagateway-production.up.railway.app
```

## Quick Start

Install the SDK:

```bash
pnpm add @rubicon-caliga/agent-sdk
```

For a dry run against a development gateway, omit `paymentEngine`; the SDK uses
`StaticPaymentEngine`.

```ts
import Rubicon from "@rubicon-caliga/agent-sdk";

const rubicon = new Rubicon({
  baseUrl: process.env.RUBICON_GATEWAY_URL ?? "http://localhost:8787",
});

const receipt = await rubicon.run({
  articleId: "live-article-id-from-repository",
  goal: "Find the resale-fee clause",
  maxSpendAtomic: "20000",
  onWord: (word) => process.stdout.write(`${word} `),
});

console.log("\nreceipt:", receipt);
```

Expected receipt fields include `sessionId`, `articleId`, `wordsRead`,
`amountPaidAtomic`, `payments`, `settlementIds`, `buyerWalletAddress`,
`sellerPayTo`, `network`, `text`, `completed`, and `stopReason`.

## Circle CLI Agent Wallet Paid Read

This is the recommended real paid-read path on Arc Testnet. It uses Circle CLI
and a funded Circle Agent Wallet Gateway/Nanopayments balance, without exposing
raw private keys to the agent.

```ts
import Rubicon, { CircleCliGatewayPaymentEngine } from "@rubicon-caliga/agent-sdk";

const rubicon = new Rubicon({
  baseUrl: process.env.RUBICON_GATEWAY_URL ?? "https://rubicon-caligagateway-production.up.railway.app",
  authorization: process.env.RUBICON_AGENT_API_KEY
    ? `Bearer ${process.env.RUBICON_AGENT_API_KEY}`
    : undefined,
  paymentEngine: new CircleCliGatewayPaymentEngine({
    agentWalletAddress: process.env.CIRCLE_AGENT_WALLET_ADDRESS as `0x${string}` | undefined,
    chain: "ARC-TESTNET",
  }),
});

const receipt = await rubicon.run({
  articleId: "live-article-id-from-repository",
  goal: "Find the useful part",
  maxSpendAtomic: "20000",
  maxWords: 1,
});
```

Before spending, verify:

- Circle CLI is installed and logged in: `circle wallet status`
- An Agent Wallet exists on `ARC-TESTNET`
- Gateway balance covers the approved budget:
  `circle gateway balance --address <agent-wallet-address> --chain ARC-TESTNET --output json`
- The selected article has `paymentTerms.network: "eip155:5042002"` and a
  seller `payTo` address

Rubicon's Arc Testnet network string is `eip155:5042002`; Circle CLI calls the
same chain `ARC-TESTNET`.

`CircleCliGatewayPaymentEngine` keeps the Circle Agent Wallet and Gateway
backing EOA separate. `agentWalletAddress` is passed to
`circle wallet sign typed-data --address`; `buyerWalletAddress` / `backingEOA`
is used as the x402 `TransferWithAuthorization.from` address. If only the Agent
Wallet is configured, the SDK discovers `data.backingEOA` with
`circle gateway balance --address <agent-wallet-address> --chain ARC-TESTNET --output json`.

Gateway/Nanopayments settlement ids can look like UUIDs rather than EVM
transaction hashes, and `transactionHashes` may be empty. Treat
`settlementIds` as the primary proof of payment. A successful nanopayment may
not appear as a direct ERC-20 transfer to the seller on Arcscan. Seller
dashboards must count Rubicon backend payment receipts / Circle Gateway
settlement IDs, not direct on-chain transfers. Verify paid reads with the
Rubicon receipt, `word.payment_accepted` events, and Circle Gateway balance
before and after the read.

## SDK Surface

Primary method:

```ts
rubicon.run({
  articleId,
  goal,
  maxSpendAtomic,
  maxWords,
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

Lower-level methods:

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

The SDK handles the session-first lifecycle, budget conversion, one-word payment
body shape, idempotency key, and x402 wrapper. Agents should not manually build
x402 payment payloads when the SDK payment engine is available.

## Paid-Read Preflight

Before spending real testnet or production funds:

1. Confirm the exact user budget for this read.
2. Discover live articles from the gateway:

   ```bash
   curl -s "$RUBICON_GATEWAY_URL/v1/articles?status=published"
   ```

3. Choose an article from the live response.
4. Confirm the article exposes USDC payment terms on `eip155:5042002`.
5. Check Circle CLI login and Agent Wallet balance on `ARC-TESTNET`.
6. Verify the seller `payTo` is allowed by wallet policy or recipient allowlist.

Stop at the first failed check. Do not substitute on-chain wallet balance for
Gateway/Nanopayments balance.

## Raw HTTP Protocol

Use raw HTTP only for protocol tests or custom integrations. The SDK input
`maxSpendAtomic` is a convenience field; raw session creation must use nested
`budget`:

```json
{
  "articleId": "article_<uuid>",
  "goal": "Find the useful part",
  "sectionId": "section-2",
  "budget": {
    "currency": "USDC",
    "maxAmountAtomic": "20000"
  }
}
```

Rubicon is session-first. `POST /v1/sessions` returns the one-word
`paymentRequired` challenge. `POST /v1/sessions/:sessionId/payments` expects:

```json
{
  "paymentPayload": { "...": "signed x402 payment payload" },
  "idempotencyKey": "<sessionId>:0"
}
```

Do not use `circle services pay` against the current Rubicon payments route; it
expects the endpoint itself to emit a standard HTTP 402 challenge.

Endpoints:

- `GET /v1/repository`
- `GET /v1/articles?status=published`
- `GET /v1/articles/:articleId/navigation`
- `POST /v1/seller-agent/conversations`
- `POST /v1/sessions`
- `POST /v1/sessions/:sessionId/payments`
- `GET /v1/sessions/:sessionId/events`
- `POST /v1/sessions/:sessionId/abort`

## Hosted Gateway Environment

On Railway, set:

```bash
PORT=8080
RUBICON_GATEWAY_URL=https://rubicon-caligagateway-production.up.railway.app
RUBICON_AGENT_API_KEY=your-shared-buyer-agent-secret
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.4-mini
RUBICON_PAYMENTS=circle
CIRCLE_FACILITATOR_URL=https://gateway-api-testnet.circle.com
CIRCLE_X402_NETWORKS=eip155:5042002
```

Keep Railway's service and target port aligned to `8080`.

## Troubleshooting

- `Expected 402`: `circle services pay` was used against Rubicon's
  session-first payment route. Use the SDK or submit a signed `paymentPayload`.
- `Cannot read properties of undefined (reading 'maxAmountAtomic')`: raw
  session body omitted nested `budget`.
- `invalid_signature`: the payment signature does not match the authorization.
  Prefer the SDK payment engine instead of manual signing.
- `authorization_validity_too_short`: the x402 authorization window is too
  short for Circle Gateway.
- `session_not_found`: the session expired, was evicted, or the wrong session
  id was used. Start a fresh session.
- `EADDRINUSE`: the local gateway port is already in use. Pick another port and
  pass the matching `baseUrl` to the SDK.

If the hosted gateway accepts sessions but payments fail, check gateway logs by
timestamp and `sessionId` for payment requirement and payment attempt events,
then verify the buyer Gateway balance, seller `payTo`, and hosted Circle
environment variables.
