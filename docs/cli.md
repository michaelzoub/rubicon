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
pnpm --filter @rubicon-caliga/cli dev -- buy --first --goal "<goal>" --max-usdc 0.10 --json
```

After publishing or linking, the binary is:

```bash
rubicon repository
```

For one-off use without installing Rubicon globally, npm users can run:

```bash
npx -y @rubicon-caliga/cli buy --first --goal "<goal>" --max-usdc 0.10 --json
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

Rubicon article metadata includes the Circle chain mapping when it is known.
For Arc Testnet articles (`paymentTerms.network: "eip155:5042002"`), the Circle
CLI chain is `ARC-TESTNET`. Fund with Circle's testnet faucet / Gateway testnet
funding flow; do not send mainnet fiat or crypto to satisfy an Arc Testnet read.

The CLI respects:

- `CIRCLE_CLI_PAYMENT`
- `CIRCLE_AGENT_WALLET_ADDRESS`
- `CIRCLE_CLI_CHAIN`
- `CIRCLE_CLI_COMMAND`
- `CIRCLE_API_KEY`
- `CIRCLE_ENTITY_SECRET`
- `CIRCLE_AGENT_WALLET_ID`

The CLI looks for `circle` first, then falls back to `circle-cli`, which is the
binary exposed by the npm `circle-cli` package. Set `CIRCLE_CLI_COMMAND` only
when a custom path is needed. The CLI never asks for, prints, stores, or infers
raw private keys.

## Autonomous Purchases

The primary buyer workflow is one command:

```bash
rubicon buy --first --goal "<exact goal>" --max-usdc 0.10 --json
rubicon buy --first --goal "<exact goal>" --max-usdc 0.10 --granularity 10 --json
```

It selects the first relevant live article, performs hidden wallet readiness
checks, consults the real seller agent for expected value, minimum useful word
counts, and alternatives, then ranks sections by expected information value per
paid word. Every paid session receives only the remaining cumulative budget.
The command reassesses after each section, avoids duplicate content, can switch
sections, reserves useful budget for conclusions/counterarguments/practical
details, and persists then reloads each receipt for verification.

JSON output includes structured decision events. `purchasedInformation` is paid
article text; `metadataInference` describes conclusions based only on public
metadata and seller routing. Successful internal checks are intentionally not a
multi-command user workflow.

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
notices. Human output also includes a recommended read command that starts at
the seller-recommended section:

```bash
rubicon read <article-id> --section <section-id> --stop-after-section --max-usdc <amount>
```

## Lower-Level Dry Runs

Dry runs remain available for protocol debugging and direct `read` callers.
They are not required before `rubicon buy`, which performs its budget and
wallet preflight internally before initiating payment:

```bash
rubicon read <article-id> --goal "find pricing" --max-usdc 0.10 --dry-run
rubicon read <article-id> --goal "find pricing" --max-usdc 0.10 --dry-run --json
```

Dry run fetches repository/article metadata and shows:

- article title, author, word count, price per word, max article price
- payment terms when present
- testnet/mainnet environment, Circle chain, and recommended funding method
- intended budget
- estimated maximum cost for the selected section, seller-recommended section,
  `--max-words` slice, or full article
- whether the requested budget covers that estimate
- whether live wallet balance was checked
- gateway URL
- payment mode

Dry run does not call `rubicon.read()` or `rubicon.run()` and does not spend
money.

## Paid Reads

Paid reads require an explicit budget:

```bash
rubicon read <article-id> --max-usdc 0.10
rubicon read <article-id> --max-usdc 0.10 --goal "find the pricing section"
rubicon read <article-id> --max-usdc 0.10 --section section-22 --stop-after-section
rubicon read <article-id> --max-usdc 0.10 --section section-22 --stream-mode bundled
rubicon read <article-id> --max-usdc 0.10 --section section-22 --chunk-words 32
rubicon read <article-id> --max-usdc 0.10 --section section-22 --per-word
rubicon read <article-id> --max-usdc 0.10 --granularity word
rubicon read <article-id> --max-usdc 0.10 --granularity 10
rubicon read <article-id> --section section-22 --max-usdc 0.10 --granularity section
rubicon read <article-id> --max-usdc 1.00 --granularity article
rubicon read <article-id> --max-usdc 0.10 --max-words 50
rubicon read <article-id> --max-atomic 100000
```

Use `--section` or `--section-id` to start at a known section id. The gateway
streams only that selected section, so the read naturally ends at the section
boundary. `--stop-after-section` documents that intent and requires either a
section flag or a goal that lets the seller agent recommend one.

Bundled reads are the default. The buyer authorizes a small word bundle, the
gateway releases those paid words together, and the receipt records one bundled
payment with the bundle sequence, word count, amount, per-word price, and text.
The bundle is clamped to the remaining budget, selected section/article bounds,
and `--max-words`. Use `--chunk-words` to choose the target bundle size; the
default is 32 words. `--fast` and `--mode batch` remain compatibility aliases for
batch-friendly reads. Use `--stream-mode word`, `--per-word`, or `--mode word`
when you explicitly want the old one-word authorization and `article.word`
events for debugging or strict metering.

`--granularity` is the unified buyer-facing control. It accepts `word`, any
positive word count, `section`, or `article`. Word/count modes pay and deliver
in the selected unit. Section/article modes use one payment for the complete
selected range and fail before payment if the explicit budget cannot cover it.
They cannot be mixed with `--max-words` or the legacy stream/chunk flags.

Without `--json`, words stream as they arrive. At the end, the CLI prints a
compact receipt summary with session id, article id, words read, amount paid,
stop reason, buyer/seller wallet details, network/Circle chain, settlement ids,
transaction hashes when present, and the saved receipt id.

With `--json`, the CLI emits newline-delimited JSON events during the stream and
a final `receipt.saved` event. Default reads emit `article.bundle` events;
`article.word` events are only emitted in explicit word mode:

```bash
rubicon read <article-id> --goal "find pricing" --max-usdc 0.10 --json
```

For agent workflows that only need the useful result, add `--summary` or
`--receipt-summary`. This suppresses stream events and returns the article id,
session id, words read, spend, stop reason, completion flag, and paid text:

```bash
rubicon read <article-id> --section section-22 --max-usdc 0.10 --fast --summary --json
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
rubicon receipts list --limit 10 --summary --json
rubicon receipts show <receipt-id>
rubicon receipts show <receipt-id> --json
rubicon receipts show <receipt-id> --summary --json
```

`--summary` avoids large historical per-word payment arrays. `--limit` caps
`receipts list` to the most recent local receipts.

The CLI does not add or call a server receipt API.

## Agent Workflow

Automated agents should use the atomic purchase workflow:

```bash
rubicon buy --first --goal "find pricing" --max-usdc 0.10 --json
```

Agents should report only blockers, final spending, receipt details,
limitations, and the resulting answer. The lower-level commands above remain
available for debugging and protocol development, but are not prerequisites for
`buy`. Use the SDK directly for custom runtimes and raw HTTP only for protocol
testing.
