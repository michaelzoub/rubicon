# Plan 002: Put characterization tests on the untested core money math

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cda7cef..HEAD -- packages/core/src/money.ts packages/core/src/pricing.ts`
> If either file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (001 recommended first so CI runs these)
- **Category**: tests
- **Planned at**: commit `cda7cef`, 2026-07-07

## Why this matters

`packages/core` is the package every payment computation flows through — USDC atomic-unit parsing, per-word quotes, fee math — and it has **zero tests** (`pnpm --filter @rubicon-caliga/core test` reports `# tests 0`). A rounding or unit-conversion regression here silently mis-charges every buyer on every word. These are characterization tests: they pin today's exact behavior (including its quirks) so the settlement refactors in plans 005–007 have a floor to stand on.

## Current state

- `packages/core/src/money.ts` — the entire file (19 lines):

```ts
export const USDC_ATOMIC_UNITS = 1_000_000n;

export type AtomicAmount = `${bigint}`;

export function parseUsdcToAtomic(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  const paddedFraction = `${fraction}000000`.slice(0, 6);
  return BigInt(whole) * USDC_ATOMIC_UNITS + BigInt(paddedFraction);
}

export function formatAtomicUsdc(amount: bigint): string {
  const whole = amount / USDC_ATOMIC_UNITS;
  const fraction = `${amount % USDC_ATOMIC_UNITS}`.padStart(6, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
}

export function addBasisPoints(amount: bigint, basisPoints: number): bigint {
  return amount + (amount * BigInt(basisPoints)) / 10_000n;
}
```

- `packages/core/src/pricing.ts` — key functions (see the file for the full 67 lines):
  - `quotePerWord({ pricePerWordAtomic, gatewayFeeBps? })` → `WordPriceQuote` where `wordPaymentAtomic = addBasisPoints(pricePerWordAtomic, gatewayFeeBps)` (fee defaults to 0), all amounts serialized as `` `${bigint}` `` strings.
  - `usageForWords({ wordsDelivered, pricePerWordAtomic, gatewayFeeBps? })` → `WordUsageReport` where `creatorAmountAtomic = pricePerWordAtomic * wordsDelivered`, `totalPaidAtomic = addBasisPoints(creatorAmount, feeBps)`, `rubiconFeeAtomic = total - creatorAmount`.
- Behavior quirks to PIN, not fix (they are current production behavior):
  - `parseUsdcToAtomic` silently **truncates** past 6 decimals: for `"0.0000009"` the fraction `"0000009"` is padded then `slice(0, 6)` keeps `"000000"`, so the result is `0n`. Assert that.
  - `parseUsdcToAtomic("")` → `0n` (whole defaults `"0"`).
  - `parseUsdcToAtomic` throws on non-numeric input (e.g. `"abc"`) because `BigInt("abc")` throws — assert it throws, don't assert the message.
  - `addBasisPoints` uses integer division: `addBasisPoints(1n, 50)` → `1n` (the 0.5% of 1 truncates to 0). Fee can round to zero on tiny amounts.
  - `formatAtomicUsdc` strips trailing zeros: `1_500_000n` → `"1.5"`; `1_000_000n` → `"1"`; `1n` → `"0.000001"`.
- Conventions: tests use Node's built-in runner, `import { test } from "node:test"` + `import assert from "node:assert/strict"`. Exemplar: `apps/gateway/src/payments/x402-circle.test.ts:1-33`. Core's `test` script runs **compiled** tests: `node --test dist/**/*.test.js`, so tests live in `packages/core/src/*.test.ts` and require `pnpm --filter @rubicon-caliga/core build` before running.

## Commands you will need

| Purpose   | Command                                        | Expected on success |
|-----------|------------------------------------------------|---------------------|
| Build core | `pnpm --filter @rubicon-caliga/core build`    | exit 0              |
| Test core  | `pnpm --filter @rubicon-caliga/core test`     | exit 0, N tests > 0 |
| Typecheck  | `pnpm --filter @rubicon-caliga/core typecheck` | exit 0             |
| Full suite | `pnpm build && pnpm test`                     | exit 0, 135 + new   |

## Scope

**In scope** (the only files you should create/modify):
- `packages/core/src/money.test.ts` (create)
- `packages/core/src/pricing.test.ts` (create)

**Out of scope** (do NOT touch):
- `packages/core/src/money.ts`, `pricing.ts` — this plan pins behavior; it does not change it. If a test reveals behavior you believe is a bug, record it in your report — do not fix it here.
- `packages/core/src/protocol.ts`, `contract.ts`, `session.ts`, `networks.ts` — worthwhile later, but keep this plan small and money-focused.
- `packages/core/package.json` — the test script already globs `dist/**/*.test.js`.

## Git workflow

- Branch: `advisor/002-core-pricing-tests`
- Commit style: `test(core): characterize money and pricing math`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: `money.test.ts`

Cover, at minimum (table-driven where natural):

- `parseUsdcToAtomic`: `"1"` → `1_000_000n`; `"0.1"` → `100_000n`; `"0.000001"` → `1n`; `"0.0000009"` → `0n` (truncation quirk); `"1.5"` → `1_500_000n`; `"0"` → `0n`; `""` → `0n`; `"10.123456"` → `10_123_456n`; `"abc"` → throws.
- `formatAtomicUsdc`: `1_000_000n` → `"1"`; `1_500_000n` → `"1.5"`; `1n` → `"0.000001"`; `0n` → `"0"`; `10_123_456n` → `"10.123456"`.
- Round-trip: for `["1","0.5","0.000001","123.456789"]`, `formatAtomicUsdc(parseUsdcToAtomic(v))` equals the 6-decimal-truncated canonical form of `v`.
- `addBasisPoints`: `(1_000_000n, 0)` → `1_000_000n`; `(1_000_000n, 100)` → `1_010_000n` (1%); `(1n, 50)` → `1n` (truncation quirk); `(0n, 500)` → `0n`.

**Verify**: `pnpm --filter @rubicon-caliga/core build && pnpm --filter @rubicon-caliga/core test` → exit 0, all money tests pass.

### Step 2: `pricing.test.ts`

Cover:

- `quotePerWord`: fee 0 ⇒ `wordPaymentAtomic === pricePerWordAtomic` (as strings); fee 100 bps on `1_000_000n` ⇒ `"1010000"`; returned object has `currency: "USDC"`, `meteringUnit: "word"`, and `gatewayFeeBps` echoed; fee omitted defaults to 0.
- `usageForWords`: the **conservation invariant** `BigInt(creatorAmountAtomic) + BigInt(rubiconFeeAtomic) === BigInt(totalPaidAtomic)` for a grid of `wordsDelivered ∈ {0, 1, 32, 1000}` × `pricePerWordAtomic ∈ {1n, 5n, 1_000_000n}` × `gatewayFeeBps ∈ {0, 1, 100, 9999}`.
- `usageForWords` with `wordsDelivered: 0` ⇒ all three amounts `"0"`.
- Fee-rounds-to-zero quirk: `usageForWords({ wordsDelivered: 1, pricePerWordAtomic: 1n, gatewayFeeBps: 100 })` ⇒ `rubiconFeeAtomic === "0"` (1% of 1 atomic unit truncates).
- Consistency with the quote: for fee 0, `BigInt(quotePerWord(...).wordPaymentAtomic) * BigInt(n) === BigInt(usageForWords({wordsDelivered: n, ...}).totalPaidAtomic)`. For nonzero fee this can diverge by truncation — assert the *actual* current relation for one concrete case (compute it, then pin it) and add a comment that per-word-quote×N vs usage-of-N may differ by rounding; that divergence is exactly what plans 005/006 must not make worse.

**Verify**: `pnpm --filter @rubicon-caliga/core build && pnpm --filter @rubicon-caliga/core test` → exit 0; `# tests` ≥ 20.

### Step 3: Full-repo regression

**Verify**: `pnpm build && pnpm test` → exit 0, previous 135 tests plus the new core tests all pass.

## Test plan

This plan **is** the test plan; the two files above are the deliverable. Model structure on `apps/gateway/src/payments/x402-circle.test.ts` (plain `test(...)` blocks, `assert/strict`, no describe nesting, comments only where a pinned quirk needs explaining).

## Done criteria

- [ ] `packages/core/src/money.test.ts` and `pricing.test.ts` exist
- [ ] `pnpm --filter @rubicon-caliga/core test` reports ≥ 20 passing tests, 0 failing
- [ ] The conservation invariant test (creator + fee = total) exists and passes
- [ ] The truncation quirks (6-decimal parse truncation; fee-rounds-to-zero) are each pinned by a named test
- [ ] `pnpm build && pnpm test` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any test you write **fails** against current behavior — that means either your expectation or the code is wrong; report the discrepancy with the actual output instead of "fixing" either side.
- `money.ts`/`pricing.ts` differ from the excerpts above (drift).
- The `dist/**/*.test.js` glob does not pick up your compiled tests (test count stays 0 after build) after one fix attempt.

## Maintenance notes

- Plans 005–007 change settlement accounting; if any of them needs different fee/rounding behavior, these tests must be **consciously updated** in the same PR, never deleted to make a suite green.
- Follow-up deferred: characterization tests for `protocol.ts` encode/decode shapes and `session.ts` state transitions.
