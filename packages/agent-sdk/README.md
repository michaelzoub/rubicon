# @rubicon-caliga/agent-sdk

Buyer-agent SDK for Rubicon. The agent opens a budgeted reading session and pays
for **every individual word** it receives via x402. A high-level `read()` loop
runs the whole seller conversation → session → one-word payment → word → usage
cycle until a stop condition is met, so you never send a payment per word by
hand. The buyer can stop the moment it has enough information and pays for
exactly the words it received.

## Quick Start

```ts
import Rubicon, { CircleAgentWalletEngine, StaticPaymentEngine } from "@rubicon-caliga/agent-sdk";

const hasAgentWallet =
  process.env.CIRCLE_API_KEY &&
  process.env.CIRCLE_ENTITY_SECRET &&
  process.env.CIRCLE_AGENT_WALLET_ID;

const rubicon = new Rubicon({
  paymentEngine: hasAgentWallet
    ? new CircleAgentWalletEngine({
        apiKey: process.env.CIRCLE_API_KEY!,
        entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
        walletId: process.env.CIRCLE_AGENT_WALLET_ID!,
        walletAddress: process.env.CIRCLE_AGENT_WALLET_ADDRESS as `0x${string}` | undefined,
      })
    : new StaticPaymentEngine(),
});

const receipt = await rubicon.run({
  articleId: "live-article-id-from-repository",
  goal: "Find the resale-fee clause",
  maxSpendAtomic: "20000",
  stopWhen: ({ text, wordsRead, amountPaid }) => wordsRead > 50 || /resale fee/i.test(text),
  onWord: (word) => {
    process.stdout.write(`${word} `);
  },
});

console.log("\nreceipt:", receipt);
```

`baseUrl` defaults to `http://localhost:8787`. In development, omitting
`paymentEngine` uses `StaticPaymentEngine`, which works against a dev-mode
gateway. For real settlement, pass `CircleAgentWalletEngine`.

## `run(options)`

Runs the whole seller conversation → session → one-word payment → word → usage
cycle and returns a final receipt. Use `onWord` or `onEvent` when you want live
progress.

## `read(options)`

Yields `session.started`, `seller.message`, `article.word`, `article.usage`,
`article.completed` (with a final receipt), and `article.error`. It handles:

- seller-agent conversation and starting-section selection
- session creation and one-word payment creation/submission
- word receipt and running usage
- retry idempotency (per-word idempotency keys)
- budget enforcement (`maxSpendAtomic` / `budget`)
- early stopping (`stopWhen`, `maxWords`)
- stream abortion and a final receipt

## Lower-level methods

`getRepository`, `getNavigation`, `startConversation`, `sendConversationMessage`,
`startSession`, `payForWord`, `abort`, and `streamEvents` (raw SSE) are available
for custom flows.

## Payment engines

- `StaticPaymentEngine` — no-money development engine for a dev-mode gateway.
- `CircleAgentWalletEngine` — **custodial, Circle-native.** Each word's
  authorization is signed by a Circle Agent / Developer-Controlled Wallet through
  Circle's API, so the SDK never holds a private key. The wallet controller
  provisions, funds, and sets spending policies on the wallet beforehand; the SDK
  only consumes it and keeps enforcing the confirmed budget.

```ts
import Rubicon, { CircleAgentWalletEngine } from "@rubicon-caliga/agent-sdk";

const rubicon = new Rubicon({
  baseUrl: process.env.RUBICON_GATEWAY_URL,
  paymentEngine: new CircleAgentWalletEngine({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
    walletId: process.env.CIRCLE_AGENT_WALLET_ID!,
    walletAddress: process.env.CIRCLE_AGENT_WALLET_ADDRESS as `0x${string}` | undefined,
  }),
});
```

You can also pass an already-initiated Circle client instead of credentials:

```ts
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
new CircleAgentWalletEngine({ client, walletId });
```

> Circle Agent Wallets must be EOA wallets — EIP-3009 (the x402 `exact` scheme)
> requires an EOA signature, not an EIP-1271 smart-contract-account signature.

## Local Run

```bash
pnpm dev:gateway
pnpm dev:agent
```
