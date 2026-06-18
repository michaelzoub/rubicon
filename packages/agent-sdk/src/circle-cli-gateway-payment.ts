import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StartSessionResponse, StreamPaymentRequest } from "@rubicon-caliga/core";
import { registerBatchScheme } from "@circle-fin/x402-batching/client";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { AgentPaymentEngine } from "./payment-engine.js";
import { serializeTypedData, toEip712Payload } from "./circle-agent-wallet.js";

const execFileAsync = promisify(execFile);

export type CircleCliRunner = (command: string, args: string[]) => Promise<string>;

export interface CircleCliGatewayPaymentEngineOptions {
  /**
   * Agent Wallet address controlled by Circle CLI. When omitted, the engine
   * resolves the sole agent wallet returned by `circle wallet list`.
   */
  walletAddress?: `0x${string}`;
  /** Circle CLI chain name. Rubicon real reads settle on Arc Testnet by default. */
  chain?: string;
  /** Circle CLI binary name or path. */
  command?: string;
  /** Command runner injection point for tests or hosted agent sandboxes. */
  runner?: CircleCliRunner;
}

interface TypedDataRequest {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * Circle CLI / Agent Wallet payment engine. It creates the one-word x402
 * payment payload for Rubicon's session-first flow and delegates EIP-712
 * signing to `circle wallet sign typed-data`, so agents never need raw private
 * keys or hand-built x402 payloads.
 */
export class CircleCliGatewayPaymentEngine implements AgentPaymentEngine {
  private readonly x402 = new x402Client();
  private readonly signer: CircleCliGatewaySigner;

  constructor(options: CircleCliGatewayPaymentEngineOptions = {}) {
    this.signer = new CircleCliGatewaySigner({
      walletAddress: options.walletAddress,
      chain: options.chain ?? "ARC-TESTNET",
      command: options.command ?? "circle",
      runner: options.runner ?? runCircleCli,
    });
    registerBatchScheme(this.x402, {
      signer: this.signer,
      fallbackScheme: new ExactEvmScheme(this.signer),
    });
  }

  async createWordPayment(session: StartSessionResponse): Promise<StreamPaymentRequest> {
    if (!session.paymentRequired) {
      throw new Error("Session did not include an x402 one-word payment requirement");
    }
    await this.signer.ensureAddress();
    return {
      paymentPayload: await this.x402.createPaymentPayload(session.paymentRequired as never),
    };
  }
}

class CircleCliGatewaySigner {
  address: `0x${string}` = "0x0000000000000000000000000000000000000000";
  private resolved = false;
  private resolving?: Promise<void>;

  constructor(
    private readonly options: {
      walletAddress?: `0x${string}`;
      chain: string;
      command: string;
      runner: CircleCliRunner;
    },
  ) {
    if (options.walletAddress) {
      this.address = options.walletAddress;
      this.resolved = true;
    }
  }

  async ensureAddress(): Promise<void> {
    if (this.resolved) return;
    if (!this.resolving) {
      this.resolving = this.resolveAddress();
    }
    return this.resolving;
  }

  async signTypedData(typed: TypedDataRequest): Promise<`0x${string}`> {
    await this.ensureAddress();
    const signature = await this.options.runner(this.options.command, [
      "wallet",
      "sign",
      "typed-data",
      serializeTypedData(toEip712Payload(typed)),
      "--address",
      this.address,
      "--chain",
      this.options.chain,
      "--quiet",
    ]);
    return parseCircleCliSignature(signature);
  }

  private async resolveAddress(): Promise<void> {
    const output = await this.options.runner(this.options.command, [
      "wallet",
      "list",
      "--chain",
      this.options.chain,
      "--type",
      "agent",
      "--output",
      "json",
    ]);
    const address = parseCircleCliWalletAddress(output);
    this.address = address;
    this.resolved = true;
  }
}

async function runCircleCli(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Circle CLI command failed. Ensure Circle CLI is installed, logged in, and has an Agent Wallet on the selected chain. ${message}`,
    );
  }
}

export function parseCircleCliSignature(output: string): `0x${string}` {
  const trimmed = output.trim();
  if (isHexSignature(trimmed)) {
    return trimmed;
  }

  let parsed: unknown;
  try {
    parsed = parseJson(trimmed);
  } catch {
    throw new Error("Circle CLI did not return a hex EIP-712 signature");
  }
  const signature = findString(parsed, ["signature", "signedData", "data.signature"]);
  if (signature && isHexSignature(signature)) {
    return signature;
  }
  throw new Error("Circle CLI did not return a hex EIP-712 signature");
}

export function parseCircleCliWalletAddress(output: string): `0x${string}` {
  const parsed = parseJson(output);
  const wallets = collectWalletCandidates(parsed);
  const addresses = wallets
    .map((wallet) => findString(wallet, ["address", "walletAddress", "blockchainAddress"]))
    .filter((address): address is `0x${string}` => Boolean(address && isAddress(address)));

  const unique = [...new Set(addresses.map((address) => address.toLowerCase()))];
  if (unique.length === 1) {
    return addresses.find((address) => address.toLowerCase() === unique[0])!;
  }
  if (unique.length === 0) {
    throw new Error("Circle CLI did not return an Agent Wallet address");
  }
  throw new Error("Multiple Circle Agent Wallets found; pass walletAddress explicitly");
}

function collectWalletCandidates(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (!isRecord(value)) {
    return [];
  }
  for (const key of ["wallets", "items", "data"]) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      return nested.filter(isRecord);
    }
    if (isRecord(nested)) {
      const deeper = collectWalletCandidates(nested);
      if (deeper.length > 0) return deeper;
    }
  }
  return [value];
}

function findString(value: unknown, keys: string[]): string | undefined {
  for (const key of keys) {
    const found = key.split(".").reduce<unknown>((current, part) => {
      if (!isRecord(current)) return undefined;
      return current[part];
    }, value);
    if (typeof found === "string") {
      return found;
    }
  }
  return undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Circle CLI returned non-JSON output");
  }
}

function isHexSignature(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]+$/.test(value);
}

function isAddress(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
