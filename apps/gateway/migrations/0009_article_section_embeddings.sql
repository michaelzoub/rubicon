-- Per-section embeddings for semantic search.
--
-- WRITTEN by rubicon-marketing at article publish time (state -> 'live') and on
-- every revision bump. The Rubicon gateway is READ-ONLY here: it calls
-- search_article_sections() via supabase.rpc() and never inserts or updates rows.
--
-- Model: text-embedding-3-small, EXACTLY 1536 dimensions (no truncation).
-- See docs/embeddings-contract.md for the full write-side contract.

-- pgvector is normally allow-listed on Supabase. If the project disallows it,
-- escalate to the DB owner (Plan 013 STOP condition).
create extension if not exists vector;

create table if not exists article_section_embeddings (
  article_id   text not null references articles(id) on delete cascade,
  section_id   text not null,          -- matches article_sections.section_id
  revision     integer not null,        -- matches articles.revision at embed time
  embedding    vector(1536) not null,   -- text-embedding-3-small, EXACTLY 1536 dims
  content_hash text not null,           -- sha256 of the embedded input; skip re-embed if unchanged
  model        text not null default 'text-embedding-3-small',
  updated_at   timestamptz not null default now(),
  primary key (article_id, section_id)
);

-- Cosine HNSW index for fast top-k similarity search.
create index if not exists article_section_embeddings_hnsw
  on article_section_embeddings using hnsw (embedding vector_cosine_ops);

-- RLS: mirror the public-read policy established in migration 0003 so the role
-- the gateway reads with (see supabase.ts createSupabaseClientFromEnv) can
-- SELECT, and the search RPC below can read embeddings for live articles.
alter table article_section_embeddings enable row level security;

drop policy if exists "anon can read embeddings for live articles" on article_section_embeddings;
create policy "anon can read embeddings for live articles"
  on article_section_embeddings
  for select
  to anon
  using (
    exists (
      select 1
      from articles
      where articles.id = article_section_embeddings.article_id
        and articles.state = 'live'
    )
  );

-- Read-side RPC the gateway calls via supabase.rpc(). Returns cosine similarity
-- for sections of LIVE articles only, ordered by similarity descending, limited
-- to match_count. The join on articles(state = 'live') filters stale/deleted
-- content at the database level so the gateway never sees embeddings for
-- non-public articles.
create or replace function search_article_sections(
  query_embedding vector(1536),
  match_count integer default 40
)
returns table (article_id text, section_id text, revision integer, similarity real)
language sql stable security definer
as $$
  select e.article_id, e.section_id, e.revision,
         (1 - (e.embedding <=> query_embedding))::real as similarity
  from article_section_embeddings e
  join articles a on a.id = e.article_id
  where a.state = 'live'
  order by e.embedding <=> query_embedding asc
  limit match_count;
$$;

-- Grant execute to the gateway's role (anon), consistent with migration 0003.
grant execute on function search_article_sections(vector, integer) to anon;
