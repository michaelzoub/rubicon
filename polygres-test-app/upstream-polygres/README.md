# Polygres authorship graph demo

A runnable local demo of a one-way semantic-ish relationship:

```text
users.username --AUTHORED(score)--> articles.author
```

The fake-data script compares every `users.username` with every
`articles.author`, keeps matches at or above a configurable threshold,
materializes those matches in `authorship_edges`, and registers that edge table
with the real [pgGraph](https://github.com/Evokoa/pgGraph) PostgreSQL extension.

## Run it

Requirements: Docker Desktop and Python 3.9+.

The compose file currently pins pgGraph `0.1.7`: the upstream repository has a
`0.1.8` release, but its matching GHCR image was not available when this demo
was verified.

```bash
./scripts/run_demo.sh
```

Then open <http://localhost:8000>. Stop the database with:

```bash
docker compose down
```

To change the acceptance threshold:

```bash
MATCH_THRESHOLD=0.72 ./scripts/run_demo.sh
```

## What is real, and what is a demo

- **Real pgGraph:** `graph.add_table`, a unidirectional `graph.add_edge`,
  `graph.build()`, and `graph.traverse()` all run in PostgreSQL.
- **Fake data:** four users and six articles, reset on every run.
- **Local scorer:** a deterministic name matcher combining normalized token,
  character n-gram cosine, and sequence similarity. It recognizes handles such
  as `ada_lovelace` vs. `Ada Lovelace` without an API key.
- **Not a language embedding:** lexical name matching is the right no-key test
  double for this dataset, but it will not infer that `database_witch` and
  `Maya Chen` are the same person. In production, replace `similarity()` in
  `scripts/seed_and_build.py` with an embedding/cross-encoder score. The edge
  materialization and pgGraph code stays unchanged.

The cloned Polygres Python SDK is in `../vendor/polygres-sdk`. It targets a
hosted Polygres Runtime API, not a direct PostgreSQL connection, so this local
demo deliberately exercises pgGraph through SQL. `scripts/sdk_example.py`
shows the equivalent hosted traversal once `POLYGRES_API_KEY` and
`POLYGRES_RUNTIME_URL` are available.

## Files

- `scripts/seed_and_build.py` — fake data, scoring, edge materialization,
  pgGraph registration/traversal, and UI JSON generation.
- `scripts/run_demo.sh` — boots pgGraph, runs the script, and serves the app.
- `public/index.html` — zero-build graph/table UI.
- `scripts/sdk_example.py` — optional hosted Polygres SDK query.
