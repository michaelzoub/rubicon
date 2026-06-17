# Rubicon — Pay-Per-Word Content for AI Agents

Rubicon is the backend infrastructure for pay-per-word content consumption by AI
agents. A **buyer agent** opens a budgeted reading session and pays for **every
individual word** it receives; a server-side **seller agent** represents the
article, helps the buyer find the right section without leaking unpaid content,
and controls the paid stream one word at a time. The buyer can stop the instant
it has enough information and pays for exactly the words it received.

Rubicon meters and charges every word individually. Circle may batch settlement
internally, but creators earn according to the exact number of words delivered.
There are no payment chunks.

## Packages

- `apps/gateway` — Fastify public agent API: article repository, seller agent,
  word-level billing, persistence, and SSE events.
- `packages/agent-sdk` — buyer-agent SDK with a high-level `read()` loop.
- `packages/core` — shared protocol types, word-level pricing, session
  primitives, and the API contract shared with rubicon-marketing.
- `examples/agent-client` — a local buyer agent that reads an article.

Creator authentication, article CRUD, wallet settings, and the dashboard live in
the separate Next.js app
[rubicon-marketing](https://github.com/michaelzoub/rubicon-marketing). The two
repositories integrate through a shared Postgres data model — Rubicon does not
implement a creator dashboard API.

## Gateway fee

The Rubicon gateway fee is **0 bps**. Creators receive the full per-word price,
excluding only unavoidable external network/payment-provider costs.

## Quick Start (development)

Development mode uses in-memory fixtures and a no-money payment shim:

```bash
pnpm install
cp .env.example .env
pnpm dev:gateway
```

In another terminal, run the buyer agent:

```bash
pnpm dev:agent
```

Manual flow:

```bash
curl -s http://localhost:8787/v1/repository
curl -s "http://localhost:8787/v1/articles/rubicon-streaming-001/navigation?goal=how%20billing%20works"
curl -s -X POST http://localhost:8787/v1/seller-agent/conversations \
  -H "content-type: application/json" \
  -d '{"articleId":"rubicon-streaming-001","goal":"how billing works","message":"where do you explain pricing?"}'
```

Open a session with `POST /v1/sessions`, then send one `POST
/v1/sessions/:id/payments` per word. Each accepted payment releases exactly one
word.

## Buyer SDK

```ts
import { RubiconClient, StaticPaymentEngine } from "@rubicon-caliga/agent-sdk";

const rubicon = new RubiconClient({
  paymentEngine: new StaticPaymentEngine(),
});

const receipt = await rubicon.run({
  articleId: "rubicon-streaming-001",
  goal: "Find the resale-fee clause",
  maxSpendAtomic: "20000",
  stopWhen: ({ text, wordsRead }) => wordsRead > 50 || /resale fee/i.test(text),
  onWord: (word) => {
    process.stdout.write(`${word} `);
  },
});

console.log("\nreceipt:", receipt);
```

The SDK runs the entire seller conversation → session → one-word payment → word →
usage loop until a stop condition is met, with retry idempotency, budget
enforcement, early stopping, abort, and a final receipt. Developers never send a
payment per word by hand.

## Production storage

Set `DATABASE_URL` to a shared Postgres instance authored by rubicon-marketing.
The gateway then reads `live` articles, creators, and verified wallets from
Postgres and writes word/payment/earnings activity. Apply migrations:

```bash
DATABASE_URL=postgres://... pnpm --filter @rubicon-caliga/gateway migrate
```

Only articles with `state = live` are consumable by buyer agents.

## Real x402 word payments

1. Fund the buyer wallet's Circle Gateway balance.
2. Set `CIRCLE_PRIVATE_KEY` for the buyer and `RUBICON_PAYMENTS=circle`.
3. Ensure each live article resolves to a verified creator wallet.
4. Set `CIRCLE_FACILITATOR_URL` for the target network.

Each word is verified and settled to the creator's wallet before the next word is
emitted.

## Docs

See [docs/architecture.md](./docs/architecture.md) and
[docs/protocol.md](./docs/protocol.md).
