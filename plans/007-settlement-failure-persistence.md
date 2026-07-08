# Plan 007: Persist settlement failures so they survive restarts and reach operators

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cda7cef..HEAD -- apps/gateway/src/index.ts apps/gateway/src/payments/x402-circle.ts apps/gateway/src/workflows/paid-reading.ts apps/gateway/src/repositories/ apps/gateway/migrations/`
> Plans 005/006 legitimately touch some of these files — reconcile against the
> live code; on an unexplained mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (additive persistence/logging; one new migration)
- **Depends on**: plans/005-settle-only-delivered.md
- **Category**: bug
- **Planned at**: commit `cda7cef`, 2026-07-07

## Why this matters

When a batched settlement fails, today the only consequences are: an in-process `Set` (`haltedSessions`) refuses further words, and a `console.warn`. The failure is **not persisted** (`onSettled` at `apps/gateway/src/index.ts:72-75` returns early on `!outcome.success`), the buyer was already told the payment succeeded (`word.payment_accepted` SSE fired before settlement), the receipt keeps its optimistic null settlement fields forever, and a **process restart forgets the halt** — the gateway resumes releasing words to a session whose payments are failing. Separately, final settlement flushes on session close/shutdown swallow errors entirely (`.catch(() => {})`). Money that failed to move must leave a durable, queryable trace.

## Current state

- `apps/gateway/src/index.ts:72-90` — the `onSettled` wiring:

```ts
onSettled: async (outcome) => {
  if (!outcome.success || !ledger.updatePaymentSettlement) {
    return;
  }
  try {
    await ledger.updatePaymentSettlement({ sessionId: outcome.sessionId, sequence: outcome.sequence, ... });
  } catch (error) {
    console.error("[gateway] failed to backfill settlement", error);
  }
},
```

- Halt is memory-only: `x402-circle.ts:116` (`private readonly haltedSessions = new Set<string>()`), added at `:306` (settle returned `success:false`) and `:341` (settle threw); checked in `verify()` at `:208-210` (`reason: "prior_settlement_failed"`).
- `SettlementOutcome` (`x402-circle.ts:14-28`) already carries `success: boolean` and `reason?: string` — the failure signal exists; it just gets dropped.
- Swallowed flush errors: `apps/gateway/src/workflows/paid-reading.ts:58` and `:75` (`await this.options.paymentVerifier.flush?.().catch(() => {})`), `apps/gateway/src/server.ts:112` (`await paymentVerifier.drain?.().catch(() => {})`).
- Ledger write surface: `word_payments` / `settlement_receipts` tables (migrations under `apps/gateway/migrations/`, **append-only** — new columns require a NEW migration file; read the latest file for naming/format conventions first). `updatePaymentSettlement` is the existing backfill (`postgres.ts:688-749`).
- Event bus is internal to `createGateway` (`server.ts:84`) — `index.ts` has NO access to it, so a live SSE `settlement_failed` event cannot be emitted from `onSettled` without restructuring. This plan deliberately settles for durable state + the existing halt behavior; the next paid request on the session gets refused, and (new) the session is closed in the ledger so `/stream` returns `409 session_aborted`. Live-event emission is a documented deferral.
- Session states: `SessionRecord["state"]` includes `"aborted"` (see `postgres.ts:326` row typing and the state checks at `server.ts:781`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `pnpm build` | exit 0 |
| Gateway tests | `pnpm --filter @rubicon-caliga/gateway test` | exit 0 |
| Contract suite vs Postgres | `TEST_DATABASE_URL=… pnpm --filter @rubicon-caliga/gateway test` (docker one-liner in plan 003) | exit 0, migration applies |
| Typecheck / full | `pnpm typecheck && pnpm test` | exit 0 |

## Scope

**In scope**:
- `apps/gateway/migrations/<next>-settlement-status.sql` (create — follow existing file naming)
- `apps/gateway/src/repositories/types.ts`, `postgres.ts`, `in-memory.ts` (one new method)
- `apps/gateway/src/index.ts` (onSettled failure branch)
- `apps/gateway/src/payments/x402-circle.ts` (halt-state hydration hook, logging only otherwise)
- `apps/gateway/src/workflows/paid-reading.ts`, `apps/gateway/src/server.ts` (replace silent catches with logged ones)
- `apps/gateway/src/gateway.test.ts`, `apps/gateway/src/repositories/ledger-contract.test.ts`, `apps/gateway/src/payments/x402-circle.test.ts` (tests)

**Out of scope** (do NOT touch):
- Emitting new SSE event types (requires protocol changes in `packages/core/src/protocol.ts` and event-bus plumbing — deferred, see Maintenance notes).
- Retrying failed settlements automatically.
- Editing any existing migration file.

## Git workflow

- Branch: `advisor/007-settlement-failure-persistence`
- Commit style: `fix(gateway): persist settlement failures and close affected sessions`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Migration + ledger method

1. New migration adding to `word_payments`: `settlement_status TEXT` (nullable; semantics: `NULL` = pending/never-reported, `'settled'`, `'failed'`) and `settlement_error TEXT` (nullable). Follow the exact format of the most recent file in `apps/gateway/migrations/`.
2. `types.ts`: add optional `markSettlementOutcome?(input: { sessionId: string; sequence: number; status: "settled" | "failed"; error?: string }): Promise<void>;` to `LedgerRepository`, with a doc comment mirroring `updatePaymentSettlement`'s style.
3. `postgres.ts`: `UPDATE word_payments SET settlement_status=$3, settlement_error=$4 WHERE session_id=$1 AND sequence=$2`.
4. `in-memory.ts`: equivalent field updates on its records.

**Verify**: `pnpm build` exit 0; contract-suite quick case (Step 4) or a direct psql check that the migration applies cleanly on the plan-003 docker Postgres: `runMigrations` runs without error.

### Step 2: Wire the failure branch in `onSettled`

Rewrite `index.ts:72-90`:

```ts
onSettled: async (outcome) => {
  try {
    if (outcome.success) {
      await ledger.updatePaymentSettlement?.({ ...existing fields... });
      await ledger.markSettlementOutcome?.({ sessionId: outcome.sessionId, sequence: outcome.sequence, status: "settled" });
      return;
    }
    console.error("[gateway] settlement failed", JSON.stringify({ sessionId: outcome.sessionId, sequence: outcome.sequence, reason: outcome.reason }));
    await ledger.markSettlementOutcome?.({ sessionId: outcome.sessionId, sequence: outcome.sequence, status: "failed", error: outcome.reason });
    const session = await ledger.getSession(outcome.sessionId);
    if (session && session.state === "active") {
      session.state = "aborted";
      session.metadata = { ...session.metadata, abortReason: "settlement_failed" };
      await ledger.saveSession(session);
    }
  } catch (error) {
    console.error("[gateway] failed to record settlement outcome", error);
  }
},
```

Check the actual `SessionRecord` state union for the active-state name (read `packages/core` — it may be `"active"`, `"open"`, or similar; use what `server.ts:781`'s completed/aborted/expired checks imply is the live state). Closing the session in the ledger is what makes the halt durable: after restart, `/stream` returns `409 session_aborted` from the existing state check.

**Verify**: `pnpm build` exit 0.

### Step 3: Log instead of swallow on flush/drain

- `paid-reading.ts:58,75`: `.catch(() => {})` → `.catch((error) => console.error("[gateway] settlement flush failed on session close", { sessionId: session.id }, error))` (match the structured-ish console style used elsewhere; keep awaiting so close still completes).
- `server.ts:112`: same treatment for `drain` with a `"settlement drain failed on shutdown"` message.

**Verify**: `pnpm build && pnpm --filter @rubicon-caliga/gateway test` → existing tests pass.

### Step 4: Tests

1. Contract suite: `markSettlementOutcome` round-trip — record a delivery, mark `failed` with an error string, assert `listPayments` (extend its SELECT/mapping to expose `settlementStatus`/`settlementError` — that touches `postgres.ts:772-809` and the `PaymentActivity` type in `packages/core`… **it does not**: `PaymentActivity` lives in core, out of scope. Instead assert via a direct query in the postgres variant and via the record object in-memory, OR add the fields as optional to the repo-internal result only if no core change is needed. If exposing requires editing `packages/core`, keep the columns write-only for now and assert with `pool.query` in the test — state this choice in your report).
2. `x402-circle.test.ts`: a failing `settlePayment` produces `onSettled` with `success:false` and `reason` (may already exist — extend if so), and subsequent `verify` returns `prior_settlement_failed`.
3. Gateway-level: with a stub verifier calling its `onSettled`-equivalent path... (the wiring under test lives in `index.ts`, which boots on import — so test the `onSettled` closure's LOGIC by extracting it? No: keep `index.ts` unextracted; instead replicate the wiring assertion at the contract level: after marking failed + aborting the session, `app.inject` POST `/stream` → `409 { error: "session_aborted" }`. That is the behavior users see and it uses only public surfaces.)

**Verify**: `pnpm build && pnpm test` → all pass including new cases; with `TEST_DATABASE_URL`, migration + contract case pass on real Postgres.

## Test plan

As Step 4. Pattern sources: plan-003 suite for ledger cases, `x402-circle.test.ts` fake resource server for verifier cases, `gateway.test.ts` `setup()`/`inject` for the 409 behavior.

## Done criteria

- [ ] New migration adds `settlement_status`/`settlement_error`; `runMigrations` applies cleanly on a fresh Postgres
- [ ] Failed settlement ⇒ payment row marked `failed` with reason ⇒ session state `aborted` in the ledger ⇒ subsequent `/stream` 409s — verified by tests
- [ ] Successful settlement ⇒ row marked `settled` (backfill unchanged)
- [ ] `grep -rn "catch(() => {})" apps/gateway/src` returns no matches on the flush/drain lines
- [ ] `pnpm build && pnpm typecheck && pnpm test` exit 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The live session-state union has no state that both (a) blocks streaming via the existing 409 check and (b) is semantically honest for "payments failing" — do not invent a new state (that's a `packages/core` protocol change).
- Exposing status via `listPayments` requires editing `packages/core` types — take the write-only fallback described in Step 4.1 and report it.
- Plan 005's `SettlementOutcome` shape changed underneath this plan.
- The migration conflicts with a concurrently-added migration file (numbering collision).

## Maintenance notes

- **Deferred**: a live `payment.settlement_failed` SSE event (needs a new `GatewayEvent` variant in `packages/core/src/protocol.ts` and event-bus access from the settlement callback — a small protocol RFC, not a patch). The receipts read-back endpoint (plan 011) partially compensates: buyers can poll final settlement state.
- **Deferred**: reconciliation tooling for `settlement_status='failed'` rows (who re-settles or refunds, and how).
- Reviewers: confirm `onSettled` cannot throw out of the queue's `settleQueued` (it is already wrapped at `x402-circle.ts:363-368`) and that aborting the session does not race the in-flight delivery loop of plan 006's lock (the abort happens in a settlement-queue callback outside the lock — the CAS from plan 006 protects the counters; state overwrite last-write-wins on `state` is acceptable and should be noted in review).
