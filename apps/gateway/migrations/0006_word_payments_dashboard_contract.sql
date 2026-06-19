-- Make word_payments / stream_sessions match exactly what the creator dashboard
-- reads (WordPaymentRow). This migration is idempotent and self-contained: it can
-- be applied even if an earlier migration was skipped on this database, and it is
-- safe to re-run.
--
-- 1. Ensure every column the dashboard depends on exists.
-- 2. Normalize settlement_ids from JSONB to text[] (the dashboard's WordPaymentRow
--    types it as text[]; the gateway now writes a native string[] array).
--
-- Amounts are atomic USDC (6 decimals), stored as exact TEXT — never floats.

-- word_payments: the table the dashboard sums for per-article earnings.
ALTER TABLE word_payments
  ADD COLUMN IF NOT EXISTS article_id            TEXT,
  ADD COLUMN IF NOT EXISTS creator_id            TEXT,
  ADD COLUMN IF NOT EXISTS session_id            TEXT,
  ADD COLUMN IF NOT EXISTS sequence              INTEGER,
  ADD COLUMN IF NOT EXISTS amount_atomic         TEXT,
  ADD COLUMN IF NOT EXISTS creator_amount_atomic TEXT,
  ADD COLUMN IF NOT EXISTS rubicon_fee_atomic    TEXT,
  ADD COLUMN IF NOT EXISTS transfer_id           TEXT,
  ADD COLUMN IF NOT EXISTS settlement_id         TEXT,
  ADD COLUMN IF NOT EXISTS created_at            TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS word_payments_article_idx ON word_payments(article_id);
CREATE INDEX IF NOT EXISTS word_payments_creator_idx ON word_payments(creator_id);

-- stream_sessions: per-section/session usage the dashboard derives.
ALTER TABLE stream_sessions
  ADD COLUMN IF NOT EXISTS article_id      TEXT,
  ADD COLUMN IF NOT EXISTS creator_id      TEXT,
  ADD COLUMN IF NOT EXISTS words_delivered INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_atomic     TEXT NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();

-- settlement_ids: JSONB -> text[]. Guarded so it works whether the column is
-- missing, already JSONB, or already text[]. A subquery is not allowed inside an
-- ALTER ... USING transform, so JSONB columns are converted via a temp column +
-- UPDATE (which does permit the subquery) and then renamed into place.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'word_payments' AND column_name = 'settlement_ids'
  ) THEN
    ALTER TABLE word_payments ADD COLUMN settlement_ids TEXT[];
  ELSIF (
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'word_payments' AND column_name = 'settlement_ids'
  ) = 'jsonb' THEN
    ALTER TABLE word_payments ADD COLUMN settlement_ids_text TEXT[];
    UPDATE word_payments
      SET settlement_ids_text = ARRAY(SELECT jsonb_array_elements_text(settlement_ids))
      WHERE settlement_ids IS NOT NULL;
    ALTER TABLE word_payments DROP COLUMN settlement_ids;
    ALTER TABLE word_payments RENAME COLUMN settlement_ids_text TO settlement_ids;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'settlement_receipts' AND column_name = 'settlement_ids'
  ) THEN
    ALTER TABLE settlement_receipts ADD COLUMN settlement_ids TEXT[];
  ELSIF (
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'settlement_receipts' AND column_name = 'settlement_ids'
  ) = 'jsonb' THEN
    ALTER TABLE settlement_receipts ADD COLUMN settlement_ids_text TEXT[];
    UPDATE settlement_receipts
      SET settlement_ids_text = ARRAY(SELECT jsonb_array_elements_text(settlement_ids))
      WHERE settlement_ids IS NOT NULL;
    ALTER TABLE settlement_receipts DROP COLUMN settlement_ids;
    ALTER TABLE settlement_receipts RENAME COLUMN settlement_ids_text TO settlement_ids;
  END IF;
END $$;
