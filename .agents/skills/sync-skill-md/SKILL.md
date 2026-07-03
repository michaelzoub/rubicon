---
name: sync-skill-md
description: Keep the hosted Rubicon agent runbook in sync. Use whenever /skill.md in this repo is created, edited, reviewed, or versioned — the same file is published from the rubicon-marketing repo and must not drift. Triggers on skill.md, agent runbook, hosted runbook, runbook sync, publish skill.
---

# Sync skill.md to rubicon-marketing

The root `skill.md` in this repo is the **canonical source** of the Rubicon agent
runbook. The copy that agents actually fetch is served from the marketing site at:

```
../rubicon-marketing/public/skill.md
```

(both repos share the parent directory `/Users/michaelzoubkoff/Documents`).

## Rule

Any time you modify `skill.md` in this repo, you MUST also update the
rubicon-marketing copy in the same session:

1. Bump `version:` in the frontmatter of the root `skill.md` (semver: patch for
   wording fixes, minor for behavior/command changes).
2. Copy the root `skill.md` verbatim to `../rubicon-marketing/public/skill.md`.
3. Verify the two files are identical: `diff skill.md ../rubicon-marketing/public/skill.md`
   must produce no output.
4. If `../rubicon-app/public/skill.md` exists, sync it the same way — it is a
   third copy of the same file.

## Version safety

Before syncing, check every `@rubicon-caliga/cli@X.Y.Z` reference in the runbook
against `packages/cli/package.json`. If the runbook references a CLI version that
is not yet published to npm (`npm view @rubicon-caliga/cli version`), warn the
user: the marketing copy goes live for real agents immediately, so it must only
be deployed after that CLI version is published.

## Never

- Never let the copies drift: do not make marketing-only edits to
  `public/skill.md`; edit the canonical root file and sync.
- Never sync without bumping the frontmatter version when content changed.
