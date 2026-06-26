/**
 * Single source of truth for the active onchain network — the gateway-side mirror
 * of rubicon-marketing's `lib/chain.ts`. Every onchain transaction Rubicon makes
 * goes through Circle on **Arc Testnet**; flip these constants in one place to
 * move to Arc mainnet later.
 *
 * Verified against Circle's published Arc config (canteen context):
 *   - chain id 5042002 (0x4CEF52), RPC https://rpc.testnet.arc.network
 *   - USDC ERC-20 0x3600…0000 with 6 decimals (native gas USDC is 18 decimals —
 *     never conflate the two)
 *   - Gateway Wallet contract 0x0077777d7EBA4688BDeF3E311b846F25870A19B9
 */

/** Arc Testnet chain id (hex 0x4CEF52). */
export const ARC_TESTNET_CHAIN_ID = 5042002;

/** CAIP-2 network string used for x402 settlement and CreatorWallet.network. */
export const ACTIVE_X402_NETWORK = `eip155:${ARC_TESTNET_CHAIN_ID}` as const;

/** Human-facing slug stored by rubicon-marketing for a creator's receiving wallet. */
export const RECEIVING_NETWORK = "arc-testnet" as const;

/** Display label for the active receiving network. */
export const RECEIVING_NETWORK_LABEL = "Arc Testnet" as const;

/** Arc Testnet JSON-RPC endpoint. */
export const ARC_TESTNET_RPC_URL = "https://rpc.testnet.arc-node.thecanteenapp.com/v1/swrm_8b207c9fd12afb52770c688a457711905d597a5f5c497b4324d962c6e101c24c" as const;

/** Circle Gateway facilitator (Arc Testnet). */
export const GATEWAY_API_URL = "https://gateway-api-testnet.circle.com" as const;

/** USDC ERC-20 contract on Arc Testnet. Transfer amounts use 6 decimals. */
export const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000" as const;

/** Decimals for ERC-20 USDC amounts (distinct from 18-decimal native gas USDC). */
export const USDC_DECIMALS = 6;

/** Circle Gateway Wallet contract on Arc Testnet (balance/withdraw, x402 verifyingContract). */
export const GATEWAY_WALLET_CONTRACT = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;

/**
 * Normalize a stored network value to its canonical CAIP-2 form. rubicon-marketing
 * persists the human slug ("arc-testnet"); the x402 verifier needs CAIP-2
 * ("eip155:5042002"). Already-CAIP-2 values pass through unchanged.
 */
export function toCaip2Network(network: string | null | undefined): string {
  if (!network) {
    return ACTIVE_X402_NETWORK;
  }
  const normalized = network.trim().toLowerCase();
  if (normalized === RECEIVING_NETWORK || normalized === "arctestnet" || normalized === "arc") {
    return ACTIVE_X402_NETWORK;
  }
  return network;
}
