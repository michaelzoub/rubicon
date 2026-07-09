# Embeddings write contract (rubicon-marketing)

This document specifies what the **rubicon-marketing** repository MUST do to
maintain the `article_section_embeddings` table. The Rubicon gateway (this repo)
is **read-only** on the index and falls back to lexical scoring when embeddings
are missing, stale, or when `OPENAI_API_KEY` is unset.

## Schema

Owned by this repo in `apps/gateway/migrations/0009_article_section_embeddings.sql`:

| Column         | Type             | Notes                                              |
| -------------- | ---------------- | -------------------------------------------------- |
| `article_id`   | `text`           | FK to `articles(id)` on delete cascade             |
| `section_id`   | `text`           | Matches `article_sections.section_id`              |
| `revision`     | `integer`        | Matches `articles.revision` at embed time          |
| `embedding`    | `vector(1536)`   | `text-embedding-3-small`, EXACTLY 1536 dimensions  |
| `content_hash` | `text`           | sha256 of the embedded input; skip re-embed if unchanged |
| `model`        | `text`           | Defaults to `text-embedding-3-small`               |
| `updated_at`   | `timestamptz`    | Auto-updated on write                              |

Primary key: `(article_id, section_id)`.

## When to write

- **On publish**: when an article's state transitions to `live`.
- **On revision bump**: every time `articles.revision` increases.
- **On section add/change**: when a section's heading or body text changes.
- **On section remove**: delete the row for the removed `section_id`.
- **On unpublish/delete**: delete all rows for the article (the `on delete
  cascade` on the FK covers hard deletes; for soft deletes where `state` changes
  away from `live`, explicitly delete the embedding rows so stale results do not
  surface before the article is hard-deleted).

## What to embed (per section)

For each section, embed the concatenation:

```
`${title}\n${heading}\n${sectionBodyText}`
```

- `title`: the article title.
- `heading`: the section heading.
- `sectionBodyText`: the section's slice of the article body (the words from
  `word_start` to `word_start + word_count`).

## Model and dimensions

- **Model**: `text-embedding-3-small`
- **Dimensions**: EXACTLY `1536`. Do **not** pass a `dimensions` truncation
  parameter. The `vector(1536)` column will reject inserts with a different
  dimension count.
- **Assert** the returned embedding length is 1536 before inserting; reject
  otherwise.

## Upsert behavior

- Keyed on `(article_id, section_id)`.
- Compute `content_hash` = sha256 of the embedded input text.
- If the stored `content_hash` matches the new one, **skip the OpenAI call** (the
  content has not changed) and leave the row as-is.
- Otherwise, call the embeddings API and upsert the row with the new embedding,
  `revision`, `content_hash`, `model`, and `updated_at = now()`.

## Gateway tolerance (read side)

The gateway tolerates lag and absence:

- Any live article whose `revision` has no matching embedding rows (or a stale
  `revision`) is scored **lexically** by the gateway and reported as
  `mode: "lexical"`.
- When `OPENAI_API_KEY` is unset (demo/in-memory mode), the gateway never calls
  OpenAI and always uses lexical scoring.
- The search RPC (`search_article_sections`) joins on `articles.state = 'live'`
  so embeddings for draft/paused/deleted articles never surface.
