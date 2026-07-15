export interface AnalyticsConfig {
  enabled: boolean;
  clickhouseUrl?: string;
  clickhouseUsername?: string;
  clickhousePassword?: string;
  clickhouseDatabase: string;
  batchSize: number;
  flushIntervalMs: number;
  maxAttempts: number;
  leaseTimeoutMs: number;
}

export function analyticsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AnalyticsConfig {
  const requested = env.ANALYTICS_ENABLED === "true";
  return {
    // Missing ClickHouse configuration disables only the worker. It must never
    // prevent the delivery gateway from starting.
    enabled: requested && Boolean(env.CLICKHOUSE_URL),
    clickhouseUrl: env.CLICKHOUSE_URL,
    clickhouseUsername: env.CLICKHOUSE_USERNAME,
    clickhousePassword: env.CLICKHOUSE_PASSWORD,
    clickhouseDatabase: env.CLICKHOUSE_DATABASE ?? "default",
    batchSize: positiveInt(env.ANALYTICS_BATCH_SIZE, 500),
    flushIntervalMs: positiveInt(env.ANALYTICS_FLUSH_INTERVAL_MS, 1_000),
    maxAttempts: positiveInt(env.ANALYTICS_MAX_ATTEMPTS, 12),
    leaseTimeoutMs: positiveInt(env.ANALYTICS_LEASE_TIMEOUT_MS, 60_000),
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
