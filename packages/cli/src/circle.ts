import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CircleRunner = (command: string, args: string[]) => Promise<string>;

export interface CircleErrorInfo {
  code: "network_unavailable" | "otp_expired" | "terms_not_accepted" | "not_logged_in" | "missing_cli" | "command_failed";
  message: string;
  guidance: string;
}

export interface CircleCommandDiagnostics {
  command: string;
  args: string[];
  exitCode: number | string | null;
  signal?: string;
  stdout: string;
  stderr: string;
}

export interface CircleWalletInfo {
  address: `0x${string}`;
  raw?: unknown;
}

export interface CircleBalanceInfo {
  balanceAtomic: `${bigint}`;
  backingEOA?: `0x${string}`;
  /** Address Circle reported the balance for; used to detect a profile/wallet mismatch. */
  reportedAddress?: `0x${string}`;
  raw?: unknown;
}

/**
 * Maps a Circle CLI `--chain` value to the identifiers the Gateway balance
 * response uses inside its per-network `balances[]` array (`network` label and
 * CCTP `domain`). Circle Gateway reports a cross-chain `total` plus one entry
 * per funded domain; spending settles on a specific domain, so the depositor's
 * balance on the requested chain is the authoritative figure.
 */
interface GatewayChainDescriptor {
  networkLabels: string[];
  domain?: number;
}

const GATEWAY_CHAIN_DESCRIPTORS: Record<string, GatewayChainDescriptor> = {
  "arc-testnet": { networkLabels: ["arc testnet", "arc-testnet"], domain: 26 },
};

export const CIRCLE_NPX_PACKAGE = "@circle-fin/cli";

export function defaultCircleCommand(): string {
  return process.env.CIRCLE_CLI_COMMAND ?? "circle";
}

export function npxCircleArgs(args: string[]): string[] {
  return ["-y", "--package", CIRCLE_NPX_PACKAGE, "circle", ...args];
}

export interface CircleInvocation {
  file: string;
  args: string[];
  options: { maxBuffer: number; windowsVerbatimArguments?: boolean };
}

export function buildCircleInvocation(command: string, args: string[], platform: NodeJS.Platform = process.platform): CircleInvocation {
  const maxBuffer = 1024 * 1024;
  if (platform !== "win32" || /[\\/.]/.test(command)) {
    return { file: command, args, options: { maxBuffer } };
  }
  // npm exposes CLI entry points as .cmd shims on Windows, and Node refuses to
  // spawn those without a shell, so bare commands route through cmd.exe.
  const escaped = [escapeCmdCommand(command), ...args.map(escapeCmdArg)].join(" ");
  return {
    file: "cmd.exe",
    args: ["/d", "/s", "/c", `"${escaped}"`],
    options: { maxBuffer, windowsVerbatimArguments: true },
  };
}

function escapeCmdCommand(command: string): string {
  return /[\s()%!^"<>&|]/.test(command) ? `"${command}"` : command;
}

function escapeCmdArg(value: string): string {
  let arg = value.replace(/(\\*)"/g, '$1$1\\"');
  arg = arg.replace(/(\\*)$/, "$1$1");
  return `"${arg}"`.replace(/[()%!^"<>&|]/g, "^$&");
}

async function execCircle(command: string, args: string[]): Promise<string> {
  const invocation = buildCircleInvocation(command, args);
  try {
    const { stdout } = await execFileAsync(invocation.file, invocation.args, invocation.options);
    return stdout;
  } catch (error) {
    annotateInvocation(error, command, args);
    throw error;
  }
}

// Records which logical Circle command failed so classifyCircleError can emit
// structured diagnostics. The outermost annotation wins: execCircle names the
// binary actually spawned (including fallbacks), injected runners keep theirs.
function annotateInvocation(error: unknown, command: string, args: string[]): void {
  if (!isRecord(error) || error.circleInvocation !== undefined) return;
  (error as { circleInvocation?: { command: string; args: string[] } }).circleInvocation = { command, args };
}

async function invokeRunner(runner: CircleRunner, command: string, args: string[]): Promise<string> {
  try {
    return await runner(command, args);
  } catch (error) {
    annotateInvocation(error, command, args);
    throw error;
  }
}

const SECRET_FLAGS = new Set(["--otp", "--api-key", "--token", "--secret", "--password", "--private-key"]);

export function redactCircleArgs(args: string[]): string[] {
  const redacted: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const [flag] = arg.split("=", 1);
    if (SECRET_FLAGS.has(arg) && index + 1 < args.length) {
      redacted.push(arg, "[REDACTED]");
      index += 1;
    } else if (flag !== undefined && SECRET_FLAGS.has(flag) && arg.includes("=")) {
      redacted.push(`${flag}=[REDACTED]`);
    } else {
      redacted.push(arg);
    }
  }
  return redacted;
}

export function redactSecrets(text: string): string {
  return text
    .replace(/(--otp[=\s]+)\S+/gi, "$1[REDACTED]")
    .replace(/("otp"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|private[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}&]+/gi, "$1[REDACTED]");
}

export async function runCircleCli(command: string, args: string[]): Promise<string> {
  try {
    return await execCircle(command, args);
  } catch (error) {
    if (!shouldRetryCircleCliFallback(command, error)) throw classifyCircleError(error);
    try {
      return await execCircle("circle-cli", args);
    } catch (fallbackError) {
      if (isMissingBinary(fallbackError) && process.env.RUBICON_NO_NPX_FALLBACK !== "1") {
        try {
          return await execCircle("npx", npxCircleArgs(args));
        } catch (npxError) {
          throw classifyCircleError(npxError);
        }
      }
      throw classifyCircleError(fallbackError);
    }
  }
}

export function classifyCircleError(error: unknown): Error & { circle?: CircleErrorInfo; circleDiagnostics?: CircleCommandDiagnostics } {
  const message = error instanceof Error ? error.message : String(error);
  const stdout = isRecord(error) && typeof error.stdout === "string" ? error.stdout : "";
  const stderr = isRecord(error) && typeof error.stderr === "string" ? error.stderr : "";
  const output = [message, stdout || undefined, stderr || undefined].filter(Boolean).join("\n");
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
  } else if (lower.includes("terms") && (lower.includes("accept") || lower.includes("agree"))) {
    info = {
      code: "terms_not_accepted",
      message: "Circle terms must be accepted before payments can run.",
      guidance: "Run `npx -y --package @circle-fin/cli circle terms accept` (or the exact terms command reported in the Circle output) in this same execution context, then rerun the original Rubicon command.",
    };
  } else if (lower.includes("login") || lower.includes("logged in") || lower.includes("unauthorized") || lower.includes("auth")) {
    info = {
      code: "not_logged_in",
      message: "Circle CLI is not logged in.",
      guidance: "Run `rubicon login <email>` (add --testnet for Arc Testnet articles) to start Circle OTP login, complete it with `rubicon login --request <id> --otp <code>`, then rerun this command.",
    };
  } else if (lower.includes("enoent") || lower.includes("not found")) {
    info = {
      code: "missing_cli",
      message: "Circle CLI was not found.",
      guidance: "Install Circle CLI, or rely on the automatic `npx -y --package @circle-fin/cli circle ...` fallback; set CIRCLE_CLI_COMMAND to a custom binary path if needed.",
    };
  } else {
    info = {
      code: "command_failed",
      message: "Circle CLI command failed.",
      guidance: "Inspect the Circle CLI output, confirm login, wallet, selected chain, and network access, then retry.",
    };
  }
  const invocation = isRecord(error) && isRecord(error.circleInvocation) ? error.circleInvocation : undefined;
  const exitCode = isRecord(error) && (typeof error.code === "number" || typeof error.code === "string") ? error.code : null;
  const signal = isRecord(error) && typeof error.signal === "string" ? error.signal : undefined;
  const wrapped = new Error(`${info.message} ${redactSecrets(output)}`.trim()) as Error & {
    circle?: CircleErrorInfo;
    circleDiagnostics?: CircleCommandDiagnostics;
  };
  wrapped.circle = info;
  wrapped.circleDiagnostics = {
    command: typeof invocation?.command === "string" ? invocation.command : "unknown",
    args: Array.isArray(invocation?.args) ? redactCircleArgs(invocation.args.map(String)) : [],
    exitCode,
    ...(signal ? { signal } : {}),
    stdout: redactSecrets(stdout),
    stderr: redactSecrets(stderr),
  };
  return wrapped;
}

export function circleCommandDiagnostics(error: unknown): CircleCommandDiagnostics | undefined {
  if (isRecord(error) && isRecord(error.circleDiagnostics)) {
    return error.circleDiagnostics as unknown as CircleCommandDiagnostics;
  }
  return undefined;
}

function shouldRetryCircleCliFallback(command: string, error: unknown): boolean {
  return command === "circle" && isMissingBinary(error);
}

function isMissingBinary(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = isRecord(error) && typeof error.stderr === "string" ? error.stderr : "";
  const output = `${message}\n${stderr}`.toLowerCase();
  return output.includes("enoent") || output.includes("not found");
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
  return (await invokeRunner(runner, command, ["--version"])).trim();
}

export async function circleAuthStatus(input: { command?: string; runner?: CircleRunner; testnet?: boolean } = {}): Promise<unknown> {
  const command = input.command ?? defaultCircleCommand();
  const runner = input.runner ?? runCircleCli;
  const args = ["wallet", "status", "--type", "agent"];
  if (input.testnet) args.push("--testnet");
  args.push("--output", "json");
  const output = await invokeRunner(runner, command, args);
  return parseMaybeJson(output);
}

export interface CircleLoginInitResult {
  requestId?: string;
  raw: unknown;
}

export async function circleLoginInit(input: {
  email: string;
  testnet: boolean;
  command?: string;
  runner?: CircleRunner;
}): Promise<CircleLoginInitResult> {
  const command = input.command ?? defaultCircleCommand();
  const runner = input.runner ?? runCircleCli;
  const args = ["wallet", "login", input.email, "--type", "agent"];
  if (input.testnet) args.push("--testnet");
  args.push("--init");
  const raw = parseMaybeJson(await invokeRunner(runner, command, args));
  return { requestId: parseLoginRequestId(raw), raw };
}

export async function circleLoginComplete(input: {
  requestId: string;
  otp: string;
  testnet: boolean;
  command?: string;
  runner?: CircleRunner;
}): Promise<unknown> {
  const command = input.command ?? defaultCircleCommand();
  const runner = input.runner ?? runCircleCli;
  const args = ["wallet", "login", "--type", "agent"];
  if (input.testnet) args.push("--testnet");
  args.push("--request", input.requestId, "--otp", input.otp);
  return parseMaybeJson(await invokeRunner(runner, command, args));
}

function parseLoginRequestId(raw: unknown): string | undefined {
  const direct = findString(raw, ["requestId", "request_id", "data.requestId", "data.request_id", "data.id", "id"]);
  if (direct) return direct;
  if (typeof raw === "string") {
    const match = raw.match(/request[ _-]?id[^A-Za-z0-9]{0,4}([A-Za-z0-9][A-Za-z0-9-]{5,})/i);
    return match?.[1];
  }
  return undefined;
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
  const output = await invokeRunner(runner, command, ["wallet", "list", "--chain", input.chain, "--type", "agent", "--output", "json"]);
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
  const output = await invokeRunner(runner, command, ["gateway", "balance", "--address", input.address, "--chain", input.chain, "--output", "json"]);
  const raw = parseMaybeJson(output);
  return {
    balanceAtomic: parseBalanceAtomic(raw, input.chain),
    backingEOA: parseBackingEOA(raw),
    reportedAddress: parseReportedAddress(raw),
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
  const output = await invokeRunner(runner, command, [
    "wallet",
    "fund",
    "--address",
    input.address,
    "--chain",
    input.chain,
    "--token",
    "usdc",
    "--output",
    "json",
  ]);
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

// Resolves the usable Gateway USDC balance to 6-decimal atomic units across the
// shapes Circle CLI has emitted. Order matters: a chain-scoped decimal balance
// is the amount actually spendable on the requested domain, so it wins over the
// cross-chain `total`; pre-atomized integer fields (older/mock shapes) are still
// honored, and a bare numeric `balance` is the last resort.
function parseBalanceAtomic(value: unknown, chain?: string): `${bigint}` {
  const atomic = findString(value, [
    "data.balanceAtomic",
    "data.availableAtomic",
    "data.usdc.balanceAtomic",
    "balanceAtomic",
    "availableAtomic",
    "usdc.balanceAtomic",
  ]);
  if (atomic && /^\d+$/.test(atomic)) return atomic as `${bigint}`;
  if (atomic && isDecimalUsdc(atomic)) return `${decimalUsdcToAtomic(atomic)}`;

  const chainBalance = findChainBalanceDecimal(value, chain);
  if (chainBalance !== undefined) return `${decimalUsdcToAtomic(chainBalance)}`;

  const total = findString(value, ["data.total", "total"]);
  if (total && isDecimalUsdc(total)) return `${decimalUsdcToAtomic(total)}`;

  const numeric = findNumber(value, ["data.balance", "data.available", "balance", "available"]);
  if (typeof numeric === "number" && Number.isFinite(numeric)) return `${BigInt(Math.trunc(numeric * 1_000_000))}`;
  return "0";
}

// Picks the depositor's balance for the requested chain out of the per-network
// `balances[]` array, matching on the Gateway network label or CCTP domain and
// falling back to a lone entry when the chain is unambiguous.
function findChainBalanceDecimal(value: unknown, chain?: string): string | undefined {
  const balances = findArray(value, ["data.balances", "balances"]);
  if (!balances) return undefined;
  const records = balances.filter(isRecord);
  if (records.length === 0) return undefined;
  const descriptor = chain ? GATEWAY_CHAIN_DESCRIPTORS[chain.toLowerCase()] : undefined;
  const match = records.find((entry) => chainBalanceMatches(entry, chain, descriptor)) ?? (records.length === 1 ? records[0] : undefined);
  if (!match) return undefined;
  const balance = findString(match, ["balance", "amount", "available"]);
  if (balance && isDecimalUsdc(balance)) return balance;
  const numeric = findNumber(match, ["balance", "amount", "available"]);
  return typeof numeric === "number" && Number.isFinite(numeric) ? String(numeric) : undefined;
}

function chainBalanceMatches(entry: Record<string, unknown>, chain: string | undefined, descriptor: GatewayChainDescriptor | undefined): boolean {
  const network = findString(entry, ["network", "chain", "networkLabel"]);
  if (network && chain && network.toLowerCase() === chain.toLowerCase()) return true;
  if (network && descriptor?.networkLabels.includes(network.toLowerCase())) return true;
  const domain = findNumber(entry, ["domain"]);
  return typeof domain === "number" && descriptor?.domain === domain;
}

function parseBackingEOA(value: unknown): `0x${string}` | undefined {
  const address = findString(value, ["data.backingEOA", "backingEOA", "data.backingEoa", "backingEoa"]);
  return address && isAddress(address) ? address : undefined;
}

function parseReportedAddress(value: unknown): `0x${string}` | undefined {
  const address = findString(value, ["data.address", "address", "data.depositor", "depositor"]);
  return address && isAddress(address) ? address : undefined;
}

function isDecimalUsdc(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value.trim());
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

// Safe decimal USDC -> 6-decimal atomic conversion: fractions longer than six
// digits are truncated (never rounded up past the reported balance) so
// "1.1382" resolves to exactly 1_138_200 atomic units.
function decimalUsdcToAtomic(value: string): bigint {
  const trimmed = value.trim();
  if (!isDecimalUsdc(trimmed)) return 0n;
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const padded = `${fraction}000000`.slice(0, 6);
  return BigInt(whole || "0") * 1_000_000n + BigInt(padded || "0");
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

function findArray(value: unknown, paths: string[]): unknown[] | undefined {
  for (const path of paths) {
    const found = path.split(".").reduce<unknown>((current, part) => (isRecord(current) ? current[part] : undefined), value);
    if (Array.isArray(found)) return found;
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
