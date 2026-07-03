-- Free access is an explicit policy, not inferred from a zero draft price.
-- Existing articles and sessions stay paid unless a creator deliberately opts in.
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS access_mode TEXT NOT NULL DEFAULT 'paid'
  CHECK (access_mode IN ('free', 'paid'));

ALTER TABLE stream_sessions
  ADD COLUMN IF NOT EXISTS access_mode TEXT NOT NULL DEFAULT 'paid'
  CHECK (access_mode IN ('free', 'paid'));

-- Free sessions have no settlement recipient and free deliveries have no payment.
ALTER TABLE stream_sessions ALTER COLUMN seller_wallet DROP NOT NULL;
ALTER TABLE word_deliveries ALTER COLUMN payment_id DROP NOT NULL;
