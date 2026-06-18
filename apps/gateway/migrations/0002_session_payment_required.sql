ALTER TABLE stream_sessions
  ADD COLUMN IF NOT EXISTS payment_required JSONB;
