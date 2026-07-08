# Plan 004: Make production payment configuration fail closed

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cda7cef..HEAD -- apps/gateway/src/index.ts apps/gateway/src/server.ts apps/gateway/src/repositories/postgres.ts .env.example`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (boot-time guards; only affects misconfigured deploys)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `cda7cef`, 2026-07-07

## Why this matters

The public Railway gateway's payment enforcement hinges on one exact env string. `apps/gateway/src/index.ts:51-52` selects the real Circle verifier only when `process.env.RUBICON_PAYMENTS === "circle"`; any other value — unset, `"Circle"`, a typo — silently falls through to `DevelopmentPaymentVerifier`, which accepts fabricated payment payloads and releases paid articles for free while writing receipts as if paid. The codebase already fails closed on Railway for DB misconfiguration (`assertRailwayCompatibleDatabaseUrl`), so the precedent exists; payments deserve at least the same guard. Two smaller hardenings ride along: a timing-safe API-key comparison, and honoring an operator's explicit `sslmode=verify-full` instead of silently downgrading it. Finally, `.env.example` gets the env vars the code actually reads.

## Current state

- Verifier selection, `apps/gateway/src/index.ts:51-52,92`:

```ts
const paymentVerifier: PaymentVerifier =
  process.env.RUBICON_PAYMENTS === "circle"
    ? new CircleX402PaymentVerifier({ ... })
    : new DevelopmentPaymentVerifier();
```

- The dev verifier accepts anything (`apps/gateway/src/payments/types.ts:39-53`): returns `accepted: true` for any payload unless it literally contains `reject: true`, stamping `network: "development"`. Its doc comment already says "NOT for production".
- Railway detection precedent: `apps/gateway/src/repositories/postgres.ts:69-77` — `assertRailwayCompatibleDatabaseUrl(databaseUrl, env)` early-returns unless `isRailwayRuntime(env)`. Check whether `isRailwayRuntime` is exported from `postgres.ts`; it detects Railway via env (read the function — it keys off `RAILWAY_*` env vars). It lives in the postgres module today, which the payment guard must NOT import lazily-only-when-DATABASE_URL (see Step 1).
- API-key hook, `apps/gateway/src/server.ts:91,99-108`:

```ts
const agentApiKey = process.env.RUBICON_AGENT_API_KEY;
app.addHook("onRequest", async (request, reply) => {
  if (!agentApiKey || request.url === "/health") {
    return;
  }
  const authorization = request.headers.authorization;
  const expected = `Bearer ${agentApiKey}`;
  if (authorization !== expected) {
    return reply.code(401).send({ error: "unauthorized" });
  }
});
```

  **Decided design constraint** (`docs/api-contract.md`, "Public buyer-agent API"): "Buyer endpoints under `/v1/*` are public and x402-gated — payment, not an API key, authorizes word delivery." An **unset key is by design** — do NOT make the key mandatory. Only the comparison gets hardened.
- TLS downgrade, `apps/gateway/src/repositories/postgres.ts:52-67`:

```ts
const sslMode = parsed.searchParams.get("sslmode");
if (isSupabasePoolerHost(parsed.hostname) && sslMode !== "disable") {
  config.ssl = { rejectUnauthorized: false };
}
if (sslMode === "no-verify") {
  config.ssl = { rejectUnauthorized: false };
}
```

  The pooler branch disables verification even when the operator explicitly set `sslmode=require`, `verify-ca`, or `verify-full`. The pooler workaround itself is a **documented decision** (commit 78d9601 and `.env.example:26-28` recommend `sslmode=no-verify`) — keep it for the unset/`no-verify` cases; stop overriding explicit verify intents.
- `.env.example` currently documents: GATEWAY_PORT, GATEWAY_BASE_URL, GATEWAY_FEE_BPS, SESSION_TTL_MS, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL (commented), RUN_MIGRATIONS, RUBICON_PAYMENTS, CIRCLE_CHAIN, CIRCLE_API_KEY/ENTITY_SECRET/AGENT_WALLET_ID (commented), CIRCLE_FACILITATOR_URL, CIRCLE_ARC_PRIVATE_MAINNET, CIRCLE_X402_NETWORKS, CIRCLE_X402_MAX_TIMEOUT_SECONDS (commented), CIRCLE_RPC_URL. Missing but read by code: `RUBICON_AGENT_API_KEY` (`server.ts:91`), `OPENAI_API_KEY`/`OPENAI_MODEL` (`index.ts:145,149`), `RUBICON_ARTICLES` (`index.ts:25`), `PRICE_PER_WORD_ATOMIC` + `DEMO_CREATOR_ID`/`DEMO_ARTICLE_ID`/`DEMO_CREATOR_USERNAME`/`DEMO_AUTHOR`/`DEMO_CREATOR_WALLET` (`index.ts:106-141`), `CIRCLE_SYNCHRONOUS_SETTLEMENT`, `CIRCLE_SETTLEMENT_BATCH_SIZE`, `CIRCLE_SETTLEMENT_BATCH_INTERVAL_MS` (`index.ts:63-69`).
- Existing tests for `resolvePgPoolConfig` live in `apps/gateway/src/gateway.test.ts` (~lines 876–934) — extend there.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build gateway | `pnpm --filter @rubicon-caliga/gateway build` | exit 0 |
| Gateway tests | `pnpm --filter @rubicon-caliga/gateway test` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Full suite | `pnpm build && pnpm test` | exit 0, 135+ tests |
| Local boot smoke | `cd apps/gateway && RUBICON_ARTICLES=demo RUBICON_PAYMENTS=development RUBICON_AGENT_API_KEY= DATABASE_URL= pnpm dev` | boots, logs "using in-memory runtime ledger" |

## Scope

**In scope** (modify only these):
- `apps/gateway/src/index.ts`
- `apps/gateway/src/server.ts` (the onRequest hook only)
- `apps/gateway/src/repositories/postgres.ts` (`resolvePgPoolConfig` only)
- `apps/gateway/src/gateway.test.ts` (add/extend tests)
- `.env.example`

**Out of scope** (do NOT touch):
- `payments/types.ts` — the dev verifier itself is fine for local demo use.
- Making `RUBICON_AGENT_API_KEY` required — explicitly against the documented public-API design.
- `docs/*` — plan 010 owns doc changes.
- The local `.env` / `.env.local` files (gitignored, operator-owned). Never read or echo their values.

## Git workflow

- Branch: `advisor/004-production-fail-closed`
- Commit style: `fix(gateway): fail closed on payment misconfiguration in production`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Boot guard against the dev verifier in production

In `apps/gateway/src/index.ts`, right after the `paymentVerifier` ternary (line ~92):

1. Determine "production runtime": reuse the Railway detection. If `isRailwayRuntime` is not exported from `postgres.ts`, export it (it is a pure env check — exporting it does not pull `pg` into module scope; verify `postgres.ts`'s top-level imports stay side-effect-free for this path, since `index.ts` currently imports postgres bits **dynamically** only when `DATABASE_URL` is set. If exporting would force a static import of the `pg`-typed module, instead duplicate the small env check locally in `index.ts` with a comment pointing at the original — smallness beats indirection here).
2. Guard:

```ts
const isProductionRuntime = isRailwayRuntime(process.env) || process.env.NODE_ENV === "production";
if (isProductionRuntime && process.env.RUBICON_PAYMENTS !== "circle" && process.env.RUBICON_ALLOW_DEV_PAYMENTS !== "true") {
  throw new Error(
    "[gateway] Refusing to start: production runtime detected but RUBICON_PAYMENTS is " +
      `"${process.env.RUBICON_PAYMENTS ?? "(unset)"}" — paid articles would be released without real payment. ` +
      "Set RUBICON_PAYMENTS=circle, or set RUBICON_ALLOW_DEV_PAYMENTS=true to explicitly run money-free.",
  );
}
```

3. Also log the active mode unconditionally at boot (matching the existing `console.log("[gateway] using …")` style at `index.ts:30,45,48`): `[gateway] payments: circle` or `[gateway] payments: DEVELOPMENT (no real money)`.

**Verify**: local boot smoke command (see table) still boots (no Railway env → guard inactive). Then `RAILWAY_ENVIRONMENT=production RUBICON_ARTICLES=demo RUBICON_PAYMENTS= DATABASE_URL= node dist/index.js` (after build, from `apps/gateway`) → process exits nonzero with the refusal message. (Use whichever `RAILWAY_*` variable `isRailwayRuntime` actually checks — read it first.)

### Step 2: Timing-safe API-key comparison

In `apps/gateway/src/server.ts`, replace the `!==` comparison with a constant-time check (`import { timingSafeEqual } from "node:crypto";` at top of file):

```ts
const authorization = request.headers.authorization ?? "";
const expected = `Bearer ${agentApiKey}`;
const a = Buffer.from(authorization);
const b = Buffer.from(expected);
if (a.length !== b.length || !timingSafeEqual(a, b)) {
  return reply.code(401).send({ error: "unauthorized" });
}
```

Keep the `!agentApiKey || request.url === "/health"` early return exactly as is.

**Verify**: add a gateway test (pattern: `gateway.test.ts` uses `app.inject`): with `RUBICON_AGENT_API_KEY` set in `process.env` before `createGateway`, a request without the header → 401; with the right `Bearer` → 200; then delete the env var. Note the hook reads the env at `createGateway` time, so set/unset around setup. `pnpm --filter @rubicon-caliga/gateway build && pnpm --filter @rubicon-caliga/gateway test` → pass.

### Step 3: Honor explicit sslmode verify intents

In `resolvePgPoolConfig` (`postgres.ts:52-67`), change the pooler branch so explicit verify intents win:

```ts
const sslMode = parsed.searchParams.get("sslmode");
const explicitVerify = sslMode === "require" || sslMode === "verify-ca" || sslMode === "verify-full";
if (isSupabasePoolerHost(parsed.hostname) && sslMode !== "disable" && !explicitVerify) {
  config.ssl = { rejectUnauthorized: false };
}
if (sslMode === "no-verify") {
  config.ssl = { rejectUnauthorized: false };
}
```

(Semantics: pooler host with no `sslmode` or `sslmode=no-verify` keeps today's working default; an operator who writes `verify-full` gets real verification — and owns providing a CA that makes it work.)

**Verify**: extend the existing `resolvePgPoolConfig` tests in `gateway.test.ts` (~876–934): pooler URL with no sslmode → `ssl.rejectUnauthorized === false` (unchanged); pooler URL with `sslmode=verify-full` → `config.ssl` is `undefined` (driver default verification); `sslmode=no-verify` on any host → `rejectUnauthorized: false`. Build + gateway tests pass.

### Step 4: Complete `.env.example`

Append (placeholders only — never a real value):

```bash
# --- Gateway auth (optional by design) ---
# Buyer endpoints are public and x402-gated; payment, not an API key, authorizes
# word delivery. Set this only to front the gateway with an extra auth layer.
# RUBICON_AGENT_API_KEY=

# --- Production guard ---
# On Railway/NODE_ENV=production the gateway refuses to boot unless
# RUBICON_PAYMENTS=circle. Set true ONLY to run a deliberately money-free deploy.
# RUBICON_ALLOW_DEV_PAYMENTS=false

# --- Demo article mode (local dev without Supabase) ---
# RUBICON_ARTICLES=demo
# PRICE_PER_WORD_ATOMIC=1
# DEMO_CREATOR_ID=creator_demo
# DEMO_ARTICLE_ID=article_demo
# DEMO_CREATOR_USERNAME=demo
# DEMO_AUTHOR="Rubicon Demo"
# DEMO_CREATOR_WALLET=0x2222222222222222222222222222222222222222

# --- Seller agent model (optional; deterministic fallback without it) ---
# OPENAI_API_KEY=
# OPENAI_MODEL=gpt-5.4-mini

# --- Settlement batching (defaults: batch 25, interval 250ms, async) ---
# CIRCLE_SYNCHRONOUS_SETTLEMENT=false
# CIRCLE_SETTLEMENT_BATCH_SIZE=25
# CIRCLE_SETTLEMENT_BATCH_INTERVAL_MS=250
```

**Verify**: `grep -c 'RUBICON_AGENT_API_KEY\|OPENAI_API_KEY\|RUBICON_ARTICLES\|CIRCLE_SETTLEMENT_BATCH_SIZE' .env.example` → 4. `git diff .env.example` contains no non-placeholder secrets.

### Step 5: Full regression

**Verify**: `pnpm build && pnpm typecheck && pnpm test` → exit 0, all tests (135 baseline + new) pass.

## Test plan

New tests, all in `apps/gateway/src/gateway.test.ts` following its existing `setup()`/`app.inject` pattern:
- API key: 401 without header / 200 with correct bearer (Step 2).
- `resolvePgPoolConfig`: the three sslmode cases (Step 3), added beside the existing helper tests.
- The boot guard runs before Fastify exists, so cover it with the CLI-level smoke in Step 1's verify rather than a unit test; if you can cheaply extract the guard into an exported pure function (e.g. `assertProductionPaymentMode(env)`) in `index.ts`… do NOT create a new module for it; only extract if `index.ts` can export it without executing its top-level boot code on import (it cannot — `index.ts` boots at import). So: smoke-verify only, and say so in your report.

## Done criteria

- [ ] Railway-simulated boot with `RUBICON_PAYMENTS` unset exits nonzero with the refusal message; with `RUBICON_ALLOW_DEV_PAYMENTS=true` it boots
- [ ] Boot log always states the active payment mode
- [ ] API-key comparison uses `timingSafeEqual`; unset key still means open access; `/health` always open
- [ ] `resolvePgPoolConfig` honors `verify-full`/`verify-ca`/`require` on pooler hosts; existing no-verify behavior unchanged
- [ ] `.env.example` documents every env var listed in Current state, placeholders only
- [ ] `pnpm build && pnpm typecheck && pnpm test` exit 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Exporting/duplicating `isRailwayRuntime` would require a static import that pulls the `pg` module into `index.ts`'s import graph (breaking the optional-dependency dance) — report and propose the local-duplication fallback explicitly.
- The onRequest hook's shape at `server.ts:99-108` has drifted from the excerpt.
- Any existing gateway test fails after Step 3 — the sslmode matrix may be covered by tests asserting today's downgrade behavior; reconcile the test intent, don't just invert assertions.
- You find any real credential value while editing `.env.example` — never copy it; reference location + type in your report and recommend rotation.

## Maintenance notes

- If a multi-instance or multi-tenant deployment ever hands out per-tenant API keys, the shared-key model (and the session-abort/SSE routes being key-only) must be revisited — sessions would need caller binding. Documented assumption today: single trust domain.
- `RUBICON_ALLOW_DEV_PAYMENTS` is an escape hatch for demo deploys; if it starts appearing in production configs, that's config drift worth alerting on.
- Reviewers: confirm Step 1's guard runs before any `listen()` and cannot be reached with a half-started server.
