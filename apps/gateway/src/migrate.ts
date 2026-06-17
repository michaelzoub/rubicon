import { createPgPool, runMigrations } from "./repositories/postgres.js";

// Apply Rubicon's shared schema migrations.
//
//   DATABASE_URL=postgres://... pnpm --filter @rubicon-caliga/gateway migrate
//
// The same schema is shared with rubicon-marketing; run migrations from a single
// owner (typically the marketing app in production) to avoid divergence.

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

const pool = createPgPool(databaseUrl);
try {
  await runMigrations(pool);
  console.log("[migrate] migrations applied");
} finally {
  await pool.end();
}
