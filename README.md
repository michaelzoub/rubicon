# Rubicon — Pay-Per-Word Content for AI Agents

Rubicon is the backend infrastructure for pay-per-word content consumption by AI
agents. A **buyer agent** opens a budgeted reading session, authorizes a maximum
USDC spend, and pays for the **exact words** it actually receives; a server-side
**seller agent** represents the
article, helps the buyer find the right section without leaking unpaid content,
and controls the paid stream in budget-safe word bundles. The buyer can stop the instant
it has enough information and pays for exactly the words it received.

Rubicon is still pay per word. The change is where payment work happens:
CLI/API reads authorize bundled words by default, with explicit one-word mode
available for debugging or strict metering. The gateway meters delivered words
exactly, withholds content beyond the authorized budget, article/section bounds,
or stop conditions, and records bundled payment receipts with per-word detail.
Creators earn according to the exact number of words delivered.

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

Open a session with `POST /v1/sessions`, authorize the session cap with Circle /
Arc, then consume the stream until the buyer stops, the article ends, or the
authorized budget is exhausted. The legacy `POST /v1/sessions/:id/payments`
route remains the chunk fallback for environments that cannot yet hold a
session-level authorization.

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

The SDK runs the entire seller conversation → session authorization → metered
word stream → final usage settlement loop until a stop condition is met, with
budget enforcement, early stopping, abort, and a final receipt. Developers never
drive a payment flow per word by hand.

## CLI

Terminal-native agents can use the Rubicon CLI instead of importing the SDK
directly:

```bash
pnpm --filter @rubicon-caliga/cli build
pnpm dev:cli -- buy --first --goal "find pricing" --max-usdc 0.10 --json
```

The CLI is a thin wrapper around `@rubicon-caliga/agent-sdk`. Its primary `buy`
command autonomously performs seller-guided section selection, cumulative
budget enforcement, wallet readiness checks, strategic paid reads, and verified
local receipt persistence. It also supports lower-level discovery and debugging
commands and `~/.rubicon/config.json`. It does not implement
creator dashboard functionality. See [docs/cli.md](./docs/cli.md).

## Production storage

Set `SUPABASE_URL` and a Supabase key so the gateway can read `live` articles,
creators, sections, and verified wallets. The gateway is a trusted server-side
process, so it accepts `SUPABASE_SERVICE_ROLE_KEY` (preferred when set — it reads
directly, bypassing RLS). An anon/publishable key
(`SUPABASE_ANON_KEY` / `SUPABASE_PUBLISHABLE_KEY` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`)
also works when RLS policies grant the anon role access to live articles. Set
`DATABASE_URL` when you also want runtime sessions, word deliveries, payments,
and earnings persisted in Postgres. Apply migrations:

```bash
DATABASE_URL=postgres://... pnpm --filter @rubicon-caliga/gateway migrate
```

Only articles with `state = live` are consumable by buyer agents.

## Real Circle / Arc payments

1. Create and fund a Circle Agent Wallet with the Circle Agent Stack.
2. Set `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `CIRCLE_AGENT_WALLET_ID`, and `RUBICON_PAYMENTS=circle`.
3. Ensure each live article resolves to a verified creator wallet.
4. Set `CIRCLE_FACILITATOR_URL` for the target network.

The target path creates Circle / Arc-compatible bundled authorizations, streams
only words covered by the remaining budget and selected article range, and
records the final amount from actual words delivered. Explicit word mode remains
available when a buyer needs one authorization per delivered word.

## Railway deployment

The gateway binds `0.0.0.0:$PORT` (`apps/gateway/src/index.ts`). Set `PORT=8080`
and keep the Railway service's target port aligned to **8080** so the edge proxy
and the app agree. A target-port mismatch returns
`502 "Application failed to respond"` even when the container is healthy and
listening. The app always honors `process.env.PORT` for the bind, so no
application-code change is needed — only the env/target port must match.

For runtime persistence on Railway, set `DATABASE_URL` to the Supabase connection
pooler string, not the direct `db.<project-ref>.supabase.co:5432` string. The
direct host is IPv6-only and commonly fails from Railway with `ENETUNREACH` on
port 5432, which prevents sessions, word payments, and settlement receipts from
being persisted. Use the Supabase Dashboard connection-pooling URL. If Node
rejects the pooler certificate chain with `SELF_SIGNED_CERT_IN_CHAIN`, use
`sslmode=no-verify` unless you also configure the Supabase CA certificate:

```bash
DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=no-verify
```

## Docs

See [docs/architecture.md](./docs/architecture.md),
[docs/cli.md](./docs/cli.md), and
[docs/protocol.md](./docs/protocol.md). To test an unpublished SDK from another
local agent project, use
[docs/local-agent-test.md](./docs/local-agent-test.md). For a public agent setup
file, use [skill.md](./skill.md).
