import type { Pool, QueryResult } from "pg";
import type { AnalyticsOutboxRepository } from "./outbox-repository.js";
import type { ReadBundleCommittedEvent, SettlementChangedEvent } from "./types.js";
import { hashBuyerAgentIdentity } from "./identity.js";

export interface BackfillOptions {
  dryRun: boolean;
  from?: string;
  to?: string;
  creatorId?: string;
  cursor?: string;
  batchSize: number;
  onProgress?: (message: string) => void;
}

export async function backfillBundleAnalytics(
  pool: Pool,
  outbox: AnalyticsOutboxRepository,
  options: BackfillOptions,
): Promise<{ scanned: number; inserted: number; lastCursor?: string }> {
  let cursor = decodeCursor(options.cursor);
  let scanned = 0;
  let inserted = 0;
  if (cursor?.phase !== "settlements") {
    const bundleCursor = cursor?.phase === "bundles" ? cursor : undefined;
    cursor = bundleCursor;
    while (true) {
      const result = await pool.query<BundleBackfillRow>(
        `SELECT bundle_id, creator_id, article_id, session_id, access_mode, section_id,
                start_sequence, end_sequence, words_count, gross_amount_atomic::text,
                creator_amount_atomic::text, rubicon_fee_atomic::text,
                buyer_wallet_address, created_at
         FROM read_bundles
         WHERE ($1::timestamptz IS NULL OR created_at >= $1)
           AND ($2::timestamptz IS NULL OR created_at < $2)
           AND ($3::text IS NULL OR creator_id = $3)
           AND ($4::timestamptz IS NULL OR (created_at, bundle_id) > ($4, $5))
         ORDER BY created_at, bundle_id
         LIMIT $6`,
        [
          options.from ?? null,
          options.to ?? null,
          options.creatorId ?? null,
          cursor?.createdAt ?? null,
          cursor?.id ?? "",
          options.batchSize,
        ],
      );
      if (result.rows.length === 0) break;
      for (const row of result.rows) {
        scanned += 1;
        if (!options.dryRun && await outbox.appendBackfillEvent(toBundleEvent(row))) inserted += 1;
        cursor = { phase: "bundles", createdAt: row.created_at, id: row.bundle_id };
      }
      options.onProgress?.(`phase=bundles scanned=${scanned} inserted=${inserted} cursor=${encodeCursor(cursor!)}`);
      if (result.rows.length < options.batchSize) break;
    }
    cursor = { phase: "settlements", createdAt: options.from ?? "1970-01-01T00:00:00.000Z", id: "" };
  }

  while (true) {
    const result: QueryResult<SettlementBackfillRow> = await pool.query<SettlementBackfillRow>(
      `SELECT s.id, s.idempotency_key, s.provider_reference, s.status, s.created_at,
              array_agg(l.bundle_id ORDER BY l.bundle_id) AS bundle_ids,
              MIN(b.creator_id) AS creator_id,
              MIN(b.article_id) AS article_id,
              MIN(b.session_id) AS session_id,
              SUM(l.allocated_creator_amount_atomic)::text AS creator_amount_atomic
       FROM settlements s
       JOIN settlement_bundle_links l ON l.settlement_record_id = s.id
       JOIN read_bundles b ON b.bundle_id = l.bundle_id
       WHERE ($1::timestamptz IS NULL OR s.created_at >= $1)
         AND ($2::timestamptz IS NULL OR s.created_at < $2)
         AND ($3::text IS NULL OR b.creator_id = $3)
         AND (s.created_at, s.id) > ($4::timestamptz, $5)
       GROUP BY s.id, s.idempotency_key, s.provider_reference, s.status, s.created_at
       ORDER BY s.created_at, s.id
       LIMIT $6`,
      [
        options.from ?? null,
        options.to ?? null,
        options.creatorId ?? null,
        cursor.createdAt,
        cursor.id,
        options.batchSize,
      ],
    );
    if (result.rows.length === 0) break;
    for (const row of result.rows) {
      scanned += 1;
      if (!options.dryRun && await outbox.appendBackfillEvent(toSettlementEvent(row))) inserted += 1;
      cursor = { phase: "settlements", createdAt: row.created_at, id: row.id };
    }
    options.onProgress?.(`phase=settlements scanned=${scanned} inserted=${inserted} cursor=${encodeCursor(cursor)}`);
    if (result.rows.length < options.batchSize) break;
  }
  return { scanned, inserted, lastCursor: encodeCursor(cursor) };
}

interface BundleBackfillRow {
  bundle_id: string;
  creator_id: string;
  article_id: string;
  session_id: string;
  access_mode: "paid" | "free";
  section_id: string | null;
  start_sequence: number;
  end_sequence: number;
  words_count: number;
  gross_amount_atomic: string;
  creator_amount_atomic: string;
  rubicon_fee_atomic: string;
  buyer_wallet_address: string | null;
  created_at: string;
}

export function toBundleEvent(row: BundleBackfillRow): ReadBundleCommittedEvent {
  return {
    eventId: `read_bundle:${row.bundle_id}:v1`,
    eventVersion: 1,
    eventType: "read_bundle_committed",
    occurredAt: row.created_at,
    bundleId: row.bundle_id,
    creatorId: row.creator_id,
    articleId: row.article_id,
    sessionId: row.session_id,
    accessMode: row.access_mode,
    sectionId: row.section_id ?? undefined,
    startSequence: row.start_sequence,
    endSequence: row.end_sequence,
    wordsCount: row.words_count,
    grossAmountAtomic: row.gross_amount_atomic,
    creatorAmountAtomic: row.creator_amount_atomic,
    rubiconFeeAtomic: row.rubicon_fee_atomic,
    buyerAgentHash: hashBuyerAgentIdentity(row.buyer_wallet_address ?? undefined),
  };
}

interface SettlementBackfillRow {
  id: string;
  idempotency_key: string;
  provider_reference: string;
  status: "pending" | "confirmed" | "completed" | "failed";
  created_at: string;
  bundle_ids: string[];
  creator_id: string;
  article_id: string;
  session_id: string;
  creator_amount_atomic: string;
}

export function toSettlementEvent(row: SettlementBackfillRow): SettlementChangedEvent {
  return {
    eventId: `settlement:${row.idempotency_key}:v1`,
    eventVersion: 1,
    eventType: "settlement_changed",
    occurredAt: row.created_at,
    settlementRecordId: row.id,
    bundleIds: row.bundle_ids,
    creatorId: row.creator_id,
    articleId: row.article_id,
    sessionId: row.session_id,
    providerReference: row.provider_reference,
    status: row.status,
    settledCreatorAmountAtomicDelta: row.status === "completed" ? row.creator_amount_atomic : "0",
  };
}

interface BackfillCursor {
  phase: "bundles" | "settlements";
  createdAt: string;
  id: string;
}

function encodeCursor(cursor: BackfillCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): BackfillCursor | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
  if (typeof parsed.createdAt !== "string") throw new Error("invalid_cursor");
  if (parsed.phase === "bundles" || parsed.phase === "settlements") {
    if (typeof parsed.id !== "string") throw new Error("invalid_cursor");
    return { phase: parsed.phase, createdAt: parsed.createdAt, id: parsed.id };
  }
  // Accept cursors emitted before settlement backfill became a second phase.
  if (typeof parsed.bundleId === "string") {
    return { phase: "bundles", createdAt: parsed.createdAt, id: parsed.bundleId };
  }
  throw new Error("invalid_cursor");
}
