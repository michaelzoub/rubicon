-- Run only after every gateway instance using the legacy per-word persistence
-- code has been drained. This script is idempotent: it catches up rows written
-- after migration 0011's initial backfill, links their delivery audits, carries
-- forward real provider evidence, then rejects future placeholder receipts.

LOCK TABLE settlement_receipts IN SHARE ROW EXCLUSIVE MODE;

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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'settlement_receipts_has_provider_evidence'
  ) THEN
    ALTER TABLE settlement_receipts
      ADD CONSTRAINT settlement_receipts_has_provider_evidence CHECK (
        transfer_id IS NOT NULL
        OR settlement_id IS NOT NULL
        OR COALESCE(cardinality(settlement_ids), 0) > 0
        OR transaction_hash IS NOT NULL
        OR jsonb_array_length(COALESCE(transaction_hashes, '[]'::jsonb)) > 0
      ) NOT VALID;
  END IF;
END $$;

-- Operator-visible transition counts. Historical placeholder rows remain
-- preserved and are intentionally excluded from the new settlement lifecycle.
SELECT
  (SELECT COUNT(*) FROM read_bundles) AS bundle_count,
  (SELECT COUNT(*)
   FROM word_payments p
   LEFT JOIN read_bundles b ON b.payment_id = p.payment_id
   WHERE b.bundle_id IS NULL) AS unmigrated_payment_count,
  (SELECT COUNT(*) FROM word_deliveries WHERE bundle_id IS NULL) AS unlinked_delivery_count,
  (SELECT COUNT(*) FROM settlements) AS settlement_count,
  (SELECT COUNT(*)
   FROM settlement_receipts r
   LEFT JOIN settlements s ON s.id = 'legacy-settlement:' || r.id
   WHERE s.id IS NULL
     AND (
       r.transfer_id IS NOT NULL
       OR r.settlement_id IS NOT NULL
       OR COALESCE(cardinality(r.settlement_ids), 0) > 0
       OR r.transaction_hash IS NOT NULL
       OR jsonb_array_length(COALESCE(r.transaction_hashes, '[]'::jsonb)) > 0
     )) AS unmigrated_evidence_receipt_count,
  (SELECT COUNT(*) FROM settlement_receipts_migration_audit
   WHERE migration_classification = 'placeholder_without_evidence') AS preserved_placeholder_count;
