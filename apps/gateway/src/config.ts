export type AppEnv = "development" | "staging" | "production";

/**
 * The deployment uses the existing shared resources and credentials. Only the
 * public gateway URL has an environment-specific override.
 */
export const ENVIRONMENT_SCOPED_VARIABLES = [
  "GATEWAY_BASE_URL",
] as const;

type EnvironmentScopedVariable = (typeof ENVIRONMENT_SCOPED_VARIABLES)[number];

const REQUIRED_DEPLOYED_VARIABLES = [
  "DATABASE_URL",
  "SUPABASE_URL",
  "RUBICON_PAYMENTS",
  "CIRCLE_FACILITATOR_URL",
  "CIRCLE_X402_NETWORKS",
  "BASE_X402_NETWORK",
  "RUBICON_AGENT_API_KEY",
  "GATEWAY_BASE_URL",
];

const TESTNET_CHAIN_IDS = new Set([5042002, 84532, 11155111]);

export interface GatewayEnvironmentConfig {
  appEnv: AppEnv;
  /** Selected profile mapped back to the canonical variable names consumed by adapters. */
  env: NodeJS.ProcessEnv;
  databaseUrl?: string;
  clickhouseUrl?: string;
  agentApiKey?: string;
  publicUrl: string;
}

export function parseAppEnv(value: string | undefined): AppEnv {
  if (value === "development" || value === "staging" || value === "production") {
    return value;
  }
  throw new Error("APP_ENV must be exactly one of development, staging, or production");
}

export function profileVariableName(appEnv: AppEnv, name: EnvironmentScopedVariable): string {
  return appEnv === "development" ? name : `${appEnv.toUpperCase()}_${name}`;
}

/** Select one profile without validating that every server-startup value exists. */
export function selectEnvironmentVariables(env: NodeJS.ProcessEnv = process.env): {
  appEnv: AppEnv;
  env: NodeJS.ProcessEnv;
} {
  const appEnv = parseAppEnv(env.APP_ENV);
  const selected: NodeJS.ProcessEnv = { ...env, APP_ENV: appEnv };
  if (appEnv === "development") {
    for (const name of ENVIRONMENT_SCOPED_VARIABLES) {
      delete selected[`STAGING_${name}`];
      delete selected[`PRODUCTION_${name}`];
    }
    return { appEnv, env: selected };
  }

  for (const name of ENVIRONMENT_SCOPED_VARIABLES) {
    delete selected[name];
    const value = env[profileVariableName(appEnv, name)];
    if (value !== undefined) selected[name] = value;
    delete selected[`STAGING_${name}`];
    delete selected[`PRODUCTION_${name}`];
  }
  return { appEnv, env: selected };
}

/**
 * Resolve and validate the complete gateway startup configuration. All checks
 * happen before database, analytics, payment, or HTTP adapters are created.
 */
export function loadGatewayEnvironment(env: NodeJS.ProcessEnv = process.env): GatewayEnvironmentConfig {
  const selected = selectEnvironmentVariables(env);
  const runtime = selected.env;
  if (selected.appEnv !== "development") {
    validateRequiredDeployedVariables(selected.appEnv, runtime);
    validateDeployedResources(selected.appEnv, runtime);
  }

  return {
    appEnv: selected.appEnv,
    env: runtime,
    databaseUrl: runtime.DATABASE_URL,
    clickhouseUrl: runtime.CLICKHOUSE_URL,
    agentApiKey: runtime.RUBICON_AGENT_API_KEY,
    publicUrl: runtime.GATEWAY_BASE_URL ?? `http://localhost:${runtime.GATEWAY_PORT ?? runtime.PORT ?? 8787}`,
  };
}

/** Activate a previously selected profile for dependencies that read process.env internally. */
export function activateEnvironmentVariables(selected: NodeJS.ProcessEnv): void {
  for (const name of ENVIRONMENT_SCOPED_VARIABLES) {
    delete process.env[name];
    delete process.env[`STAGING_${name}`];
    delete process.env[`PRODUCTION_${name}`];
  }
  for (const name of ENVIRONMENT_SCOPED_VARIABLES) {
    const value = selected[name];
    if (value !== undefined) process.env[name] = value;
  }
  process.env.APP_ENV = selected.APP_ENV;
}

function validateRequiredDeployedVariables(appEnv: Exclude<AppEnv, "development">, env: NodeJS.ProcessEnv): void {
  const missing = REQUIRED_DEPLOYED_VARIABLES.filter((name) => !env[name]?.trim())
    .map((name) => name === "GATEWAY_BASE_URL" ? profileVariableName(appEnv, name) : name);
  if (!supabaseKey(env)) {
    missing.push("SUPABASE_SERVICE_ROLE_KEY (or another supported Supabase key)");
  }
  if (missing.length > 0) {
    throw new Error(`Missing required ${appEnv} configuration: ${missing.join(", ")}`);
  }
}

function validateDeployedResources(appEnv: Exclude<AppEnv, "development">, env: NodeJS.ProcessEnv): void {
  if (env.RUBICON_ARTICLES === "demo") {
    throw new Error(`${appEnv} cannot use RUBICON_ARTICLES=demo`);
  }
  if (env.RUBICON_PAYMENTS !== "circle") {
    throw new Error(`${appEnv} must use RUBICON_PAYMENTS=circle`);
  }
  const databaseUrl = assertPostgresUrl(env.DATABASE_URL!);
  const publicUrl = assertHttpsUrl("GATEWAY_BASE_URL", env.GATEWAY_BASE_URL!);
  const supabaseUrl = assertHttpsUrl("SUPABASE_URL", env.SUPABASE_URL!);
  const facilitatorUrl = assertHttpsUrl("CIRCLE_FACILITATOR_URL", env.CIRCLE_FACILITATOR_URL!);
  const clickhouseUrl = env.CLICKHOUSE_URL ? assertHttpsUrl("CLICKHOUSE_URL", env.CLICKHOUSE_URL) : undefined;

  const networks = parseNetworks(env.CIRCLE_X402_NETWORKS!);
  const baseChainId = parseEip155ChainId("BASE_X402_NETWORK", env.BASE_X402_NETWORK!);
  if (appEnv === "staging") {
    assertNoMarker("staging", "production", [
      resourceIdentity(databaseUrl), resourceIdentity(supabaseUrl), resourceIdentity(clickhouseUrl),
      resourceIdentity(facilitatorUrl),
    ]);
    if (!hasEnvironmentMarker(publicUrl.hostname, "staging") && !isRailwayPublicDomain(publicUrl.hostname)) {
      throw new Error("STAGING_GATEWAY_BASE_URL hostname must include a staging, stage, or test marker (or use a Railway public domain)");
    }
    if (!hasEnvironmentMarker(facilitatorUrl.hostname, "staging")) {
      throw new Error("staging CIRCLE_FACILITATOR_URL must be a testnet/staging endpoint");
    }
    if (env.CIRCLE_ARC_PRIVATE_MAINNET === "true") {
      throw new Error("staging cannot enable CIRCLE_ARC_PRIVATE_MAINNET");
    }
    if (networks.some((chainId) => !TESTNET_CHAIN_IDS.has(chainId))) {
      throw new Error("staging CIRCLE_X402_NETWORKS must contain only recognized testnet networks");
    }
    if (baseChainId !== 84532) {
      throw new Error("staging BASE_X402_NETWORK must be Base Sepolia (eip155:84532)");
    }
  } else {
    assertNoMarker("production", "staging", [
      resourceIdentity(databaseUrl), resourceIdentity(supabaseUrl), resourceIdentity(clickhouseUrl),
      resourceIdentity(publicUrl), resourceIdentity(facilitatorUrl),
    ]);
    if (networks.some((chainId) => TESTNET_CHAIN_IDS.has(chainId))) {
      throw new Error("production CIRCLE_X402_NETWORKS cannot contain testnet networks");
    }
    if (baseChainId !== 8453) {
      throw new Error("production BASE_X402_NETWORK must be Base mainnet (eip155:8453)");
    }
  }
}

function supabaseKey(env: NodeJS.ProcessEnv): string | undefined {
  return env.SUPABASE_SERVICE_ROLE_KEY
    ?? env.SUPABASE_ANON_KEY
    ?? env.SUPABASE_PUBLISHABLE_KEY
    ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
}

function assertPostgresUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a full PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://");
  }
  return parsed;
}

function assertHttpsUrl(name: string, value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${name} must use https in staging and production`);
  return parsed;
}

function parseNetworks(value: string): number[] {
  const networks = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (networks.length === 0) throw new Error("CIRCLE_X402_NETWORKS must include at least one network");
  return networks.map((network) => parseEip155ChainId("CIRCLE_X402_NETWORKS", network));
}

function parseEip155ChainId(name: string, value: string): number {
  const match = /^eip155:(\d+)$/.exec(value);
  const chainId = Number(match?.[1]);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`${name} must contain CAIP-2 eip155:<chainId> values`);
  }
  return chainId;
}

function assertNoMarker(
  appEnv: Exclude<AppEnv, "development">,
  forbidden: "staging" | "production",
  values: Array<string | undefined>,
): void {
  if (values.some((value) => value && hasEnvironmentMarker(value, forbidden))) {
    throw new Error(`${appEnv} configuration contains an explicit ${forbidden} resource marker`);
  }
}

function hasEnvironmentMarker(value: string, environment: "staging" | "production"): boolean {
  const tokens = value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return environment === "staging"
    ? tokens.some((token) => token === "staging" || token === "stage" || token === "test" || token === "testnet")
    : tokens.some((token) => token === "production" || token === "prod" || token === "mainnet" || token === "live");
}

/** Railway assigns domains from the service name, which can include "production" for a staging service. */
function isRailwayPublicDomain(hostname: string): boolean {
  return hostname.toLowerCase().endsWith(".up.railway.app");
}

function resourceIdentity(url: URL | undefined): string | undefined {
  return url ? `${url.username} ${url.hostname} ${url.pathname}` : undefined;
}
