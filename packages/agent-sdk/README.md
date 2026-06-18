# @rubicon-caliga/agent-sdk

Buyer-agent SDK for Rubicon. The agent opens a budgeted reading session,
authorizes a maximum Circle / Arc spend, then pays for the **exact words** it
actually receives. A high-level `read()` loop runs the whole seller conversation
→ session authorization → metered word stream → final receipt cycle until a stop
condition is met, so you never run a payment flow per word by hand. The buyer
can stop the moment it has enough information and pays for exactly the words it
received.

## Quick Start

```ts
import Rubicon, {
  CircleCliGatewayPaymentEngine,
  StaticPaymentEngine,
} from "@rubicon-caliga/agent-sdk";

const hasCircleCliWallet = process.env.CIRCLE_AGENT_WALLET_ADDRESS;

const rubicon = new Rubicon({
  paymentEngine: hasCircleCliWallet
    ? new CircleCliGatewayPaymentEngine({
        agentWalletAddress: process.env.CIRCLE_AGENT_WALLET_ADDRESS as `0x${string}`,
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
gateway. For real Arc Testnet settlement without raw private keys, pass
`CircleCliGatewayPaymentEngine`.

## `run(options)`

Runs the whole seller conversation → session authorization → word-level metering
→ final receipt cycle and returns a final receipt. Use `onWord` or `onEvent`
when you want live progress.

## `read(options)`

Yields `session.started`, `seller.message`, `article.word`, `article.usage`,
`article.completed` (with a final receipt), and `article.error`. It handles:

- seller-agent conversation and starting-section selection
- session authorization, with chunk or one-word fallback for older gateways
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
- `CircleCliGatewayPaymentEngine` — **Circle CLI / Agent Wallet custody.**
  Signs Circle / Arc authorization payloads through `circle wallet sign
  typed-data`, so the SDK never holds a private key and callers never manually
  assemble payment payloads. The target mode is one session authorization with
  chunk fallback.
- `CircleAgentWalletEngine` — **custodial, Circle-native.** Signs authorization
  payloads with a Circle Agent / Developer-Controlled Wallet through Circle's
  API. The wallet controller provisions, funds, and sets spending policies on the
  wallet beforehand; the SDK only consumes it and keeps enforcing the confirmed
  budget.

```ts
import Rubicon, { CircleCliGatewayPaymentEngine } from "@rubicon-caliga/agent-sdk";

const rubicon = new Rubicon({
  baseUrl: process.env.RUBICON_GATEWAY_URL,
  paymentEngine: new CircleCliGatewayPaymentEngine({
    agentWalletAddress: process.env.CIRCLE_AGENT_WALLET_ADDRESS as `0x${string}` | undefined,
    chain: "ARC-TESTNET",
  }),
});
```

`CircleCliGatewayPaymentEngine` keeps two addresses distinct:

- `agentWalletAddress` is the Circle Agent Wallet passed to
  `circle wallet sign typed-data --address`.
- `buyerWalletAddress` / `backingEOA` is the Gateway backing EOA used as the
  x402 `TransferWithAuthorization.from` address.

When only `agentWalletAddress` is provided, the engine discovers the backing EOA
with `circle gateway balance --address <agentWalletAddress> --chain ARC-TESTNET --output json`.
When no address is provided, the engine first runs
`circle wallet list --chain ARC-TESTNET --type agent --output json` and uses the
sole Agent Wallet it finds, then discovers its backing EOA with Gateway balance.
The older `walletAddress` option remains as an alias for `agentWalletAddress`.
If multiple Agent Wallets are present, pass the agent wallet explicitly.

Gateway/Nanopayments receipts may have empty `transactionHashes`. Treat
`settlementIds` as the primary proof of payment; scanner visibility is not
guaranteed because a successful nanopayment may not appear as a direct ERC-20
transfer to the seller. Seller dashboards should count Rubicon backend payment
receipts and Circle Gateway settlement IDs, not direct on-chain transfers.

The lower-level API-backed custody path is also available:

```ts
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { CircleAgentWalletEngine } from "@rubicon-caliga/agent-sdk";

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
