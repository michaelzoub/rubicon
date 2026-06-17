-- Add first-class per-word settlement receipt details.
-- `transfer_id` is retained for backwards compatibility, while
-- `transaction_hash` / `transaction_hashes` are the canonical on-chain proof
-- fields for each delivered word.

ALTER TABLE word_payments
  ADD COLUMN IF NOT EXISTS network TEXT,
  ADD COLUMN IF NOT EXISTS pay_to TEXT,
  ADD COLUMN IF NOT EXISTS transaction_hash TEXT,
  ADD COLUMN IF NOT EXISTS transaction_hashes JSONB;

UPDATE word_payments
SET
  transaction_hash = COALESCE(transaction_hash, transfer_id),
  transaction_hashes = COALESCE(transaction_hashes, to_jsonb(ARRAY[transfer_id]))
WHERE transfer_id IS NOT NULL;

ALTER TABLE settlement_receipts
  ADD COLUMN IF NOT EXISTS network TEXT,
  ADD COLUMN IF NOT EXISTS pay_to TEXT,
  ADD COLUMN IF NOT EXISTS transaction_hash TEXT,
  ADD COLUMN IF NOT EXISTS transaction_hashes JSONB;

UPDATE settlement_receipts
SET
  transaction_hash = COALESCE(transaction_hash, transfer_id),
  transaction_hashes = COALESCE(transaction_hashes, to_jsonb(ARRAY[transfer_id]))
WHERE transfer_id IS NOT NULL;
