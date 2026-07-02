# Agent instructions for the Rubicon repo

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
  `cd apps/gateway && RUBICON_ARTICLES=demo RUBICON_PAYMENTS=development RUBICON_AGENT_API_KEY= DATABASE_URL= pnpm dev`
  then `node packages/cli/dist/index.js buy --goal "<goal>" --max-usdc 0.0001 --gateway-url http://localhost:8787 --json`.
