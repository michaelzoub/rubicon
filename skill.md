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
  articleId: "live-article-id-from-repository",
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
`transactionHashes` or Gateway settlement ids, `buyerWalletAddress`,
`sellerPayTo`, `network`, `text`, `completed`, and `stopReason`.

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
  articleId: "live-article-id-from-repository",
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

Production/testnet settlement uses `CircleAgentWalletEngine` (custodial
signing, no raw key — see Circle Agent Wallets below). This is the default and
only recommended real-payment path. Do not configure buyer agents with raw
private keys, and do not ask a wallet controller to export one.

```ts
import Rubicon, { CircleAgentWalletEngine } from "@rubicon-caliga/agent-sdk";

const rubicon = new Rubicon({
  baseUrl: process.env.RUBICON_GATEWAY_URL ?? "https://rubicon-caligagateway-production.up.railway.app",
  authorization: process.env.RUBICON_AGENT_API_KEY
    ? `Bearer ${process.env.RUBICON_AGENT_API_KEY}`
    : undefined,
  paymentEngine: new CircleAgentWalletEngine({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
    walletId: process.env.CIRCLE_AGENT_WALLET_ID!,
    walletAddress: process.env.CIRCLE_AGENT_WALLET_ADDRESS as `0x${string}` | undefined,
    baseUrl: process.env.CIRCLE_API_BASE_URL,
  }),
});
```

### Circle Agent Wallets + Gateway Nanopayments

Circle Agent Wallets are the recommended buyer setup path because the agent
never handles a raw private key — payments are signed custodially through
Circle's API. The person controlling the wallet/funds should create the Agent
Wallet, fund its Gateway/Nanopayments balance, and set spending policies such
as transfer limits, recipient allowlists, and contract blocklists before the
agent starts a paid read. See
Circle's Agent Wallets guide: https://developers.circle.com/agent-stack/agent-wallets

Once that wallet exists, use `CircleAgentWalletEngine`. It signs each one-word
x402 payment with the wallet over the Circle API, without exposing a local
signing key to the agent:

```ts
import Rubicon, { CircleAgentWalletEngine } from "@rubicon-caliga/agent-sdk";

const rubicon = new Rubicon({
  baseUrl: process.env.RUBICON_GATEWAY_URL ?? "https://rubicon-caligagateway-production.up.railway.app",
  authorization: process.env.RUBICON_AGENT_API_KEY
    ? `Bearer ${process.env.RUBICON_AGENT_API_KEY}`
    : undefined,
  paymentEngine: new CircleAgentWalletEngine({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
    walletId: process.env.CIRCLE_AGENT_WALLET_ID!,
    // Optional — resolved from the Circle API when omitted:
    walletAddress: process.env.CIRCLE_AGENT_WALLET_ADDRESS as `0x${string}` | undefined,
    // Optional — override the Circle API base URL (sandbox vs. production):
    baseUrl: process.env.CIRCLE_API_BASE_URL,
  }),
});
```

`CircleAgentWalletEngine` uses gasless Gateway batching with an `exact` EIP-3009
fallback. The signer is the Circle Agent Wallet, not a local key.

The SDK consumes an already configured wallet-backed payment capability and
keeps enforcing the user's confirmed Rubicon budget. Do not create wallets,
fund wallets, change wallet policies, or use a user's personal key unless the
wallet controller has explicitly asked for that setup action.

Legacy/raw-EOA adapters that accept a local private key are unsupported for
normal Rubicon paid reads. Use them only if the user explicitly requests raw
private-key custody for a custom test and accepts that custody model.

### Paid-Read Preflight

Before spending real testnet or production funds, run this preflight and stop
at the first failure:

1. Confirm the exact user budget for this read. Example: `$0.02` equals
   `20000` atomic USDC.
2. Discover live articles from the gateway:

   ```bash
   curl -s "$RUBICON_GATEWAY_URL/v1/articles?status=published"
   ```

   The current gateway exposes live published articles at `/v1/articles`; the
   `status=published` query is safe and may be ignored by older gateways.
3. Choose `articleId` from the live response, and confirm the article exposes
   public seller payment terms: `paymentTerms.asset = "USDC"`,
   `paymentTerms.network = "eip155:5042002"` / `ARC-TESTNET`, and
   `paymentTerms.payTo` is present.
4. Check Arc Testnet support in Circle CLI:

   ```bash
   circle blockchain list
   ```

5. Check Circle CLI wallet login and find the Agent Wallet address:

   ```bash
   circle wallet list --chain ARC-TESTNET --type agent --output json
   ```

   If Circle CLI is not logged in, stop and ask the wallet controller to log in.
   Do not work around CLI auth.
6. Check the Gateway/Nanopayments balance for the Agent Wallet:

   ```bash
   circle gateway balance --address <agent-wallet-address> --chain ARC-TESTNET --output json
   ```

   The Gateway balance must cover `maxSpendAtomic`. If it is missing or too
   low, stop and ask the wallet controller to deposit. Do not substitute the
   on-chain wallet balance.
7. Verify the seller `payTo` is public, ARC-TESTNET-compatible, and allowed by
   the Agent Wallet policy or recipient allowlist.

### Controlled Paid Attempt

Only after preflight passes, run one controlled paid attempt:

```ts
import Rubicon, { CircleAgentWalletEngine } from "@rubicon-caliga/agent-sdk";

const rubicon = new Rubicon({
  baseUrl: process.env.RUBICON_GATEWAY_URL!,
  authorization: process.env.RUBICON_AGENT_API_KEY
    ? `Bearer ${process.env.RUBICON_AGENT_API_KEY}`
    : undefined,
  paymentEngine: new CircleAgentWalletEngine({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
    walletId: process.env.CIRCLE_AGENT_WALLET_ID!,
    walletAddress: process.env.CIRCLE_AGENT_WALLET_ADDRESS as `0x${string}` | undefined,
  }),
});

const repository = await rubicon.getRepository();
const articleId = repository.articles.find((article) => article.state === "live")?.articleId;
if (!articleId) throw new Error("No live Rubicon article found");

const receipt = await rubicon.run({
  articleId,
  goal: "find info related to central risks",
  maxSpendAtomic: "20000",
  maxWords: 1,
});

console.log({
  sessionId: receipt.sessionId,
  amountPaidAtomic: receipt.amountPaidAtomic,
  wordsRead: receipt.wordsRead,
  transactionHashes: receipt.transactionHashes,
  settlementIds: receipt.settlementIds,
  buyerWalletAddress: receipt.buyerWalletAddress,
  sellerPayTo: receipt.sellerPayTo,
  network: receipt.network,
});
```

This must create one session, receive one payment requirement, make one payment
attempt, and read at most one word. After the attempt, inspect gateway logs by
timestamp and `sessionId`; the server logs
`rubicon.payment_requirement_issued` and `rubicon.payment_attempt` for this
flow.

Rubicon's current architecture is session-first: `POST /v1/sessions` returns
the one-word x402-style payment requirement, and the SDK pays
`POST /v1/sessions/:sessionId/payments`. `circle services pay` expects a
standard HTTP 402 challenge from the protected endpoint itself, so use it only
against gateways that explicitly implement that standard 402 challenge flow.

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

`RUBICON_AGENT_API_KEY` protects the Rubicon HTTP API. `OPENAI_API_KEY` powers
the hosted seller agent's navigation/conversation model.

The gateway binds `0.0.0.0:$PORT` (see `apps/gateway/src/index.ts`). Keep
`PORT=8080` and Railway's service/target port aligned to 8080 — if the edge
proxy targets a different port, requests return `502 "Application failed to
respond"` even though the container is healthy and listening.

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

If a hosted Circle/x402 read opens sessions but every
`POST /v1/sessions/:sessionId/payments` returns `402`, treat it as a payment
settlement problem, not an article-navigation problem. Public request logs may
only show the 402 status and an abort; no article body or transaction hash is
available until at least one word payment settles. Check the gateway application
logs by timestamp and `sessionId` for `rubicon.payment_requirement_issued`,
`rubicon.payment_attempt`, and the verifier reason from Circle
(`settlement.errorReason` or `settlement.errorMessage`), then confirm:

- the buyer Agent Wallet address is the address with the Circle Gateway balance;
- the creator `payTo` wallet is verified and allowed by wallet policies;
- hosted env uses `RUBICON_PAYMENTS=circle`,
  `CIRCLE_FACILITATOR_URL=https://gateway-api-testnet.circle.com`, and
  `CIRCLE_X402_NETWORKS=eip155:5042002`;
- `CIRCLE_X402_MAX_TIMEOUT_SECONDS` is unset or at least 604800.

Do not retry with arbitrary payment amounts. A probe such as one atomic USDC
will correctly fail with `payment_does_not_match_session_terms` unless the
session's issued one-word payment requirement is exactly for that amount.

If the hosted gateway is not compatible with Circle CLI / Agent Wallet
nanopayments, ask the server owner to implement either standard x402 402
challenge compatibility or the SDK-supported Circle Agent Wallet-backed payment
adapter for Rubicon's session-first challenge. Do not work around this by
requesting, storing, exporting, inferring, or using raw private keys.

If the request is about the raw HTTP protocol, see the gateway endpoints:

- `GET /v1/repository`
- `GET /v1/articles/:articleId/navigation`
- `POST /v1/seller-agent/conversations`
- `POST /v1/sessions`
- `POST /v1/sessions/:sessionId/payments`
- `GET /v1/sessions/:sessionId/events`
- `POST /v1/sessions/:sessionId/abort`
