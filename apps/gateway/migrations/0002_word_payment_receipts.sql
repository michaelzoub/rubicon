-- Add first-class per-word settlement receipt details.
-- `transfer_id` is retained for backwards compatibility, while
-- `transaction_hash` / `transaction_hashes` are the canonical on-chain proof
-- fields for each delivered word.

ALTER TABLE word_payments
  ADD COLUMN IF NOT EXISTS network TEXT,
  ADD COLUMN IF NOT EXISTS pay_to TEXT,
  ADD COLUMN IF NOT EXISTS transaction_hash TEXT,
  ADD COLUMN IF NOT EXISTS transaction_hashes JSONB;

ALTER TABLE settlement_receipts
  ADD COLUMN IF NOT EXISTS network TEXT,
  ADD COLUMN IF NOT EXISTS pay_to TEXT,
  ADD COLUMN IF NOT EXISTS transaction_hash TEXT,
  ADD COLUMN IF NOT EXISTS transaction_hashes JSONB;
