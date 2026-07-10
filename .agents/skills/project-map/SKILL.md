---
name: project-map
description: Orient coding agents to the Rubicon repository's packages, entrypoints, gateway architecture, buyer flows, payments, persistence, commands, and maintenance hazards. Use before making code changes in this repo and when updating the map after structural or architecture changes.
---

# Project Map

## Purpose

Rubicon is backend infrastructure for AI agents to discover and consume creator articles with exact per-word USDC metering. This repo owns the public Fastify gateway, shared protocol/pricing types, buyer SDK, terminal CLI, and a local buyer example. Creator auth, article CRUD, wallet settings, and dashboard UI live in sibling web repositories, not here.

## Stack

- TypeScript ESM on Node.js 20+; pnpm 9 workspace.
- Fastify 5 gateway with server-sent events.
- Supabase client for public article/creator data; PostgreSQL (`pg`) for runtime ledgers and receipts, with in-memory development adapters.
- Circle x402 batching, Circle Agent Wallet tooling, Arc/EVM authorization, `@x402/core`, `@x402/evm`, and viem.
- Node's built-in test runner; TypeScript supplies lint/typecheck. Railway deployment config is in `railway.json`.
- No browser UI, styling system, creator auth, or product analytics SDK exists in this repo.

## How to run

```bash
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm dev:gateway
pnpm dev:agent
pnpm dev:cli
pnpm smoke:hosted-buyer-flow
DATABASE_URL=postgres://... pnpm --filter @rubicon-caliga/gateway migrate
```

Development article reads require Supabase values in `.env` or `.env.local`. For the local demo/no-money path, follow the exact gateway command in `AGENTS.md`.

## High-level structure

| Path | Purpose |
| --- | --- |
| `apps/gateway/` | Public HTTP gateway, payment verification, repositories, session workflow, migrations. |
| `packages/core/` | Shared protocol, API contract, money/pricing, network, and session primitives. |
| `packages/agent-sdk/` | Buyer client, read loop, SSE handling, and payment engines. |
| `packages/cli/` | `rubicon` executable, autonomous `buy` flow, Circle login/readiness, config, receipts. |
| `examples/agent-client/` | Minimal local SDK consumer. |
| `docs/` | Protocol, API, CLI, local test, and server architecture documentation. |
| `scripts/` | Hosted-flow smoke test and package-scope maintenance. |
| `skill.md` | Canonical published buyer-agent runbook; synchronization rules are in `AGENTS.md`. |

## Main entrypoints

- `apps/gateway/src/index.ts`: compose environment-selected repositories/payment engine and start Fastify.
- `apps/gateway/src/server.ts`: HTTP routes, validation, response shapes, SSE, and structured payment logs.
- `apps/gateway/src/migrate.ts`: apply `apps/gateway/migrations/*.sql`.
- `packages/core/src/index.ts`: public shared exports; `contract.ts` and `protocol.ts` define cross-repo API shapes.
- `packages/agent-sdk/src/index.ts`: SDK exports; `agent-client.ts` owns the end-to-end buyer read loop.
- `packages/cli/src/index.ts`: `rubicon` binary dispatch; `args.ts` defines commands and flags.
- `examples/agent-client/src/index.ts` and `read-article.ts`: runnable client examples.

## Core systems

### Gateway API and paid-reading workflow

`apps/gateway/src/server.ts` owns `/health`, endpoint/repository discovery, article navigation, seller conversations, session creation, preferred session streaming, legacy chunk payments, SSE events, and abort/receipt routes. Keep HTTP concerns here; metering, transitions, settlement flushes, budget calculations, and receipt construction belong in `apps/gateway/src/workflows/paid-reading.ts`. `seller-agent/seller-agent.ts` guides navigation and conversation but does not release paid words.

### Content repositories

`repositories/supabase.ts` reads only live public article, section, creator, and verified-wallet data. `repositories/in-memory.ts` supports demo data. This service does not own creator CRUD. Changes to public content shapes must be coordinated with `packages/core/src/contract.ts` and the sibling dashboard schema.

### Sessions, persistence, and events

`stores/session-store.ts` and `stores/event-bus.ts` provide in-process state/events. `repositories/postgres.ts` persists sessions, deliveries, payments, earnings, and settlement data when `DATABASE_URL` is set; migrations are append-only under `apps/gateway/migrations/`. SSE is exposed at `/v1/sessions/:sessionId/events`; event types live in `packages/core/src/protocol.ts`.

### Payments/onchain

`payments/types.ts` defines the verifier boundary. `payments/x402-circle.ts` verifies Circle/Arc authorizations and queues settlement through `settlement-queue.ts`; development mode uses a no-money verifier. `payments/x402-base.ts` is the separate AgentCash whole-article lane and fails closed unless the writer has a verified wallet on its configured Base network; its 402 challenge is the only source of `payTo`. `chain.ts` normalizes supported networks. Never release paid content before authorization verification, weaken the session cap, silently change `payTo`, or treat a queued settlement as final success.

### Buyer SDK

`packages/agent-sdk/src/agent-client.ts` owns discovery/conversation, session authorization, streamed delivery, stop conditions, aborts, and final receipts. `payment-engine.ts`, `circle-agent-wallet.ts`, and `circle-cli-gateway-payment.ts` implement authorization strategies. When protocol fields change, update core first, rebuild it, then update SDK consumers and exports.

### CLI

`packages/cli/src/index.ts` dispatches commands; `operations.ts` contains lower-level API operations and `quickstart.ts` implements autonomous buying. `circle.ts`, `login.ts`, and `payments.ts` handle Circle CLI readiness and wallet selection; `config.ts` reads `~/.rubicon/config.json`; `receipts.ts` persists verified local receipts. Keep `buy` budgets cumulative and hard-capped, redact credentials, and preserve JSON output contracts.

### Shared protocol and pricing

`packages/core/src/protocol.ts` is the canonical wire model, `pricing.ts` preserves exact per-word accounting even when authorization/delivery is bundled, `session.ts` owns session state primitives, and `networks.ts` owns network identifiers. Do not duplicate these contracts in downstream packages.

### Docs and published runbook

`docs/api-contract.md`, `protocol.md`, `architecture.md`, `server-endpoint-architecture.md`, and `cli.md` explain public behavior. Root `skill.md` is published verbatim to sibling repos: if it changes, follow `.agents/skills/sync-skill-md/SKILL.md`, bump its version, confirm any pinned CLI version exists on npm, and sync every required copy.

### Tests

Tests sit beside source as `*.test.ts`. Gateway and most SDK/core tests execute compiled `dist` output, so run `pnpm build` before `pnpm test`; CLI tests run through `tsx`. Add tests at the contract boundary being changed, not only in a downstream wrapper.

## Important flows

1. Buyer lists `/v1/repository` or `/v1/articles` and optionally uses free navigation/seller conversation to choose a relevant section.
2. Buyer opens `POST /v1/sessions` with a hard USDC cap; the gateway resolves the live article and creator payout wallet and returns authorization terms for paid content.
3. SDK/payment engine signs Circle/Arc terms; `POST /v1/sessions/:sessionId/stream` verifies authorization before releasing metered bundles. The legacy `/payments` route is a fallback.
4. Gateway records exact delivered words and amounts, emits SSE events, settles usage, and returns a final receipt when stopped, exhausted, completed, or aborted.
5. CLI `buy` wraps discovery, seller guidance, wallet readiness, strategic reads, cumulative budget enforcement, and local receipt verification.

Free articles use the same discovery/session surfaces with `accessMode: "free"` and require no payment authorization.

## Analytics/events

No product analytics service was found. Runtime observability consists of Fastify logs, structured `rubicon.payment_requirement_issued` and `rubicon.payment_attempt` records in `server.ts`, and typed session/SSE events in `packages/core/src/protocol.ts`. Never log API keys, bearer tokens, entity secrets, signed authorization payloads, private article text, or unredacted wallet credentials.

## Shared design/UI constraints

There is no browser UI or CSS in this repo. User-facing surfaces are CLI text/JSON, API responses, docs, and streamed content. Preserve machine-readable JSON output, stable error codes, public protocol shapes, and terse terminal copy; coordinate visual/dashboard work in the sibling web repo.

## Be careful

- Do not expose unpaid/private article content through navigation, seller prompts, logs, or errors.
- Do not rename routes or protocol fields without checking SDK, CLI, examples, docs, hosted runbook, and sibling clients.
- Keep author payout resolution tied to verified creator wallets; payment and settlement changes cross trust boundaries.
- Do not use raw private-key fallbacks in buyer flows; the intended custody path is Circle Agent Wallet/CLI.
- Keep `DATABASE_URL` optional only for development; production runtime data otherwise falls back to memory and disappears on restart.
- Add new schema changes as migrations and keep repository adapters aligned.
- Generated `dist/` can be stale. Build `core` before diagnosing downstream declaration errors.
- Do not edit published `public/skill.md` copies directly.

## Recent architecture changes

- 2026-07-10: Hardened the AgentCash Base lane to pay only verified writer wallets on the configured Base network, bound its runtime price to its x402scan discovery maximum, and served the Rubicon white-backed logo for marketplace discovery.
- 2026-07-03: Added explicit `accessMode: free | paid` across gateway, SDK, and CLI.
- 2026-07-03: Updated published package integrations and buyer-facing package versions.
- 2026-07-02: Reduced agent setup friction across CLI, SDK, and hosted setup guidance.
- 2026-06-26: Moved paid-word release responsibility out of the seller agent and into the server-owned session workflow.
- 2026-06-23: Aligned CLI code and the published server-side agent runbook.

## Update rules

Update this file when routes or entrypoints change; important files move; analytics/events, auth, imports, payments, API, database, SDK exports, or dashboard boundaries change; shared systems move; commands change; major dependencies are added or removed; or a large refactor lands. Keep entries compressed and retain only the latest 5–10 architecture-level changes.
