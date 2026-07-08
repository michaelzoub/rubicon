# Plan 011: Expose a receipts read-back endpoint for finalized sessions

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cda7cef..HEAD -- apps/gateway/src/server.ts apps/gateway/src/repositories/ docs/api-contract.md`
> Plans 005/006/009 legitimately touch `server.ts` — reconcile against the live
> code; on an unexplained mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW (additive read-only route)
- **Depends on**: none (composes with plan 007's settlement status if landed)
- **Category**: direction
- **Planned at**: commit `cda7cef`, 2026-07-07

## Why this matters

Receipts and settlement identifiers flow **out** of the gateway only via SSE and inline responses during the stream. Settlement clears *behind* the stream (batched; `onSettled` backfills `transferId`/hashes into the ledger afterwards — `apps/gateway/src/index.ts:70-90`). A buyer that disconnects before the batch clears has **no way to ever fetch the final settlement ids**, and no third party (the rubicon-marketing dashboard, an auditor agent) can verify a receipt against the gateway. The repository methods already exist unexposed — `listPayments`/`listDeliveries` (`postgres.ts:751-809`) — so this is one route plus contract docs. It is also the reconciliation surface plan 007's failure states want.

## Current state

- Route inventory: `ENDPOINTS` list at `apps/gateway/src/server.ts:68-80` — note `GET /v1/sessions/:sessionId/payments` (`server.ts:1011-1032`) returns payment **requirements** (and 409s on completed/aborted/expired sessions), NOT payment history. Nothing returns `listPayments`.
- Ledger surface (`repositories/types.ts:124-127`): `listDeliveries(sessionId)` / `listPayments(sessionId)` on every implementation; `PaymentActivity` (from `@rubicon-caliga/core`) carries `paymentId, sessionId, articleId, sequence, amountAtomic, creatorAmountAtomic, rubiconFeeAtomic, network, payTo, transactionHash(es), settlementId(s), buyerWalletAddress, transferId, createdAt` — see the row mapping at `postgres.ts:791-808`.
- Existing route style to copy: the `GET /v1/sessions/:sessionId/payments` handler (`server.ts:1011-1032`) — params typing, 404 shape (`{ error: "session_not_found" }`).
- Access model (documented, `docs/api-contract.md`): buyer endpoints are public in the x402 trust model; session ids are unguessable `randomUUID`s and anyone holding the id can already subscribe to the session's SSE (which replays words). Returning payment metadata to an id-holder is consistent with that. Do NOT include delivered word text in this endpoint — receipts are metadata; words remain in stream/SSE surfaces.
- Sessions in terminal states must be readable here — that is the whole point (post-hoc reconciliation). No 409 on completed/aborted/expired.
- Docs: `docs/api-contract.md` documents each `/v1/*` route; add this one alongside.
- SSE `receipt`-adjacent CLI behavior (context only): the CLI's "verified receipt" is a local save/reload check (`packages/cli/src/quickstart.ts:630-647`), not a gateway check — SDK/CLI adoption of this endpoint is deferred.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `pnpm build` | exit 0 |
| Gateway tests | `pnpm --filter @rubicon-caliga/gateway test` | exit 0 |
| Typecheck / full | `pnpm typecheck && pnpm test` | exit 0 |
| Manual probe | local gateway (AGENTS.md command) + one CLI buy, then `curl -s http://localhost:8787/v1/sessions/<id>/receipts` | JSON with payments |

## Scope

**In scope**:
- `apps/gateway/src/server.ts` (one new route + `ENDPOINTS` entry)
- `apps/gateway/src/gateway.test.ts` (tests)
- `docs/api-contract.md` (route documentation)

**Out of scope** (do NOT touch):
- `packages/core` response types — define the response shape locally in `server.ts` for now (the route is additive; promoting the type to core when the SDK adopts it is the follow-up).
- SDK (`packages/agent-sdk`) and CLI methods for this endpoint — deferred follow-up.
- Word text in the response.
- Auth changes.

## Git workflow

- Branch: `advisor/011-receipts-endpoint`
- Commit style: `feat(gateway): GET /v1/sessions/:sessionId/receipts read-back`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Route

Add after the existing `GET /v1/sessions/:sessionId/payments` route (`server.ts:~1032`):

```ts
app.get<{ Params: { sessionId: string } }>(
  "/v1/sessions/:sessionId/receipts",
  async (request, reply) => {
    const session = await ledger.getSession(request.params.sessionId);
    if (!session) {
      return reply.code(404).send({ error: "session_not_found" });
    }
    const payments = await ledger.listPayments(session.id);
    const deliveries = await ledger.listDeliveries(session.id);
    return reply.send({
      sessionId: session.id,
      articleId: session.articleId,
      state: session.state,
      accessMode: session.accessMode,
      wordsPaid: session.wordsPaid,
      wordsDelivered: session.wordsDelivered,
      paidAtomic: `${session.paidAtomic}`,
      deliveredSequences: deliveries.length,
      payments,
    });
  },
);
```

(Deliberately NO terminal-state 409. `payments` items are `PaymentActivity` objects — serialize as-is; the atomic amounts are already `` `${bigint}` `` strings per the mapping at `postgres.ts:791-808`.) Add to `ENDPOINTS` (`server.ts:68-80`): `{ method: "GET", path: "/v1/sessions/:sessionId/receipts", description: "Read-back of a session's payment receipts and settlement identifiers; available after completion." }`.

**Verify**: `pnpm build` → exit 0.

### Step 2: Tests

In `gateway.test.ts` using `setup()` + the existing paid-session helpers:

1. Buy a few words on a session (drive the dev-verifier `/stream` path as existing tests do), then `GET /v1/sessions/:id/receipts` → 200; `payments.length` equals words bought; `paidAtomic` matches; `settlementId`s present per the dev verifier's stamps.
2. Complete/abort the session (`POST /v1/sessions/:id/abort`), fetch again → still 200 with `state: "aborted"` (regression pin for the no-409 decision).
3. Unknown session id → 404.
4. Free session → 200 with empty `payments`, `deliveredSequences` > 0 after a free chunk.

**Verify**: `pnpm build && pnpm --filter @rubicon-caliga/gateway test` → new tests pass; `pnpm test` → exit 0.

### Step 3: Document

In `docs/api-contract.md`, add the route in the endpoint documentation section (match the surrounding formatting): method, path, availability in terminal states, response field list, and the note that settlement identifiers may lag delivery (batched settlement backfills them) — so a client reconciling should poll until `settlementId`/`transferId` are non-null or the session is aborted. If plan 007 landed and payments expose a settlement status, document those values too.

**Verify**: `grep -n 'receipts' docs/api-contract.md` → the new section exists.

### Step 4: Manual probe

Run the local demo-gateway flow (Commands table), buy with the CLI, `curl` the endpoint with the session id from the buy output.

**Verify**: JSON response with per-word payments matching the CLI's reported spend.

## Test plan

Step 2's four cases, modeled on existing `gateway.test.ts` stream tests (read a passing paid-stream test first for the exact payload/session helpers).

## Done criteria

- [ ] `GET /v1/sessions/:sessionId/receipts` returns 200 for active AND terminal sessions, 404 for unknown ids
- [ ] Response contains session totals + full `PaymentActivity` list; no word text
- [ ] Route listed in `ENDPOINTS` and documented in `docs/api-contract.md` with the settlement-lag note
- [ ] 4 new gateway tests pass; `pnpm build && pnpm typecheck && pnpm test` exit 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Serializing `PaymentActivity` directly leaks a field that looks like an internal secret or over-shares (inspect one real payload in the test before shipping — expected fields are listed in Current state; anything beyond them needs a human look).
- The existing tests offer no working way to drive a paid `/stream` with the dev verifier (would contradict the premise; check before building new harness).
- You are tempted to add SDK/CLI support "while you're here" — out of scope.

## Maintenance notes

- Follow-ups deliberately deferred: an SDK `client.getReceipts(sessionId)` + CLI `rubicon receipts --session <id> --remote` that verifies local receipts against this endpoint; promoting the response type into `packages/core/src/contract.ts` at that time.
- If per-tenant API keys ever arrive, this endpoint must join the session-ownership enforcement discussed in plan 004's maintenance notes.
- Reviewers: confirm the response builds entirely from the ledger (no `streamStates` in-memory dependence) so it works after restarts — that is its reason to exist.
