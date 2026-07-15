import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AnalyticsEvent, AnalyticsHealth, OutboxRow } from "./types.js";

export class AnalyticsOutboxRepository {
  constructor(private readonly pool: Pool) {}

  async claim(input: {
    workerId: string;
    limit: number;
    maxAttempts: number;
    leaseTimeoutMs: number;
  }): Promise<OutboxRow[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<OutboxDbRow>(
        `WITH candidates AS (
           SELECT id FROM analytics_outbox
           WHERE processed_at IS NULL
             AND attempts < $1
             AND available_at <= now()
             AND (locked_at IS NULL OR locked_at < now() - ($2::text || ' milliseconds')::interval)
           ORDER BY occurred_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT $3
         )
         UPDATE analytics_outbox o
         SET locked_at = now(), locked_by = $4, attempts = attempts + 1, last_error = NULL
         FROM candidates c
         WHERE o.id = c.id
         RETURNING o.*`,
        [input.maxAttempts, input.leaseTimeoutMs, input.limit, input.workerId],
      );
      await client.query("COMMIT");
      return result.rows.map(toOutboxRow);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markProcessed(workerId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(
      `UPDATE analytics_outbox
       SET processed_at = now(), locked_at = NULL, locked_by = NULL, last_error = NULL
       WHERE id = ANY($1::text[]) AND locked_by = $2`,
      [ids, workerId],
    );
  }

  async markFailed(workerId: string, rows: OutboxRow[], error: unknown, maxAttempts: number): Promise<void> {
    if (rows.length === 0) return;
    const message = sanitizeError(error);
    for (const row of rows) {
      const delayMs = boundedBackoffMs(row.attempts);
      await this.pool.query(
        `UPDATE analytics_outbox
         SET locked_at = NULL,
             locked_by = NULL,
             available_at = CASE WHEN attempts >= $4 THEN available_at ELSE now() + ($3::text || ' milliseconds')::interval END,
             last_error = $2
         WHERE id = $1 AND locked_by = $5`,
        [row.id, message, delayMs, maxAttempts, workerId],
      );
    }
  }

  async releaseClaims(workerId: string): Promise<void> {
    await this.pool.query(
      "UPDATE analytics_outbox SET locked_at = NULL, locked_by = NULL WHERE locked_by = $1 AND processed_at IS NULL",
      [workerId],
    );
  }

  async health(maxAttempts: number, workerRunning: boolean, enabled = true): Promise<AnalyticsHealth> {
    const result = await this.pool.query<{
      backlog_size: string;
      poison_count: string;
      oldest_occurred_at: string | null;
      latest_processed_at: string | null;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE processed_at IS NULL AND attempts < $1)::text AS backlog_size,
         COUNT(*) FILTER (WHERE processed_at IS NULL AND attempts >= $1)::text AS poison_count,
         MIN(occurred_at) FILTER (WHERE processed_at IS NULL AND attempts < $1) AS oldest_occurred_at,
         MAX(processed_at) AS latest_processed_at
       FROM analytics_outbox`,
      [maxAttempts],
    );
    const row = result.rows[0];
    const oldest = row?.oldest_occurred_at ? new Date(row.oldest_occurred_at).getTime() : undefined;
    return {
      enabled,
      backlogSize: Number(row?.backlog_size ?? "0"),
      poisonEventCount: Number(row?.poison_count ?? "0"),
      oldestEventAgeSeconds: oldest === undefined ? undefined : Math.max(0, Math.floor((Date.now() - oldest) / 1_000)),
      latestProcessedAt: row?.latest_processed_at ?? undefined,
      workerRunning,
    };
  }

  async appendBackfillEvent(event: AnalyticsEvent): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO analytics_outbox
         (id, event_id, event_type, event_version, aggregate_key, payload, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        randomUUID(), event.eventId, event.eventType, event.eventVersion,
        event.eventType === "read_bundle_committed" ? event.bundleId : event.settlementRecordId,
        JSON.stringify(event), event.occurredAt,
      ],
    );
    return result.rowCount > 0;
  }
}

interface OutboxDbRow {
  id: string;
  event_id: string;
  event_type: AnalyticsEvent["eventType"];
  event_version: number;
  aggregate_key: string;
  payload: AnalyticsEvent;
  occurred_at: string;
  attempts: number;
}

function toOutboxRow(row: OutboxDbRow): OutboxRow {
  return {
    id: row.id,
    eventId: row.event_id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    aggregateKey: row.aggregate_key,
    payload: row.payload,
    occurredAt: row.occurred_at,
    attempts: row.attempts,
  };
}

function boundedBackoffMs(attempt: number): number {
  return Math.min(5 * 60_000, 500 * (2 ** Math.min(10, Math.max(0, attempt - 1))));
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s]+/g, "[redacted-url]").slice(0, 1_000);
}
