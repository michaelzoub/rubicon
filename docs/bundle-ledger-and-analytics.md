# Bundle ledger, settlement lifecycle, and analytics

## Request transaction

The paid-reading product remains exactly metered per word, but persistence is
bundle-oriented. For every authorized bundle the gateway:

1. verifies the provider authorization;
2. assembles only the current response bundle in memory;
3. begins a Postgres transaction and locks the `stream_sessions` row;
4. enforces the expected starting sequence and idempotency key;
5. inserts one authoritative `read_bundles` row and one compatibility
   `word_payments` row;
6. bulk-inserts all optional `word_deliveries` audit rows through one `unnest`
   statement;
7. updates durable session word/payment counters;
8. appends one sanitized `read_bundle_committed` event to `analytics_outbox`;
9. commits, then queues provider settlement and emits content.

If any statement fails, no content is returned. ClickHouse is not contacted by
this transaction. A 20-word request therefore creates one bundle, one payment
record, one outbox event, and (for compatibility) 20 audit rows in one bulk SQL
statement.

`read_bundles` is authoritative for the session, article, creator, immutable
sequence range, exact charged price per word, aggregate amounts, buyer payment
reference, and eventual settlement status. Money is `NUMERIC(78,0)` atomic USDC;
application code uses `bigint`. The database checks the range/word-count and
gross-amount invariants.

Word text remains only in `word_deliveries` because current receipt and debugging
surfaces reconstruct returned ranges from it. It never enters the outbox or
ClickHouse.

## Settlement lifecycle

Authorization, delivery, and settlement are separate facts:

- a paid bundle starts as `authorized` after verification and delivery commit;
- a `settlements` row exists only after the provider returns at least one real
  transfer, settlement, or transaction reference;
- `settlement_bundle_links` supports multiple bundles per settlement and
  multiple settlement attempts/events per bundle;
- transitions are `pending`, `confirmed`, `completed`, or `failed`;
- retries are idempotent through the settlement idempotency key;
- only `completed` events contribute a settled-creator-amount delta.

The legacy `settlement_receipts` table becomes read-only compatibility history
after the new gateway is deployed. New delivery code never inserts it. The
post-deploy `finalize:bundle-transition` operation adds a `NOT VALID` evidence
constraint, so old placeholders remain auditable while new placeholder rows are
rejected. Keeping that constraint out of migration `0011` lets the previous
gateway version continue serving during an expand-first rolling deployment.

## Migration audit and cleanup

Migration `0011` performs a non-destructive compatibility backfill: each old
word payment/delivery becomes a deterministic one-word historical bundle, and
only legacy receipts with provider evidence are copied into `settlements`.
Nothing is deleted.

Before migration, take a database snapshot. After migration, classify rows:

```sql
SELECT migration_classification, count(*)
FROM settlement_receipts_migration_audit
GROUP BY migration_classification
ORDER BY migration_classification;

SELECT *
FROM settlement_receipts_migration_audit
WHERE migration_classification <> 'provider_evidence'
ORDER BY created_at;

SELECT count(*) AS legacy_payments,
       (SELECT count(*) FROM read_bundles WHERE bundle_id LIKE 'legacy:%') AS migrated_paid_bundles
FROM word_payments;

SELECT count(*) AS evidence_receipts,
       (SELECT count(*) FROM settlements WHERE provider = 'legacy') AS migrated_settlements
FROM settlement_receipts_migration_audit
WHERE migration_classification = 'provider_evidence';
```

Do not delete placeholder or duplicate legacy rows until the snapshot is
verified and the count/reference queries reconcile. Cleanup is intentionally a
separate operator decision, not part of an application migration.

## Production server transition

The ClickHouse DDL creates analytics storage only. It does not alter Postgres,
deploy the gateway, start the worker, or copy historical rows. Transition the
server in this order:

1. Keep production analytics disabled and take a Postgres snapshot.
2. Run the normal Postgres migrations once from a single migration owner. This
   expand step creates `read_bundles`, evidence-backed settlements, linkage,
   and `analytics_outbox`, and performs the first idempotent legacy backfill.
3. Deploy the new gateway code. Do not run old and new persistence versions
   across the same session longer than the platform's normal drain window.
4. Confirm a new read creates a `read_bundles` row and sanitized outbox event.
5. After every old gateway instance is drained, run
   `finalize:bundle-transition`. It catches up legacy writes that landed during
   deployment, links their word audits, migrates real settlement evidence, and
   only then rejects future placeholder receipts.
6. Dry-run and then execute the analytics backfill.
7. Enable the ClickHouse worker and redeploy/restart the gateway.
8. Watch `/health/analytics` until the backlog reaches zero, then reconcile an
   interval older than the ingestion-delay window.

For a production Railway service using the production profile, run the one-off
commands inside that service environment so the existing `PRODUCTION_*`
variables are selected:

```bash
APP_ENV=production pnpm --filter @rubicon-caliga/gateway migrate
APP_ENV=production pnpm --filter @rubicon-caliga/gateway finalize:bundle-transition -- --confirm-no-legacy-gateways
APP_ENV=production pnpm --filter @rubicon-caliga/gateway backfill:analytics -- --dry-run --from 2026-01-01
APP_ENV=production pnpm --filter @rubicon-caliga/gateway backfill:analytics -- --from 2026-01-01 --batch-size 500
APP_ENV=production pnpm --filter @rubicon-caliga/gateway reconcile:analytics -- --from 2026-01-01 --to 2026-07-15 --delay-hours 1
```

Keep `PRODUCTION_RUN_MIGRATIONS=false` on ordinary gateway replicas. Migrations
and finalization are single-owner operations; the outbox worker itself is safe
across multiple replicas because claims use leases and `SKIP LOCKED`.

## Outbox and ClickHouse worker

`analytics_outbox` is appended in the same transaction as each bundle or
settlement record. Events contain IDs, ranges, counts, exact atomic amounts, and
optional hashed buyer identity only. They never contain article bodies, words,
prompts, signed authorization payloads, or credentials.

The worker claims batches with `FOR UPDATE SKIP LOCKED`, leases rows, inserts
JSONEachRow into ClickHouse, and marks rows processed only after ClickHouse
confirms the request. Expired leases are reclaimable. Failures use bounded
exponential backoff; rows reaching `ANALYTICS_MAX_ATTEMPTS` remain visible as
poison events. Shutdown releases outstanding claims.

The ClickHouse source table uses stable event IDs and `ReplacingMergeTree`.
Aggregate views query `FINAL`, preventing ambiguous-response retries or
backfills from double-counting. Insert-triggered aggregate materialized views
are deliberately not used because they would aggregate a retry before source
deduplication.

Health is available at `GET /health/analytics`: backlog size, poison count,
oldest event age, latest processed timestamp, and worker state. The ordinary
`GET /health` and every content/payment route are independent of it.

Development configuration uses these unprefixed names. Staging and production
must prefix them with `STAGING_` or `PRODUCTION_`; see
[environments.md](environments.md).

```text
ANALYTICS_ENABLED=true
CLICKHOUSE_URL=https://...
CLICKHOUSE_USERNAME=...
CLICKHOUSE_PASSWORD=...
CLICKHOUSE_DATABASE=default
ANALYTICS_BATCH_SIZE=500
ANALYTICS_FLUSH_INTERVAL_MS=1000
ANALYTICS_MAX_ATTEMPTS=12
ANALYTICS_LEASE_TIMEOUT_MS=60000
```

Missing or unavailable ClickHouse disables/fails only ingestion; it never
blocks bundle commits or content delivery.

## Backfill and reconciliation

The backfill runs resumable bundle and settlement phases. It reads
`read_bundles` and evidence-backed `settlements` in bounded `(created_at, id)`
cursor batches and appends deterministic outbox event IDs:

```bash
APP_ENV=development pnpm --filter @rubicon-caliga/gateway backfill:analytics -- --dry-run --from 2026-01-01 --to 2026-08-01
APP_ENV=development pnpm --filter @rubicon-caliga/gateway backfill:analytics -- --from 2026-01-01 --creator creator_123 --batch-size 500
```

Progress prints a resumable `cursor`. Re-running is safe because `event_id` is
unique.

Reconciliation compares Postgres and ClickHouse by UTC day and creator for
bundle count, delivered/paid words, distinct sessions, gross amount, creator
amount, and settled creator amount. It exits non-zero on old mismatches and
ignores only the explicit ingestion-delay window:

```bash
APP_ENV=development pnpm --filter @rubicon-caliga/gateway reconcile:analytics -- --from 2026-01-01 --to 2026-08-01 --delay-hours 1
```
