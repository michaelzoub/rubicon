# Plan 008: Isolate SSE subscriber failures and clamp the CLI faucet fallback to usable balance

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cda7cef..HEAD -- apps/gateway/src/stores/event-bus.ts apps/gateway/src/server.ts packages/cli/src/quickstart.ts packages/cli/src/quickstart.test.ts`
> NOTE: at planning time `packages/cli/src/quickstart.ts` already had UNCOMMITTED
> working-tree changes relative to `cda7cef`; the excerpts below were taken from
> the working tree. Compare against the live file content, not the commit.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (touches `server.ts` lines far from plans 005/006 — still reconcile if those landed)
- **Category**: bug
- **Planned at**: commit `cda7cef` + uncommitted CLI changes, 2026-07-07

## Why this matters

Two small, real defects:

1. **A dead SSE subscriber can 500 a successful paid request.** `InMemoryEventBus.publish` calls every listener synchronously with no error isolation, and the SSE route's listener does a bare `reply.raw.write(...)`. If a subscriber socket has errored, the throw propagates out of `events.publish(...)` — which the payment handler calls *after* the word was recorded and paid — turning a completed sale into an error response and skipping delivery to every other subscriber of that session.
2. **The CLI's faucet rate-limit fallback can start reads the wallet can't finish.** Commit `cda7cef` intentionally lets a buy proceed on a 429 when the wallet has *any* positive Gateway balance, on the stated theory that "the per-section budget loop clamps each read to what remains" — but that loop clamps to the approved **budget**, not the wallet **balance** (`affordableWords = remaining / pricePerWordAtomic`). With balance < price of the planned read, the run fails mid-stream with `PAYMENT_AMBIGUOUS` after partial spend instead of sizing the read to what the wallet can actually pay.

## Current state

- `apps/gateway/src/stores/event-bus.ts` (entire file, 27 lines):

```ts
publish(event: GatewayEvent): void {
  const history = this.history.get(event.sessionId) ?? [];
  history.push(event);
  this.history.set(event.sessionId, history.slice(-100));
  for (const listener of this.listeners.get(event.sessionId) ?? []) {
    listener(event);
  }
}
```

- SSE route, `apps/gateway/src/server.ts:1034-1048`:

```ts
app.get<{ Params: { sessionId: string } }>("/v1/sessions/:sessionId/events", async (request, reply) => {
  const session = await ledger.getSession(request.params.sessionId);
  if (!session) {
    return reply.code(404).send({ error: "session_not_found" });
  }
  reply.raw.writeHead(200, { "content-type": "text/event-stream", ... });
  const unsubscribe = events.subscribe(request.params.sessionId, (event) => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  request.raw.on("close", unsubscribe);
});
```

No `error` handler on the raw socket; a `write` throw escapes into `publish`.
- CLI fallback, `packages/cli/src/quickstart.ts:411-430` (working tree): after a faucet 429, the buy aborts only when `faucetError && BigInt(balance.balanceAtomic) <= 0n`; the comment at `:411-414` claims the section loop clamps to wallet funds.
- Section loop, `quickstart.ts:457-473` (working tree):

```ts
const remaining = BigInt(maxSpendAtomic) - spent;
...
const affordableWords = isFree ? sectionWords : Number(remaining / pricePerWordAtomic);
...
const maxWords = Math.min(sectionWords, Math.max(plan.minimumUsefulWords, affordableWords - reserveWords));
const sessionCap = BigInt(maxWords) * pricePerWordAtomic;
if (sessionCap > remaining) throw new CliError("BUDGET_INVARIANT", ...);
```

`balanceAtomic` (a `` `${bigint}` `` captured at `quickstart.ts:354` and refreshed at `:400-401`) is in scope but unused by the loop.
- CLI test conventions: `packages/cli/src/quickstart.test.ts` and `buy.test.ts` run via `tsx` (`pnpm --filter @rubicon-caliga/cli test`), building fixtures with a `CommandRuntime`/deps double — read one `funding.*` test in `quickstart.test.ts` before writing yours; an existing test named like "buy clamps partial reads to remaining budget before payment" (`buy.test.ts:29`) is the structural model.
- Behavior guarantee to preserve (from `cda7cef`'s intent): a 429 with a positive, *sufficient-for-something* balance must still proceed. Do not restore a hard `balance >= requiredAtomic` abort.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `pnpm build` | exit 0 |
| Gateway tests | `pnpm --filter @rubicon-caliga/gateway test` | exit 0 |
| CLI tests | `pnpm --filter @rubicon-caliga/cli test` | exit 0 (64 + new) |
| Typecheck / full | `pnpm typecheck && pnpm test` | exit 0 |

## Scope

**In scope**:
- `apps/gateway/src/stores/event-bus.ts`
- `apps/gateway/src/server.ts` (the `/events` route only)
- `packages/cli/src/quickstart.ts` (the balance clamp only)
- `apps/gateway/src/gateway.test.ts`, `packages/cli/src/quickstart.test.ts` or `buy.test.ts` (tests)

**Out of scope** (do NOT touch):
- The 100-event history cap in `event-bus.ts:12` — documenting `/events` as live-only+bounded-replay is plan 010's docs territory; changing capacity is a product call. Leave the cap.
- The faucet request/429 classification logic (`isFaucetRateLimited`, `faucetRetryAfterSeconds`) — working as intended.
- Payment routes in `server.ts` (plans 005/006 own them).

## Git workflow

- Branch: `advisor/008-sse-and-cli-quick-wins`
- Commit style: `fix(gateway): isolate SSE listener failures` / `fix(cli): clamp faucet-fallback reads to usable balance` (two commits is fine)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Error-isolate the event bus

In `event-bus.ts`, wrap each listener call:

```ts
for (const listener of this.listeners.get(event.sessionId) ?? []) {
  try {
    listener(event);
  } catch {
    // A failing subscriber must never break publishing or other subscribers.
    // Listener owners handle their own transport errors (see server.ts /events).
  }
}
```

Apply the same guard to the history-replay loop in `subscribe` (`:22-24`).

**Verify**: `pnpm build && pnpm --filter @rubicon-caliga/gateway test` → pass.

### Step 2: Harden the SSE route

In the `/events` handler: keep a `let closed = false`; wrap the `reply.raw.write` in `try/catch` that calls a shared `cleanup()` (sets `closed`, calls `unsubscribe`, `reply.raw.end()` guarded); register `cleanup` on BOTH `request.raw.on("close", ...)` and `reply.raw.on("error", ...)`; skip writes when `closed`. Also call `reply.hijack()` before `reply.raw.writeHead` so Fastify stops managing the reply lifecycle (check Fastify 5's `reply.hijack()` — it exists; if the current code works without it, the minimal change is the error handler + guarded writes, and you may skip hijack, noting that in your report).

**Verify**: `pnpm build && pnpm --filter @rubicon-caliga/gateway test` → pass, plus new test below.

### Step 3: Gateway test for subscriber isolation

In `gateway.test.ts`: subscribe two listeners to a session via the event bus indirectly — simplest honest test at the unit level of the bus: instantiate `InMemoryEventBus` directly (it is exported), subscribe listener A that throws and listener B that records, publish, assert B received the event and `publish` did not throw. (HTTP-level SSE socket-error simulation with `app.inject` is not worth the harness complexity — say so in the report if you agree, or add it if `inject`'s stream mode makes it easy.)

**Verify**: `pnpm build && pnpm --filter @rubicon-caliga/gateway test` → new test passes.

### Step 4: Clamp CLI reads to usable wallet balance

In `quickstart.ts`:

1. Track the freshest known usable balance: after the post-faucet recheck (`:400-401`), keep `let usableBalanceAtomic: bigint | undefined = balanceAtomic ? BigInt(balanceAtomic) : undefined;` (it is also set on the no-faucet path at `:354` — capture both).
2. In the section loop, clamp: `const spendable = usableBalanceAtomic === undefined ? remaining : min(remaining, usableBalanceAtomic - spent)` (bigint min inline), then `affordableWords = isFree ? sectionWords : Number(spendable / pricePerWordAtomic)`.
3. Update the `:411-414` comment to state the loop now clamps to `min(budget, wallet balance)`.
4. Keep the `<= 0n` abort exactly as is (429 + zero balance is still fatal), and do NOT add a `balance >= requiredAtomic` pre-flight abort.

Only clamp when `paymentMode === "circle-cli"` and a balance was actually fetched — `usableBalanceAtomic` stays `undefined` otherwise (e.g. free reads, other payment modes), preserving current behavior.

**Verify**: `pnpm --filter @rubicon-caliga/cli test` → existing 64 pass.

### Step 5: CLI test

In `quickstart.test.ts` (or `buy.test.ts`, wherever the funding fixtures live — follow the file that already stubs `circleGatewayBalance`): a fixture with budget 100 words' worth, wallet balance 10 words' worth, faucet rate-limited → assert the session cap requested is ≤ 10 words' worth and the run completes without `PAYMENT_AMBIGUOUS`/`BUDGET_INVARIANT`; and a control case with balance ≥ budget behaving as before.

**Verify**: `pnpm --filter @rubicon-caliga/cli test` → all pass including new; `pnpm test` (root) → exit 0.

## Test plan

Steps 3 and 5. Patterns: direct `InMemoryEventBus` unit test beside the gateway tests; CLI fixture style from `buy.test.ts:14-29` (`setup([...])`, `runBuy(fixture.runtime)`, assertions on `fixture.runs`).

## Done criteria

- [ ] `publish` and `subscribe` replay cannot throw due to a listener; test proves a throwing listener doesn't starve others
- [ ] `/events` route has error-path cleanup (`unsubscribe` on socket error, no write-after-close)
- [ ] CLI section loop clamps `affordableWords` by `min(remaining budget, usable wallet balance − spent)` when balance is known; comment updated to match reality
- [ ] The 429 + positive-balance proceed behavior is preserved (control test)
- [ ] `pnpm build && pnpm typecheck && pnpm test` exit 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `quickstart.ts` live content around lines 330–475 no longer matches the working-tree excerpts (this file was already mid-edit at planning time — a further user edit needs reconciling before you patch it).
- The CLI test fixtures don't stub `circleGatewayBalance` anywhere you can find — building a new fixture layer is beyond this plan's size; report.
- `reply.hijack()` breaks SSE delivery in the existing manual flow (verify with the local gateway + `curl -N http://localhost:8787/v1/sessions/<id>/events` if in doubt) — fall back to the minimal error-handler variant.

## Maintenance notes

- The event-history 100-cap remains: `/events` replays at most the last 100 events. Plan 010 documents this; plan 011's receipts endpoint is the authoritative post-hoc record.
- If the SDK later adds SSE reconnection with `Last-Event-ID`, the bus needs event ids — this plan deliberately didn't add them.
- Reviewers: on the CLI change, check the `spent` subtraction — balance is consumed as sections are bought, so the clamp must be against `usableBalanceAtomic - spent`, not the initial balance.
