import { createPgPool } from "../repositories/postgres.js";
import { analyticsConfigFromEnv } from "./config.js";
import { ClickHouseAnalyticsClient } from "./clickhouse-client.js";
import { loadGatewayEnvironment } from "../config.js";

const fields: Array<keyof Omit<MetricRow, "day" | "creator_id">> = [
  "bundle_count", "delivered_words", "paid_words", "distinct_sessions",
  "gross_amount_atomic", "creator_amount_atomic", "settled_creator_amount_atomic",
];

const { env } = loadGatewayEnvironment();
const databaseUrl = env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (key?.startsWith("--") && value && !value.startsWith("--")) { args.set(key.slice(2), value); i += 1; }
}
const from = args.get("from") ?? "1970-01-01";
const to = args.get("to") ?? "2100-01-01";
const creator = args.get("creator");
const delayHours = Number(args.get("delay-hours") ?? 1);
const cutoff = new Date(Date.now() - delayHours * 3_600_000);
const pool = createPgPool(databaseUrl);
try {
  const postgres = await pool.query<MetricRow>(
    `WITH bundle_metrics AS (
       SELECT (created_at AT TIME ZONE 'UTC')::date::text AS day, creator_id,
              COUNT(*)::text AS bundle_count,
              SUM(words_count)::text AS delivered_words,
              SUM(CASE WHEN access_mode = 'paid' THEN words_count ELSE 0 END)::text AS paid_words,
              COUNT(DISTINCT session_id)::text AS distinct_sessions,
              SUM(gross_amount_atomic)::text AS gross_amount_atomic,
              SUM(creator_amount_atomic)::text AS creator_amount_atomic
       FROM read_bundles
       WHERE created_at >= $1 AND created_at < $2 AND ($3::text IS NULL OR creator_id = $3)
       GROUP BY day, creator_id
     ), settled_metrics AS (
       SELECT (s.created_at AT TIME ZONE 'UTC')::date::text AS day, b.creator_id,
              SUM(l.allocated_creator_amount_atomic)::text AS settled_creator_amount_atomic
       FROM settlements s
       JOIN settlement_bundle_links l ON l.settlement_record_id = s.id
       JOIN read_bundles b ON b.bundle_id = l.bundle_id
       WHERE s.status = 'completed' AND s.created_at >= $1 AND s.created_at < $2
         AND ($3::text IS NULL OR b.creator_id = $3)
       GROUP BY day, b.creator_id
     )
     SELECT COALESCE(b.day, s.day) AS day, COALESCE(b.creator_id, s.creator_id) AS creator_id,
            COALESCE(b.bundle_count, '0') AS bundle_count,
            COALESCE(b.delivered_words, '0') AS delivered_words,
            COALESCE(b.paid_words, '0') AS paid_words,
            COALESCE(b.distinct_sessions, '0') AS distinct_sessions,
            COALESCE(b.gross_amount_atomic, '0') AS gross_amount_atomic,
            COALESCE(b.creator_amount_atomic, '0') AS creator_amount_atomic,
            COALESCE(s.settled_creator_amount_atomic, '0') AS settled_creator_amount_atomic
     FROM bundle_metrics b FULL JOIN settled_metrics s USING (day, creator_id)
     ORDER BY day, creator_id`,
    [from, to, creator ?? null],
  );
  const config = analyticsConfigFromEnv(env);
  if (!config.clickhouseUrl) throw new Error("CLICKHOUSE_URL is required");
  const creatorFilter = creator ? `AND creator_id = '${escapeSql(creator)}'` : "";
  const clickhouse = await new ClickHouseAnalyticsClient(config).queryJson<{ data: MetricRow[] }>(
    `SELECT toString(day) AS day, creator_id,
            toString(sum(bundle_count)) AS bundle_count,
            toString(sum(delivered_words)) AS delivered_words,
            toString(sum(paid_words)) AS paid_words,
            toString(sum(agent_reads)) AS distinct_sessions,
            toString(sum(gross_amount_atomic)) AS gross_amount_atomic,
            toString(sum(creator_earnings_atomic)) AS creator_amount_atomic,
            toString(sum(settled_creator_earnings_atomic)) AS settled_creator_amount_atomic
     FROM ${quoteIdentifier(config.clickhouseDatabase)}.creator_daily_metrics
     WHERE day >= toDate('${escapeSql(from)}') AND day < toDate('${escapeSql(to)}') ${creatorFilter}
     GROUP BY day, creator_id ORDER BY day, creator_id`,
  );
  const left = new Map(postgres.rows.map((row) => [key(row), row]));
  const right = new Map(clickhouse.data.map((row) => [key(row), row]));
  const mismatches: Array<{ key: string; postgres?: MetricRow; clickhouse?: MetricRow }> = [];
  for (const metricKey of new Set([...left.keys(), ...right.keys()])) {
    const dayEnd = new Date(`${metricKey.slice(0, 10)}T23:59:59.999Z`);
    if (dayEnd > cutoff) continue;
    const pg = left.get(metricKey);
    const ch = right.get(metricKey);
    if (!pg || !ch || fields.some((field) => pg[field] !== ch[field])) mismatches.push({ key: metricKey, postgres: pg, clickhouse: ch });
  }
  console.log(JSON.stringify({ from, to, creator, delayHours, mismatches }, null, 2));
  if (mismatches.length > 0) process.exitCode = 1;
} finally {
  await pool.end();
}

interface MetricRow {
  day: string;
  creator_id: string;
  bundle_count: string;
  delivered_words: string;
  paid_words: string;
  distinct_sessions: string;
  gross_amount_atomic: string;
  creator_amount_atomic: string;
  settled_creator_amount_atomic: string;
}
const key = (row: MetricRow) => `${row.day}:${row.creator_id}`;

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function quoteIdentifier(value: string): string {
  return `\`${value.replace(/`/g, "``")}\``;
}
