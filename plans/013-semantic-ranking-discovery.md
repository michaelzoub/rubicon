# Plan 013: Semantic ranking & discovery (pgvector search)

> **Executor instructions**: Follow this plan step by step. It is split into
> six phases; phases 1–6 can each be handed to a separate model. Respect the
> **Depends on** line in each phase. Run every verification command and confirm
> the expected result before moving on. If a "STOP condition" occurs, stop and
> report — do not improvise.
>
> **Drift check (run first)**: `git diff --stat -- apps/gateway/src/server.ts apps/gateway/src/repositories/ packages/core/src/protocol.ts packages/cli/src/quickstart.ts packages/cli/src/index.ts packages/agent-sdk/src/agent-client.ts`
> If any in-scope file changed since this plan was written, compare the "Current
> state" excerpts below against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MEDIUM (touches shared DB schema; new external-repo write contract)
- **Depends on**: none
- **Category**: feature
- **Planned at**: 2026-07-08

## Context — why this change

Buyer agents discover articles through `GET /v1/repository`, which returns **every**
live article as an unranked JSON array with no query parameter. The CLI `buy`
command then ranks client-side with `articleRelevance()` — a substring
term-overlap **count** over `title + section headings` — sorts descending and
takes `[0]`. For a broad buyer goal, a single shared generic word produces a
non-zero score, so the buyer selects a low-confidence "first match" and proceeds
to (potentially) spend real USDC on content that does not answer the goal. There
is no semantic understanding and no confidence floor at selection time — the only
gate is the seller agent's per-section `expectedValue >= 0.35` check, which fires
*after* an article is already chosen.

This plan adds **semantic ranking with a confidence floor**:

- Per-**section** embeddings (`text-embedding-3-small`, 1536-dim) stored in
  Supabase Postgres via **pgvector**, covering `title + heading + section body`.
- Embeddings are **written at publish time by the separate `rubicon-marketing`
  repo** (see the contract in Phase 1). This repo owns the schema and is
  **read-only** on the index, falling back to lexical scoring when embeddings are
  missing/stale or when `OPENAI_API_KEY` is unset (demo/in-memory mode).
- A new `GET /v1/search?q=&limit=` endpoint returns ranked articles each with a
  normalized `0..1` confidence score and per-section scores.
- The CLI `buy` flow calls search and **refuses to select** (zero-spend stop,
  reusing the existing `goalfit.gate` event) when the top score is below a floor.

Decisions locked with the user (do not relitigate): pgvector in the existing
Supabase DB; OpenAI `text-embedding-3-small` reusing the `OPENAI_API_KEY`
pattern; embed title+headings+body; per-section granularity; writes happen in
rubicon-marketing; new `/v1/search` endpoint + confidence floor; scope =
gateway + core types + agent-sdk + CLI + skill.md.

## Invariants that MUST hold (do not break)

- **Never expose unpaid body text.** Body is used *only* server-side to compute
  vectors. Every response returns safe metadata + scores only — the same
  `ArticleSummary` guarantee as `/v1/repository` today.
- Per-word payment, sessions, streaming, and seller-agent consultation are
  **untouched**. This change only alters DISCOVERY and initial SELECTION.
- `GET /v1/repository` **without** `?q=` returns the exact same response shape it
  does today. Search is additive.
- The gateway must **never crash or hang** when embeddings are absent — it falls
  back to lexical ranking and reports `mode: "lexical"`.

---

## Current state (verified 2026-07-08)

- **Gateway**: Fastify 5, ESM/TS, `apps/gateway/src/server.ts`. Routes registered
  in the `ENDPOINTS` const at `server.ts:68-80`. Discovery handler `listRepository`
  at `server.ts:317-331` returns `{ repository: "articles", articles: await withPaymentTerms(await articles.listPublishedArticles()) }`. No query param, no ranking.
- **Repository interface**: `PublishedArticleRepository` at
  `apps/gateway/src/repositories/types.ts:48-53` — `listPublishedArticles`,
  `getPublishedArticle`, `getArticleSections`, `getCreatorWallet`. Supabase impl at
  `apps/gateway/src/repositories/supabase.ts:168`; in-memory impl at
  `apps/gateway/src/repositories/in-memory.ts`.
- **SupabaseReader** interface at `supabase.ts:32-34` exposes only `from<T>(table)`.
  It does **NOT** expose `.rpc()` — must be extended (the runtime object is a real
  `@supabase/supabase-js` client cast to `SupabaseReader` at `supabase.ts:88-99`,
  so `.rpc` exists at runtime; only the type needs the method).
- `ArticleRecord` (server-side, has private `body`, `words`, `revision`) at
  `types.ts:19-39`. `ArticleSummary` (safe, public) at
  `packages/core/src/protocol.ts:14-31`. `ArticleSectionSummary` at
  `protocol.ts:45-52`.
- **Migrations**: `apps/gateway/migrations/` numbered `0001`–`0008`. Applied by
  `runMigrations(pool)` (`apps/gateway/src/migrate.ts`) from `DATABASE_URL`. Public
  read RLS precedent: `migrations/0003_supabase_public_repository_rls.sql`.
- **OpenAI usage pattern**: `createSellerAgent()` at `apps/gateway/src/index.ts:144-183`
  reads `OPENAI_API_KEY`, falls back to a deterministic provider when unset, and
  calls the API with `fetch`. Reuse this exact shape for query embeddings.
- **In-memory demo repo**: `createDemoArticleRepository()` at `index.ts:106-142`
  (one demo article, no DB). Used when Supabase env is absent.
- **CLI `buy`**: `runBuy` at `packages/cli/src/quickstart.ts:204-234`. Selection at
  `quickstart.ts:220-222` (`articleRelevance > 0`, sort desc, `[0]`). Existing gate
  logic: `MIN_GOAL_FIT_EXPECTED_VALUE = 0.35` (`quickstart.ts:151`), `assessGoalFit`
  (`quickstart.ts:166-202`), `articleRelevance` (`quickstart.ts:726-731`),
  `rankSectionPlans` synthetic decay `0.9 - index*0.25` (`quickstart.ts:733-742`).
  The `goalfit.gate` / `stop_zero_spend` event pattern is at `quickstart.ts:224`.
- **CLI `search`**: `search()` at `packages/cli/src/index.ts:178-191`, AND-substring
  `matchesQuery` at `index.ts:645-660`, no ranking.
- **SDK**: `RubiconClient.getRepository()` at
  `packages/agent-sdk/src/agent-client.ts:175-177`; `getNavigation` (query-param
  pattern) at `agent-client.ts:179-185`. `RepositoryResponse` type at
  `agent-client.ts:35-38`.
- **Test runners**: gateway `node --test dist/**` (needs build first); CLI
  `node --import tsx --test src/**/*.test.ts` (runs from source). CLI tests inject a
  fake `runtime.client`.
- **No embedding/vector deps** anywhere in `packages/*` or `apps/gateway` today.

---

## Scoring & confidence design (read before Phase 2/4)

Two scoring modes produce a **normalized `0..1` confidence** so a single floor
works regardless of mode:

- **Semantic** (`mode: "semantic"`): pgvector cosine similarity
  `sim = 1 - (embedding <=> query_embedding)`. Raw cosine for
  `text-embedding-3-small` clusters ~0.1 (unrelated) to ~0.6 (strongly related),
  so raw cosine is a **bad** confidence scale. Rescale:
  `confidence = clamp01((sim - SEM_FLOOR) / (SEM_CEIL - SEM_FLOOR))` with
  `SEM_FLOOR = 0.20`, `SEM_CEIL = 0.55` (both tunable constants, documented inline).
- **Lexical** (`mode: "lexical"`, fallback): fraction of meaningful query terms
  matched: `confidence = matchedTermCount / max(1, meaningfulTermCount)` — already
  `0..1`. This replaces the raw *count* used today.
- **Article score** = per-section aggregate:
  `articleScore = maxSectionConfidence + 0.15 * meanSectionConfidence`, then
  `clamp01`. Max drives it (one strongly-matching section is enough); the mean
  bonus breaks ties toward broadly-relevant articles.
- **Confidence floor** for the CLI gate: `MIN_SEARCH_CONFIDENCE = 0.35`
  (mirrors the existing `0.35` goal-fit semantics; now applied to the normalized
  score at *selection* time). Overridable via `--min-confidence` flag and
  `RUBICON_MIN_CONFIDENCE` env.

All four constants are heuristics — put them in one place with a comment saying
they are tunable, not physical constants.

---

## Phase 1 — Migration + rubicon-marketing write contract

**Depends on**: none. Deliverable: SQL schema this repo owns + a written spec for
the other repo. No gateway code yet.

### 1a. Create `apps/gateway/migrations/0009_article_section_embeddings.sql`

Contents (sketch — the executor writes real SQL):

```sql
-- Enable pgvector (Supabase supports it; may require the extension be allowed).
create extension if not exists vector;

-- Per-section embeddings. WRITTEN by rubicon-marketing at publish time.
-- The gateway is read-only here.
create table if not exists article_section_embeddings (
  article_id   text not null references articles(id) on delete cascade,
  section_id   text not null,          -- matches article_sections.section_id
  revision     integer not null,        -- matches articles.revision at embed time
  embedding    vector(1536) not null,   -- text-embedding-3-small, EXACTLY 1536 dims
  content_hash text not null,           -- sha256 of the embedded input; skip re-embed if unchanged
  model        text not null default 'text-embedding-3-small',
  updated_at   timestamptz not null default now(),
  primary key (article_id, section_id)
);

-- Cosine HNSW index for fast top-k.
create index if not exists article_section_embeddings_hnsw
  on article_section_embeddings using hnsw (embedding vector_cosine_ops);

-- RLS: mirror migrations/0003 public-repository policy so the role the gateway
-- reads with (see supabase.ts createSupabaseClientFromEnv) can SELECT, and the
-- search RPC below can read. Follow whatever 0003 established for `articles`.

-- Read-side RPC the gateway calls via supabase.rpc(). Returns similarity for
-- sections of LIVE articles only, top match_count by cosine distance.
create or replace function search_article_sections(
  query_embedding vector(1536),
  match_count integer default 40
)
returns table (article_id text, section_id text, revision integer, similarity real)
language sql stable security definer
as $$
  select e.article_id, e.section_id, e.revision,
         (1 - (e.embedding <=> query_embedding))::real as similarity
  from article_section_embeddings e
  join articles a on a.id = e.article_id
  where a.state = 'live'
  order by e.embedding <=> query_embedding asc
  limit match_count;
$$;

-- grant execute to the gateway's role, consistent with 0003.
```

STOP condition: if the `articles` table's PK type is `uuid` (not `text`), match
it — check `migrations/0001_init.sql` and the FK/`article_id` types before
finalizing. STOP if pgvector cannot be enabled on the target Supabase project
(the extension is normally allow-listed; escalate to the DB owner).

**Do not run this migration blindly against production.** The migrate note in
`apps/gateway/src/migrate.ts` says the schema is shared and migrations should be
applied by a single owner (rubicon-marketing in prod). Coordinate.

### 1b. Write the rubicon-marketing contract (docs only in this repo)

Add a short section to `docs/` (e.g. `docs/embeddings-contract.md`) specifying
what rubicon-marketing MUST do — this repo only reads:

- **When**: on article publish (state → `live`) and on every `revision` bump.
- **Per section**, embed the input text:
  `` `${title}\n${heading}\n${sectionBodyText}` `` (define exactly; body text is
  the section's slice of the article body).
- **Model**: `text-embedding-3-small`, **dimensions EXACTLY 1536** (no
  truncation) — must equal the `vector(1536)` column or inserts fail.
- **Upsert** keyed `(article_id, section_id)` with the current `revision` and
  `content_hash` (sha256 of the input text). Skip the OpenAI call when
  `content_hash` is unchanged.
- **Delete** rows for removed sections; delete all rows for an article on
  unpublish/delete (the `on delete cascade` covers hard deletes).
- Gateway tolerates lag: any article whose live `revision` has no matching
  embedding rows (or stale `revision`) is scored **lexically** and reported as
  such — see Phase 2.

### Verification (Phase 1)
- `psql "$DATABASE_URL" -f apps/gateway/migrations/0009_article_section_embeddings.sql` against a **dev/staging** DB; confirm the table, index, and function exist (`\d article_section_embeddings`, `\df search_article_sections`).
- Insert a dummy row with a 1536-length vector and call
  `select * from search_article_sections( (that vector), 5 );` → returns the row
  with `similarity` near 1.0. STOP if dimension errors occur.

---

## Phase 2 — Gateway search endpoint

**Depends on**: Phase 3 (core types). Do Phase 3 first or in the same change.

### 2a. Extend `SupabaseReader` for RPC (`apps/gateway/src/repositories/supabase.ts`)

Add to the interface at `supabase.ts:32`:

```ts
rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<{ data: T | null; error: unknown }>;
```

No runtime change needed — the cast client already has `.rpc`.

### 2b. Add a lexical scorer to core (shared by gateway + CLI)

Create `packages/core/src/search-lexical.ts` exporting:

```ts
export function meaningfulTerms(query: string): string[];       // lowercase, split /[^a-z0-9]+/, len>2, minus stopwords
export function lexicalConfidence(summary: ArticleSummary, query: string): number; // matched/total, 0..1
export function lexicalSearch(summaries: ArticleSummary[], query: string, limit: number): SearchResultSummary[];
```

Move the stopword set + tokenizer here (currently inlined in `articleRelevance`,
`quickstart.ts:727-728`). Export from `packages/core/src/index.ts`. Phase 4 will
re-point the CLI at these so there is one source of truth.

### 2c. Extend the repository interface (`apps/gateway/src/repositories/types.ts`)

Add an **optional** method to `PublishedArticleRepository`:

```ts
/** Semantic top-k over section embeddings. Absent/empty ⇒ caller falls back to lexical. */
searchSections?(queryEmbedding: number[], matchCount: number): Promise<Array<{ articleId: string; sectionId: string; revision: number; similarity: number }>>;
```

- **Supabase impl**: call `this.supabase.rpc("search_article_sections", { query_embedding: embedding, match_count: matchCount })`; map rows. Throw `SupabaseRepositoryError` on `error` (matches existing pattern).
- **In-memory impl**: do **not** implement it (leave `undefined`) so demo mode is lexical-only.

### 2d. Query-embedding helper (`apps/gateway/src/search/embed-query.ts`)

Reuse the `createSellerAgent` fetch pattern (`index.ts:144-183`):

```ts
export function createQueryEmbedder(): ((q: string) => Promise<number[] | null>) | null;
// null when OPENAI_API_KEY unset. Otherwise POST https://api.openai.com/v1/embeddings
// { model: "text-embedding-3-small", input: q } → data[0].embedding (1536 numbers).
```

Add a tiny in-process `Map<string, number[]>` LRU (cap ~200) so repeated queries
don't re-hit the API. On fetch failure, log and return `null` (→ lexical fallback,
never throw to the request).

### 2e. Search service (`apps/gateway/src/search/search-service.ts`)

`buildSearchResults({ query, limit, articles, repo, embedder })`:

1. `summaries = await withPaymentTerms(await repo.listPublishedArticles())` (reuse
   the existing `withPaymentTerms` from `server.ts` — either export it or pass it
   in; keep payment-terms behavior identical to `/v1/repository`).
2. If `embedder` and `repo.searchSections` both exist: embed the query; call
   `searchSections(embedding, ~40)`. Build `sectionConfidence` per `(articleId,
   sectionId)` using the **semantic** rescale. Only trust rows whose `revision`
   matches the live summary's revision — BUT note `ArticleSummary` has no
   `revision` field. **Decision**: expose `revision` internally by fetching it
   from the record, OR (simpler) trust the RPC's `live`-join and skip the
   per-article revision check in v1, accepting brief staleness. Recommend v1:
   skip the revision match (RPC already filters to live); log a TODO. Articles
   with **zero** returned sections fall to lexical for that article.
3. Compute `articleScore = clamp01(max + 0.15*mean)` per article from its section
   confidences. Attach `matchedSections` (top sections by score, heading + score).
4. For articles with no semantic sections (or when embedder/searchSections
   absent), score with `lexicalConfidence`. Set overall `mode = "semantic"` if any
   article scored semantically, else `"lexical"`.
5. Sort by score desc, drop score `<= 0`, take `limit` (default 20).
6. Return `SearchResponse` (Phase 3 type): `{ query, mode, results }`.

### 2f. Route (`apps/gateway/src/server.ts`)

- Add a handler and register `GET /v1/search` in `ENDPOINTS` (`server.ts:68-80`)
  and in the route table near `server.ts:329`. Parse `q` (required → 400 with a
  clear error if missing) and `limit` (optional, default 20, clamp 1..50).
- Add optional `?q=` to `listRepository` (`server.ts:317`): when `q` present,
  reorder/filter the returned `articles` array by search rank **but keep the exact
  `{ repository, articles }` shape** (drop the score fields — thin alias). When `q`
  absent, behavior is byte-for-byte unchanged.

### Verification (Phase 2)
- `pnpm --filter @rubicon-caliga/gateway build && pnpm --filter @rubicon-caliga/gateway test`.
- Local demo (no OPENAI key, in-memory repo): `pnpm --filter @rubicon-caliga/gateway dev`, then
  `curl 'http://localhost:8787/v1/search?q=metered+reading'` → JSON with
  `mode: "lexical"`, `results[]` each having `score` (0..1) and `matchedSections`.
  `curl 'http://localhost:8787/v1/search?q=quantum+chromodynamics'` → empty
  `results` (nothing matches) — confirms the floor/empty path.
- With `OPENAI_API_KEY` set and a Supabase DB that has embeddings → `mode: "semantic"`.
- `curl 'http://localhost:8787/v1/repository'` (no q) unchanged vs. main.

---

## Phase 3 — Core wire types

**Depends on**: none (do before/with Phase 2). File: `packages/core/src/protocol.ts`
(export from `packages/core/src/index.ts`).

```ts
/** One article in a ranked search response. Safe metadata + scores only. */
export interface SearchResultSummary {
  article: ArticleSummary;
  /** Normalized 0..1 confidence that this article answers the query. */
  score: number;
  matchedSections: SectionMatch[];
}

export interface SectionMatch {
  sectionId: string;
  heading: string;
  /** Normalized 0..1 confidence for this section. */
  score: number;
}

export interface SearchResponse {
  query: string;
  /** Whether embeddings were used ("semantic") or the lexical fallback ("lexical"). */
  mode: "semantic" | "lexical";
  results: SearchResultSummary[];
}
```

Keep the "safe metadata only" invariant: `SearchResultSummary.article` is an
`ArticleSummary`, never `ArticleRecord`.

### Verification (Phase 3)
`pnpm --filter @rubicon-caliga/core build && pnpm --filter @rubicon-caliga/core typecheck`.

---

## Phase 4 — Agent SDK + CLI

**Depends on**: Phases 2 & 3.

### 4a. SDK (`packages/agent-sdk/src/agent-client.ts`)

Add, following the `getNavigation` query-param pattern (`agent-client.ts:179-185`):

```ts
async search(query: string, options?: { limit?: number }): Promise<SearchResponse> {
  const url = new URL(`${this.baseUrl}/v1/search`);
  url.searchParams.set("q", query);
  if (options?.limit != null) url.searchParams.set("limit", String(options.limit));
  return this.readJson(await this.fetcher(url.toString(), this.timeoutInit({ headers: this.headers() })));
}
```

Import `SearchResponse` from `@rubicon-caliga/core`. Export the type from the SDK
index if it re-exports protocol types.

### 4b. CLI `buy` (`packages/cli/src/quickstart.ts`)

Replace the client-side selection at `quickstart.ts:217-227`:

- `const search = await runtime.client.search(goal, { limit: 20 });`
- `const top = search.results[0];`
- Read the floor: `--min-confidence` flag (`stringFlag`), else `RUBICON_MIN_CONFIDENCE`
  env, else `MIN_SEARCH_CONFIDENCE = 0.35` (new exported const).
- Gate: if `!top || top.score < floor` → emit
  `{ type: "goalfit.gate", decision: "stop_zero_spend", reason: "below_confidence_floor", topScore: top?.score ?? 0, minConfidence: floor, availableTitles }`
  and return the existing `noRelevantArticleResult(...)`. Reuse the zero-spend
  return path already used at `quickstart.ts:224-225`.
- Otherwise `article = top.article;` emit `article.selected` with
  `basis: "semantic_search"`, `provisional: true`, `searchScore: top.score`,
  `searchMode: search.mode`.
- Feed `top.matchedSections` into `rankSectionPlans` (`quickstart.ts:733-742`) so
  real per-section scores replace the synthetic `0.9 - index*0.25` decay when
  present (keep the decay as fallback when `matchedSections` is empty, e.g. lexical
  mode).
- **Keep the downstream seller consultation and the existing `assessGoalFit` /
  `MIN_GOAL_FIT_EXPECTED_VALUE` gate as a second, belt-and-suspenders check.** Do
  not remove it.
- Point `articleRelevance` (used in `assessGoalFit`, `quickstart.ts:172`) at the
  new core `lexicalConfidence` so there is one scorer (optional cleanup; keep
  behavior equivalent).

### 4c. CLI `search` command (`packages/cli/src/index.ts:178-191`)

Replace the `matchesQuery` filter with `runtime.client.search(query)`. Print ranked
results with scores, e.g. `article.title | score 0.72 | author`. JSON mode returns
`{ success, query, mode, results }`.

### Verification (Phase 4)
- `pnpm --filter @rubicon-caliga/cli test` and `pnpm --filter @rubicon-caliga/agent-sdk test`.
- Against a locally running gateway:
  `node packages/cli/dist/index.js buy --goal "how metered reading sessions work" --max-spend 0.01`
  selects the demo article; `... buy --goal "octopus migration patterns"` hits the
  floor → `stop_zero_spend`, zero spend. Confirm no payment occurs on the gate.

---

## Phase 5 — Tests

**Depends on**: the phase each test covers.

- **core** (`packages/core/src/search-lexical.test.ts`, `node --test` via tsx like CLI or dist like core): `meaningfulTerms` strips stopwords; `lexicalConfidence` = matched/total; `lexicalSearch` ranks and normalizes 0..1.
- **gateway** (`apps/gateway/src/search.test.ts`, compiled `dist`): with the
  in-memory repo, `GET /v1/search?q=` returns ranked+scored results, `mode:
  "lexical"`, respects `limit`, and returns `[]` for an unmatched query. Assert
  `/v1/repository` (no q) is unchanged. (Follow the existing gateway test harness
  used by `gateway.test.ts`.)
- **cli** (`packages/cli/src/buy.test.ts` or a new `search.test.ts`): inject a fake
  `runtime.client.search`. (1) top score `< floor` → `goalfit.gate /
  stop_zero_spend`, no session opened, no payment. (2) top score `>= floor` →
  proceeds to consultation. (3) `--min-confidence` / env override changes the gate.
  Add `search` to the existing fake client used across CLI tests.

### Verification (Phase 5)
`pnpm -r build && pnpm -r test` — all green.

---

## Phase 6 — Docs / skill.md

**Depends on**: Phases 2 & 4 landing (behavior finalized).

- Update the buyer workflow in `skill.md`: selection is now "rank candidates by
  semantic search score and refuse selection below the confidence floor" instead
  of "selects the first relevant live article" (current text ~`skill.md:69-70,
  87-97, 143`). Mention the new `/v1/search` endpoint and `--min-confidence`.
- `skill.md` is mirrored from/to the rubicon-marketing repo — **run the
  `sync-skill-md` skill** after editing so the hosted runbook does not drift. Do
  NOT hand-edit the rubicon-marketing copy.
- If `docs/embeddings-contract.md` was added in Phase 1, link it from `docs/` or
  the README's architecture section.

### Verification (Phase 6)
`sync-skill-md` reports no drift; `skill.md` describes ranked search + floor.

---

## Risks & mitigations

- **Dimension mismatch** — `vector(1536)` must equal the model's output.
  Mitigation: pin `text-embedding-3-small`, no `dimensions` truncation param,
  assert length 1536 in the marketing writer and reject otherwise.
- **pgvector not enabled on Supabase** — Mitigation: `create extension` in the
  migration; if the project disallows it, escalate to DB owner (Phase 1 STOP).
- **Embeddings lag / absent** (marketing hasn't backfilled) — Mitigation: gateway
  falls back to lexical per-article and reports `mode: "lexical"`; never crashes.
- **Confidence scale mismatch** between semantic and lexical — Mitigation: both
  normalized to `0..1` (semantic via the `SEM_FLOOR/SEM_CEIL` rescale) so one
  floor works; constants are tunable and documented.
- **Query embedding cost/latency** — small model, in-process cache, one call per
  distinct query. Failure → lexical, request never blocks on OpenAI.
- **Shared-schema migration** — coordinate with rubicon-marketing; apply from one
  owner (per `migrate.ts` note). Never run against prod blindly.
- **Revision staleness** (v1 skips per-article revision match) — accepted for v1;
  logged TODO to add a revision check once marketing writes are proven.

## STOP conditions (any → stop and report)

- pgvector cannot be enabled on the target Supabase project.
- `articles` PK type differs from what the migration FK assumes.
- Any code path would place unpaid `body`/`words` text into a search response.
- `/v1/repository` (no `q`) response shape changes vs. main.
- A CLI gate test shows a payment/session opening when the top score is below the floor.

## Out of scope (explicitly not in this plan)

- rubicon-marketing's embedding **writer** implementation (only its contract).
- Hybrid keyword+vector fusion (user deferred it; can be a follow-up on top of the
  lexical scorer already in core).
- Backfilling embeddings for existing articles (a marketing-side one-off script).
