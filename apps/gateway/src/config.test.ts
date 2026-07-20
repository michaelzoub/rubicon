import assert from "node:assert/strict";
import test from "node:test";
import { loadGatewayEnvironment, selectEnvironmentVariables } from "./config.js";

function sharedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://rubicon:secret@db.example.com:5432/rubicon",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    RUBICON_PAYMENTS: "circle",
    CIRCLE_FACILITATOR_URL: "https://gateway-api-testnet.circle.com",
    CIRCLE_X402_NETWORKS: "eip155:5042002",
    CIRCLE_ARC_PRIVATE_MAINNET: "false",
    BASE_X402_NETWORK: "eip155:84532",
    RUBICON_AGENT_API_KEY: "agent-key",
    ...overrides,
  };
}

test("APP_ENV is explicit and limited to the supported environments", () => {
  assert.throws(() => loadGatewayEnvironment({}), /APP_ENV must be exactly/);
  assert.throws(() => loadGatewayEnvironment({ APP_ENV: "preview" }), /APP_ENV must be exactly/);
});

test("staging overrides only the gateway base URL", () => {
  const source = sharedEnv({
    APP_ENV: "staging",
    GATEWAY_BASE_URL: "https://old.api.rubiconpay.xyz",
    STAGING_GATEWAY_BASE_URL: "https://staging.api.rubiconpay.xyz",
    STAGING_DATABASE_URL: "postgresql://ignored",
  });
  const selected = selectEnvironmentVariables(source);
  assert.equal(selected.appEnv, "staging");
  assert.equal(selected.env.DATABASE_URL, source.DATABASE_URL);
  assert.equal(selected.env.GATEWAY_BASE_URL, source.STAGING_GATEWAY_BASE_URL);
  assert.equal(selected.env.STAGING_DATABASE_URL, source.STAGING_DATABASE_URL);
});

test("staging and production load the shared resources", () => {
  const staging = loadGatewayEnvironment(sharedEnv({
    APP_ENV: "staging",
    STAGING_GATEWAY_BASE_URL: "https://staging.api.rubiconpay.xyz",
  }));
  assert.equal(staging.appEnv, "staging");
  assert.equal(staging.env.DATABASE_URL, sharedEnv().DATABASE_URL);

  const production = loadGatewayEnvironment(sharedEnv({
    APP_ENV: "production",
    PRODUCTION_GATEWAY_BASE_URL: "https://api.rubiconpay.xyz",
    CIRCLE_FACILITATOR_URL: "https://gateway-api.circle.com",
    CIRCLE_X402_NETWORKS: "eip155:1",
    CIRCLE_ARC_PRIVATE_MAINNET: "true",
    BASE_X402_NETWORK: "eip155:8453",
  }));
  assert.equal(production.appEnv, "production");
  assert.equal(production.env.DATABASE_URL, sharedEnv().DATABASE_URL);
});

test("staging still rejects mainnet payment networks", () => {
  assert.throws(
    () => loadGatewayEnvironment(sharedEnv({
      APP_ENV: "staging",
      STAGING_GATEWAY_BASE_URL: "https://staging.api.rubiconpay.xyz",
      CIRCLE_X402_NETWORKS: "eip155:1",
    })),
    /only recognized testnet networks/,
  );
});

test("deployed profiles do not require unused payment webhook configuration", () => {
  const env = sharedEnv({ APP_ENV: "staging", STAGING_GATEWAY_BASE_URL: "https://staging.api.rubiconpay.xyz" });
  assert.equal(loadGatewayEnvironment(env).appEnv, "staging");
});
