# Plan 006: Serialize per-session payment handling so concurrent requests cannot double-charge

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cda7cef..HEAD -- apps/gateway/src/server.ts apps/gateway/src/repositories/ apps/gateway/src/gateway.test.ts`
> If any in-scope file changed since this plan was written (plan 005 legitimately
> touches `server.ts` — reconcile against the live code), compare the "Current
> state" excerpts against the live code before proceeding; on an unexplained
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED (locking on the hot payment path)
- **Depends on**: plans/003-ledger-contract-suite.md, plans/005-settle-only-delivered.md
- **Category**: bug
- **Planned at**: commit `cda7cef`, 2026-07-07

## Why this matters

Nothing serializes two concurrent requests for the same session. Each `/v1/sessions/:sessionId/stream` request loads its **own copy** of the session (`server.ts:773`), computes `maxWords` from its private `session.wordsDelivered`, verifies a full-chunk payment, and then races the other request word-by-word through the ledger. The loser sees every sequence as a duplicate, never advances its private counter, and returns **zero words** — after plan 005 it at least no longer settles, but the race still burns the buyer's signed authorization, produces confusing empty responses, and `saveSession` (`postgres.ts:371-387`) is last-write-wins, so the losing request's stale counters can clobber the winner's persisted totals. On the money path, session state needs single-writer semantics.

## Current state

- Chunk route flow (`apps/gateway/src/server.ts:770-918`): `getSession` → free/state/expiry checks → clamp `maxWords` by `normalizeChunkWords`, `affordableWordCount(session, …)`, `remainingArticleWords` → `verify` → per-word loop of `ledger.recordWordDelivery` (idempotency-keyed `` `${idempotencyKey}:${sequence}` ``), `recordWordPayment(session, …)`, `recordWordDelivery(session)` (in-memory counter bumps from `@rubicon-caliga/core`), `await ledger.saveSession(session)` on every word, `continue` on `record.duplicate`.
- Legacy word route (`server.ts:570-768`) has the same load-compute-write shape for one word.
- `saveSession` (`postgres.ts:371-387`):

```ts
await this.pool.query(
  `UPDATE stream_sessions SET state=$2, words_paid=$3, words_delivered=$4, paid_atomic=$5,
     conversation_id=$6, metadata=$7, payment_required=$8, updated_at=$9 WHERE id=$1`,
  [...]
);
```

No version check; concurrent writers silently overwrite each other.
- The only cross-request serialization today is the `word_deliveries` uniqueness in `recordWordDelivery` (`postgres.ts:524-608`), which the loser experiences as `duplicate: true`.
- Deployment reality: single gateway instance (Railway single service; in-process `streamStates`, `haltedSessions`, and event bus already assume it). An in-process mutex is therefore correct today; the DB-level compare-and-swap is the belt-and-braces that also makes the single-instance assumption *visible* if it is ever violated.
- The ledger contract suite from plan 003 lives at `apps/gateway/src/repositories/ledger-contract.test.ts` — extend it, don't fork it.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `pnpm build` | exit 0 |
| Gateway tests | `pnpm --filter @rubicon-caliga/gateway test` | exit 0 |
| Contract suite vs Postgres | `TEST_DATABASE_URL=… pnpm --filter @rubicon-caliga/gateway test` (see plan 003 for the docker one-liner) | exit 0 |
| Full suite | `pnpm test` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |

## Scope

**In scope**:
- `apps/gateway/src/server.ts` (payment routes + a small mutex helper in the same file)
- `apps/gateway/src/repositories/types.ts`, `postgres.ts`, `in-memory.ts` (compare-and-swap variant of saveSession)
- `apps/gateway/src/gateway.test.ts`, `apps/gateway/src/repositories/ledger-contract.test.ts` (tests)

**Out of scope** (do NOT touch):
- `apps/gateway/migrations/` — the CAS keys off the existing `words_delivered` column; no schema change. If you conclude a schema change is required, STOP.
- Payment verifier internals (`payments/`) — plan 005 owns those.
- Multi-instance coordination (Redis locks, advisory locks held across requests) — out of scope; the single-instance assumption is documented below.
- Free-chunk and SSE routes.

## Git workflow

- Branch: `advisor/006-session-concurrency`
- Commit style: `fix(gateway): serialize per-session payment handling`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Per-session in-process mutex

In `server.ts`, add a small helper near the top of `createGateway` (module scope is fine too):

```ts
const sessionLocks = new Map<string, Promise<unknown>>();
async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionLocks.get(sessionId) ?? Promise.resolve();
  const run = previous.then(fn, fn); // run regardless of predecessor outcome
  sessionLocks.set(sessionId, run.catch(() => undefined));
  try {
    return await run;
  } finally {
    if (sessionLocks.get(sessionId) === run.catch(() => undefined)) { /* see note */ }
  }
}
```

Note: the naive cleanup above is subtle — implement it carefully so the map does not leak: after `run` settles, delete the entry **iff** it is still the tail (compare against the stored promise reference; store the same reference you compare). Keep the helper ~15 lines, no external deps. Wrap the ENTIRE body of both paid handlers (`/stream` after the `getSession` 404 check, and `/payments` likewise) in `withSessionLock(request.params.sessionId, async () => { …existing body, re-loading the session INSIDE the lock… })`. The session must be (re)loaded inside the critical section — that is the point.

**Verify**: `pnpm build && pnpm --filter @rubicon-caliga/gateway test` → existing tests pass (they are sequential; behavior unchanged).

### Step 2: Compare-and-swap saveSession for payment writes

1. `types.ts`: add to `LedgerRepository`:

```ts
/**
 * Persist session counters only if the stored words_delivered still equals
 * `expectedWordsDelivered`. Returns false when a concurrent writer got there
 * first — the caller must re-read and re-decide, never overwrite.
 */
saveSessionIf?(session: SessionRecord, expectedWordsDelivered: number): Promise<boolean>;
```

2. `postgres.ts`: implement with `…same UPDATE… WHERE id=$1 AND words_delivered=$10` and `return (result.rowCount ?? 0) > 0;`.
3. `in-memory.ts`: implement with the same semantics against its map.
4. In the chunk handler's delivery loop, replace `await ledger.saveSession(session)` with:

```ts
const expected = session.wordsDelivered - 1; // value before recordWordDelivery bumped it
const saved = ledger.saveSessionIf
  ? await ledger.saveSessionIf(session, expected)
  : (await ledger.saveSession(session), true);
if (!saved) {
  request.log.error({ sessionId: session.id }, "session_concurrent_write_detected");
  break; // stop releasing; the response reports what was actually released
}
```

(Compute `expected` from the pre-bump value explicitly rather than `-1` arithmetic if plan 009 has hoisted the save out of the loop — reconcile with the live code; the invariant is: CAS on the value read inside this critical section.) Apply the same CAS to the legacy word route's single `saveSession`.

**Verify**: `pnpm build && pnpm --filter @rubicon-caliga/gateway test` → pass. Contract suite: add the case in Step 4 first if convenient.

### Step 3: Gateway race test

In `gateway.test.ts` (pattern: `setup()` + `app.inject`), with the default `DevelopmentPaymentVerifier`:

1. Create a session with budget for ≥ 64 words on the 200-word `plainArticle`.
2. Fire two `app.inject` POSTs to `/stream` **concurrently** (`Promise.all`), each `{ maxWords: 32, paymentPayload: {...}, idempotencyKey: <distinct-per-request> }` (mirror the payload shape existing stream tests use — read a passing stream test first and copy it).
3. Assert: the two responses' released sequences are **disjoint and contiguous overall** (0–31 and 32–63); combined `wordsDelivered` on the final session equals 64; `paidAtomic` equals `64 * wordPaymentAtomic`; neither response is empty.
4. Add a duplicate-retry test: same `idempotencyKey` twice sequentially → second response returns the SAME words, session totals unchanged (this pins the retry path plan 005 relies on).

**Verify**: `pnpm build && pnpm --filter @rubicon-caliga/gateway test` → new tests pass. Temporarily revert Step 1's lock wrapper locally (do not commit) and confirm test 3 FAILS — proving the test actually exercises the race — then restore.

### Step 4: Contract-suite case for saveSessionIf

In `ledger-contract.test.ts`, add: create session → `saveSessionIf(session, correctExpected)` → true; mutate a stale copy and `saveSessionIf(stale, wrongExpected)` → false and stored record unchanged. Runs against both implementations.

**Verify**: in-memory always; against Postgres with `TEST_DATABASE_URL` (docker one-liner in plan 003) → both pass.

## Test plan

Steps 3–4 are the test plan: one true-concurrency race test at the HTTP boundary, one duplicate-retry pin, one CAS contract case in the shared suite. Model on existing `gateway.test.ts` stream tests and the plan-003 suite structure.

## Done criteria

- [ ] Both paid routes run their session-load-to-response body under `withSessionLock`
- [ ] `saveSessionIf` exists on both ledger implementations with a contract-suite case passing on Postgres
- [ ] The concurrent-chunks test passes with the lock and fails without it (state in your report that you performed the revert-check)
- [ ] `pnpm build && pnpm typecheck && pnpm test` exit 0
- [ ] `sessionLocks` map cannot grow unboundedly (entry removed when its chain drains — demonstrate with a test or a targeted assertion)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 005 has NOT landed and the chunk handler still enqueues settlement inside `verify()` — landing this first changes what 005's steps patch; sequencing needs a human call.
- The existing stream tests' payment payload shape doesn't match what you inferred — copy from a green test, and if none exercises the paid `/stream` chunk path with the dev verifier, report that gap before writing the race test.
- You believe a schema change (version column) is required after all.
- The race test is flaky (>1 failure in 20 runs) after the lock — the lock has a hole; report the interleaving you observe rather than loosening assertions.

## Maintenance notes

- **Documented assumption**: one gateway instance. `withSessionLock` is in-process; `saveSessionIf` returning false in production logs `session_concurrent_write_detected` — if that ever fires, a second instance (or a bug) is writing concurrently and multi-instance coordination becomes a real project.
- Plan 009 hoists `saveSession` out of the loop; whichever lands second reconciles — the end state is: one CAS write per chunk, inside the lock.
- Reviewers: scrutinize `withSessionLock` cleanup (map leak) and that the 404/free-mode early returns moved inside vs outside the lock consistently — `getSession` must be inside.
