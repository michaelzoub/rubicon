import {
  CircleCliGatewayPaymentEngine,
  StaticPaymentEngine,
  type AgentPaymentEngine,
} from "@rubicon-caliga/agent-sdk";
import { HOSTED_GATEWAY_URL, type RubiconCliConfig } from "./config.js";
import { CliError } from "./errors.js";

export type PaymentMode = "static" | "circle-cli";

export interface PaymentSelection {
  mode: PaymentMode;
  engine: AgentPaymentEngine;
  circleChain?: string;
}

export function selectPaymentEngine(input: {
  requestedMode?: string;
  gatewayUrl: string;
  config: RubiconCliConfig;
}): PaymentSelection {
  const mode = normalizeMode(input.requestedMode ?? process.env.RUBICON_PAYMENT_MODE ?? input.config.paymentMode);
  const selectedMode = mode ?? defaultPaymentMode(input.gatewayUrl);

  if (selectedMode === "static") {
    return { mode: selectedMode, engine: new StaticPaymentEngine() };
  }

  const circleChain = process.env.CIRCLE_CLI_CHAIN ?? input.config.circleChain ?? "ARC-TESTNET";
  return {
    mode: selectedMode,
    engine: new CircleCliGatewayPaymentEngine({
      agentWalletAddress: envAddress("CIRCLE_AGENT_WALLET_ADDRESS") ?? input.config.agentWalletAddress,
      chain: circleChain,
    }),
    circleChain,
  };
}

function normalizeMode(value: string | undefined): PaymentMode | undefined {
  if (!value) {
    if (process.env.CIRCLE_CLI_PAYMENT === "1") return "circle-cli";
    if (process.env.CIRCLE_AGENT_WALLET_ADDRESS) return "circle-cli";
    return undefined;
  }
  if (value === "static" || value === "circle-cli") return value;
  throw new CliError("INVALID_PAYMENT_MODE", "Payment mode must be static or circle-cli.");
}

function defaultPaymentMode(gatewayUrl: string): PaymentMode {
  if (isLocalGateway(gatewayUrl)) return "static";
  if (process.env.CIRCLE_CLI_PAYMENT === "1" || process.env.CIRCLE_AGENT_WALLET_ADDRESS) return "circle-cli";
  if (gatewayUrl === HOSTED_GATEWAY_URL) return "circle-cli";
  return "circle-cli";
}

function isLocalGateway(gatewayUrl: string): boolean {
  try {
    const url = new URL(gatewayUrl);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  } catch {
    return false;
  }
}

function envAddress(name: string): `0x${string}` | undefined {
  const value = process.env[name];
  return value?.startsWith("0x") ? (value as `0x${string}`) : undefined;
}
