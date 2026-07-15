import { createPgPool } from "../repositories/postgres.js";
import { AnalyticsOutboxRepository } from "./outbox-repository.js";
import { backfillBundleAnalytics } from "./backfill.js";
import { loadGatewayEnvironment } from "../config.js";

const { env } = loadGatewayEnvironment();
const databaseUrl = env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const args = parseArgs(process.argv.slice(2));
const pool = createPgPool(databaseUrl);
try {
  const result = await backfillBundleAnalytics(pool, new AnalyticsOutboxRepository(pool), {
    dryRun: args.has("dry-run"),
    from: args.get("from"),
    to: args.get("to"),
    creatorId: args.get("creator"),
    cursor: args.get("cursor"),
    batchSize: Number(args.get("batch-size") ?? 500),
    onProgress: (message) => console.log(message),
  });
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}

function parseArgs(values: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) result.set(key, "true");
    else { result.set(key, next); index += 1; }
  }
  return result;
}
