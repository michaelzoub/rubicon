/** Policy for lightweight OpenRouter routing/relevance calls only. */
export const DEFAULT_GATEWAY_AGENT_MODEL = "qwen/qwen3-8b";
export const MAX_GATEWAY_AGENT_PARAMETERS_BILLIONS = 100;
export const DEFAULT_GATEWAY_AGENT_MAX_REQUESTS = 500;
export const DEFAULT_GATEWAY_AGENT_MONTHLY_TOKEN_BUDGET = 250_000;

const DEFAULT_ALLOWLIST = [
  "qwen/qwen3-8b",
  "qwen/qwen3-14b",
  "meta-llama/llama-3.1-8b-instruct",
  "mistralai/mistral-small-24b-instruct-2501",
];

export interface GatewayAgentPolicy {
  model: string;
  allowlist: readonly string[];
  maxRequests: number;
  monthlyTokenBudget: number;
}

export type GatewayAgentUse = "routing" | "relevance";

export function logGatewayAgentUsage(input: {
  policy: GatewayAgentPolicy;
  use: GatewayAgentUse;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  logger?: (entry: Record<string, unknown>, message: string) => void;
}): void {
  if (!Number.isInteger(input.promptTokens) || input.promptTokens < 0 || !Number.isInteger(input.completionTokens) || input.completionTokens < 0) {
    throw new Error("OpenRouter gateway-agent token usage must be non-negative integers");
  }
  (input.logger ?? ((entry, message) => console.info(message, entry)))({
    model: input.policy.model,
    use: input.use,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    totalTokens: input.promptTokens + input.completionTokens,
    estimatedCostUsd: input.estimatedCostUsd,
  }, "[gateway] lightweight OpenRouter agent usage");
}

function parameterCount(model: string): number | undefined {
  const match = model.match(/(?:^|[-/])([0-9]+(?:\.[0-9]+)?)b(?:[-/]|$)/i);
  return match ? Number(match[1]) : undefined;
}

export function loadGatewayAgentPolicy(env: NodeJS.ProcessEnv = process.env): GatewayAgentPolicy {
  const allowlist = (env.OPENROUTER_GATEWAY_AGENT_ALLOWLIST ?? DEFAULT_ALLOWLIST.join(","))
    .split(",").map((model) => model.trim()).filter(Boolean);
  const model = env.OPENROUTER_GATEWAY_AGENT_MODEL?.trim() || DEFAULT_GATEWAY_AGENT_MODEL;
  const params = parameterCount(model);
  if (!allowlist.includes(model)) throw new Error(`OpenRouter gateway-agent model is not allowlisted: ${model}`);
  if (params !== undefined && params > MAX_GATEWAY_AGENT_PARAMETERS_BILLIONS) {
    throw new Error(`OpenRouter gateway-agent model exceeds the ${MAX_GATEWAY_AGENT_PARAMETERS_BILLIONS}B parameter ceiling: ${model}`);
  }
  return {
    model,
    allowlist,
    maxRequests: boundedBudget(env.OPENROUTER_GATEWAY_AGENT_MAX_REQUESTS, DEFAULT_GATEWAY_AGENT_MAX_REQUESTS),
    monthlyTokenBudget: boundedBudget(env.OPENROUTER_GATEWAY_AGENT_MONTHLY_TOKEN_BUDGET, DEFAULT_GATEWAY_AGENT_MONTHLY_TOKEN_BUDGET),
  };
}

function boundedBudget(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("OpenRouter gateway-agent budgets must be positive integers");
  return parsed;
}
