# @rubicon-caliga/agent-sdk

Buyer-agent SDK for Rubicon. The agent opens a budgeted reading session and pays
for **every individual word** it receives via x402. A high-level `read()` loop
runs the whole seller conversation → session → one-word payment → word → usage
cycle until a stop condition is met, so you never send a payment per word by
hand. The buyer can stop the moment it has enough information and pays for
exactly the words it received.

## Quick Start

```ts
import Rubicon, { CircleGatewayPaymentEngine, StaticPaymentEngine } from "@rubicon-caliga/agent-sdk";

const privateKey = process.env.CIRCLE_PRIVATE_KEY as `0x${string}` | undefined;

const rubicon = new Rubicon({
  paymentEngine: privateKey
    ? new CircleGatewayPaymentEngine({ chain: "arcTestnet", privateKey, rpcUrl: process.env.CIRCLE_RPC_URL })
    : new StaticPaymentEngine(),
});

const receipt = await rubicon.run({
  articleId: "rubicon-streaming-001",
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
gateway. For real settlement, pass `CircleGatewayPaymentEngine`.

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
- `CircleGatewayPaymentEngine` — signs the gateway's one-word x402 terms; Circle
  may batch settlement internally, but each payload corresponds to one word.

## Local Run

```bash
pnpm dev:gateway
pnpm dev:agent
```
