-- Public repository reads use the Supabase anon role. These policies expose
-- only records required to list and consume live articles.

ALTER TABLE creators ENABLE ROW LEVEL SECURITY;
ALTER TABLE articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE article_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE creator_wallets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon can read creators with live articles" ON creators;
CREATE POLICY "anon can read creators with live articles"
  ON creators
  FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1
      FROM articles
      WHERE articles.creator_id = creators.id
        AND articles.state = 'live'
    )
  );

DROP POLICY IF EXISTS "anon can read live articles" ON articles;
CREATE POLICY "anon can read live articles"
  ON articles
  FOR SELECT
  TO anon
  USING (state = 'live');

DROP POLICY IF EXISTS "anon can read sections for live articles" ON article_sections;
CREATE POLICY "anon can read sections for live articles"
  ON article_sections
  FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1
      FROM articles
      WHERE articles.id = article_sections.article_id
        AND articles.state = 'live'
    )
  );

DROP POLICY IF EXISTS "anon can read verified wallets for live article creators" ON creator_wallets;
CREATE POLICY "anon can read verified wallets for live article creators"
  ON creator_wallets
  FOR SELECT
  TO anon
  USING (
    verified = true
    AND EXISTS (
      SELECT 1
      FROM articles
      WHERE articles.creator_id = creator_wallets.creator_id
        AND articles.state = 'live'
    )
  );
