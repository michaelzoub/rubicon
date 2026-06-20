---
name: rubicon
version: 1.1.0
description: Autonomously buy goal-relevant article content with a hard USDC cap
homepage: https://github.com/michaelzoub/rubicon
---

# Rubicon Agent Runbook

Rubicon lets agents buy the useful parts of a paid article under one atomic,
cumulative budget. Use the CLI first and the SDK only in embedded runtimes.

## Hard Rules

- Never request, handle, print, store, infer, or export private keys.
- Never accept Circle Terms on the user's behalf.
- Always require an explicit `--max-usdc` or `--max-atomic` budget.
- Never exceed the approved cumulative cap.
- Use the testnet faucet only for testnet articles.
- Do not recommend fiat, crypto on-ramp, or mainnet funding for Arc Testnet.
- Prefer `--json` for agent-executed commands.

## Primary Workflow

Run exactly one command:

```bash
rubicon buy --first --goal "<exact goal>" --max-usdc <amount> --json
```

`buy` internally verifies wallet readiness, chooses the first relevant live
article, consults its seller agent, ranks sections by expected information value
per paid word, purchases under the shrinking cumulative cap, reassesses after
each section, and saves and verifies every receipt. It may switch sections or
stop early once the goal is adequately answered. Do not separately run
`doctor`, repository/article/navigation inspection, wallet status, dry-run, or
receipt commands before or after a normal purchase.

The JSON result distinguishes `purchasedInformation` from
`metadataInference`. Internal decisions are emitted as structured events.

## Blockers

If `buy` reports missing Circle authentication, use only the supported agent
wallet login flow. Never ask for private keys and never accept legal terms for
the user. A low non-testnet balance requires the wallet controller to fund it
through supported production funding. A low testnet balance may be handled by
the command's internal testnet faucet flow.

## Final Report

Report only:

- blockers, if the command failed;
- final USDC spending and approved budget;
- receipt ids and available settlement/payment/transaction details;
- limitations, including partial reads or metadata-only inferences;
- the answer derived from `purchasedInformation`.

Do not narrate internal diagnostics, navigation, wallet checks, preflight, or
receipt verification when they succeed.
