# Plan 010: Fix the three places the docs contradict the code

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cda7cef..HEAD -- docs/api-contract.md README.md AGENTS.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `cda7cef`, 2026-07-07

## Why this matters

Three doc statements are actively wrong (worse than missing — they misconfigure readers):

1. `docs/api-contract.md` says the SDK's default base URL is `http://localhost:8787`. The SDK actually defaults to the **hosted gateway** (`HOSTED_GATEWAY_URL = "https://rubicon-caligagateway-production.up.railway.app"`, `packages/agent-sdk/src/agent-client.ts:139,154`) — a deliberate product decision (PRD US-010) already documented correctly in `packages/agent-sdk/README.md:56-59`. A contract-doc reader points at a non-running localhost.
2. `README.md` still teaches `buy --first` in all three quickstart examples; the PRD (US-003, `passes: true`) removed the `--first` ceremony and `showHelp()` (`packages/cli/src/index.ts:663-667`) no longer lists it. The flag still parses, but the README models the exact friction the product removed.
3. `AGENTS.md` tells agents "`pnpm typecheck` and `pnpm test` must pass before committing" without the `pnpm build` prerequisite — but gateway/core/sdk tests run compiled `dist/**` output (documented only at `README.md:289-290`), so an agent following `AGENTS.md` verbatim tests stale code. (If plan 001 landed, root `pnpm test` now builds first — check, and phrase the fix accordingly.)

## Current state

- `docs/api-contract.md:68-69`:

```
- **Base URL**: configure via `GATEWAY_BASE_URL` (server) and the SDK
  `RubiconClient({ baseUrl })`. Default `http://localhost:8787`.
```

- `README.md:182,222,223`:

```
pnpm dev:cli -- buy --first --goal "find pricing" --max-usdc 0.10 --json
...
pnpm dev:cli -- buy --first --goal "find pricing" --max-usdc 0.10 --json
pnpm dev:cli -- buy --first --goal "find pricing" --max-usdc 0.10 --granularity 10 --json
```

- `AGENTS.md`, "Repo basics" section: "Per package: `pnpm typecheck` and `pnpm test` must pass before committing."
- **Publication hazard**: the root `skill.md` is published verbatim to sibling repos with a versioned sync procedure (`AGENTS.md` "skill.md is published — keep copies in sync"; `.agents/skills/sync-skill-md/SKILL.md`). This plan must NOT touch `skill.md`. The three files above have no such procedure.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Confirm SDK default | `grep -n 'HOSTED_GATEWAY_URL' packages/agent-sdk/src/agent-client.ts` | shows the Railway URL constant and its use as `baseUrl` default |
| Confirm help text | `grep -n 'first' packages/cli/src/index.ts` | `--first` absent from `showHelp()` buy usage |
| Full suite (docs can't break it, run anyway) | `pnpm test` | exit 0 |

## Scope

**In scope**:
- `docs/api-contract.md` (the Base URL bullet only)
- `README.md` (the three `--first` example lines only)
- `AGENTS.md` (the one "Repo basics" sentence + the dist-CLI example note)

**Out of scope** (do NOT touch):
- `skill.md` — published artifact with its own sync/versioning procedure.
- `packages/agent-sdk/README.md` — already correct.
- Any code. If you find further doc/code contradictions while editing, list them in your report; don't expand the diff.

## Git workflow

- Branch: `advisor/010-docs-sync`
- Commit style: `docs: align api-contract, README, AGENTS.md with shipped behavior`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: api-contract.md base-URL bullet

Replace the bullet with (keep surrounding formatting):

```
- **Base URL**: the server binds per `GATEWAY_BASE_URL`/`PORT` (local default
  `http://localhost:8787`). The SDK's `RubiconClient({ baseUrl })` defaults to
  the hosted gateway (`HOSTED_GATEWAY_URL`,
  `https://rubicon-caligagateway-production.up.railway.app`); pass `baseUrl`
  explicitly to target a local or self-hosted gateway.
```

**Verify**: `grep -n 'localhost:8787' docs/api-contract.md` → only the server-side mention remains (line count in that bullet: 1).

### Step 2: README `--first` removal

Delete ` --first` from the three example lines (182, 222, 223 — re-locate by grep, not line number). Do not remove the flag from any prose that documents it as an *optional* narrowing flag if such prose exists (grep first; if README explains `--first` semantics somewhere, leave the explanation, fix only the "default path" examples).

**Verify**: `grep -c 'buy --first' README.md` → 0.

### Step 3: AGENTS.md build prerequisite

In "Repo basics", change the sentence to: "Per package: `pnpm build` then `pnpm typecheck` and `pnpm test` must pass before committing — gateway/core/sdk tests execute compiled `dist/**` output, so an unbuilt tree tests stale code." If plan 001 landed (root `test` script starts with `pnpm build &&`), instead say: "Run `pnpm test` from the repo root (it builds first); per-package test runs need a prior `pnpm build`." Also note the same caveat applies to the `node packages/cli/dist/index.js …` example later in the file.

**Verify**: `grep -n 'pnpm build' AGENTS.md` → at least one hit in Repo basics.

### Step 4: Regression

**Verify**: `pnpm test` → exit 0 (unchanged); `git diff --stat` shows exactly the three files.

## Test plan

None (docs only). The greps in each step are the machine checks.

## Done criteria

- [ ] `grep -c 'buy --first' README.md` → 0
- [ ] api-contract.md states the hosted-gateway SDK default and the explicit-override path
- [ ] AGENTS.md states the build-before-test requirement
- [ ] `skill.md` untouched (`git diff --name-only` does not list it)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `HOSTED_GATEWAY_URL` no longer matches the Railway URL quoted above (the hosted gateway may have moved — copy the live constant, and flag that this plan's text was stale).
- You find `--first` still listed in `showHelp()` (would contradict the premise — re-verify before editing README).
- Anything tempts you to edit `skill.md`.

## Maintenance notes

- These three files have no drift guard. Cheap follow-up idea (not in scope): a doc-lint script that greps docs for the hosted URL and flag examples against `showHelp()` output.
- Reviewers: confirm the api-contract wording keeps the server/SDK distinction — collapsing them is how the original error happened.
