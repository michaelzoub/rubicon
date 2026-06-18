-- Circle Gateway x402 returns a transfer UUID in the settle response's
-- `transaction` field. It is not an on-chain transaction hash, so keep it in
-- transfer/settlement fields and clear earlier UUID backfills from hash fields.

UPDATE word_payments
SET
  transaction_hash = NULL,
  transaction_hashes = CASE
    WHEN transaction_hashes = to_jsonb(ARRAY[transfer_id]) THEN NULL
    ELSE transaction_hashes
  END
WHERE
  transfer_id IS NOT NULL
  AND transaction_hash = transfer_id
  AND transfer_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

UPDATE settlement_receipts
SET
  transaction_hash = NULL,
  transaction_hashes = CASE
    WHEN transaction_hashes = to_jsonb(ARRAY[transfer_id]) THEN NULL
    ELSE transaction_hashes
  END
WHERE
  transfer_id IS NOT NULL
  AND transaction_hash = transfer_id
  AND transfer_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
