# Rubicon x402 Article Streaming

Rubicon is a streaming service for agents that need paid article content. Agents open a budgeted stream, receive words in chunks, and send x402 micropayments as they read. They can stop any time once they have enough information.

The repo is intentionally small:

- `apps/gateway`: Fastify x402 streaming endpoint. It owns article lookup, author wallet resolution, word streaming, usage accounting, and SSE events.
- `packages/agent-sdk`: client SDK for autonomous agents consuming article streams.
- `packages/core`: shared protocol types, pricing math, and session primitives.
- `examples/agent-client`: local agent that reads an article stream.

There is no provider SDK. Rubicon's server is the seller-side endpoint.

## Circle Alignment

Circle Gateway nanopayments use x402 with `402 Payment Required`, buyer-signed EIP-3009 authorizations, and batched Circle settlement. Buyer integrations use `@circle-fin/x402-batching/client`; the Rubicon streaming endpoint uses `@circle-fin/x402-batching/server` with `BatchFacilitatorClient` and `GatewayEvmScheme`.

The gateway exposes `GET /v1/endpoints` for route discovery and `GET /v1/repository` for the configured article repository. `GET /v1/articles` is kept as a compatibility alias.

## Quick Start

Development mode uses a static payment shim when Circle seller credentials are not set:

```bash
pnpm install
cp .env.example .env
pnpm dev:gateway
```

In another terminal:

```bash
pnpm dev:agent
```

The demo gateway exposes one in-memory article. Configure `DEMO_ARTICLE_*`, `PRICE_PER_WORD_ATOMIC`, `PAYMENT_CHUNK_WORDS`, and `AUTHOR_WALLET_REGISTRY` in `.env`. Author registry entries use `author_username:arc_wallet_address`; the stream pays the wallet for the article's resolved author.

## Real x402 Nanopayment Test

To charge real Gateway USDC for streamed words:

1. Fund the buyer wallet's Circle Gateway balance on the configured chain.
2. Set `CIRCLE_PRIVATE_KEY` for the buyer agent.
3. Set `AUTHOR_WALLET_REGISTRY` with an entry for every article author, for example `rubicon-demo:0x...`.
4. Set `CIRCLE_FACILITATOR_URL=https://gateway-api-testnet.circle.com` for testnet.
5. Set `PRICE_PER_WORD_ATOMIC=1` to charge `0.000001 USDC` per streamed word before gateway fees.

Then run:

```bash
pnpm dev:gateway
pnpm dev:agent
```

When `AUTHOR_WALLET_REGISTRY` contains the article author's wallet, the gateway uses Circle's x402 seller path and sets `payTo` from that author record. When `CIRCLE_PRIVATE_KEY` is present, the agent uses Circle's batch scheme to sign the gateway's `paymentRequired` terms. Each payment request is verified and settled before the next word chunk is emitted.

## First Implementation Milestones

1. Replace the in-memory article and author registry with Postgres or SQLite.
2. Persist receipts and signed authorizations for auditability.
3. Add article search and discovery.
4. Add creator onboarding and wallet verification.
5. Add settlement reconciliation using Circle Gateway transfer history.

## Docs

See [docs/architecture.md](./docs/architecture.md) and [docs/protocol.md](./docs/protocol.md).
