import assert from "node:assert/strict";
import test from "node:test";
import { loadGatewayEnvironment, selectEnvironmentVariables } from "./config.js";

function stagingEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    APP_ENV: "staging",
    STAGING_DATABASE_URL: "postgresql://rubicon_staging:secret@db.example.com:5432/rubicon_staging",
    STAGING_SUPABASE_URL: "https://staging-project.supabase.co",
    STAGING_SUPABASE_SERVICE_ROLE_KEY: "staging-service-key",
    STAGING_RUBICON_PAYMENTS: "circle",
    STAGING_CIRCLE_FACILITATOR_URL: "https://gateway-api-testnet.circle.com",
    STAGING_CIRCLE_X402_NETWORKS: "eip155:5042002",
    STAGING_CIRCLE_ARC_PRIVATE_MAINNET: "false",
    STAGING_BASE_X402_NETWORK: "eip155:84532",
    STAGING_CDP_API_KEY_ID: "staging-cdp-id",
    STAGING_CDP_API_KEY_SECRET: "staging-cdp-secret",
    STAGING_PAYMENT_WEBHOOK_URL: "https://staging.api.rubiconpay.xyz/webhooks/payments",
    STAGING_PAYMENT_WEBHOOK_SECRET: "staging-webhook-secret",
    STAGING_RUBICON_AGENT_API_KEY: "staging-agent-key",
    STAGING_OPENAI_API_KEY: "staging-openai-key",
    STAGING_GATEWAY_BASE_URL: "https://staging.api.rubiconpay.xyz",
    ...overrides,
  };
}

function productionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    APP_ENV: "production",
    PRODUCTION_DATABASE_URL: "postgresql://rubicon:secret@db.example.com:5432/rubicon",
    PRODUCTION_SUPABASE_URL: "https://project.supabase.co",
    PRODUCTION_SUPABASE_SERVICE_ROLE_KEY: "production-service-key",
    PRODUCTION_RUBICON_PAYMENTS: "circle",
    PRODUCTION_CIRCLE_FACILITATOR_URL: "https://gateway-api.circle.com",
    PRODUCTION_CIRCLE_X402_NETWORKS: "eip155:1",
    PRODUCTION_CIRCLE_ARC_PRIVATE_MAINNET: "true",
    PRODUCTION_BASE_X402_NETWORK: "eip155:8453",
    PRODUCTION_CDP_API_KEY_ID: "production-cdp-id",
    PRODUCTION_CDP_API_KEY_SECRET: "production-cdp-secret",
    PRODUCTION_PAYMENT_WEBHOOK_URL: "https://api.rubiconpay.xyz/webhooks/payments",
    PRODUCTION_PAYMENT_WEBHOOK_SECRET: "production-webhook-secret",
    PRODUCTION_RUBICON_AGENT_API_KEY: "production-agent-key",
    PRODUCTION_OPENAI_API_KEY: "production-openai-key",
    PRODUCTION_GATEWAY_BASE_URL: "https://api.rubiconpay.xyz",
    ...overrides,
  };
}

test("APP_ENV is explicit and limited to the supported environments", () => {
  assert.throws(() => loadGatewayEnvironment({}), /APP_ENV must be exactly/);
  assert.throws(() => loadGatewayEnvironment({ APP_ENV: "preview" }), /APP_ENV must be exactly/);
});

test("staging selects only STAGING_ resource variables", () => {
  const source = stagingEnv({
    DATABASE_URL: "postgresql://wrong-unscoped",
    PRODUCTION_DATABASE_URL: "postgresql://production:secret@prod.example.com/prod",
  });
  const selected = selectEnvironmentVariables(source);
  assert.equal(selected.appEnv, "staging");
  assert.equal(selected.env.DATABASE_URL, source.STAGING_DATABASE_URL);
  assert.equal(selected.env.OPENAI_API_KEY, source.STAGING_OPENAI_API_KEY);
  assert.notEqual(selected.env.DATABASE_URL, source.DATABASE_URL);
  assert.equal(selected.env.PRODUCTION_DATABASE_URL, undefined);
  assert.equal(selected.env.STAGING_DATABASE_URL, undefined);
});

test("valid staging configuration uses isolated testnet payment resources", () => {
  const config = loadGatewayEnvironment(stagingEnv({
    STAGING_ANALYTICS_ENABLED: "true",
    STAGING_CLICKHOUSE_URL: "https://staging-clickhouse.example.com",
    STAGING_CLICKHOUSE_DATABASE: "rubicon_staging",
  }));
  assert.equal(config.appEnv, "staging");
  assert.equal(config.env.BASE_X402_NETWORK, "eip155:84532");
  assert.equal(config.env.CLICKHOUSE_DATABASE, "rubicon_staging");
  assert.equal(config.publicUrl, "https://staging.api.rubiconpay.xyz");
});

test("valid production configuration uses production-scoped resources", () => {
  const config = loadGatewayEnvironment(productionEnv());
  assert.equal(config.appEnv, "production");
  assert.equal(config.env.BASE_X402_NETWORK, "eip155:8453");
  assert.equal(config.agentApiKey, "production-agent-key");
});

test("staging fails closed on mainnet payment configuration", () => {
  assert.throws(
    () => loadGatewayEnvironment(stagingEnv({ STAGING_CIRCLE_X402_NETWORKS: "eip155:1" })),
    /only recognized testnet networks/,
  );
  assert.throws(
    () => loadGatewayEnvironment(stagingEnv({ STAGING_BASE_X402_NETWORK: "eip155:8453" })),
    /Base Sepolia/,
  );
  assert.throws(
    () => loadGatewayEnvironment(stagingEnv({ STAGING_CIRCLE_ARC_PRIVATE_MAINNET: "true" })),
    /cannot enable CIRCLE_ARC_PRIVATE_MAINNET/,
  );
});

test("staging fails closed on production-marked service resources", () => {
  assert.throws(
    () => loadGatewayEnvironment(stagingEnv({
      STAGING_GATEWAY_BASE_URL: "https://production.api.rubiconpay.xyz",
      STAGING_PAYMENT_WEBHOOK_URL: "https://production.api.rubiconpay.xyz/webhooks/payments",
    })),
    /explicit production resource marker/,
  );
});

test("production fails closed on staging URLs and testnet payment networks", () => {
  assert.throws(
    () => loadGatewayEnvironment(productionEnv({
      PRODUCTION_GATEWAY_BASE_URL: "https://staging.api.rubiconpay.xyz",
      PRODUCTION_PAYMENT_WEBHOOK_URL: "https://staging.api.rubiconpay.xyz/webhooks/payments",
    })),
    /explicit staging resource marker/,
  );
  assert.throws(
    () => loadGatewayEnvironment(productionEnv({ PRODUCTION_CIRCLE_X402_NETWORKS: "eip155:5042002" })),
    /cannot contain testnet networks/,
  );
  assert.throws(
    () => loadGatewayEnvironment(productionEnv({ PRODUCTION_BASE_X402_NETWORK: "eip155:84532" })),
    /Base mainnet/,
  );
});

test("startup rejects resources or credentials shared by staging and production", () => {
  const env = stagingEnv({
    PRODUCTION_DATABASE_URL: "postgresql://rubicon_staging:secret@db.example.com:5432/rubicon_staging",
    PRODUCTION_RUBICON_AGENT_API_KEY: "staging-agent-key",
  });
  assert.throws(() => loadGatewayEnvironment(env), /DATABASE_URL, RUBICON_AGENT_API_KEY/);
});

test("deployed profiles fail when required scoped values are absent", () => {
  const env = stagingEnv();
  delete env.STAGING_PAYMENT_WEBHOOK_SECRET;
  assert.throws(() => loadGatewayEnvironment(env), /STAGING_PAYMENT_WEBHOOK_SECRET/);
});
