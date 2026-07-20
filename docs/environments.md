# Gateway environments

The gateway uses `APP_ENV=development|staging|production`. Configuration is
resolved once, before any database pool, analytics worker, payment verifier, or
HTTP server is created. The runtime composition and request paths are otherwise
the same for staging and production.

## Profile naming

All environments use the existing unprefixed resource, payment, and credential
variables. Only the public gateway URL has an environment-specific override:

```text
APP_ENV=development  -> DATABASE_URL, CLICKHOUSE_URL, ...
APP_ENV=staging      -> STAGING_GATEWAY_BASE_URL
APP_ENV=production   -> PRODUCTION_GATEWAY_BASE_URL
```

Platform values, resources, credentials, and tuning remain unprefixed.

## Required staging and production variables

Use the existing unprefixed names below. Only `GATEWAY_BASE_URL` is prefixed in
staging and production.

| Concern | Required variables | Rules |
| --- | --- | --- |
| Runtime database | `DATABASE_URL` | Full Postgres URL. Use a different database/project for each environment. |
| Published content/API database | `SUPABASE_URL` and one of `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_PUBLISHABLE_KEY`, or `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Staging and production projects and credentials must be distinct. |
| Payments | `RUBICON_PAYMENTS=circle`, `CIRCLE_FACILITATOR_URL`, `CIRCLE_X402_NETWORKS`, `BASE_X402_NETWORK` | Staging accepts recognized testnets only and requires Base Sepolia (`eip155:84532`). Production rejects testnets and requires Base mainnet (`eip155:8453`). |
| API credentials | `RUBICON_AGENT_API_KEY` | Must be unique per environment. `OPENAI_API_KEY`, `CDP_API_KEY_ID`, and `CDP_API_KEY_SECRET` are optional adapter credentials, but must also be environment-scoped when used. |
| Public URL | `GATEWAY_BASE_URL` | HTTPS. A staging hostname must contain `staging`, `stage`, or `test`; production rejects staging/test markers. |

ClickHouse is optional. To enable analytics, set
`ANALYTICS_ENABLED=true`, `CLICKHOUSE_URL`, `CLICKHOUSE_USERNAME`,
`CLICKHOUSE_PASSWORD`, and `CLICKHOUSE_DATABASE`. `CLICKHOUSE_URL` becomes
part of the selected profile; if it is absent the worker remains disabled and
content delivery still starts. Use separate endpoints, credentials, and databases
for staging and production.

Other payment settings are
`CIRCLE_ARC_PRIVATE_MAINNET`, `CIRCLE_X402_MAX_TIMEOUT_SECONDS`,
`CIRCLE_SYNCHRONOUS_SETTLEMENT`, `CIRCLE_SETTLEMENT_BATCH_SIZE`,
`CIRCLE_SETTLEMENT_BATCH_INTERVAL_MS`, `BASE_X402_USDC`,
`BASE_X402_MAX_ARTICLE_PRICE_ATOMIC`, and `BASE_X402_MAX_TIMEOUT_SECONDS`.
`RUN_MIGRATIONS`, `RUBICON_CONTACT_EMAIL`, `OPENAI_MODEL`, and
`RUBICON_ARTICLES` remain unprefixed. Deployed environments reject
`RUBICON_ARTICLES=demo`.

## Staging example

```text
APP_ENV=staging
DATABASE_URL=postgresql://...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
RUBICON_PAYMENTS=circle
CIRCLE_FACILITATOR_URL=https://gateway-api-testnet.circle.com
CIRCLE_X402_NETWORKS=eip155:5042002
CIRCLE_ARC_PRIVATE_MAINNET=false
BASE_X402_NETWORK=eip155:84532
RUBICON_AGENT_API_KEY=...
STAGING_GATEWAY_BASE_URL=https://staging.api.example.com
ANALYTICS_ENABLED=true
CLICKHOUSE_URL=https://clickhouse.example.com
CLICKHOUSE_USERNAME=...
CLICKHOUSE_PASSWORD=...
CLICKHOUSE_DATABASE=rubicon
```

## Startup safety checks

Startup fails before opening network connections when:

- `APP_ENV` is missing or unsupported;
- a deployed profile is missing a required variable;
- staging selects mainnet payment resources, private Arc mainnet, or a public
  production-marked URL;
- production selects a recognized testnet, Base Sepolia, or a staging/test URL;

Both `GET /health` and `GET /health/analytics` return `appEnv`. Fastify request
logs, payment lifecycle records, Circle settlement records, and startup records
also carry `appEnv` without logging secrets.
