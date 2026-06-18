import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const HOSTED_GATEWAY_URL = "https://rubicon-caligagateway-production.up.railway.app";

export interface RubiconCliConfig {
  gatewayUrl?: string;
  apiKey?: string;
  paymentMode?: "static" | "circle-cli";
  circleChain?: string;
  agentWalletAddress?: `0x${string}`;
}

export function configPath(): string {
  return join(homedir(), ".rubicon", "config.json");
}

export async function readConfig(): Promise<RubiconCliConfig> {
  try {
    const raw = await readFile(configPath(), "utf8");
    return JSON.parse(raw) as RubiconCliConfig;
  } catch (error) {
    if (isNotFound(error)) return {};
    throw error;
  }
}

export async function writeConfig(config: RubiconCliConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
