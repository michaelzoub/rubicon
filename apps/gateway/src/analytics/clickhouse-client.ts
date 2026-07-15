import type { AnalyticsConfig } from "./config.js";
import type { OutboxRow } from "./types.js";

export class ClickHouseAnalyticsClient {
  constructor(private readonly config: AnalyticsConfig) {}

  async insert(rows: OutboxRow[]): Promise<void> {
    if (rows.length === 0) return;
    const body = rows.map((row) => JSON.stringify(toClickHouseRow(row))).join("\n") + "\n";
    await this.request(
      `INSERT INTO ${quoteIdentifier(this.config.clickhouseDatabase)}.analytics_events FORMAT JSONEachRow`,
      body,
    );
  }

  async queryJson<T>(query: string): Promise<T> {
    const response = await this.request(`${query} FORMAT JSON`, undefined);
    return JSON.parse(response) as T;
  }

  private async request(query: string, body: string | undefined): Promise<string> {
    if (!this.config.clickhouseUrl) throw new Error("clickhouse_url_missing");
    const url = new URL(this.config.clickhouseUrl);
    url.searchParams.set("query", query);
    url.searchParams.set("wait_end_of_query", "1");
    const headers: Record<string, string> = { "content-type": "application/x-ndjson" };
    if (this.config.clickhouseUsername) headers["x-clickhouse-user"] = this.config.clickhouseUsername;
    if (this.config.clickhousePassword) headers["x-clickhouse-key"] = this.config.clickhousePassword;
    const response = await fetch(url, { method: "POST", headers, body });
    const text = await response.text();
    if (!response.ok) throw new Error(`clickhouse_request_failed:${response.status}:${text.slice(0, 300)}`);
    return text;
  }
}

function toClickHouseRow(row: OutboxRow): Record<string, unknown> {
  const event = row.payload;
  return {
    event_id: event.eventId,
    event_type: event.eventType,
    event_version: event.eventVersion,
    occurred_at: normalizeClickHouseDate(event.occurredAt),
    bundle_id: event.eventType === "read_bundle_committed" ? event.bundleId : "",
    settlement_record_id: event.eventType === "settlement_changed" ? event.settlementRecordId : "",
    creator_id: event.creatorId,
    article_id: event.articleId,
    session_id: event.sessionId,
    access_mode: event.eventType === "read_bundle_committed" ? event.accessMode : "",
    section_id: event.eventType === "read_bundle_committed" ? event.sectionId ?? "" : "",
    start_sequence: event.eventType === "read_bundle_committed" ? event.startSequence : 0,
    end_sequence: event.eventType === "read_bundle_committed" ? event.endSequence : 0,
    words_count: event.eventType === "read_bundle_committed" ? event.wordsCount : 0,
    gross_amount_atomic: event.eventType === "read_bundle_committed" ? event.grossAmountAtomic : "0",
    creator_amount_atomic: event.eventType === "read_bundle_committed" ? event.creatorAmountAtomic : "0",
    rubicon_fee_atomic: event.eventType === "read_bundle_committed" ? event.rubiconFeeAtomic : "0",
    buyer_agent_hash: event.eventType === "read_bundle_committed" ? event.buyerAgentHash ?? "" : "",
    bundle_ids: event.eventType === "settlement_changed" ? event.bundleIds : [],
    provider_reference: event.eventType === "settlement_changed" ? event.providerReference : "",
    settlement_status: event.eventType === "settlement_changed" ? event.status : "",
    settled_creator_amount_atomic_delta: event.eventType === "settlement_changed" ? event.settledCreatorAmountAtomicDelta : "0",
    ingested_at: normalizeClickHouseDate(new Date().toISOString()),
  };
}

function normalizeClickHouseDate(value: string): string {
  return new Date(value).toISOString().replace("T", " ").replace("Z", "");
}

function quoteIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/g, "``")}\``;
}
