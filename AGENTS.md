# Agent instructions for the Rubicon repo

## Project orientation

Before making code changes, read:

`.agents/skills/project-map/SKILL.md`

Use it as the repo orientation map.

Update the project map whenever your change:

- adds, removes, or renames important routes, commands, packages, or entrypoints
- changes auth, analytics, payments, imports, API, database, or dashboard architecture
- moves shared components or shared libraries
- introduces or removes major dependencies
- deprecates important files
- changes build, test, lint, or dev commands
- performs a big refactor

Keep the map concise and accurate. Do not turn it into a full implementation log.

## skill.md is published — keep copies in sync

The root `skill.md` is the canonical Rubicon agent runbook. It is served to real
agents from sibling repos that share this repo's parent directory:

- `../rubicon-marketing/public/skill.md` (live)
- `../rubicon-app/public/skill.md` (if present)

If you change `skill.md` here, you must bump its frontmatter `version:` and copy
it verbatim to those locations in the same session. Never edit the `public/`
copies directly. Full procedure: `.agents/skills/sync-skill-md/SKILL.md`.

Before syncing, confirm any `@rubicon-caliga/cli@X.Y.Z` version the runbook pins
is actually published to npm; the marketing copy goes live immediately.

## Repo basics

- pnpm workspace: `packages/core`, `packages/agent-sdk`, `packages/cli`,
  `apps/gateway`.
- Per package: `pnpm typecheck` and `pnpm test` must pass before committing.
- Local gateway for agent-flow testing:
  `cd apps/gateway && APP_ENV=development RUBICON_ARTICLES=demo RUBICON_PAYMENTS=development RUBICON_AGENT_API_KEY= DATABASE_URL= pnpm dev`
  then `node packages/cli/dist/index.js buy --goal "<goal>" --max-usdc 0.0001 --gateway-url http://localhost:8787 --json`.
