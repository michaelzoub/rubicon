-- Bundle-oriented delivery ledger, evidence-based settlement lifecycle, and
-- transactional analytics outbox.
--
-- This migration is deliberately additive. Historical word payments remain
-- available for compatibility, and historical settlement_receipts are never
-- deleted. New runtime writes use read_bundles, settlements, and
-- settlement_bundle_links instead.

CREATE TABLE IF NOT EXISTS read_bundles (
  id                       TEXT PRIMARY KEY,
  bundle_id                TEXT NOT NULL UNIQUE,
  idempotency_key          TEXT NOT NULL UNIQUE,
  session_id               TEXT NOT NULL REFERENCES stream_sessions(id),
  creator_id               TEXT NOT NULL,
  article_id               TEXT NOT NULL,
  access_mode              TEXT NOT NULL CHECK (access_mode IN ('paid', 'free')),
  section_id               TEXT,
  bundle_sequence          INTEGER NOT NULL CHECK (bundle_sequence >= 0),
  start_sequence           INTEGER NOT NULL CHECK (start_sequence >= 0),
  end_sequence             INTEGER NOT NULL CHECK (end_sequence >= start_sequence),
  words_count              INTEGER NOT NULL CHECK (words_count > 0),
  price_per_word_atomic    NUMERIC(78,0) NOT NULL CHECK (price_per_word_atomic >= 0),
  gross_amount_atomic      NUMERIC(78,0) NOT NULL CHECK (gross_amount_atomic >= 0),
  creator_amount_atomic    NUMERIC(78,0) NOT NULL CHECK (creator_amount_atomic >= 0),
  rubicon_fee_atomic       NUMERIC(78,0) NOT NULL CHECK (rubicon_fee_atomic >= 0),
  payment_id               TEXT,
  authorization_reference TEXT,
  buyer_wallet_address     TEXT,
  network                  TEXT,
  pay_to                   TEXT,
  payment_status           TEXT NOT NULL CHECK (payment_status IN
                              ('free', 'authorized', 'pending', 'confirmed', 'completed', 'failed')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, bundle_sequence),
  CHECK (words_count = end_sequence - start_sequence + 1),
  CHECK (gross_amount_atomic = price_per_word_atomic * words_count),
  CHECK (
    (access_mode = 'free'
      AND price_per_word_atomic = 0
      AND gross_amount_atomic = 0
      AND creator_amount_atomic = 0
      AND rubicon_fee_atomic = 0
      AND payment_id IS NULL
      AND authorization_reference IS NULL
      AND payment_status = 'free')
    OR
    (access_mode = 'paid'
      AND payment_id IS NOT NULL
      AND authorization_reference IS NOT NULL
      AND payment_status <> 'free')
  )
);
CREATE INDEX IF NOT EXISTS read_bundles_session_idx ON read_bundles(session_id, start_sequence);
CREATE INDEX IF NOT EXISTS read_bundles_creator_created_idx ON read_bundles(creator_id, created_at);
CREATE INDEX IF NOT EXISTS read_bundles_article_created_idx ON read_bundles(article_id, created_at);
CREATE INDEX IF NOT EXISTS read_bundles_payment_idx ON read_bundles(payment_id);

ALTER TABLE word_deliveries ADD COLUMN IF NOT EXISTS bundle_id TEXT;
CREATE INDEX IF NOT EXISTS word_deliveries_bundle_idx ON word_deliveries(bundle_id);

CREATE TABLE IF NOT EXISTS settlements (
  id                    TEXT PRIMARY KEY,
  provider              TEXT NOT NULL,
  provider_reference    TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL UNIQUE,
  status                TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'completed', 'failed')),
  network               TEXT,
  pay_to                TEXT,
  buyer_wallet_address  TEXT,
  transaction_hash      TEXT,
  transaction_hashes    TEXT[],
  settlement_id         TEXT,
  settlement_ids        TEXT[],
  transfer_id           TEXT,
  gross_amount_atomic   NUMERIC(78,0) NOT NULL CHECK (gross_amount_atomic >= 0),
  creator_amount_atomic NUMERIC(78,0) NOT NULL CHECK (creator_amount_atomic >= 0),
  rubicon_fee_atomic    NUMERIC(78,0) NOT NULL CHECK (rubicon_fee_atomic >= 0),
  initiated_at          TIMESTAMPTZ,
  confirmed_at          TIMESTAMPTZ,
  failed_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    transfer_id IS NOT NULL
    OR settlement_id IS NOT NULL
    OR COALESCE(cardinality(settlement_ids), 0) > 0
    OR transaction_hash IS NOT NULL
    OR COALESCE(cardinality(transaction_hashes), 0) > 0
  )
);
CREATE INDEX IF NOT EXISTS settlements_provider_reference_idx ON settlements(provider, provider_reference);

CREATE TABLE IF NOT EXISTS settlement_bundle_links (
  settlement_record_id            TEXT NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  bundle_id                       TEXT NOT NULL REFERENCES read_bundles(bundle_id),
  allocated_gross_amount_atomic   NUMERIC(78,0) NOT NULL CHECK (allocated_gross_amount_atomic >= 0),
  allocated_creator_amount_atomic NUMERIC(78,0) NOT NULL CHECK (allocated_creator_amount_atomic >= 0),
  allocated_fee_atomic             NUMERIC(78,0) NOT NULL CHECK (allocated_fee_atomic >= 0),
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (settlement_record_id, bundle_id)
);
CREATE INDEX IF NOT EXISTS settlement_bundle_links_bundle_idx ON settlement_bundle_links(bundle_id);

CREATE TABLE IF NOT EXISTS analytics_outbox (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL UNIQUE,
  event_type    TEXT NOT NULL,
  event_version INTEGER NOT NULL CHECK (event_version > 0),
  aggregate_key TEXT NOT NULL,
  payload       JSONB NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL,
  available_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_at     TIMESTAMPTZ,
  locked_by     TEXT,
  processed_at  TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analytics_outbox_claim_idx
  ON analytics_outbox(processed_at, available_at, attempts, locked_at);

-- Historical ledger rows become deterministic one-word bundles. This is a
-- compatibility backfill, not the new write pattern.
INSERT INTO read_bundles (
  id, bundle_id, idempotency_key, session_id, creator_id, article_id,
  access_mode, section_id, bundle_sequence, start_sequence, end_sequence,
  words_count, price_per_word_atomic, gross_amount_atomic,
  creator_amount_atomic, rubicon_fee_atomic, payment_id,
  authorization_reference, buyer_wallet_address, network, pay_to,
  payment_status, created_at, updated_at
)
SELECT
  'legacy-bundle:' || p.payment_id,
  'legacy:' || p.payment_id,
  'legacy:' || p.idempotency_key,
  p.session_id,
  p.creator_id,
  p.article_id,
  'paid',
  s.section_id,
  p.sequence,
  p.sequence,
  p.sequence,
  1,
  p.amount_atomic::numeric,
  p.amount_atomic::numeric,
  p.creator_amount_atomic::numeric,
  p.rubicon_fee_atomic::numeric,
  p.payment_id,
  p.idempotency_key,
  p.buyer_wallet_address,
  p.network,
  p.pay_to,
  CASE
    WHEN p.transaction_hash IS NOT NULL OR jsonb_array_length(COALESCE(p.transaction_hashes, '[]'::jsonb)) > 0 THEN 'confirmed'
    WHEN p.transfer_id IS NOT NULL OR p.settlement_id IS NOT NULL OR COALESCE(cardinality(p.settlement_ids), 0) > 0 THEN 'pending'
    ELSE 'authorized'
  END,
  p.created_at,
  p.created_at
FROM word_payments p
JOIN stream_sessions s ON s.id = p.session_id
WHERE p.session_id IS NOT NULL AND p.sequence IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO read_bundles (
  id, bundle_id, idempotency_key, session_id, creator_id, article_id,
  access_mode, section_id, bundle_sequence, start_sequence, end_sequence,
  words_count, price_per_word_atomic, gross_amount_atomic,
  creator_amount_atomic, rubicon_fee_atomic, payment_status, created_at, updated_at
)
SELECT
  'legacy-free-bundle:' || d.id,
  'legacy-free:' || d.id,
  'legacy-free:' || d.idempotency_key,
  d.session_id,
  s.creator_id,
  d.article_id,
  'free',
  s.section_id,
  d.sequence,
  d.sequence,
  d.sequence,
  1, 0, 0, 0, 0,
  'free',
  d.created_at,
  d.created_at
FROM word_deliveries d
JOIN stream_sessions s ON s.id = d.session_id
WHERE d.payment_id IS NULL
ON CONFLICT DO NOTHING;

UPDATE word_deliveries d
SET bundle_id = b.bundle_id
FROM read_bundles b
WHERE d.bundle_id IS NULL
  AND b.session_id = d.session_id
  AND d.sequence BETWEEN b.start_sequence AND b.end_sequence;

-- Preserve historical evidence in the new lifecycle. UUID-only transfer and
-- settlement references stay pending; a transaction hash is evidence of a
-- confirmed provider result, not necessarily business-level completion.
INSERT INTO settlements (
  id, provider, provider_reference, idempotency_key, status, network, pay_to,
  buyer_wallet_address, transaction_hash, transaction_hashes, settlement_id,
  settlement_ids, transfer_id, gross_amount_atomic, creator_amount_atomic,
  rubicon_fee_atomic, initiated_at, confirmed_at, created_at, updated_at
)
SELECT
  'legacy-settlement:' || r.id,
  'legacy',
  COALESCE(r.transfer_id, r.settlement_id, r.transaction_hash,
           r.settlement_ids[1], r.transaction_hashes->>0),
  'legacy:' || r.id,
  CASE WHEN r.transaction_hash IS NOT NULL OR jsonb_array_length(COALESCE(r.transaction_hashes, '[]'::jsonb)) > 0
       THEN 'confirmed' ELSE 'pending' END,
  r.network,
  r.pay_to,
  r.buyer_wallet_address,
  r.transaction_hash,
  ARRAY(SELECT jsonb_array_elements_text(COALESCE(r.transaction_hashes, '[]'::jsonb))),
  r.settlement_id,
  r.settlement_ids,
  r.transfer_id,
  r.amount_atomic::numeric,
  r.creator_amount_atomic::numeric,
  r.rubicon_fee_atomic::numeric,
  r.created_at,
  CASE WHEN r.transaction_hash IS NOT NULL OR jsonb_array_length(COALESCE(r.transaction_hashes, '[]'::jsonb)) > 0
       THEN r.created_at ELSE NULL END,
  r.created_at,
  r.created_at
FROM settlement_receipts r
WHERE r.transfer_id IS NOT NULL
   OR r.settlement_id IS NOT NULL
   OR COALESCE(cardinality(r.settlement_ids), 0) > 0
   OR r.transaction_hash IS NOT NULL
   OR jsonb_array_length(COALESCE(r.transaction_hashes, '[]'::jsonb)) > 0
ON CONFLICT DO NOTHING;

INSERT INTO settlement_bundle_links (
  settlement_record_id, bundle_id, allocated_gross_amount_atomic,
  allocated_creator_amount_atomic, allocated_fee_atomic, created_at
)
SELECT
  'legacy-settlement:' || r.id,
  b.bundle_id,
  r.amount_atomic::numeric,
  r.creator_amount_atomic::numeric,
  r.rubicon_fee_atomic::numeric,
  r.created_at
FROM settlement_receipts r
JOIN read_bundles b ON b.payment_id = r.payment_id
JOIN settlements s ON s.id = 'legacy-settlement:' || r.id
ON CONFLICT DO NOTHING;

-- Do not constrain the legacy table during the expand migration. The previous
-- gateway version still writes placeholder receipts, so enforcing the evidence
-- check here would break paid reads during a rolling deployment. After every
-- old gateway instance is drained, run `finalize:bundle-transition`; it catches
-- up legacy rows written after this backfill and then installs the NOT VALID
-- evidence constraint for future writes.

CREATE OR REPLACE VIEW settlement_receipts_migration_audit AS
SELECT
  r.*,
  CASE
    WHEN r.transfer_id IS NULL
      AND r.settlement_id IS NULL
      AND COALESCE(cardinality(r.settlement_ids), 0) = 0
      AND r.transaction_hash IS NULL
      AND jsonb_array_length(COALESCE(r.transaction_hashes, '[]'::jsonb)) = 0
      THEN 'placeholder_without_evidence'
    WHEN COUNT(*) OVER (PARTITION BY r.payment_id) > 1
      THEN 'duplicate_payment_receipts'
    ELSE 'provider_evidence'
  END AS migration_classification
FROM settlement_receipts r;
