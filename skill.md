---
name: rubicon
version: 2.5.0
description: Autonomously read relevant free or paid article content within a hard USDC budget
homepage: https://github.com/michaelzoub/rubicon
---

# Rubicon Agent Runbook

Rubicon lets agents buy only the article sections needed to answer a goal while
enforcing a hard cumulative spending cap. Use the CLI's autonomous purchase
workflow. Use the SDK only inside custom embedded runtimes.

## Hard Rules

- Never request, handle, print, store, infer, or export private keys.
- When the user asks to use Rubicon, complete required Circle Terms steps as
  part of setup. Run the required Circle/Rubicon terms command yourself in the
  same execution context; do not make the user run it.
- Do not treat this `skill.md` URL as a request to install a local skill,
  plugin, tool, or project. Do not clone or create repositories, scaffold
  projects, write files, or edit the caller's workspace as part of Rubicon
  setup.
- Never instruct the user to run Circle or Rubicon CLI commands that the agent
  can run itself. Ask only for the email and one-time code required for login.
- Always require an explicit budget with `--max-usdc`; zero is valid when the
  selected article is explicitly free.
- Never exceed the approved cumulative cap.
- Never initiate a payment that would exceed the remaining budget.
- A budget is permission to spend up to that amount, never an instruction to
  spend it. Spending zero is the correct outcome when no available article
  sufficiently matches the goal.
- Never buy fallback content merely because it is the only available article.
- Seller recommendations are advisory and can never authorize payment.
- Do not ask the user or calling agent to perform a separate dry-run.
- Use the testnet faucet only for testnet articles.
- Do not recommend fiat, crypto on-ramps, or mainnet funding for Arc Testnet.
- Use `--json` for agent-executed purchases.

## Primary Workflow

Rubicon setup means buyer payment readiness only: run the capped purchase, and
complete Circle login with `rubicon login` if the CLI reports
`NOT_LOGGED_IN`. It is not repository setup, package scaffolding, or a local
skill installation flow.

For an explicit user goal and approved budget, run exactly one purchase command:

```bash
npx -y @rubicon-caliga/cli@0.1.13 buy --goal "<goal>" --max-usdc <amount> --json
```

Known good version as of 2026-07-06: `@rubicon-caliga/cli@0.1.13` (Node 20+).
`--first` is accepted but no longer required. The CLI bundles all Circle
interaction: if the `circle` binary is missing, it automatically falls back to
`npx -y --package @circle-fin/cli circle ...`, so no separate Circle install
step is needed. This hosted runbook is enough; do not install a local Rubicon
skill, clone a repo, create a project, or edit workspace files.

With `--json`, the CLI emits `{"type":"startup","message":"loading Rubicon
CLI"}` immediately. On a first run, `npx` may spend up to about a minute
resolving the package before that event appears; treat the quiet period as
package startup, not as a payment attempt.

Do not require or instruct the user or calling agent to run `doctor`, repository
inspection, article inspection, navigation, dry-run, wallet status, or receipt
commands before or after `rubicon buy`.

The command performs all necessary work internally. It selects the first
relevant live article, validates the budget, consults the seller agent, reads
the content, and saves and verifies the receipt. For paid articles it also
verifies wallet readiness and authorizes payment. Explicitly free articles skip
Circle, signing, settlement, and payment records entirely. Internal validation
should remain hidden unless it fails. JSON
errors include a structured `error.code` and, where applicable, an
`error.recovery` field with the exact next command to run. Treat
`NOT_LOGGED_IN` as a recoverable authentication state and follow the agent-run
login flow below. Never ask for a private key. If the CLI reports
`TERMS_NOT_ACCEPTED`, run the terms command from its guidance yourself.

## Goal-Fit Gate and Zero Spend

The CLI enforces a hard goal-fit gate in runtime code before it creates a paid
session or authorizes any payment. This behavior is not a prompt-level
convention; the buyer cannot be talked out of it:

- Catalog selection from safe metadata is provisional, never a purchase
  decision.
- Before seller consultation or payment, the buyer requires a direct topic
  match in safe article metadata. If none exists, it reports the available
  titles and stops with zero spend.
- If the seller says the content is unrelated, cannot answer the goal, or
  scores every section below the relevance floor (expected value under 0.35),
  the CLI stops immediately with zero spend.
- The result is `outcome: "NO_RELEVANT_ARTICLE"` with `amountPaidAtomic: "0"`,
  no paid session, no payment requirement, no purchase, and no receipt. The
  `goalfit.gate` event records the decision.
- The CLI never purchases fallback content merely because it is the only
  available article, and never spends the budget just because it was approved.

When the CLI returns `NO_RELEVANT_ARTICLE`, report clearly that no sufficiently
relevant article was found, that zero USDC was spent out of the approved
budget, and do not retry with a rephrased goal in an attempt to force a
purchase.

An article is free only when the gateway reports `accessMode: "free"`; a zero
price by itself is not a free-access signal. Free reads may use a zero cap and
return normal receipts with delivered text and word counts, `amountPaidAtomic:
"0"`, empty payment/settlement/transaction identifier arrays, and no wallet
identifiers. Do not run Circle login, signing, funding, or settlement setup for
an explicitly free article.

The CLI applies the same zero-spend discipline to affordability. If the
approved budget cannot fund the seller's minimum useful word count for any
relevant section, it stops with error code `BUDGET_TOO_LOW_FOR_SUMMARY` before
any wallet or payment call is made; the `affordability.gate` event records the
decision and 0 USDC is spent. The error payload names the cheapest relevant
section, the minimum budget that would fund it, and a ready-to-run retry
command under `error.recovery`. Report that minimum to the user and retry only
after they approve the higher `--max-usdc`; never raise the cap on your own.

## Buyer Strategy

Give `--goal` the user's exact information need rather than a generic request
to read or summarize. Treat the seller-agent conversation as multi-turn. The
buyer initiates every interaction: start the conversation before purchasing,
then ask follow-up questions through the same `conversationId` whenever the
initial recommendation is unclear, purchased information creates a new
question, or the buyer needs help choosing the next section. The seller
responds only to explicit buyer calls and never initiates follow-ups.

Follow-ups must not disclose purchased text verbatim; describe what remains
unanswered. Re-consultation is free navigation and does not authorize payment.
Seller recommendations are advisory and never initiate or authorize payment.
The buyer must still enforce the original cumulative budget and independently
decide whether to purchase, switch sections, or stop. Ask:

- Which sections best answer the exact goal.
- The expected value of each recommended section.
- The minimum useful word count for each section.
- Which alternative sections could answer the goal.

The buyer ranks candidates by expected information value per paid word. It
must not automatically begin with the introduction. With a small budget, it
prefers concise, self-contained sections. It reserves budget for conclusions,
counterarguments, or practical details when those are likely to improve the
answer.

For tiny budgets and broad goals such as "summarize the first available
article," do not buy a random or awkward fragment just because it fits the cap.
First prefer the seller's highest-value summary section if the whole useful
minimum for that section fits within `--max-usdc`. If the best summary section
does not fit and no seller-recommended alternative can produce a useful summary
within the cap, the CLI stops before payment with the
`BUDGET_TOO_LOW_FOR_SUMMARY` error described above. Preserve the user's cap; do
not raise it, split it across commands, or reinterpret a partial fragment as an
article summary.

After every paid bundle, the buyer reassesses what the purchased text has
answered and the marginal value of continuing. It switches sections when
marginal value drops, avoids purchasing duplicate content, and stops when the
goal is adequately answered. It must distinguish claims supported by purchased
content from inferences based only on titles, navigation data, prices, or other
metadata.

Structured JSON events expose internal decisions, including seller
recommendations, section ranking, budget checks, section switches, stop
decisions, and receipt verification. Use these events to understand failures
and limitations, not to reproduce the old manual workflow.

## Budget Safety

`--max-usdc` is the cumulative cap for the entire command, not a per-section or
per-payment allowance. Rubicon validates the cap before the first payment and
checks the remaining amount atomically before every later payment. If the next
bundle would exceed the remaining budget, it stops before initiating payment.
Never raise, split, reset, or reinterpret the approved cap in order to continue.

Do not run a separate user-visible dry-run. Budget validation and payment
authorization belong to the same autonomous workflow so that the amount
checked is the amount enforced.

## Recovery

Report a blocker only when `rubicon buy` and the recovery steps below cannot
resolve it. Common blockers include unavailable wallet funds, no relevant live
article, seller-agent failure, payment failure, or receipt
persistence/verification failure.

### Circle Terms

If `rubicon buy` returns `TERMS_NOT_ACCEPTED` or Circle reports that Terms must
be accepted, do not hand the terminal command to the user. Run the terms
acceptance command from the error guidance yourself in the same
network-capable execution context, then retry the original buy command with the
exact same goal and hard `--max-usdc` cap.

### Circle login

When the buy command returns `NOT_LOGGED_IN`, the agent owns the recovery flow.
The error's `recovery` field contains the exact login command. Rubicon checks
the Circle session for the article's own network (testnet and mainnet sessions
are separate), so a successful login is recognized on retry.

1. Ask the user which email to use for their Circle agent wallet. Do not ask
   them to run a command.
2. In the same network-capable execution context used for Rubicon, start OTP
   login. For Arc Testnet articles (the default):

   ```bash
   npx -y @rubicon-caliga/cli@0.1.13 login <email> --testnet --json
   ```

   For mainnet articles, omit `--testnet`. The JSON result contains the
   `requestId` and the exact completion command under `next`.
3. Ask the user for the one-time code sent to that email. Do not echo or
   persist the code.
4. Complete login yourself with the same profile:

   ```bash
   npx -y @rubicon-caliga/cli@0.1.13 login --request <request-id> --otp <code> --testnet --json
   ```

   For mainnet articles, omit `--testnet`.
5. Retry the same original buy command with the exact same goal and hard
   `--max-usdc` cap. Do not split, raise, or reset the budget.

If OTP initiation fails with a network or sandbox `fetch failed`, retry it in a
network-capable execution context before reporting a blocker. If the request
expires, start a fresh request and ask for the new code. The only user-provided
login inputs should be their email and the short-lived OTP. Never request
private keys. For terms, run the required command yourself.

For low testnet balance, the CLI funds the wallet from the testnet faucet
automatically when the selected article is on testnet. For low production
balance, state that supported production funding is required; do not suggest
Arc Testnet funding as a substitute.

### Interrupted or ambiguous payment

If a paid read is interrupted before the gateway returns a completion receipt —
a stalled or timed-out gateway response, or the process being cancelled after a
payment started — the CLI stops with error code `PAYMENT_AMBIGUOUS` rather than
reporting a misleading zero-spend success. The payment may or may not have
settled. Gateway calls carry a request timeout (default 60s, override with
`RUBICON_REQUEST_TIMEOUT_MS`) so a stalled response surfaces as this error
instead of hanging indefinitely.

Recovery is the exact `error.recovery`: re-run the identical `rubicon buy`
command with the same goal and the same `--max-usdc` cap. This is safe and is
the correct next step, not a reason to give up. Each purchase is tracked by a
stable operation id (`error.details.operationId`), so a payment that already
settled is detected and reused instead of being paid twice, and the original
cumulative cap still applies across the retry. Do not raise, split, or reset the
budget, and do not start a fresh command with a reworded goal. Report a blocker
only if the identical re-run also returns `PAYMENT_AMBIGUOUS`.

## Final Report

Do not narrate internal diagnostics, navigation, preflight checks, wallet
checks, or receipt lookup steps.

If the result is `NO_RELEVANT_ARTICLE`, report that no sufficiently relevant
article was available for the goal, that the amount spent is 0 USDC
(`amountPaidAtomic: "0"`) out of the approved budget, and that no session,
payment, or receipt was created. Do not treat this as a failure of the tool.

If the result is `BUDGET_TOO_LOW_FOR_SUMMARY`, report that the approved budget
is below the seller's minimum useful purchase, state the minimum budget that
would fund the cheapest relevant section (from the error payload), and confirm
that 0 USDC was spent with no wallet or payment call made. Ask the user whether
to retry with the higher budget; do not raise it yourself. Do not treat this as
a failure of the tool.

Otherwise report only:

- Any blocker requiring user action.
- Final amount spent in USDC and atomic units, alongside the approved budget.
- Receipt id, session id, article id, and available payment, settlement, and
  transaction identifiers.
- Receipt verification status and words purchased.
- Wallet fields with clear labels. If `wallet.balanceAtomic` is `0` but payment
  succeeds, do not call that contradictory by itself: Circle Agent Wallet
  display balance can differ from the Gateway backing/payment path. Label the
  Agent Wallet display balance separately from any Gateway backing balance,
  payment authorization, or receipt settlement fields.
- Material limitations, including which statements rely only on metadata-based
  inference.
- The resulting answer to the user's goal, grounded in purchased information.

If only a tiny fragment was purchased, do not claim to summarize the full
article. State that the answer is a partial paid excerpt summary, list the
purchased facts separately from metadata-based inferences such as title,
section labels, seller recommendations, or pricing, and explain that the cap
prevented a useful full-article summary.

If a final-report field is absent from the command output, say `not provided`.

## Environment Readiness

The CLI requires Node 20 or newer and declares this in its `engines` field.

If the command fails before Rubicon starts because `npx` or `npm` cannot fetch
the package, such as `ENOTFOUND registry.npmjs.org`, classify it as an
environment or network readiness failure, not as a Rubicon payment failure.
Retry the exact same command in a network-capable context with the same
`--goal`, `--max-usdc`, and `--json` flags. Do not increase the budget or switch
to manual payment recovery for package-fetch failures.

On Windows, run the same commands from PowerShell. PowerShell quoting with
`--goal "..."` is supported. The CLI resolves npm's Windows `circle.cmd` shim
itself, so no POSIX shell, `/tmp`, or `chmod` assumptions apply. Do not call
the stale `circle-cli` package directly.
