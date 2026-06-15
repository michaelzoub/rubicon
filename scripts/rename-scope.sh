#!/usr/bin/env bash
# Rename the npm scope across the whole monorepo.
#
#   ./scripts/rename-scope.sh rubicons      # @rubicon/* -> @rubicons/*
#
# Only the scope prefix "@rubicon/" is replaced (package names, workspace deps,
# imports, README, repository.directory). The repo directory name, git remote,
# and prose are untouched. Run from the repo root, then `pnpm install` + build.
set -euo pipefail

NEW_SCOPE="${1:-}"
if [[ -z "$NEW_SCOPE" ]]; then
  echo "usage: $0 <new-scope>   (e.g. rubicons, caliga)" >&2
  exit 1
fi
NEW_SCOPE="${NEW_SCOPE#@}"   # tolerate a leading @

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FILES="$(grep -rl "@rubicon/" . \
  --include="*.json" --include="*.ts" --include="*.md" \
  | grep -vE "node_modules|/dist/")"

if [[ -z "$FILES" ]]; then
  echo "No @rubicon/ references found (already renamed?)."
  exit 0
fi

while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  perl -pi -e "s{\@rubicon/}{\@${NEW_SCOPE}/}g" "$f"
  echo "updated $f"
done <<< "$FILES"

echo
echo "Done. @rubicon/* -> @${NEW_SCOPE}/*"
echo "Next:"
echo "  pnpm install"
echo "  pnpm --filter @${NEW_SCOPE}/core --filter @${NEW_SCOPE}/agent-sdk --filter @${NEW_SCOPE}/provider-sdk build"
