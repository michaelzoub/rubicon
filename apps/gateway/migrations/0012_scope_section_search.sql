-- Add an article-and-revision-scoped overload alongside the legacy global RPC.
-- The legacy function remains available so older gateway instances and shared
-- staging/production deployments can roll forward without a breaking schema
-- change. The gateway prefers this scoped overload and has a temporary
-- compatibility fallback for databases whose schema cache has not refreshed.

create or replace function search_article_sections(
  query_embedding vector(1536),
  target_article_id text,
  target_revision integer,
  match_count integer default 3
)
returns table (article_id text, section_id text, revision integer, similarity real)
language sql stable security definer
as $$
  select e.article_id, e.section_id, e.revision,
         (1 - (e.embedding <=> query_embedding))::real as similarity
  from article_section_embeddings e
  join articles a on a.id = e.article_id
  where a.state = 'live'
    and a.id = target_article_id
    and a.revision = target_revision
    and e.article_id = target_article_id
    and e.revision = target_revision
  order by e.embedding <=> query_embedding asc
  limit greatest(1, least(match_count, 10));
$$;

grant execute on function search_article_sections(vector, text, integer, integer) to anon;
