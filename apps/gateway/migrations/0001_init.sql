-- Rubicon shared persistent data model.
--
-- This schema is shared with rubicon-marketing. The marketing app owns creator
-- authentication and creator-facing CRUD for creators, wallets, articles,
-- revisions, and sections. Rubicon reads published data and writes runtime
-- stream/word/payment/earnings activity.
--
-- Pricing units are atomic USDC (1 USDC = 1_000_000), stored as exact TEXT.
-- Article state lifecycle: draft | live | paused | archived | deleted.
-- Only `live` articles may be consumed by buyer agents.

CREATE TABLE IF NOT EXISTS creators (
  id           TEXT PRIMARY KEY,
  username     TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creator_profiles (
  creator_id TEXT PRIMARY KEY REFERENCES creators(id) ON DELETE CASCADE,
  bio        TEXT,
  avatar_url TEXT
);

CREATE TABLE IF NOT EXISTS creator_wallets (
  creator_id TEXT PRIMARY KEY REFERENCES creators(id) ON DELETE CASCADE,
  address    TEXT NOT NULL,
  network    TEXT NOT NULL,
  verified   BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS articles (
  id                       TEXT PRIMARY KEY,
  creator_id               TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  title                    TEXT NOT NULL,
  author                   TEXT NOT NULL,
  state                    TEXT NOT NULL DEFAULT 'draft'
                             CHECK (state IN ('draft','live','paused','archived','deleted')),
  price_per_word_atomic    TEXT NOT NULL,
  max_article_price_atomic TEXT,
  total_words              INTEGER NOT NULL DEFAULT 0,
  revision                 INTEGER NOT NULL DEFAULT 1,
  seller_agent_config      JSONB,
  body                     TEXT NOT NULL DEFAULT '',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS articles_state_idx ON articles(state);
CREATE INDEX IF NOT EXISTS articles_creator_idx ON articles(creator_id);

CREATE TABLE IF NOT EXISTS article_revisions (
  id         TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  revision   INTEGER NOT NULL,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (article_id, revision)
);

CREATE TABLE IF NOT EXISTS article_sections (
  id         TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  section_id TEXT NOT NULL,
  heading    TEXT NOT NULL,
  level      INTEGER NOT NULL DEFAULT 1,
  word_start INTEGER NOT NULL,
  word_count INTEGER NOT NULL,
  ordinal    INTEGER NOT NULL,
  UNIQUE (article_id, section_id)
);

CREATE TABLE IF NOT EXISTS stream_sessions (
  id                    TEXT PRIMARY KEY,
  article_id            TEXT NOT NULL REFERENCES articles(id),
  creator_id            TEXT NOT NULL REFERENCES creators(id),
  conversation_id       TEXT,
  state                 TEXT NOT NULL,
  goal                  TEXT,
  section_id            TEXT,
  price_per_word_atomic TEXT NOT NULL,
  gateway_fee_bps       INTEGER NOT NULL DEFAULT 0,
  seller_wallet         TEXT NOT NULL,
  budget_atomic         TEXT NOT NULL,
  words_paid            INTEGER NOT NULL DEFAULT 0,
  words_delivered       INTEGER NOT NULL DEFAULT 0,
  paid_atomic           TEXT NOT NULL DEFAULT '0',
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS seller_agent_conversations (
  id         TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id),
  creator_id TEXT NOT NULL REFERENCES creators(id),
  goal       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seller_agent_messages (
  id                    TEXT PRIMARY KEY,
  conversation_id       TEXT NOT NULL REFERENCES seller_agent_conversations(id) ON DELETE CASCADE,
  article_id            TEXT NOT NULL,
  session_id            TEXT,
  role                  TEXT NOT NULL CHECK (role IN ('buyer','seller')),
  content               TEXT NOT NULL,
  recommended_section_id TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS seller_agent_messages_conversation_idx
  ON seller_agent_messages(conversation_id);

-- One row per delivered word. A word is never delivered twice for a session.
CREATE TABLE IF NOT EXISTS word_deliveries (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES stream_sessions(id),
  article_id      TEXT NOT NULL,
  sequence        INTEGER NOT NULL,
  word            TEXT NOT NULL,
  price_atomic    TEXT NOT NULL,
  payment_id      TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, sequence),
  UNIQUE (idempotency_key)
);

-- One payment per delivered word. Retries reuse idempotency_key (no double charge).
CREATE TABLE IF NOT EXISTS word_payments (
  id                   TEXT PRIMARY KEY,
  payment_id           TEXT NOT NULL UNIQUE,
  session_id           TEXT NOT NULL REFERENCES stream_sessions(id),
  article_id           TEXT NOT NULL,
  creator_id           TEXT NOT NULL,
  sequence             INTEGER NOT NULL,
  amount_atomic        TEXT NOT NULL,
  creator_amount_atomic TEXT NOT NULL,
  rubicon_fee_atomic   TEXT NOT NULL,
  transfer_id          TEXT,
  idempotency_key      TEXT NOT NULL UNIQUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS word_payments_article_idx ON word_payments(article_id);
CREATE INDEX IF NOT EXISTS word_payments_creator_idx ON word_payments(creator_id);

CREATE TABLE IF NOT EXISTS settlement_receipts (
  id                    TEXT PRIMARY KEY,
  payment_id            TEXT NOT NULL REFERENCES word_payments(payment_id),
  transfer_id           TEXT,
  amount_atomic         TEXT NOT NULL,
  creator_amount_atomic TEXT NOT NULL,
  rubicon_fee_atomic    TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
