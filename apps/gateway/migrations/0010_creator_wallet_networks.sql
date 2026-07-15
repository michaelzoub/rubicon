-- One creator-owned wallet record per settlement network.
ALTER TABLE creator_wallets
  DROP CONSTRAINT IF EXISTS creator_wallets_pkey;

ALTER TABLE creator_wallets
  ADD PRIMARY KEY (creator_id, network);
