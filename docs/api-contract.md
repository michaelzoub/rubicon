# Shared API Contract (Rubicon ↔ rubicon-marketing)

Rubicon and [rubicon-marketing](https://github.com/michaelzoub/rubicon-marketing)
integrate through a **shared persistent data model** and a set of shared
TypeScript types. The two repositories must agree on the database schema, article
states, pricing units, word-counting rules, wallet format, creator ownership,
revision behavior, and seller-agent configuration.

## Shared TypeScript types

Import the contract from `@rubicon-caliga/core`:

```ts
import type {
  Creator,
  CreatorProfile,
  CreatorWallet,
  Article,
  ArticleSection,
  ArticleState,
  SellerAgentConfig,
  EarningsSummary,
  PaymentActivity,
  SellerAgentMessageRecord,
  StreamSessionRecord,
  WordDeliveryRecord,
  ApiError,
} from "@rubicon-caliga/core";
```

These mirror the tables in `apps/gateway/migrations/0001_init.sql`, the schema
shared by both apps.

## Agreed rules

- **Article states**: `draft | live | paused | archived | deleted`. Only `live`
  articles are consumable by buyer agents or visible in the public repository.
- **Pricing units**: atomic USDC, `1 USDC = 1_000_000`, stored as exact strings.
- **Payment granularity**: one delivered word remains the billing unit. Payment
  authorization is session-level by default and chunk-level as a fallback; each
  delivered word still has durable `PaymentActivity` / `settlement_receipts`
  accounting with network, destination, settlement id or transaction hash(es),
  and amount.
- **Word counting**: a word is a maximal run of non-whitespace characters
  (`content.trim().split(/\s+/)`). `articles.total_words` uses this rule.
- **Wallet format**: `0x`-prefixed address plus a CAIP-2 `network` string. Only
  `verified` wallets may receive settlement.
- **Creator ownership**: every article belongs to one creator; every published
  article resolves to that creator's verified wallet.
- **Seller-agent configuration**: optional per-article `SellerAgentConfig`
  (`persona`, `model`, `guidance`).

## Ownership boundary

- rubicon-marketing owns creator authentication and creator-facing CRUD
  (creators, profiles, wallets, articles, revisions, sections). It is the writer
  of published content.
- Rubicon owns the runtime buyer-agent API and writes runtime activity
  (`stream_sessions`, `seller_agent_messages`, `word_deliveries`,
  `word_payments`, `settlement_receipts`).

Rubicon never implements the creator dashboard API and never trusts
buyer-supplied article price, creator wallet, creator identity, ownership, word
sequence, amount owed, or settlement recipient — all are loaded from storage.

## Public buyer-agent API: base URL and auth

- **Base URL**: configure via `GATEWAY_BASE_URL` (server) and the SDK
  `RubiconClient({ baseUrl })`. Default `http://localhost:8787`.
- **Buyer endpoints** under `/v1/*` are public and x402-gated — payment, not an
  API key, authorizes word delivery.
- **Optional authorization header**: the SDK accepts an `authorization` option
  (sent as the `Authorization` header) for deployments that front the gateway
  with an additional gateway/edge auth layer. It is not required by the core
  protocol.

## Dashboard data

The marketing dashboard reads earnings and read activity directly from the shared
tables (`word_payments`, `word_deliveries`, `settlement_receipts`,
`stream_sessions`) — for example via `LedgerRepository.earningsForCreator` /
`earningsForArticle`, which sum the exact words delivered. Creators earn the full
per-word subtotal; the Rubicon fee is always zero.

For granular audit views, `word_payments` and `settlement_receipts` include
`network`, `pay_to`, `settlement_id`, `settlement_ids`, `transaction_hash`,
`transaction_hashes`, and legacy `transfer_id`. Prefer settlement ids when the
Circle Gateway path returns UUID-style transfer identifiers instead of visible
on-chain hashes.
