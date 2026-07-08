# Plan 012: Spike — wire the persisted per-article seller-agent config into the seller agent

> **Executor instructions**: This is a DESIGN/SPIKE plan — the deliverable is a
> design document plus a small gated prototype, not a finished feature. Follow
> the steps, run every verification command, and honor the STOP conditions.
> When done, update the status row for this plan in `plans/README.md` — unless
> a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat cda7cef..HEAD -- apps/gateway/src/seller-agent/ apps/gateway/src/index.ts apps/gateway/src/repositories/types.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M (spike-scoped)
- **Risk**: LOW (prototype behind existing deterministic fallback)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `cda7cef`, 2026-07-07

## Why this matters

Creators can configure a per-article seller agent — `persona`, `model`, `guidance` — in the rubicon-marketing dashboard. That config is persisted, typed (`SellerAgentConfig` on `ArticleRecord`, `apps/gateway/src/repositories/types.ts:31`), loaded by both repositories (`postgres.ts:189`, `supabase.ts:258`), and advertised in `docs/api-contract.md` ("Seller-agent configuration") — **and then ignored at runtime**. The seller agent receives a `SafeArticleContext` with no persona/guidance fields (`seller-agent/model-provider.ts:16-25`), and `createSellerAgent()` (`index.ts:144-183`) wires a single global provider from env (OpenAI-only, model from `OPENAI_MODEL`), never consulting `article.sellerAgentConfig`. The product's differentiator is seller-guided discovery; the creator's knob for it is dead. Related lock-in: the provider abstraction is explicitly pluggable ("deterministic-dev" / "anthropic:claude-…" naming in `model-provider.ts:58`), but only OpenAI is wired.

## Current state

- `SellerAgentConfig` type: find its definition in `packages/core` (`grep -rn "SellerAgentConfig" packages/core/src`) — read it first; expect fields like `persona`, `model`, `guidance` (verify actual names/optionality).
- Safe-context boundary (`model-provider.ts:1-6` doc comment): providers only receive titles/headings/word ranges/pricing — **never unpaid body text**. Any config threading must preserve this invariant: `persona`/`guidance` are creator-authored (safe to show a model), but if `guidance` could quote article body, that is a leak vector to assess in the design doc.
- Provider wiring (`index.ts:144-183`): `OPENAI_API_KEY` absent → `new DefaultSellerAgent()` (deterministic); present → `TextCompletionSellerModelProvider("openai:" + model, fetchFn)` posting to `https://api.openai.com/v1/responses`.
- `DefaultSellerAgent` (`seller-agent/seller-agent.ts`): owns `navigate({ article, goal })` and `respond({...})` — read it during the spike; it builds the safe context from `ArticleRecord`, so it HAS access to `article.sellerAgentConfig` already.
- Call sites: `server.ts:115-130` (`buildNavigation`), `server.ts:1062+` (`runConversationTurn`).
- Tests: gateway tests cover navigation/conversation via the deterministic agent (grep `gateway.test.ts` for `seller` to find them).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build / tests | `pnpm build && pnpm --filter @rubicon-caliga/gateway test` | exit 0 |
| Typecheck / full | `pnpm typecheck && pnpm test` | exit 0 |
| Local nav probe | demo gateway (AGENTS.md command) + `curl -s "http://localhost:8787/v1/articles/article_demo/navigation?goal=pricing"` | navigation JSON |

## Scope

**In scope**:
- `docs/seller-agent-config-design.md` (create — the primary deliverable)
- `apps/gateway/src/seller-agent/model-provider.ts`, `seller-agent.ts` (prototype: context extension)
- `apps/gateway/src/index.ts` (prototype: provider selection sketch)
- `apps/gateway/src/gateway.test.ts` (one prototype test)

**Out of scope** (do NOT touch):
- `packages/core` type changes — if `SellerAgentConfig` needs new fields, that goes in the design doc's open questions, not this diff.
- Shipping a second real provider (Anthropic etc.) — design it; wire at most a stub.
- The rubicon-marketing dashboard side.
- Prompt-engineering polish; the spike proves plumbing, not quality.

## Git workflow

- Branch: `advisor/012-seller-agent-config-spike`
- Commit style: `spike(gateway): thread sellerAgentConfig into seller-agent context`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Investigate and write the design doc

Read: `SellerAgentConfig`'s definition in core; `seller-agent.ts` end to end; `model-provider.ts`; `index.ts:144-183`; the "Seller-agent configuration" section of `docs/api-contract.md`; how `persona`/`guidance` are authored in rubicon-marketing IF discoverable from this repo's docs (do not guess).

Write `docs/seller-agent-config-design.md` covering:

1. **Field-by-field safety assessment**: for each `SellerAgentConfig` field, whether passing it to a model provider can leak unpaid content (notably: can `guidance` contain article text? state the assumption and the mitigation — e.g. cap length, strip/never echo into buyer-visible rationale).
2. **Context extension**: proposed additions to `SafeArticleContext` (e.g. optional `sellerPersona?: string; sellerGuidance?: string`) and where `DefaultSellerAgent` injects them into prompts for `navigate` vs `respond`.
3. **Provider selection design**: a provider registry keyed by `model` prefix (`openai:…`, `anthropic:…`, `deterministic`), resolution order `article.sellerAgentConfig.model` → env default → deterministic; what happens when the configured provider's API key is absent (fall back + log, never fail the route).
4. **Trade-offs & open questions**: per-article model cost control (who pays for a creator picking an expensive model), caching/config-refresh semantics, whether `persona` should be echoed in `navigation.rationale` (buyer-visible), and validation limits (length caps) at the dashboard boundary.
5. **Adoption plan**: the follow-up issues/plans this spike implies, sized.

**Verify**: the doc exists and answers all five sections (`grep -c '^## ' docs/seller-agent-config-design.md` ≥ 5).

### Step 2: Minimal prototype — persona/guidance into the deterministic + model paths

1. Extend `SafeArticleContext` with optional `sellerPersona?: string` and `sellerGuidance?: string` (types only in `model-provider.ts` — no core change).
2. In `DefaultSellerAgent`, when building the safe context, populate them from `article.sellerAgentConfig` (apply a hard length cap, e.g. 500 chars each, per your design's safety section).
3. In the prompt-building path used by `TextCompletionSellerModelProvider`, include persona/guidance in the SYSTEM portion when present.
4. Deterministic provider: ignore them (no behavior change without a model key) — this keeps every existing test green.

**Verify**: `pnpm build && pnpm --filter @rubicon-caliga/gateway test` → all existing tests pass.

### Step 3: One prototype test

In `gateway.test.ts`: an article fixture with `sellerAgentConfig: { persona: "...", guidance: "..." }` (check `ArticleFixture` in `in-memory.ts` supports it; if not, add the optional field pass-through there — it is a fixture type), driven through a stub `SellerModelProvider` injected into `DefaultSellerAgent` that records the context it receives. Assert the recorded context contains the persona/guidance (capped) and NO article body text.

**Verify**: `pnpm build && pnpm --filter @rubicon-caliga/gateway test` → new test passes; `pnpm test` → exit 0.

### Step 4: Report

Your completion report lists: design-doc location, what the prototype proves, the open questions needing a product decision (from the doc), and the recommended next plan(s).

## Test plan

Step 3's context-capture test (also the leak guard: asserting body text absent from the provider context is the invariant test this feature will keep needing). Model on existing seller-agent tests found via `grep -n seller apps/gateway/src/gateway.test.ts`.

## Done criteria

- [ ] `docs/seller-agent-config-design.md` exists with the five sections
- [ ] Prototype threads persona/guidance to model providers with a length cap; deterministic path unchanged
- [ ] Context-capture test proves config reaches the provider and body text does not
- [ ] `pnpm build && pnpm typecheck && pnpm test` exit 0
- [ ] No `packages/core` files modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `SellerAgentConfig`'s actual fields differ materially from persona/model/guidance (design doc premises change).
- Threading config requires touching `packages/core` types after all.
- You cannot find where `DefaultSellerAgent` builds `SafeArticleContext` (structure drifted).
- The safety assessment concludes `guidance` is an unavoidable leak vector — stop at the design doc, skip the prototype, and say so.

## Maintenance notes

- The design doc is the artifact to review — the prototype exists to keep the doc honest.
- If DIRECTION follow-ups proceed, provider registry work should subsume the hardcoded OpenAI fetch in `index.ts:144-183`.
- Reviewers: the leak-guard test (no body text in provider context) should survive into the real implementation as a permanent regression test.
