-- Run with CLICKHOUSE_DATABASE selected. ReplacingMergeTree plus stable event_id
-- makes ambiguous-response retries safe. Aggregate views read FINAL so a replay
-- cannot double-count before background merges complete. Insert-triggered
-- materialized aggregate views are intentionally avoided because they would see
-- duplicate retry blocks before ReplacingMergeTree deduplication.

CREATE TABLE IF NOT EXISTS analytics_events (
  event_id String,
  event_type LowCardinality(String),
  event_version UInt16,
  occurred_at DateTime64(3, 'UTC'),
  bundle_id String,
  settlement_record_id String,
  creator_id String,
  article_id String,
  session_id String,
  access_mode LowCardinality(String),
  section_id String,
  start_sequence UInt64,
  end_sequence UInt64,
  words_count UInt64,
  gross_amount_atomic Decimal(38, 0),
  creator_amount_atomic Decimal(38, 0),
  rubicon_fee_atomic Decimal(38, 0),
  buyer_agent_hash String,
  bundle_ids Array(String),
  provider_reference String,
  settlement_status LowCardinality(String),
  settled_creator_amount_atomic_delta Decimal(38, 0),
  ingested_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY event_id;

CREATE VIEW IF NOT EXISTS creator_daily_metrics AS
SELECT
  toDate(occurred_at, 'UTC') AS day,
  creator_id,
  countIf(event_type = 'read_bundle_committed') AS bundle_count,
  sumIf(words_count, event_type = 'read_bundle_committed') AS delivered_words,
  sumIf(words_count, event_type = 'read_bundle_committed' AND access_mode = 'paid') AS paid_words,
  uniqExactIf(session_id, event_type = 'read_bundle_committed') AS agent_reads,
  uniqExactIf(buyer_agent_hash, event_type = 'read_bundle_committed' AND buyer_agent_hash != '') AS unique_agents,
  sumIf(gross_amount_atomic, event_type = 'read_bundle_committed') AS gross_amount_atomic,
  sumIf(creator_amount_atomic, event_type = 'read_bundle_committed') AS creator_earnings_atomic,
  sumIf(settled_creator_amount_atomic_delta, event_type = 'settlement_changed') AS settled_creator_earnings_atomic,
  max(ingested_at) AS latest_ingested_at
FROM analytics_events FINAL
GROUP BY day, creator_id;

CREATE VIEW IF NOT EXISTS article_daily_metrics AS
SELECT
  toDate(occurred_at, 'UTC') AS day,
  creator_id,
  article_id,
  countIf(event_type = 'read_bundle_committed') AS bundle_count,
  sumIf(words_count, event_type = 'read_bundle_committed') AS delivered_words,
  sumIf(words_count, event_type = 'read_bundle_committed' AND access_mode = 'paid') AS paid_words,
  uniqExactIf(session_id, event_type = 'read_bundle_committed') AS agent_reads,
  uniqExactIf(buyer_agent_hash, event_type = 'read_bundle_committed' AND buyer_agent_hash != '') AS unique_agents,
  sumIf(gross_amount_atomic, event_type = 'read_bundle_committed') AS gross_amount_atomic,
  sumIf(creator_amount_atomic, event_type = 'read_bundle_committed') AS creator_earnings_atomic,
  sumIf(settled_creator_amount_atomic_delta, event_type = 'settlement_changed') AS settled_creator_earnings_atomic,
  max(ingested_at) AS latest_ingested_at
FROM analytics_events FINAL
GROUP BY day, creator_id, article_id;

CREATE VIEW IF NOT EXISTS creator_totals AS
SELECT creator_id,
       sum(delivered_words) AS delivered_words,
       sum(paid_words) AS paid_words,
       sum(agent_reads) AS agent_reads,
       sum(gross_amount_atomic) AS gross_amount_atomic,
       sum(creator_earnings_atomic) AS creator_earnings_atomic,
       sum(settled_creator_earnings_atomic) AS settled_creator_earnings_atomic,
       max(latest_ingested_at) AS latest_ingested_at
FROM creator_daily_metrics
GROUP BY creator_id;

CREATE VIEW IF NOT EXISTS article_totals AS
SELECT creator_id, article_id,
       sum(delivered_words) AS delivered_words,
       sum(paid_words) AS paid_words,
       sum(agent_reads) AS agent_reads,
       sum(gross_amount_atomic) AS gross_amount_atomic,
       sum(creator_earnings_atomic) AS creator_earnings_atomic,
       sum(settled_creator_earnings_atomic) AS settled_creator_earnings_atomic,
       max(latest_ingested_at) AS latest_ingested_at
FROM article_daily_metrics
GROUP BY creator_id, article_id;

CREATE VIEW IF NOT EXISTS session_metrics AS
SELECT creator_id, article_id, session_id,
       min(occurred_at) AS started_at,
       max(occurred_at) AS latest_read_at,
       sum(words_count) AS delivered_words,
       sumIf(words_count, access_mode = 'paid') AS paid_words,
       sum(gross_amount_atomic) AS gross_amount_atomic,
       sum(creator_amount_atomic) AS creator_earnings_atomic,
       max(ingested_at) AS latest_ingested_at
FROM analytics_events FINAL
WHERE event_type = 'read_bundle_committed'
GROUP BY creator_id, article_id, session_id;

CREATE VIEW IF NOT EXISTS section_metrics AS
SELECT creator_id, article_id, section_id,
       sum(words_count) AS delivered_words,
       sumIf(words_count, access_mode = 'paid') AS paid_words,
       uniqExact(session_id) AS agent_reads,
       sum(gross_amount_atomic) AS gross_amount_atomic,
       max(ingested_at) AS latest_ingested_at
FROM analytics_events FINAL
WHERE event_type = 'read_bundle_committed' AND section_id != ''
GROUP BY creator_id, article_id, section_id;

CREATE VIEW IF NOT EXISTS recent_reads AS
SELECT event_id, occurred_at, bundle_id, creator_id, article_id, session_id,
       access_mode, section_id, words_count, gross_amount_atomic, ingested_at
FROM analytics_events FINAL
WHERE event_type = 'read_bundle_committed'
ORDER BY occurred_at DESC
LIMIT 1000;
