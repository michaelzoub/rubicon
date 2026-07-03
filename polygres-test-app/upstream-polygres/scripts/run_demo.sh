#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Docker Desktop keeps its credential helper here on macOS. Adding the bundled
# tools avoids failures when /usr/local/bin contains an old volume symlink.
if [[ -d /Applications/Docker.app/Contents/Resources/bin ]]; then
  export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
fi

docker compose up -d --wait postgres
python3 scripts/seed_and_build.py

echo
echo "Demo: http://localhost:8000"
echo "Press Ctrl-C to stop the web server (Postgres remains available)."
python3 -m http.server 8000 --directory public
