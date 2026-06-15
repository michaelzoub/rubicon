# Rubicon x402 Streaming Gateway

Rubicon is a scaffold for metered agent services: agents open a budgeted session, pay every interval through x402 nanopayments, and receive streaming provider output until the task completes, the budget is exhausted, or the agent cancels.

The repo is intentionally TypeScript-first because Circle's x402 nanopayment SDKs are Node-oriented:

- `apps/gateway`: Fastify gateway that owns session state, payment heartbeat verification, provider routing, usage accounting, and SSE streams.
- `packages/agent-sdk`: client SDK for autonomous agents consuming metered services.
- `packages/provider-sdk`: provider SDK for compute services exposing metered jobs.
- `packages/core`: shared protocol types, pricing math, and session primitives.
- `examples/mock-provider`: local provider that emits progress, usage, and completion events.
- `examples/agent-client`: local agent that starts a job and streams updates.

## Circle Alignment

Circle Gateway nanopayments use x402 with `402 Payment Required`, buyer-signed EIP-3009 authorizations, and batched Circle settlement. Buyer integrations use `@circle-fin/x402-batching/client`; seller/resource-server integrations use `@circle-fin/x402-batching/server` with `BatchFacilitatorClient` and `GatewayEvmScheme`.

This scaffold wraps those pieces behind small adapters so product logic stays independent from payment implementation details.

## Quick Start

Development mode uses a static payment shim when Circle seller credentials are not set:

```bash
pnpm install
cp .env.example .env
pnpm dev:gateway
```

In other terminals:

```bash
pnpm dev:provider
pnpm dev:agent
```

## Real x402 Nanopayment Test

To charge real Gateway USDC against a local mock provider:

1. Fund the buyer wallet's Circle Gateway balance on the configured chain.
2. Set `CIRCLE_PRIVATE_KEY` for the buyer agent.
3. Set `CIRCLE_SELLER_ADDRESS` for the gateway recipient.
4. Set `CIRCLE_FACILITATOR_URL=https://gateway-api-testnet.circle.com` for testnet.
5. Keep `MOCK_PROVIDER_UNIT_PRICE_ATOMIC=1` to charge `0.000001 USDC` per heartbeat before gateway fees.

Then run the same three commands:

```bash
pnpm dev:gateway
pnpm dev:provider
pnpm dev:agent
```

When `CIRCLE_SELLER_ADDRESS` is present, the gateway uses Circle's x402 seller path with `BatchFacilitatorClient` and `GatewayEvmScheme`. When `CIRCLE_PRIVATE_KEY` is present, the agent uses `x402Client` with Circle's batch scheme to sign the gateway's `paymentRequired` terms.

## First Implementation Milestones

1. Replace the in-memory stores in `apps/gateway` with Postgres or SQLite.
2. Persist receipts and signed authorizations for auditability.
3. Add a service registry and discovery dashboard.
4. Add provider registration and auth beyond the development shared secret.
5. Add settlement reconciliation using Circle Gateway transfer history.

## Docs

See [docs/architecture.md](./docs/architecture.md) and [docs/protocol.md](./docs/protocol.md).
