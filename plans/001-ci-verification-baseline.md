# Plan 001: Add CI and make the repo's verification commands honest

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cda7cef..HEAD -- package.json packages/*/package.json apps/gateway/package.json .github/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `cda7cef`, 2026-07-07

## Why this matters

This repo moves real USDC (per-word article payments) and auto-deploys to Railway, but has **no CI whatsoever** — there is no `.github/` directory. Nothing enforces that `build`, `typecheck`, and `test` pass before a merge. Worse, the verification commands lie: every package's `lint` script is an exact duplicate of its `typecheck` script (`tsc --noEmit`), and `pnpm test` runs compiled files in `dist/` for core/agent-sdk/gateway, so on a fresh or freshly-edited tree it tests **stale or missing output** and can report green for broken code. This plan adds a CI pipeline and makes the local commands trustworthy. It is the prerequisite safety net for the settlement refactors in plans 005–007.

## Current state

- Repo: pnpm 9 workspace (`packageManager: "pnpm@9.15.0"` in root `package.json`), TypeScript ESM, Node 20+. Workspaces: `packages/core`, `packages/agent-sdk`, `packages/cli`, `apps/gateway`, `examples/agent-client`.
- No `.github/` directory exists (verified: `ls .github` → no such file). Deployment is Railway via `railway.json`.
- Root `package.json` scripts (excerpt):
  ```json
  "scripts": {
    "build": "pnpm -r build",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test"
  }
  ```
- Every package has this identical pair (e.g. `packages/core/package.json`):
  ```json
  "lint": "tsc -p tsconfig.json --noEmit",
  "typecheck": "tsc -p tsconfig.json --noEmit"
  ```
- Test scripts differ per package:
  - `packages/core`, `packages/agent-sdk`: `node --test dist/**/*.test.js` (requires prior build)
  - `apps/gateway`: `node --test dist/gateway.test.js dist/payments/*.test.js` (requires prior build)
  - `packages/cli`: `node --import tsx --test src/**/*.test.ts` (runs from source, no build needed)
- Current baseline (verified 2026-07-07): after `pnpm build`, `pnpm test` passes with 135 tests (gateway 49, agent-sdk 22, cli 64, core 0).
- `AGENTS.md` ("Repo basics") says "`pnpm typecheck` and `pnpm test` must pass before committing" without mentioning the build prerequisite. (Fixing that sentence is plan 010's job — do not edit `AGENTS.md` here.)

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Install   | `pnpm install`           | exit 0              |
| Build     | `pnpm build`             | exit 0              |
| Typecheck | `pnpm typecheck`         | exit 0, no errors   |
| Tests     | `pnpm test`              | exit 0, 135+ tests pass |

## Scope

**In scope** (the only files you should modify/create):
- `.github/workflows/ci.yml` (create)
- `package.json` (root — scripts only)
- `packages/core/package.json`, `packages/agent-sdk/package.json`, `packages/cli/package.json`, `apps/gateway/package.json`, `examples/agent-client/package.json` (scripts only)
- `eslint.config.mjs` (create, root)
- Source files ONLY where an ESLint `no-floating-promises` violation requires an `await`/`void` fix (see Step 3 limits)

**Out of scope** (do NOT touch):
- `railway.json` — deployment config, unrelated.
- `AGENTS.md`, `README.md`, `skill.md` — doc updates belong to plan 010; `skill.md` has an external publication sync procedure you must not trigger.
- Any behavioral code change beyond adding `await`/`void` operators for lint violations.

## Git workflow

- Branch: `advisor/001-ci-verification-baseline`
- Commit style: conventional prefixes as in `git log` (e.g. `feat: added cli`, `fix: lockfile`) — use `feat(ci): add GitHub Actions pipeline and honest lint`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Make `pnpm test` self-sufficient

In the **root** `package.json`, change the `test` script so the dist-based suites can never run stale:

```json
"test": "pnpm build && pnpm -r test"
```

Leave per-package `test` scripts unchanged (they are correct when dist is fresh, and CI/devs invoke the root script).

**Verify**: `pnpm test` from a clean tree (`rm -rf packages/*/dist apps/gateway/dist` first) → exit 0, all suites run, no "Cannot find module … dist" errors.

### Step 2: Add the CI workflow

Create `.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm lint
```

(`pnpm test` includes the build after Step 1. `pnpm lint` becomes real in Step 3; if you must land this before Step 3, omit that line and add it in Step 3.)

**Verify**: `node -e "require('js-yaml')"` is NOT available — instead validate YAML with `npx --yes yaml-lint .github/workflows/ci.yml` → "valid", or simply `node --input-type=module -e "import('node:fs').then(async fs=>console.log((await fs.promises.readFile('.github/workflows/ci.yml','utf8')).length>0))"` → true, and rely on the STOP condition if GitHub rejects it later.

### Step 3: Replace the fake `lint` with a minimal real linter

The current `lint` script duplicates `typecheck` and catches nothing. Replace it with ESLint configured for exactly the async-money hazards this codebase has (unawaited settlement promises), not a full style regime.

1. Add dev deps at the **root**: `pnpm add -D -w eslint typescript-eslint`
2. Create `eslint.config.mjs` at the root:

```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "polygres-test-app/**", "docs/**", "scripts/**"],
  },
  {
    files: ["packages/*/src/**/*.ts", "apps/gateway/src/**/*.ts", "examples/*/src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
    },
  },
);
```

3. Change the **root** `lint` script to `"lint": "eslint ."` and **delete** the per-package `lint` scripts (they are now misleading duplicates; root lint covers all packages).
4. Run `pnpm lint`. For each violation: if it is a genuinely fire-and-forget promise that is intentional (the codebase uses `void this.flush()` in `apps/gateway/src/payments/settlement-queue.ts:30,34` — already compliant), prefix with `void `; if a promise should have been awaited, add `await` only when the enclosing function is already `async` and the call site's semantics clearly expect completion; otherwise use `void`. Do not restructure code.

**Verify**: `pnpm lint` → exit 0. `pnpm typecheck && pnpm test` → still exit 0, still 135+ tests.

### Step 4: Confirm the whole gate

**Verify**: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm lint` → all exit 0.

## Test plan

No new unit tests — this plan's product is the pipeline itself. The verification is the full command gate in Step 4 plus CI going green on the first push (operator's job to observe).

## Done criteria

- [ ] `.github/workflows/ci.yml` exists and lists install → typecheck → test → lint
- [ ] Root `package.json` `test` script starts with `pnpm build &&`
- [ ] `grep -l '"lint": "tsc' packages/*/package.json apps/*/package.json examples/*/package.json` returns no matches
- [ ] `pnpm lint` exits 0 with the two async rules enabled
- [ ] `pnpm test` from a tree with deleted `dist/` dirs exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `pnpm lint` reports **more than 20 violations** — the rule set needs a human decision about suppressions vs fixes.
- Any `no-floating-promises` fix would change behavior on a payment path (`apps/gateway/src/payments/`, `apps/gateway/src/workflows/`) in a way you cannot verify with the existing tests — flag the call site instead of guessing.
- `typescript-eslint`'s `projectService` cannot resolve the workspace tsconfigs (monorepo path issues) after one reasonable fix attempt.
- The 135-test baseline drops for any reason.

## Maintenance notes

- Plan 003 (ledger contract suite) will want a `postgres` service container added to this workflow; leave a comment slot in `ci.yml` if convenient but do not add the service now.
- Reviewers should scrutinize every added `await` in Step 3 — an `await` inserted on a previously fire-and-forget promise inside a request handler changes latency and error propagation.
- Deferred deliberately: formatter (prettier/biome), pre-commit hooks, broader ESLint rules. Revisit once the money-path plans (005–007) land.
