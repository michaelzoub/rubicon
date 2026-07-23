import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GATEWAY_AGENT_MODEL,
  loadGatewayAgentPolicy,
} from "./openrouter-agent-policy.js";

test("gateway agent defaults to a small allowlisted model and low budgets", () => {
  const policy = loadGatewayAgentPolicy({});
  assert.equal(policy.model, DEFAULT_GATEWAY_AGENT_MODEL);
  assert.ok(policy.maxRequests <= 500);
  assert.ok(policy.monthlyTokenBudget <= 250_000);
  assert.ok(policy.allowlist.includes(policy.model));
});

test("gateway agent rejects models over the hard parameter ceiling", () => {
  assert.throws(
    () => loadGatewayAgentPolicy({
      OPENROUTER_GATEWAY_AGENT_MODEL: "vendor/model-120b-instruct",
      OPENROUTER_GATEWAY_AGENT_ALLOWLIST: "vendor/model-120b-instruct",
    }),
    /100B parameter ceiling/,
  );
});

test("gateway agent rejects models outside the allowlist", () => {
  assert.throws(
    () => loadGatewayAgentPolicy({ OPENROUTER_GATEWAY_AGENT_MODEL: "vendor/model-8b" }),
    /not allowlisted/,
  );
});
