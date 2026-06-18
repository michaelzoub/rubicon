# Rubicon CLI

`@rubicon-caliga/cli` gives terminal-native agents a thin command wrapper around
`@rubicon-caliga/agent-sdk`. The CLI does not implement creator dashboard APIs,
does not redesign the protocol, and does not send raw gateway requests for
normal buyer-agent flows.

## Build

```bash
pnpm install
pnpm --filter @rubicon-caliga/cli build
```

During local development:

```bash
pnpm dev:cli -- repository --json
pnpm --filter @rubicon-caliga/cli dev -- read <article-id> --max-usdc 0.10 --dry-run
```

After publishing or linking, the binary is:

```bash
rubicon repository
```

## Configuration

The hosted gateway is the default:

```text
https://rubicon-caligagateway-production.up.railway.app
```

Override it with, in precedence order:

1. `--gateway-url <url>`
2. `RUBICON_GATEWAY_URL`
3. `~/.rubicon/config.json`
4. the hosted default

Set local config:

```bash
rubicon config set gateway-url https://rubicon-caligagateway-production.up.railway.app
rubicon config set api-key <key>
rubicon config show
```

API keys are sent to the SDK as:

```ts
authorization: apiKey ? `Bearer ${apiKey}` : undefined
```

The config file is written to `~/.rubicon/config.json` with user-only file
permissions.

## Payment Modes

Static dev mode works with local/dev gateways that accept the SDK's
`StaticPaymentEngine`:

```bash
rubicon read <article-id> --gateway-url http://localhost:8787 --payment-mode static --max-usdc 0.10 --dry-run
```

Circle CLI mode is preferred for hosted/real reads:

```bash
export CIRCLE_CLI_PAYMENT=1
export CIRCLE_AGENT_WALLET_ADDRESS=0x...
export CIRCLE_CLI_CHAIN=ARC-TESTNET
rubicon read <article-id> --payment-mode circle-cli --max-usdc 0.10 --dry-run
rubicon read <article-id> --payment-mode circle-cli --max-usdc 0.10
```

The CLI respects:

- `CIRCLE_CLI_PAYMENT`
- `CIRCLE_AGENT_WALLET_ADDRESS`
- `CIRCLE_CLI_CHAIN`
- `CIRCLE_API_KEY`
- `CIRCLE_ENTITY_SECRET`
- `CIRCLE_AGENT_WALLET_ID`

The CLI never asks for, prints, stores, or infers raw private keys.

## Repository And Search

```bash
rubicon repository
rubicon repository --json
rubicon search "agent economies"
rubicon search "agent economies" --json
```

Search fetches the public repository through `RubiconClient.getRepository()` and
filters safe metadata only: article id, title, author, creator username, section
ids, and section headings. It does not search unpaid article body content.

## Article Metadata

```bash
rubicon article show <article-id>
rubicon article show <article-id> --json
rubicon article navigation <article-id> --goal "find pricing"
rubicon article navigation <article-id> --goal "find pricing" --json
```

Navigation uses `RubiconClient.getNavigation(articleId, goal)` and prints safe
routing metadata, section headings, rationale, safe hints, and withheld content
notices.

## Dry Runs

Always dry-run before spending:

```bash
rubicon read <article-id> --goal "find pricing" --max-usdc 0.10 --dry-run
rubicon read <article-id> --goal "find pricing" --max-usdc 0.10 --dry-run --json
```

Dry run fetches repository/article metadata and shows:

- article title, author, word count, price per word, max article price
- payment terms when present
- intended budget
- gateway URL
- payment mode

Dry run does not call `rubicon.read()` or `rubicon.run()` and does not spend
money.

## Paid Reads

Paid reads require an explicit budget:

```bash
rubicon read <article-id> --max-usdc 0.10
rubicon read <article-id> --max-usdc 0.10 --goal "find the pricing section"
rubicon read <article-id> --max-usdc 0.10 --max-words 50
rubicon read <article-id> --max-atomic 100000
```

Without `--json`, words stream as they arrive. At the end, the CLI prints a
compact receipt summary with session id, article id, words read, amount paid,
stop reason, settlement ids, and transaction hashes when present.

With `--json`, the CLI emits newline-delimited JSON events during the stream and
a final `receipt.saved` event:

```bash
rubicon read <article-id> --goal "find pricing" --max-usdc 0.10 --json
```

Example JSON metadata response:

```json
{
  "success": true,
  "article": {
    "articleId": "article_123",
    "title": "Example",
    "author": "creator",
    "totalWords": 1200,
    "pricePerWordAtomic": "100",
    "maxArticlePriceAtomic": "120000"
  }
}
```

Example JSON error:

```json
{
  "success": false,
  "error": {
    "code": "MISSING_BUDGET",
    "message": "rubicon read requires --max-usdc or --max-atomic."
  }
}
```

## Receipts

Final CLI receipts are stored locally only:

```text
~/.rubicon/receipts/<receipt-id>.json
```

Use:

```bash
rubicon receipts list
rubicon receipts list --json
rubicon receipts show <receipt-id>
rubicon receipts show <receipt-id> --json
```

The CLI does not add or call a server receipt API.

## Agent Workflow

Automated agents should prefer JSON and explicit budgets:

```bash
rubicon config set gateway-url https://rubicon-caligagateway-production.up.railway.app
rubicon repository --json
rubicon search "agent economies" --json
rubicon article show <article-id> --json
rubicon article navigation <article-id> --goal "find pricing" --json
rubicon read <article-id> --goal "find pricing" --max-usdc 0.10 --dry-run --json
rubicon read <article-id> --goal "find pricing" --max-usdc 0.10 --json
rubicon receipts list --json
rubicon receipts show <receipt-id> --json
```

Use the SDK directly for custom agent runtimes or deeper integrations. Use raw
HTTP only when testing the protocol itself.
