import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CircleRunner = (command: string, args: string[]) => Promise<string>;

export interface CircleErrorInfo {
  code: "network_unavailable" | "otp_expired" | "not_logged_in" | "missing_cli" | "command_failed";
  message: string;
  guidance: string;
}

export interface CircleWalletInfo {
  address: `0x${string}`;
  raw?: unknown;
}

export interface CircleBalanceInfo {
  balanceAtomic: `${bigint}`;
  backingEOA?: `0x${string}`;
  raw?: unknown;
}

export function defaultCircleCommand(): string {
  return process.env.CIRCLE_CLI_COMMAND ?? "circle";
}

export async function runCircleCli(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, { maxBuffer: 1024 * 1024 });
    return stdout;
  } catch (error) {
    throw classifyCircleError(error);
  }
}

export function classifyCircleError(error: unknown): Error & { circle?: CircleErrorInfo } {
  const message = error instanceof Error ? error.message : String(error);
  const output = [
    message,
    isRecord(error) && typeof error.stdout === "string" ? error.stdout : undefined,
    isRecord(error) && typeof error.stderr === "string" ? error.stderr : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  const lower = output.toLowerCase();
  let info: CircleErrorInfo;
  if (lower.includes("fetch failed") || lower.includes("network") || lower.includes("enotfound") || lower.includes("econnrefused")) {
    info = {
      code: "network_unavailable",
      message: "Circle CLI network request failed.",
      guidance: "Retry this command in a network-capable shell or agent context. Restricted sandboxes often block Circle auth and Gateway calls.",
    };
  } else if (lower.includes("otp") && (lower.includes("expired") || lower.includes("invalid") || lower.includes("request"))) {
    info = {
      code: "otp_expired",
      message: "Circle OTP request id is invalid or expired.",
      guidance: "Start a fresh Circle auth OTP flow, then rerun the Rubicon command after login completes.",
    };
  } else if (lower.includes("login") || lower.includes("logged in") || lower.includes("unauthorized") || lower.includes("auth")) {
    info = {
      code: "not_logged_in",
      message: "Circle CLI is not logged in.",
      guidance: "Run Circle CLI login/auth again, then rerun Rubicon. If an OTP flow was interrupted, start a fresh OTP init.",
    };
  } else if (lower.includes("enoent") || lower.includes("not found")) {
    info = {
      code: "missing_cli",
      message: "Circle CLI was not found.",
      guidance: "Install Circle CLI and make sure the `circle` binary is on PATH.",
    };
  } else {
    info = {
      code: "command_failed",
      message: "Circle CLI command failed.",
      guidance: "Inspect the Circle CLI output, confirm login, wallet, selected chain, and network access, then retry.",
    };
  }
  const wrapped = new Error(`${info.message} ${output}`.trim()) as Error & { circle?: CircleErrorInfo };
  wrapped.circle = info;
  return wrapped;
}

export function circleGuidance(error: unknown): CircleErrorInfo | undefined {
  if (isRecord(error) && isRecord(error.circle)) {
    return error.circle as unknown as CircleErrorInfo;
  }
  return undefined;
}

export async function circleVersion(input: { command?: string; runner?: CircleRunner } = {}): Promise<string> {
  const command = input.command ?? defaultCircleCommand();
  const runner = input.runner ?? runCircleCli;
  return (await runner(command, ["--version"])).trim();
}

export async function circleAuthStatus(input: { command?: string; runner?: CircleRunner } = {}): Promise<unknown> {
  const command = input.command ?? defaultCircleCommand();
  const runner = input.runner ?? runCircleCli;
  const output = await runner(command, ["auth", "status", "--output", "json"]);
  return parseMaybeJson(output);
}

export async function circleAgentWallet(input: {
  chain: string;
  configuredAddress?: `0x${string}`;
  command?: string;
  runner?: CircleRunner;
}): Promise<CircleWalletInfo> {
  if (input.configuredAddress) return { address: input.configuredAddress };
  const command = input.command ?? defaultCircleCommand();
  const runner = input.runner ?? runCircleCli;
  const output = await runner(command, ["wallet", "list", "--chain", input.chain, "--type", "agent", "--output", "json"]);
  const raw = parseMaybeJson(output);
  const address = parseWalletAddress(raw);
  return { address, raw };
}

export async function circleGatewayBalance(input: {
  address: `0x${string}`;
  chain: string;
  command?: string;
  runner?: CircleRunner;
}): Promise<CircleBalanceInfo> {
  const command = input.command ?? defaultCircleCommand();
  const runner = input.runner ?? runCircleCli;
  const output = await runner(command, ["gateway", "balance", "--address", input.address, "--chain", input.chain, "--output", "json"]);
  const raw = parseMaybeJson(output);
  return {
    balanceAtomic: parseBalanceAtomic(raw),
    backingEOA: parseBackingEOA(raw),
    raw,
  };
}

export async function circleGatewayFaucet(input: {
  address: `0x${string}`;
  chain: string;
  command?: string;
  runner?: CircleRunner;
}): Promise<unknown> {
  const command = input.command ?? defaultCircleCommand();
  const runner = input.runner ?? runCircleCli;
  const output = await runner(command, ["gateway", "faucet", "--address", input.address, "--chain", input.chain, "--output", "json"]);
  return parseMaybeJson(output);
}

function parseWalletAddress(value: unknown): `0x${string}` {
  const wallets = collectRecords(value);
  const addresses = wallets
    .map((wallet) => findString(wallet, ["address", "walletAddress", "blockchainAddress"]))
    .filter((address): address is `0x${string}` => Boolean(address && isAddress(address)));
  const unique = [...new Set(addresses.map((address) => address.toLowerCase()))];
  if (unique.length === 1) return addresses.find((address) => address.toLowerCase() === unique[0])!;
  if (unique.length === 0) throw new Error("Circle CLI did not return an Agent Wallet address.");
  throw new Error("Multiple Circle Agent Wallets found; configure agent-wallet-address.");
}

function parseBalanceAtomic(value: unknown): `${bigint}` {
  const direct =
    findString(value, [
      "data.balanceAtomic",
      "data.availableAtomic",
      "data.usdc.balanceAtomic",
      "balanceAtomic",
      "availableAtomic",
      "usdc.balanceAtomic",
    ]) ?? findNumber(value, ["data.balance", "data.available", "balance", "available"]);
  if (typeof direct === "number") return `${BigInt(Math.trunc(direct * 1_000_000))}`;
  if (direct && /^\d+$/.test(direct)) return direct as `${bigint}`;
  if (direct && /^\d+(\.\d+)?$/.test(direct)) return `${decimalUsdcToAtomic(direct)}`;
  return "0";
}

function parseBackingEOA(value: unknown): `0x${string}` | undefined {
  const address = findString(value, ["data.backingEOA", "backingEOA", "data.backingEoa", "backingEoa"]);
  return address && isAddress(address) ? address : undefined;
}

function parseMaybeJson(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function decimalUsdcToAtomic(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  const padded = `${fraction}000000`.slice(0, 6);
  return BigInt(whole) * 1_000_000n + BigInt(padded);
}

function collectRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  const records: Record<string, unknown>[] = [value];
  for (const key of ["wallets", "items", "data"]) {
    const nested = value[key];
    if (Array.isArray(nested)) records.push(...nested.filter(isRecord));
    if (isRecord(nested)) records.push(...collectRecords(nested));
  }
  return records;
}

function findString(value: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const found = path.split(".").reduce<unknown>((current, part) => (isRecord(current) ? current[part] : undefined), value);
    if (typeof found === "string") return found;
  }
  return undefined;
}

function findNumber(value: unknown, paths: string[]): number | undefined {
  for (const path of paths) {
    const found = path.split(".").reduce<unknown>((current, part) => (isRecord(current) ? current[part] : undefined), value);
    if (typeof found === "number") return found;
    if (typeof found === "string" && /^\d+(\.\d+)?$/.test(found)) return Number(found);
  }
  return undefined;
}

function isAddress(value: string): value is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
