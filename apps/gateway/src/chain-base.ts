/**
 * Base (Coinbase L2) settlement constants for the AgentCash-facing x402 endpoint.
 *
 * This is a SEPARATE settlement lane from Rubicon's primary Circle/Arc path
 * (see `chain.ts`). AgentCash agents pay USDC on Base; the two lanes never share
 * state. Everything here is env-overridable so the same build can target Base
 * mainnet (real USDC) or Base Sepolia (testnet) without a code change.
 *
 * Networks use CAIP-2 (`eip155:<chainId>`). USDC on Base uses 6 decimals, the
 * same basis as Rubicon's internal atomic amounts, so a per-word atomic price
 * maps to a Base USDC atomic amount 1:1.
 */

/** Base mainnet chain id. */
export const BASE_MAINNET_CHAIN_ID = 8453;
/** Base Sepolia (testnet) chain id. */
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** Canonical USDC ERC-20 (6 decimals) per Base chain id. */
const USDC_BY_CHAIN: Record<number, `0x${string}`> = {
  [BASE_MAINNET_CHAIN_ID]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  [BASE_SEPOLIA_CHAIN_ID]: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

/** USDC on Base uses 6 decimals (matches Rubicon's internal atomic basis). */
export const BASE_USDC_DECIMALS = 6;

/**
 * The largest whole-article Base price this gateway advertises. This is both a
 * discovery bound and an enforcement guard: the OpenAPI dynamic-price maximum
 * and every issued x402 requirement must agree.
 */
const DEFAULT_BASE_X402_MAX_ARTICLE_PRICE_ATOMIC = 10_000_000n; // 10 USDC

export interface BaseX402Config {
  /** CAIP-2 network, e.g. "eip155:8453". */
  network: string;
  /** Numeric chain id parsed from `network`. */
  chainId: number;
  /** USDC ERC-20 address used as the x402 `asset`. */
  usdc: `0x${string}`;
  /** Hard maximum whole-article price accepted by the Base purchase lane. */
  maxArticlePriceAtomic: bigint;
  /** x402 authorization validity window advertised in the challenge. */
  maxTimeoutSeconds: number;
  /** True when settling real funds (mainnet) — surfaced for logging/guards. */
  mainnet: boolean;
}

/**
 * Resolve the active Base x402 configuration from the environment, defaulting to
 * Base mainnet. The recipient is deliberately not configuration: each purchase
 * must use its article creator's verified wallet on this exact network. Throws
 * only if an explicitly configured network has no known USDC address and none
 * is supplied, or if the advertised price bound is malformed.
 */
export function resolveBaseX402Config(env: NodeJS.ProcessEnv = process.env): BaseX402Config {
  const network = (env.BASE_X402_NETWORK ?? `eip155:${BASE_MAINNET_CHAIN_ID}`).trim();
  const chainId = Number(network.split(":")[1]);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`BASE_X402_NETWORK must be CAIP-2 eip155:<chainId>, got "${network}"`);
  }
  const usdcOverride = env.BASE_X402_USDC?.trim();
  const usdc = (usdcOverride || USDC_BY_CHAIN[chainId]) as `0x${string}` | undefined;
  if (!usdc) {
    throw new Error(
      `No USDC address known for ${network}; set BASE_X402_USDC to the USDC contract on that chain.`,
    );
  }
  const configuredMax = env.BASE_X402_MAX_ARTICLE_PRICE_ATOMIC?.trim();
  if (configuredMax !== undefined && !/^\d+$/.test(configuredMax)) {
    throw new Error(
      `BASE_X402_MAX_ARTICLE_PRICE_ATOMIC must be a positive atomic USDC integer, got "${configuredMax}"`,
    );
  }
  const maxArticlePriceAtomic = configuredMax === undefined
    ? DEFAULT_BASE_X402_MAX_ARTICLE_PRICE_ATOMIC
    : BigInt(configuredMax);
  if (maxArticlePriceAtomic <= 0n) {
    throw new Error("BASE_X402_MAX_ARTICLE_PRICE_ATOMIC must be greater than zero");
  }
  const maxTimeoutSeconds = Number(env.BASE_X402_MAX_TIMEOUT_SECONDS ?? 300) || 300;
  return {
    network,
    chainId,
    usdc,
    maxArticlePriceAtomic,
    maxTimeoutSeconds,
    mainnet: chainId === BASE_MAINNET_CHAIN_ID,
  };
}
