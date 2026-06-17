# Rubicon — Pay-Per-Word Content for AI Agents

Rubicon is the backend infrastructure for pay-per-word content consumption by AI
agents. A **buyer agent** opens a budgeted reading session and pays for **every
individual word** it receives; a server-side **seller agent** represents the
article, helps the buyer find the right section without leaking unpaid content,
and controls the paid stream one word at a time. The buyer can stop the instant
it has enough information and pays for exactly the words it received.

Rubicon meters and charges every word individually. Circle may batch settlement
internally, but creators earn according to the exact number of words delivered.
There are no payment chunks. Each released word returns a word-level receipt
with amount, network, destination, and transaction hash details.

## Packages

- `apps/gateway` — Fastify public agent API: article repository, seller agent,
  word-level billing, persistence, and SSE events.
- `packages/agent-sdk` — buyer-agent SDK with a high-level `read()` loop.
- `packages/core` — shared protocol types, word-level pricing, session
  primitives, and the API contract shared with rubicon-marketing.
- `examples/agent-client` — a local buyer agent that reads an article.

Creator authentication, article CRUD, wallet settings, and the dashboard live in
the separate Next.js app
[rubicon-marketing](https://github.com/michaelzoub/rubicon-marketing). The
gateway reads public article metadata from Supabase with the anon role and RLS;
Rubicon does not implement a creator dashboard API.

## Gateway fee

The Rubicon gateway fee is **0 bps**. Creators receive the full per-word price,
excluding only unavoidable external network/payment-provider costs.

## Quick Start (development)

Development mode requires Supabase credentials for article reads. The payment
path can still use the no-money payment shim:

```bash
pnpm install
cp .env.example .env
# Fill SUPABASE_URL and the anon/publishable Supabase key in .env or .env.local.
pnpm dev:gateway
```

In another terminal, run the buyer agent:

```bash
pnpm dev:agent
```

Manual flow:

```bash
curl -s http://localhost:8787/v1/repository
curl -s "http://localhost:8787/v1/articles/<live-article-id>/navigation?goal=how%20billing%20works"
curl -s -X POST http://localhost:8787/v1/seller-agent/conversations \
  -H "content-type: application/json" \
  -d '{"articleId":"<live-article-id>","goal":"how billing works","message":"where do you explain pricing?"}'
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
  articleId: "live-article-id-from-repository",
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

Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` so the gateway can read `live`
articles, creators, sections, and verified wallets through Supabase RLS. The
gateway also accepts `SUPABASE_PUBLISHABLE_KEY` or
`NEXT_PUBLIC_SUPABASE_ANON_KEY`. Do not use `SUPABASE_SERVICE_ROLE_KEY` here;
the repository must read as the anon role for RLS to apply. Set
`DATABASE_URL` when you also want runtime sessions, word deliveries, payments,
and earnings persisted in Postgres. Apply migrations:

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
emitted. The gateway returns the per-word receipt in the JSON response and in
the `PAYMENT-RESPONSE` header.

## Railway deployment

The gateway binds `0.0.0.0:$PORT` (`apps/gateway/src/index.ts`). Set `PORT=8080`
and keep the Railway service's target port aligned to **8080** so the edge proxy
and the app agree. A target-port mismatch returns
`502 "Application failed to respond"` even when the container is healthy and
listening. The app always honors `process.env.PORT` for the bind, so no
application-code change is needed — only the env/target port must match.

## Docs

See [docs/architecture.md](./docs/architecture.md) and
[docs/protocol.md](./docs/protocol.md). To test an unpublished SDK from another
local agent project, use
[docs/local-agent-test.md](./docs/local-agent-test.md). For a public agent setup
file, use [skill.md](./skill.md).
