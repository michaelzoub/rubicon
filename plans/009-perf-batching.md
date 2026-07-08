# Plan 009: Batch the repository-listing queries and stop writing the session once per word

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cda7cef..HEAD -- apps/gateway/src/repositories/ apps/gateway/src/server.ts apps/gateway/package.json`
> Plans 005/006 legitimately touch `server.ts` — reconcile against the live
> code; on an unexplained mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (reads) / MED (the saveSession hoist interacts with plan 006)
- **Depends on**: plans/006-session-concurrency.md (land 006 first; its CAS write is what the hoisted save must use)
- **Category**: perf
- **Planned at**: commit `cda7cef`, 2026-07-07

## Why this matters

Three measured inefficiencies, all on hot public paths:

1. `GET /v1/repository` against Postgres issues `1 + N + N` serial queries for N articles: `listPublishedArticles` loops `getArticleSections(row.id)` per article, then `withPaymentTerms` in the server calls `getCreatorWallet(summary.creatorId)` per article. 20 articles ⇒ 41 round-trips through the Supabase pooler for one public listing. The Supabase implementation already fetches articles+sections in a single embedded join — only the Postgres path diverged.
2. The chunk delivery loop calls `await ledger.saveSession(session)` on **every word** — a 32-word bundle does 32 `stream_sessions` UPDATEs where the final state is all that matters (each word's payment/delivery row is already individually persisted by `recordWordDelivery`).
3. `pg` — the production database driver — is declared in `optionalDependencies`; an install with `--no-optional` (or a failed optional fetch) produces a gateway that boots and then throws on first ledger write.

## Current state

- `apps/gateway/src/repositories/postgres.ts:222-232`:

```ts
async listPublishedArticles(): Promise<ArticleSummary[]> {
  const articles = await this.pool.query<ArticleRow>(`${ARTICLE_SELECT} WHERE a.state = $1`, [PUBLIC_ARTICLE_STATE]);
  const summaries: ArticleSummary[] = [];
  for (const row of articles.rows) {
    const sections = await this.getArticleSections(row.id);
    summaries.push(summarizeArticle(toArticleRecord(row, sections)));
  }
  return summaries;
}
```

- `apps/gateway/src/server.ts:132-148` — `withPaymentTerms` maps every paid summary through `articles.getCreatorWallet(summary.creatorId)` (inside `Promise.all`, so parallel but still one query per article, unbounded).
- Interface: `PublishedArticleRepository` (`repositories/types.ts:48-53`) — `listPublishedArticles`, `getPublishedArticle`, `getArticleSections`, `getCreatorWallet`. Three implementations: `postgres.ts`, `supabase.ts` (already joins sections — see its `sections:article_sections(...)` embed around `supabase.ts:171-173,216-230`), `in-memory.ts`.
- Chunk loop per-word write: `server.ts:904-906`:

```ts
recordWordPayment(session, `${wordPaymentAtomic}`);
recordWordDelivery(session);
await ledger.saveSession(session);
```

(If plan 006 landed, this line is already a `saveSessionIf` CAS — the hoist then means: CAS once after the loop instead of once per word.)
- `apps/gateway/package.json`: `"optionalDependencies": { "pg": "^8.13.1", "undici": "^6.21.0" }`. `undici` is genuinely optional by design (`http-agent.ts:33-36` degrades gracefully) — leave it. `pg` is loaded via dynamic `import()` in `index.ts:36-37` only when `DATABASE_URL` is set, but when it IS set, `pg` is mandatory.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `pnpm build` | exit 0 |
| Gateway tests | `pnpm --filter @rubicon-caliga/gateway test` | exit 0 |
| Contract/postgres | `TEST_DATABASE_URL=… pnpm --filter @rubicon-caliga/gateway test` (docker one-liner in plan 003) | exit 0 |
| Lockfile refresh | `pnpm install` | exit 0, lockfile updated |
| Typecheck / full | `pnpm typecheck && pnpm test` | exit 0 |

## Scope

**In scope**:
- `apps/gateway/src/repositories/postgres.ts` (`listPublishedArticles`, new `getCreatorWallets`)
- `apps/gateway/src/repositories/types.ts` (optional batch method), `supabase.ts` + `in-memory.ts` (implement it)
- `apps/gateway/src/server.ts` (`withPaymentTerms`; the saveSession hoist in the chunk loop)
- `apps/gateway/package.json` + `pnpm-lock.yaml` (move `pg`)
- `apps/gateway/src/gateway.test.ts` (tests)

**Out of scope** (do NOT touch):
- `recordWordDelivery` batching into multi-row inserts — real but riskier (idempotency semantics per word must survive); deferred, see Maintenance notes.
- Caching layers, HTTP cache headers.
- `supabase.ts` read shapes beyond adding the batch-wallet method.

## Git workflow

- Branch: `advisor/009-perf-batching`
- Commit style: `perf(gateway): batch repository listing queries; single session write per chunk` and `fix(gateway): pg is a required dependency`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Single-query sections in `listPublishedArticles`

Replace the per-row loop with one sections query for all ids: `SELECT * FROM article_sections WHERE article_id = ANY($1) ORDER BY article_id, word_start` (read `getArticleSections` first and reuse its exact SELECT/ordering/mapping — factor its row-mapping into a shared private method so the two stay identical), group rows by `article_id` in a `Map`, then build summaries. Zero articles ⇒ skip the sections query.

**Verify**: `pnpm build && pnpm --filter @rubicon-caliga/gateway test`; with `TEST_DATABASE_URL`, any contract/listing coverage passes. Add the test from Step 5 for row-count assertions.

### Step 2: Batch wallet lookup

1. `types.ts`: add optional `getCreatorWallets?(creatorIds: string[]): Promise<Map<string, CreatorWallet>>;` to `PublishedArticleRepository` (doc comment: absent ⇒ callers fall back to per-id lookups).
2. `postgres.ts`: `WHERE creator_id = ANY($1)` version of the existing single query (again reuse the single-lookup's SELECT + mapping).
3. `supabase.ts`: `.in("creator_id", ids)` variant of its existing wallet query.
4. `in-memory.ts`: filter its fixtures.
5. `server.ts` `withPaymentTerms`: collect unique `creatorId`s of paid summaries; if `articles.getCreatorWallets` exists, one call + Map lookups; else the existing per-summary path. Keep the `wallet?.verified` guard identical.

**Verify**: `pnpm build && pnpm --filter @rubicon-caliga/gateway test` → pass (existing repository-listing tests cover the mapping).

### Step 3: One session write per chunk

In the chunk handler, remove the per-word `saveSession`/`saveSessionIf` from inside the loop; after the loop (before building the response), perform ONE CAS write with plan 006's `saveSessionIf(session, expectedBeforeLoop)` where `expectedBeforeLoop` is the `wordsDelivered` value read when the session was loaded inside the lock. On CAS failure log `session_concurrent_write_detected` and return 409 `{ error: "session_conflict" }` WITHOUT the released words being re-sent (they are already persisted per-word in the ledger; the buyer retries with the same idempotency key and receives them as duplicates — pin that in the test). Keep the in-memory counter bumps (`recordWordPayment`/`recordWordDelivery`) inside the loop — only the persistence moves.

Note: `paidReading.complete(...)` / `close(...)` also call `saveSession` internally (`workflows/paid-reading.ts:53-78`); when the loop completed the article, order the final CAS write BEFORE `complete()` so `complete` persists only the state flip — read those 26 lines and keep the sequencing coherent (state must end `completed` with correct totals).

**Verify**: `pnpm build && pnpm --filter @rubicon-caliga/gateway test` → all pass, including plan 006's race test (unchanged semantics: totals correct, sequences disjoint).

### Step 4: Promote `pg`

Move `"pg": "^8.13.1"` from `optionalDependencies` to `dependencies` in `apps/gateway/package.json`; keep `undici` optional; run `pnpm install` to refresh the lockfile.

**Verify**: `git diff pnpm-lock.yaml` shows only the pg re-classification; `pnpm build && pnpm test` → exit 0.

### Step 5: Query-count test

In `gateway.test.ts`: the Postgres repository classes accept a `Pool`; hand `PostgresPublishedArticleRepository` a **counting fake pool** (`{ query: async (sql, params) => {...canned rows...} }` — check the constructor type: it takes `Pool`; a structural fake cast via `as unknown as Pool` matches existing test-double pragmatics in this suite) seeded with 3 articles + sections + wallets. Assert `listPublishedArticles` issues exactly 2 queries (articles + sections). For `withPaymentTerms`, drive `GET /v1/repository` through `setup()` with an in-memory repo carrying a spy on `getCreatorWallets` — assert one call for a 3-article listing.

**Verify**: `pnpm build && pnpm --filter @rubicon-caliga/gateway test` → new tests pass. Full: `pnpm test` → exit 0.

## Test plan

Step 5's counting tests plus the retry-after-409 pin from Step 3 (buyer re-requests with same idempotency key after a `session_conflict` and receives the already-persisted words as duplicates — add to `gateway.test.ts` next to plan 006's race test).

## Done criteria

- [ ] `listPublishedArticles` issues 2 queries regardless of N (counting-fake test)
- [ ] `withPaymentTerms` issues 1 wallet lookup per listing when the batch method exists
- [ ] No `saveSession` call inside the chunk delivery loop (`grep -n "saveSession" apps/gateway/src/server.ts` shows only post-loop/route-level calls)
- [ ] `pg` is under `dependencies`; lockfile consistent
- [ ] `pnpm build && pnpm typecheck && pnpm test` exit 0 (incl. plans 003/006 suites if landed)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 006 has not landed — Step 3 without the lock+CAS reintroduces the lost-update race; do Steps 1, 2, 4, 5 only and mark Step 3 BLOCKED in the index.
- `getArticleSections`' SELECT does something non-trivially per-article (window functions, limits) that `ANY($1)` can't reproduce — report with the query text.
- The counting-fake pool approach fights the `Pool` type beyond one localized cast.
- Any behavior change appears in the repository listing response shape (this plan is round-trips only).

## Maintenance notes

- **Deferred**: batching `recordWordDelivery`'s 3 inserts × N words into one multi-row transaction per chunk — do it only with the contract suite (plan 003) extended to cover per-word idempotency inside a batch.
- If pagination is ever added to `/v1/repository`, the `ANY($1)` grouping carries over as-is; the wallet batch should then key off the page, not the full listing.
- Reviewers: Step 3's 409-on-CAS-failure is new client-visible behavior in a race that previously produced silent word-count corruption — confirm the SDK/CLI retry treats 409 `session_conflict` as retryable (check `packages/agent-sdk/src/agent-client.ts` retry handling; if it hard-fails on 409, note it — the fallback is returning the released words with a warning instead).
