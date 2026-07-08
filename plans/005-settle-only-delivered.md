# Plan 005: Enqueue settlement after delivery, not inside verify()

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cda7cef..HEAD -- apps/gateway/src/payments/ apps/gateway/src/server.ts apps/gateway/src/payments/x402-circle.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (changes when settlements are queued on the live money path)
- **Depends on**: plans/002-core-pricing-tests.md, plans/003-ledger-contract-suite.md (safety net); coordinate with plans/006-session-concurrency.md (same handler)
- **Category**: bug
- **Planned at**: commit `cda7cef`, 2026-07-07

## Why this matters

Today the Circle verifier queues a settlement **inside `verify()`** — before the gateway has checked the ledger for duplicates or delivered a single word. Two concrete ways buyers get charged wrongly:

1. **Retry double-settle**: a client retry (the CLI re-runs on `PAYMENT_AMBIGUOUS`; the SDK has request timeouts) reaches `verify()` twice. Both calls enqueue. The ledger's idempotency check happens later (`server.ts:678` returns the cached word "without re-charging") — but the second settlement is already queued. If the retry carries the same signed nonce, the second settle fails as a replay and `haltedSessions` kills a session the buyer already paid for; if it carries a fresh authorization, the buyer pays twice for one word.
2. **Short delivery, full charge**: on the chunk path, `verify()` enqueues a settlement covering the whole authorized `maxWords`, then the delivery loop can `break` early (budget edge, article end) or `continue` past duplicates and deliver fewer — including **zero** — words, while the full-chunk settlement still flushes.

This violates the repo's own invariant ("never treat a queued settlement as final success" — and, in spirit, never settle what wasn't delivered). The fix: `verify()` verifies; the gateway explicitly queues the settlement **after** the ledger has accepted the delivery, and only when at least one word was actually released.

## Current state

- `apps/gateway/src/payments/x402-circle.ts:216-246` — the batched path. After `verifyPayment` succeeds:

```ts
const sequence = input.session.wordsDelivered;
this.settlementQueue.enqueue({
  sessionId: input.session.id,
  sequence,
  words: wordsCoveredByAuthorization(input.wordPaymentAtomic, input.session.pricePerWordAtomic, input.session.gatewayFeeBps),
  paymentPayload,
  requirements,
});
return { accepted: true, amountAtomic: requirements.amount as `${bigint}`, ... };
```

- `QueuedSettlement` (`x402-circle.ts:524-531`): `{ sessionId, sequence, words, paymentPayload, requirements }`. `reportSettlements` (`:349-357`) fans one outcome out to `sequence + 0 … sequence + words - 1` for receipt backfill.
- The verifier interface (`apps/gateway/src/payments/types.ts`) exposes `verify`, `createPaymentRequired`, optional `flush`/`drain`. `DevelopmentPaymentVerifier.verify` (`types.ts:39-53`) queues nothing.
- Legacy per-word route (`apps/gateway/src/server.ts:636-705`): `verify` → `recordWordDelivery` → if `record.duplicate`, return cached word (but the settlement is already queued — bug 1).
- Preferred chunk route (`server.ts:839-918`): `verify` (queues full `maxWords` — bug 2) → loop `recordWordDelivery` per word; loop may `break`/`continue`; `released.length` can be `< maxWords` or `0`.
- `synchronousSettlement` mode (`x402-circle.ts:212-214,259-296`) settles inline on the request path BEFORE delivery, by explicit design ("Legacy strict path"). Leave its ordering alone.
- Amount constraint you must respect: the buyer signs ONE authorization for the exact chunk amount (`chunkPaymentAtomic`). Settlement settles that signed authorization; the gateway cannot partially settle it. So the repair is about **when and whether** to enqueue, not about splitting amounts.
- Test doubles exist: `ResourceServerLike` (`x402-circle.ts:34-56`) is injectable; `x402-circle.test.ts` builds verifiers with fake resource servers (see its `REQUIREMENT` fixture at `:75`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build gateway + core | `pnpm build` | exit 0 |
| Gateway tests | `pnpm --filter @rubicon-caliga/gateway test` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Full suite | `pnpm test` | exit 0 |
| Local end-to-end | `cd apps/gateway && RUBICON_ARTICLES=demo RUBICON_PAYMENTS=development RUBICON_AGENT_API_KEY= DATABASE_URL= pnpm dev` then `node packages/cli/dist/index.js buy --goal "field guide" --max-usdc 0.0001 --gateway-url http://localhost:8787 --json` | buy completes with receipts |

## Scope

**In scope** (modify only these):
- `apps/gateway/src/payments/types.ts` (interface addition)
- `apps/gateway/src/payments/x402-circle.ts`
- `apps/gateway/src/server.ts` (the two payment routes only)
- `apps/gateway/src/payments/x402-circle.test.ts`, `apps/gateway/src/gateway.test.ts` (tests)

**Out of scope** (do NOT touch):
- `settlement-queue.ts` — its batching mechanics are correct and tested.
- The `synchronousSettlement` inline path ordering.
- `packages/agent-sdk`, `packages/cli` — buyer-side behavior is unchanged; the wire contract does not change.
- Session concurrency (`saveSession` races) — that is plan 006. If you find yourself adding locks, stop.

## Git workflow

- Branch: `advisor/005-settle-only-delivered`
- Commit style: `fix(gateway): queue settlement only after ledger-accepted delivery`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Split verification from settlement queuing in the verifier

1. In `payments/types.ts`, add to the `PaymentVerifier` interface an optional method:

```ts
/**
 * Queue the verified authorization for batched settlement. Called by the
 * gateway AFTER the ledger has accepted the delivery, with the count of words
 * actually released. Implementations without deferred settlement omit it.
 */
queueSettlement?(input: {
  session: SessionRecord;
  payment: StreamPaymentRequest;
  /** First sequence actually delivered in this request. */
  startSequence: number;
  /** Words actually released by this request (>= 1). */
  deliveredWords: number;
  /** Words the authorization covered (for shortfall logging). */
  authorizedWords: number;
}): void;
```

(Match the existing import style in `types.ts`; `StreamPaymentRequest` comes from `@rubicon-caliga/core` — check how `PaymentVerifyInput` already references the payment type and mirror it.)

2. In `CircleX402PaymentVerifier`:
   - Delete the `settlementQueue.enqueue` block from `verify()` (`x402-circle.ts:229-236`). `verify()` on the batched path now returns the accepted verification and nothing else. Keep the halted-session refusal and the verify-gate comment (update the comment: settlement is queued by the gateway post-delivery).
   - Implement `queueSettlement(input)`: recompute `paymentPayload`/`requirements` exactly as `verify()` did (`paymentRequirementsFromSession` + `findMatchingRequirements` are pure/synchronous — extract the small resolution into a private helper both methods call so they cannot drift), then enqueue `{ sessionId, sequence: input.startSequence, words: input.deliveredWords, paymentPayload, requirements }`. If `input.deliveredWords < input.authorizedWords`, log a structured warning `circle_x402_settlement_delivery_shortfall` with both counts (the signed amount still settles in full — the shortfall must be visible for reconciliation).
   - Add in-queue idempotency: keep a `Set<string>` of `` `${sessionId}:${startSequence}` `` keys that have been enqueued; `queueSettlement` for an already-seen key is a no-op with a structured log. Entries can be removed when their settlement reports (in `settleQueued`'s finally) to bound memory.

**Verify**: `pnpm --filter @rubicon-caliga/gateway build` → exit 0 (server.ts call sites updated in Steps 2–3 — build fully only after those; it is fine for this step's verify to be `tsc` errors ONLY in `server.ts` mentioning the removed behavior, nothing else).

### Step 2: Chunk route queues after the loop

In the `/v1/sessions/:sessionId/stream` handler (`server.ts:839-918`), after the delivery loop and before building the response:

```ts
if (released.length > 0) {
  paymentVerifier.queueSettlement?.({
    session,
    payment: { ...streamPayment, maxWords },
    startSequence: bundleStartSequence,
    deliveredWords: released.length,
    authorizedWords: maxWords,
  });
}
```

Zero released words ⇒ nothing is queued ⇒ the buyer's authorization is never settled for an empty response. (The loser of a duplicate race gets words=0 today; after plan 006 that case becomes rare, but this guard is what makes it harmless.)

**Verify**: `pnpm --filter @rubicon-caliga/gateway build` → exit 0.

### Step 3: Legacy per-word route queues after non-duplicate record

In the `/v1/sessions/:sessionId/payments` handler, move settlement queuing to after the `record.duplicate` check (`server.ts:678-701`): only when `record.duplicate === false`, call `queueSettlement?.({ session, payment: streamPayment, startSequence: sequence, deliveredWords: 1, authorizedWords: 1 })`. A duplicate retry now returns the cached word AND queues nothing — the double-settle/replay-halt path is gone.

**Verify**: `pnpm build && pnpm --filter @rubicon-caliga/gateway test` → existing 49 gateway tests pass (the DevelopmentPaymentVerifier has no `queueSettlement`, so `?.` no-ops keep all dev-mode tests green).

### Step 4: Verifier unit tests

In `x402-circle.test.ts`, using the existing fake-`ResourceServerLike` pattern:

1. `verify()` alone queues nothing: construct verifier with a fake resource server whose `settlePayment` records calls; call `verify` with a valid payload; `await verifier.flush()`; assert zero settle calls.
2. `queueSettlement` then `flush` settles once and `onSettled` receives outcomes for sequences `startSequence … startSequence + deliveredWords - 1`.
3. Idempotency: calling `queueSettlement` twice with the same `(sessionId, startSequence)` settles once.
4. Shortfall: `deliveredWords: 2, authorizedWords: 5` → settle called once; outcomes reported for exactly 2 sequences.
5. Retry-replay regression (the bug): `verify` twice with the same payload, `queueSettlement` once — total settle calls after drain: 1.

**Verify**: `pnpm build && pnpm --filter @rubicon-caliga/gateway test` → all pass, including 5 new.

### Step 5: End-to-end smoke

Run the local end-to-end from the Commands table (dev verifier — exercises the route ordering, not Circle). The buy must complete with the same receipts/word counts as before the change.

**Verify**: CLI exits 0, JSON output shows words purchased > 0, no `payment_rejected`.

## Test plan

Covered by Step 4 (verifier) plus one gateway-level test in `gateway.test.ts`: a custom `PaymentVerifier` double whose `queueSettlement` records calls, driven through the real `/stream` route with two sequential chunk requests — assert `queueSettlement` was called once per request with `deliveredWords === maxWords`, and that a request which delivers zero words (repeat an identical `idempotencyKey` payload) does NOT trigger `queueSettlement`. Model doubles on the `paymentVerifier` injection already supported by `setup()` in `gateway.test.ts:34-67`.

## Done criteria

- [ ] `grep -n "settlementQueue.enqueue" apps/gateway/src/payments/x402-circle.ts` shows enqueue ONLY inside `queueSettlement` (not in `verify`)
- [ ] Both payment routes call `queueSettlement` only after ledger acceptance; zero-delivery requests queue nothing
- [ ] Duplicate `(sessionId, startSequence)` queuing is a logged no-op
- [ ] Delivery shortfall logs `circle_x402_settlement_delivery_shortfall`
- [ ] `pnpm build && pnpm typecheck && pnpm test` exit 0; new tests from Step 4 + Test plan present
- [ ] End-to-end smoke buy completes
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `paymentRequirementsFromSession`/`findMatchingRequirements` turn out NOT to be safely re-callable outside `verify()` (e.g. they mutate session state or depend on `await this.ready` in a way `queueSettlement`'s sync signature can't satisfy) — report; the fallback design (verify returns an opaque settlement token the route passes back) needs advisor sign-off.
- Plan 006 has already landed and restructured the chunk loop lines this plan edits — reconcile against the live code first; if the merge is not mechanical, report.
- Any existing gateway test fails for a reason you cannot trace to the intentional ordering change.
- You are tempted to change settlement **amounts** (partial settles, refunds) — explicitly out of scope; the signed authorization settles whole or not at all.

## Maintenance notes

- After this plan, a session halt (`haltedSessions`) can only be triggered by a settlement that corresponds to actually-delivered words — reviewers should confirm no other `enqueue` path snuck in.
- The shortfall warning is the reconciliation hook: if it ever fires in production more than rarely, plan 006's serialization is broken or an article mutated mid-session.
- Plan 007 builds on this by persisting settlement failures; keep `SettlementOutcome` shapes stable for it.
- Deferred deliberately: making the buyer's authorization amount match delivered words exactly (requires protocol-level partial-capture support from Circle Gateway — investigate separately before promising it).
