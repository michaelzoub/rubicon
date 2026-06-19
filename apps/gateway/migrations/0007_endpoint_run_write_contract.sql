-- Endpoint-run write contract.
--
-- The gateway persists one "endpoint run" per delivered word: an atomic
-- (word_payments + word_deliveries + settlement_receipts) write, plus a later
-- settlement backfill keyed by (session_id, sequence). See
-- PostgresLedgerRepository.recordWordDelivery / updatePaymentSettlement.
--
-- This migration is idempotent and self-contained: it can be applied even if an
-- earlier migration (e.g. 0004) was skipped or applied out of order on a given
-- database, and it is safe to re-run. It guarantees every column, type, index,
-- and uniqueness constraint that the runtime write path depends on.
--
-- Amounts are atomic USDC (6 decimals), stored as exact TEXT — never floats.

-- ---------------------------------------------------------------------------
-- 1. Columns the write path inserts/updates must all exist.
-- ---------------------------------------------------------------------------

-- word_payments: one row per paid word (the table the dashboard sums).
ALTER TABLE word_payments
  ADD COLUMN IF NOT EXISTS payment_id            TEXT,
  ADD COLUMN IF NOT EXISTS session_id            TEXT,
  ADD COLUMN IF NOT EXISTS article_id            TEXT,
  ADD COLUMN IF NOT EXISTS creator_id            TEXT,
  ADD COLUMN IF NOT EXISTS sequence              INTEGER,
  ADD COLUMN IF NOT EXISTS amount_atomic         TEXT,
  ADD COLUMN IF NOT EXISTS creator_amount_atomic TEXT,
  ADD COLUMN IF NOT EXISTS rubicon_fee_atomic    TEXT,
  ADD COLUMN IF NOT EXISTS network               TEXT,
  ADD COLUMN IF NOT EXISTS pay_to                TEXT,
  ADD COLUMN IF NOT EXISTS transaction_hash      TEXT,
  ADD COLUMN IF NOT EXISTS transaction_hashes    JSONB,
  ADD COLUMN IF NOT EXISTS settlement_id         TEXT,
  ADD COLUMN IF NOT EXISTS buyer_wallet_address  TEXT,
  ADD COLUMN IF NOT EXISTS transfer_id           TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key       TEXT,
  ADD COLUMN IF NOT EXISTS created_at            TIMESTAMPTZ NOT NULL DEFAULT now();

-- settlement_receipts: per-word on-chain/Circle settlement proof.
ALTER TABLE settlement_receipts
  ADD COLUMN IF NOT EXISTS payment_id            TEXT,
  ADD COLUMN IF NOT EXISTS network               TEXT,
  ADD COLUMN IF NOT EXISTS pay_to                TEXT,
  ADD COLUMN IF NOT EXISTS transaction_hash      TEXT,
  ADD COLUMN IF NOT EXISTS transaction_hashes    JSONB,
  ADD COLUMN IF NOT EXISTS transfer_id           TEXT,
  ADD COLUMN IF NOT EXISTS settlement_id         TEXT,
  ADD COLUMN IF NOT EXISTS buyer_wallet_address  TEXT,
  ADD COLUMN IF NOT EXISTS amount_atomic         TEXT,
  ADD COLUMN IF NOT EXISTS creator_amount_atomic TEXT,
  ADD COLUMN IF NOT EXISTS rubicon_fee_atomic    TEXT,
  ADD COLUMN IF NOT EXISTS created_at            TIMESTAMPTZ NOT NULL DEFAULT now();

-- word_deliveries: the single word released by each payment.
ALTER TABLE word_deliveries
  ADD COLUMN IF NOT EXISTS session_id      TEXT,
  ADD COLUMN IF NOT EXISTS article_id      TEXT,
  ADD COLUMN IF NOT EXISTS sequence        INTEGER,
  ADD COLUMN IF NOT EXISTS word            TEXT,
  ADD COLUMN IF NOT EXISTS price_atomic    TEXT,
  ADD COLUMN IF NOT EXISTS payment_id      TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();

-- stream_sessions: the run the words/payments roll up into.
ALTER TABLE stream_sessions
  ADD COLUMN IF NOT EXISTS article_id       TEXT,
  ADD COLUMN IF NOT EXISTS creator_id       TEXT,
  ADD COLUMN IF NOT EXISTS payment_required JSONB,
  ADD COLUMN IF NOT EXISTS words_paid       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS words_delivered  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_atomic      TEXT NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS created_at       TIMESTAMPTZ NOT NULL DEFAULT now();

-- ---------------------------------------------------------------------------
-- 2. settlement_ids must be text[] (the gateway writes a native string[] array;
--    the dashboard's WordPaymentRow types it as text[]). Guarded so it works
--    whether the column is missing, already JSONB, or already text[]. A subquery
--    is not allowed inside ALTER ... USING, so JSONB is converted via a temp
--    column + UPDATE (which permits the subquery) and renamed into place.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['word_payments', 'settlement_receipts'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = tbl AND column_name = 'settlement_ids'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN settlement_ids TEXT[]', tbl);
    ELSIF (
      SELECT data_type FROM information_schema.columns
      WHERE table_name = tbl AND column_name = 'settlement_ids'
    ) = 'jsonb' THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN settlement_ids_text TEXT[]', tbl);
      EXECUTE format(
        'UPDATE %I SET settlement_ids_text = ARRAY(SELECT jsonb_array_elements_text(settlement_ids)) WHERE settlement_ids IS NOT NULL',
        tbl);
      EXECUTE format('ALTER TABLE %I DROP COLUMN settlement_ids', tbl);
      EXECUTE format('ALTER TABLE %I RENAME COLUMN settlement_ids_text TO settlement_ids', tbl);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Uniqueness that the atomic ON CONFLICT writes depend on. Created only when
--    no unique constraint/index already enforces it, so this never duplicates
--    the constraints from 0001_init. A unique index satisfies ON CONFLICT
--    inference exactly like a unique constraint.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  spec RECORD;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('word_payments',  ARRAY['idempotency_key'],        'word_payments_idempotency_key_uidx'),
      ('word_payments',  ARRAY['payment_id'],             'word_payments_payment_id_uidx'),
      ('word_deliveries', ARRAY['idempotency_key'],       'word_deliveries_idempotency_key_uidx'),
      ('word_deliveries', ARRAY['session_id', 'sequence'], 'word_deliveries_session_sequence_uidx')
    ) AS t(tbl, cols, idx)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      WHERE c.relname = spec.tbl
        AND i.indisunique
        AND (
          SELECT array_agg(a.attname::text ORDER BY a.attname::text)
          FROM unnest(i.indkey) AS k(attnum)
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        ) = (SELECT array_agg(x ORDER BY x) FROM unnest(spec.cols) AS x)
    ) THEN
      EXECUTE format('CREATE UNIQUE INDEX %I ON %I (%s)',
        spec.idx, spec.tbl, array_to_string(spec.cols, ', '));
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Lookup indexes used by the dashboard/earnings reads.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS word_payments_article_idx     ON word_payments(article_id);
CREATE INDEX IF NOT EXISTS word_payments_creator_idx     ON word_payments(creator_id);
CREATE INDEX IF NOT EXISTS word_payments_session_idx     ON word_payments(session_id);
CREATE INDEX IF NOT EXISTS word_deliveries_session_idx   ON word_deliveries(session_id);
CREATE INDEX IF NOT EXISTS settlement_receipts_payment_idx ON settlement_receipts(payment_id);
