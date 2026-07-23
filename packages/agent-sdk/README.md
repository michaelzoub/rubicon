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
  granularity: 10,
  stopWhen: ({ text, wordsRead, amountPaid }) => wordsRead > 50 || /resale fee/i.test(text),
  onWord: (word) => {
    process.stdout.write(`${word} `);
  },
});

console.log("\nreceipt:", receipt);
```

`granularity` is the caller's payment/delivery unit:

- `1` streams and pays one word at a time; `10` uses ten-word units (any
  positive integer is accepted).
- `"section"` pays for the selected section in one unit. Pass `sectionId`, or
  pass `goal` and let the seller agent select it.
- `"article"` selects and pays for the complete article in one unit.

Section/article granularity is all-or-nothing: the SDK refuses to start payment
unless `maxSpendAtomic` covers the complete selected range. Hard budget checks
remain in force for every mode. `chunkWords` remains available as a legacy
alias for numeric bundling.

`baseUrl` defaults to the hosted Rubicon gateway
(`https://rubicon-caligagateway-production.up.railway.app`), so the snippet
above works without running anything locally; pass
`baseUrl: "http://localhost:8787"` to target a local dev gateway. In
development, omitting `paymentEngine` uses `StaticPaymentEngine`, which works
against a dev-mode gateway. For real Arc Testnet settlement without raw private
keys, pass `CircleCliGatewayPaymentEngine`.

## `run(options)`

Runs the whole seller conversation → bundled authorization → metered delivery →
final receipt cycle and returns a final receipt. Use `onWord` or `onEvent` when
you want live progress.

## `read(options)`

Yields `session.started`, `seller.message`, `article.bundle`, `article.usage`,
`article.completed` (with a final receipt), and `article.error` by default. When
enabled it yields `authorship.analyzed` before `session.started`.
Use `streamMode: "word"` for legacy `article.word` events and one-word
authorization/delivery. It handles:

- seller-agent conversation and starting-section selection
- optional pre-purchase Pangram authorship verification
- bundled authorization, with one-word fallback for older gateways or explicit
  word mode
- bundled receipt metadata and running usage
- retry idempotency
- budget enforcement (`maxSpendAtomic` / `budget`)
- early stopping (`stopWhen`, `maxWords`)
- stream abortion and a final receipt

## Lower-level methods

`getRepository`, `getNavigation`, `analyzeAuthorship`, `startConversation`, `sendConversationMessage`,
`startSession`, `payForWord`, `abort`, and `streamEvents` (raw SSE) are available
for custom flows.

## Optional authorship verification

Pass the buyer-owned Pangram key as `pangramApiKey` and configure
`authorshipVerification`. The default mode is `never`; a key alone never makes
a detector request or incurs detector charges. `always` scans every selected
candidate, while `agent_decides` scans only reads with `verifyAuthorship: true`.
Threshold decisions accept 0–1 fractions. An `agent_decides` decision requires
the read's `decideAuthorship(result)` callback. The key is attached only to the
verification request and the SDK receives aggregate metrics, never article text,
Pangram windows, raw responses, or dashboard links.

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
