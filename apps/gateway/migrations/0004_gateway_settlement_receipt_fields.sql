-- Preserve Circle Gateway/Nanopayments receipt metadata on idempotent retries
-- and persisted payment activity.

ALTER TABLE word_payments
  ADD COLUMN IF NOT EXISTS settlement_id TEXT,
  ADD COLUMN IF NOT EXISTS settlement_ids JSONB,
  ADD COLUMN IF NOT EXISTS buyer_wallet_address TEXT;

UPDATE word_payments
SET
  settlement_id = COALESCE(settlement_id, transfer_id, transaction_hash),
  settlement_ids = COALESCE(settlement_ids, transaction_hashes)
WHERE transfer_id IS NOT NULL OR transaction_hash IS NOT NULL OR transaction_hashes IS NOT NULL;

ALTER TABLE settlement_receipts
  ADD COLUMN IF NOT EXISTS settlement_id TEXT,
  ADD COLUMN IF NOT EXISTS settlement_ids JSONB,
  ADD COLUMN IF NOT EXISTS buyer_wallet_address TEXT;

UPDATE settlement_receipts
SET
  settlement_id = COALESCE(settlement_id, transfer_id, transaction_hash),
  settlement_ids = COALESCE(settlement_ids, transaction_hashes)
WHERE transfer_id IS NOT NULL OR transaction_hash IS NOT NULL OR transaction_hashes IS NOT NULL;
