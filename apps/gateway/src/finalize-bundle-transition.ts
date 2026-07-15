import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadGatewayEnvironment } from "./config.js";
import { assertRailwayCompatibleDatabaseUrl, createPgPool } from "./repositories/postgres.js";

// Run after the new bundle-ledger gateway deployment is serving and all legacy
// gateway instances have drained. This intentionally is not part of the normal
// migration runner because the legacy evidence constraint is incompatible with
// old per-word persistence code.
if (!process.argv.includes("--confirm-no-legacy-gateways")) {
  throw new Error(
    "Refusing to finalize: pass --confirm-no-legacy-gateways only after every old gateway instance has drained",
  );
}

const { env } = loadGatewayEnvironment();
const databaseUrl = env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

assertRailwayCompatibleDatabaseUrl(databaseUrl);
const sqlPath = fileURLToPath(new URL(
  "../operations/post-deploy/finalize_bundle_ledger_transition.sql",
  import.meta.url,
));
const sql = await readFile(sqlPath, "utf8");
const pool = createPgPool(databaseUrl);
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const result = await client.query(sql);
  const last = Array.isArray(result) ? result.at(-1) : result;
  const counts = last?.rows?.[0] as TransitionCounts | undefined;
  if (!counts) throw new Error("Bundle transition finalizer returned no audit counts");
  const incomplete = [
    counts.unmigrated_payment_count,
    counts.unlinked_delivery_count,
    counts.unmigrated_evidence_receipt_count,
  ].some((value) => Number(value) !== 0);
  if (incomplete) {
    throw new Error(`Bundle transition catch-up incomplete: ${JSON.stringify(counts)}`);
  }
  await client.query("COMMIT");
  console.log(JSON.stringify(counts));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}

interface TransitionCounts {
  bundle_count: string;
  unmigrated_payment_count: string;
  unlinked_delivery_count: string;
  settlement_count: string;
  unmigrated_evidence_receipt_count: string;
  preserved_placeholder_count: string;
}
