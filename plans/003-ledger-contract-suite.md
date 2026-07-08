# Plan 003: One ledger contract test suite, run against both the in-memory and Postgres implementations

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cda7cef..HEAD -- apps/gateway/src/repositories/ apps/gateway/migrations/ apps/gateway/package.json .github/workflows/ci.yml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: LOW (code) / MED (CI infra — adds a DB to the pipeline)
- **Depends on**: plans/001-ci-verification-baseline.md
- **Category**: tests
- **Planned at**: commit `cda7cef`, 2026-07-07

## Why this matters

The gateway has two full, independent implementations of the same 22-method `LedgerRepository` interface: `apps/gateway/src/repositories/in-memory.ts` (359 lines) and `apps/gateway/src/repositories/postgres.ts` (854 lines). Production (any deploy with `DATABASE_URL` set — i.e. Railway) uses Postgres; **every existing test uses the in-memory one** (`apps/gateway/src/gateway.test.ts:56` instantiates `InMemoryLedgerRepository`; the only "postgres" tests, `gateway.test.ts` around lines 876–934, cover URL-parsing helpers, never a query). The SQL that actually debits buyers, enforces idempotency, and computes creator earnings has zero test coverage, and the two implementations can silently diverge. One shared contract suite run against both closes that gap and is the prerequisite for the concurrency work in plan 006.

## Current state

- Interface: `apps/gateway/src/repositories/types.ts:98-139` — `LedgerRepository` with sessions (`createSession`/`getSession`/`saveSession`), conversations, `getDeliveryByIdempotencyKey`, `recordWordDelivery`, `recordFreeWordDelivery`, `listDeliveries`, `listPayments`, `earningsForArticle`, `earningsForCreator`, optional `updatePaymentSettlement`.
- Key semantics the suite must pin (from `postgres.ts`):
  - `recordWordDelivery` (`postgres.ts:524-608`): one transaction inserting `word_payments` (with `ON CONFLICT (idempotency_key) DO NOTHING`), `word_deliveries`, `settlement_receipts`. On conflict it rolls back and returns the existing record via `getDeliveryByIdempotencyKey` with `duplicate: true`.
  - `updatePaymentSettlement` (`postgres.ts:688-749`): keyed by `(session_id, sequence)`, uses `COALESCE` so a later partial backfill never clobbers already-set fields; also updates `settlement_receipts` by `payment_id`.
  - `saveSession` (`postgres.ts:371-387`): last-write-wins `UPDATE` of state/words/paid/metadata (plan 006 will change this — your suite should cover the *current* semantics; plan 006 updates the suite).
  - `listPayments`/`listDeliveries` (`postgres.ts:751-809`): ordered by `sequence`; `settlementId` falls back `settlement_id ?? transfer_id ?? transaction_hash`.
  - `recordFreeWordDelivery` (`postgres.ts:643-686`): `ON CONFLICT DO NOTHING`, duplicate resolution first by idempotency key, then by `(session_id, sequence)`.
- Migrations: append-only SQL files under `apps/gateway/migrations/`, applied by `runMigrations(pool)` exported from `postgres.ts` (also runnable via `pnpm --filter @rubicon-caliga/gateway migrate`, entry `apps/gateway/src/migrate.ts`).
- Gateway test conventions: `node:test` + `assert/strict`, tests compiled to dist. Gateway's test script is `node --test dist/gateway.test.js dist/payments/*.test.js` — **it enumerates files explicitly**, so a new test file must be added to that script.
- Session fixtures: see how `gateway.test.ts:69-75` creates sessions via HTTP; for the contract suite construct `SessionRecord` objects directly (shape: `apps/gateway/src/repositories/postgres.ts:347-368` shows every field the DB round-trips).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build gateway | `pnpm --filter @rubicon-caliga/gateway build` | exit 0 |
| Test gateway | `pnpm --filter @rubicon-caliga/gateway test` | exit 0 |
| Local throwaway Postgres | `docker run --rm -d --name rubicon-test-pg -e POSTGRES_PASSWORD=postgres -p 54329:5432 postgres:16` | container id |
| Run suite against it | `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:54329/postgres pnpm --filter @rubicon-caliga/gateway test` | exit 0, postgres variant not skipped |
| Cleanup | `docker rm -f rubicon-test-pg` | removed |

## Scope

**In scope** (create/modify only these):
- `apps/gateway/src/repositories/ledger-contract.test.ts` (create)
- `apps/gateway/package.json` (add the new test file to the `test` script)
- `.github/workflows/ci.yml` (add a `postgres:16` service and `TEST_DATABASE_URL` env — only if plan 001 has landed; otherwise note it in your report)

**Out of scope** (do NOT touch):
- `postgres.ts`, `in-memory.ts`, `types.ts` — if the suite exposes a divergence between the two implementations, **report it, don't fix it** (that divergence is exactly the signal this plan exists to produce).
- `apps/gateway/migrations/` — read-only; never edit an existing migration.
- `supabase.ts` — it implements `PublishedArticleRepository`, not the ledger.

## Git workflow

- Branch: `advisor/003-ledger-contract-suite`
- Commit style: `test(gateway): ledger contract suite over in-memory and postgres`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Suite skeleton with dual registration

In `ledger-contract.test.ts`, write a function `registerLedgerContractTests(name: string, makeLedger: () => Promise<{ ledger: LedgerRepository; close?: () => Promise<void> }>)` that registers every contract test under a `test(\`${name}: …\`)` title. Register it twice:

1. `registerLedgerContractTests("in-memory", async () => ({ ledger: new InMemoryLedgerRepository() }))` — always runs.
2. Postgres variant, only when `process.env.TEST_DATABASE_URL` is set; otherwise register a single skipped test (`test("postgres: contract suite", { skip: "TEST_DATABASE_URL not set" }, …)`) so the skip is visible in output. For the live variant: `createPgPool(TEST_DATABASE_URL)`, `await runMigrations(pool)`, and give each test run a unique session/article id prefix (`randomUUID()`) so reruns don't collide; `close` ends the pool.

**Verify**: `pnpm --filter @rubicon-caliga/gateway build && pnpm --filter @rubicon-caliga/gateway test` → in-memory variant runs, postgres variant reports skipped.

### Step 2: Contract cases

Implement these named cases (each must pass against both implementations):

1. **Session round-trip**: `createSession` → `getSession` returns an equal record (fields per `postgres.ts:347-368`, including `budget.maxAmountAtomic`, `pricePerWordAtomic` as bigint, dates within 1s).
2. **saveSession updates**: mutate `state`, `wordsDelivered`, `paidAtomic`, `metadata` → `getSession` reflects all four.
3. **recordWordDelivery happy path**: returns `duplicate: false`, a `payment` whose `amountAtomic`/`creatorAmountAtomic`/`rubiconFeeAtomic` echo the input, and `listDeliveries`/`listPayments` each grow by one, ordered by sequence.
4. **Idempotent retry**: same `idempotencyKey` again (any word/sequence) → `duplicate: true` and the ORIGINAL word/payment returned; `listPayments` length unchanged.
5. **Same (sessionId, sequence), different idempotencyKey**: pin the actual behavior of each implementation. Postgres has a unique constraint path that ends in `throw new Error("word_delivery_conflict")` or a duplicate return — assert what actually happens, per implementation, via a behavior probe first (run once, read the result, then write the assertion). If the two implementations disagree, that is a REPORT-not-fix finding.
6. **recordFreeWordDelivery**: no `payment` on result; duplicate by key returns `duplicate: true`; `priceAtomic === "0"`.
7. **updatePaymentSettlement backfill**: record a delivery with no settlement ids → backfill `settlementId`/`transferId` → `listPayments` shows them; a second partial backfill (only `transactionHash`) does NOT null the earlier `settlementId` (COALESCE semantics).
8. **Earnings**: two deliveries for one article with fee bps > 0 → `earningsForArticle` totals equal the summed `creatorAmountAtomic`/`rubiconFeeAtomic`; `earningsForCreator` aggregates across articles.
9. **getDeliveryByIdempotencyKey**: hit and miss (`null`).

Note `updatePaymentSettlement` is optional on the interface — guard with `if (!ledger.updatePaymentSettlement) return;` inside case 7 so the contract stays honest if a future implementation omits it.

**Verify**: in-memory: `pnpm --filter @rubicon-caliga/gateway build && pnpm --filter @rubicon-caliga/gateway test` → all cases pass. Postgres: start the docker container from "Commands", run with `TEST_DATABASE_URL`, all cases pass, then clean up.

### Step 3: Wire into the gateway test script and CI

- `apps/gateway/package.json`: `"test": "node --test dist/gateway.test.js dist/payments/*.test.js dist/repositories/ledger-contract.test.js"`.
- If `.github/workflows/ci.yml` exists (plan 001): add to the `verify` job:

```yaml
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
        ports: ["5432:5432"]
        options: >-
          --health-cmd pg_isready --health-interval 5s
          --health-timeout 5s --health-retries 10
    env:
      TEST_DATABASE_URL: postgresql://postgres:postgres@localhost:5432/postgres
```

**Verify**: `pnpm test` (root) → exit 0 with the contract suite included; with `TEST_DATABASE_URL` exported locally → postgres variant runs (not skipped) and passes.

## Test plan

The suite is the deliverable. Structural pattern: `apps/gateway/src/gateway.test.ts` (plain `test()` blocks, builders like its `plainArticle()` helper). Target ≥ 18 assertions-bearing cases (9 cases × 2 implementations).

## Done criteria

- [ ] `ledger-contract.test.ts` exists; the 9 cases run against in-memory unconditionally
- [ ] With `TEST_DATABASE_URL` set, the same 9 cases run against real Postgres after `runMigrations` and pass
- [ ] Without it, the postgres variant is visibly skipped (not silently absent)
- [ ] Gateway `test` script includes the new dist file; root `pnpm test` exits 0
- [ ] Any in-memory-vs-postgres behavioral divergence found is written into your completion report (and the case pins per-implementation behavior rather than papering over it)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `runMigrations` fails against a clean `postgres:16` (migrations may assume Supabase-specific extensions — that is a finding, not something to patch here).
- Case 5's probe shows the two implementations throw/return **differently** and any later case depends on that behavior — pin what you can, report the divergence, and continue.
- You need to modify `postgres.ts` or `in-memory.ts` to make any case pass.
- The gateway `test` script's explicit file list has changed shape since planning (drift).

## Maintenance notes

- Plan 006 (session concurrency) will add a compare-and-swap variant of `saveSession`; it must extend THIS suite with a concurrent-writers case rather than adding a one-off test.
- Reviewers: check the postgres variant actually ran in CI (look for the non-skipped test names in the job log) — a skipped suite that looks green is the failure mode this plan exists to remove.
- Deferred: contract coverage for the conversation methods is included only incidentally; seller-agent conversation persistence has lower money-risk.
