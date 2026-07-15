# Gateway environments

The gateway uses `APP_ENV=development|staging|production`. Configuration is
resolved once, before any database pool, analytics worker, payment verifier, or
HTTP server is created. The runtime composition and request paths are otherwise
the same for staging and production.

## Profile naming

Development reads the existing unprefixed variables. Staging and production do
not fall back to unprefixed resource values. After selection, prefixed values
from both profiles are removed from the live process environment and only the
selected canonical values remain:

```text
APP_ENV=development  -> DATABASE_URL, CLICKHOUSE_URL, ...
APP_ENV=staging      -> STAGING_DATABASE_URL, STAGING_CLICKHOUSE_URL, ...
APP_ENV=production   -> PRODUCTION_DATABASE_URL, PRODUCTION_CLICKHOUSE_URL, ...
```

Platform values such as `PORT` and non-resource tuning such as
`ANALYTICS_BATCH_SIZE` remain unprefixed. Keep staging and production secrets in
separate deployment environments; do not expose production credentials to the
staging service.

## Required staging and production variables

Prefix each name below with `STAGING_` or `PRODUCTION_`.

| Concern | Required variables | Rules |
| --- | --- | --- |
| Runtime database | `DATABASE_URL` | Full Postgres URL. Use a different database/project for each environment. |
| Published content/API database | `SUPABASE_URL` and one of `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_PUBLISHABLE_KEY`, or `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Staging and production projects and credentials must be distinct. |
| Payments | `RUBICON_PAYMENTS=circle`, `CIRCLE_FACILITATOR_URL`, `CIRCLE_X402_NETWORKS`, `BASE_X402_NETWORK` | Staging accepts recognized testnets only and requires Base Sepolia (`eip155:84532`). Production rejects testnets and requires Base mainnet (`eip155:8453`). |
| Payment webhooks | `PAYMENT_WEBHOOK_URL`, `PAYMENT_WEBHOOK_SECRET` | The callback URL must be HTTPS and share the selected `GATEWAY_BASE_URL` origin. Use a different signing secret per environment. The current payment adapters own callback registration; this configuration does not add a public webhook route. |
| API credentials | `RUBICON_AGENT_API_KEY` | Must be unique per environment. `OPENAI_API_KEY`, `CDP_API_KEY_ID`, and `CDP_API_KEY_SECRET` are optional adapter credentials, but must also be environment-scoped when used. |
| Public URL | `GATEWAY_BASE_URL` | HTTPS. A staging hostname must contain `staging`, `stage`, or `test`; production rejects staging/test markers. |

ClickHouse is optional. To enable analytics, set the environment-prefixed
`ANALYTICS_ENABLED=true`, `CLICKHOUSE_URL`, `CLICKHOUSE_USERNAME`,
`CLICKHOUSE_PASSWORD`, and `CLICKHOUSE_DATABASE`. `CLICKHOUSE_URL` becomes
part of the selected profile; if it is absent the worker remains disabled and
content delivery still starts. Use separate endpoints, credentials, and databases
for staging and production.

Other environment-scoped payment settings are
`CIRCLE_ARC_PRIVATE_MAINNET`, `CIRCLE_X402_MAX_TIMEOUT_SECONDS`,
`CIRCLE_SYNCHRONOUS_SETTLEMENT`, `CIRCLE_SETTLEMENT_BATCH_SIZE`,
`CIRCLE_SETTLEMENT_BATCH_INTERVAL_MS`, `BASE_X402_USDC`,
`BASE_X402_MAX_ARTICLE_PRICE_ATOMIC`, and `BASE_X402_MAX_TIMEOUT_SECONDS`.
`RUN_MIGRATIONS`, `RUBICON_CONTACT_EMAIL`, `OPENAI_MODEL`, and
`RUBICON_ARTICLES` are scoped as well. Deployed environments reject
`RUBICON_ARTICLES=demo`.

## Staging example

```text
APP_ENV=staging
STAGING_DATABASE_URL=postgresql://...
STAGING_SUPABASE_URL=https://staging-project.supabase.co
STAGING_SUPABASE_SERVICE_ROLE_KEY=...
STAGING_RUBICON_PAYMENTS=circle
STAGING_CIRCLE_FACILITATOR_URL=https://gateway-api-testnet.circle.com
STAGING_CIRCLE_X402_NETWORKS=eip155:5042002
STAGING_CIRCLE_ARC_PRIVATE_MAINNET=false
STAGING_BASE_X402_NETWORK=eip155:84532
STAGING_CDP_API_KEY_ID=...
STAGING_CDP_API_KEY_SECRET=...
STAGING_PAYMENT_WEBHOOK_URL=https://staging.api.example.com/webhooks/payments
STAGING_PAYMENT_WEBHOOK_SECRET=...
STAGING_RUBICON_AGENT_API_KEY=...
STAGING_OPENAI_API_KEY=...
STAGING_GATEWAY_BASE_URL=https://staging.api.example.com
STAGING_ANALYTICS_ENABLED=true
STAGING_CLICKHOUSE_URL=https://staging-clickhouse.example.com
STAGING_CLICKHOUSE_USERNAME=...
STAGING_CLICKHOUSE_PASSWORD=...
STAGING_CLICKHOUSE_DATABASE=rubicon_staging
```

## Startup safety checks

Startup fails before opening network connections when:

- `APP_ENV` is missing or unsupported;
- a deployed profile is missing a required scoped variable;
- staging selects mainnet payment resources, private Arc mainnet, or a public
  production-marked URL;
- production selects a recognized testnet, Base Sepolia, or a staging/test URL;
- the webhook and public gateway origins differ;
- both profiles are present and any database URL, ClickHouse resource,
  credential, webhook, payment endpoint/network, or public URL is identical.

Opaque credentials cannot reveal which provider account issued them. The
profile prefixes and pairwise equality checks are therefore part of the safety
boundary; provider projects/accounts must still be separate operationally.

Both `GET /health` and `GET /health/analytics` return `appEnv`. Fastify request
logs, payment lifecycle records, Circle settlement records, and startup records
also carry `appEnv` without logging secrets.
