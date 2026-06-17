import { addBasisPoints } from "./money.js";

export type MeteringUnit = "word";

/**
 * The atomic content unit in Rubicon is exactly one word. A quote describes the
 * price the creator earns for a single word and the amount the buyer must pay to
 * release one additional word.
 *
 * Rubicon never bills in chunks. Circle/x402 may batch settlement internally,
 * but the application-level accounting is always one word = one paid unit.
 */
export interface WordPriceQuote {
  currency: "USDC";
  meteringUnit: MeteringUnit;
  /** Price the creator earns for one delivered word. */
  pricePerWordAtomic: `${bigint}`;
  /** Rubicon gateway fee in basis points. Defaults to 0. */
  gatewayFeeBps: number;
  /** Exact amount the buyer authorizes/sends to release one additional word. */
  wordPaymentAtomic: `${bigint}`;
}

export interface WordUsageReport {
  unit: MeteringUnit;
  /** Number of individually delivered, individually paid words. */
  wordsDelivered: number;
  /** Full word price accruing to the creator (no Rubicon fee deducted). */
  creatorAmountAtomic: `${bigint}`;
  /** Rubicon fee. Zero by default — creators keep the full word price. */
  rubiconFeeAtomic: `${bigint}`;
  /** Total atomic USDC the buyer paid for these words. */
  totalPaidAtomic: `${bigint}`;
}

export function quotePerWord(input: {
  pricePerWordAtomic: bigint;
  gatewayFeeBps?: number;
}): WordPriceQuote {
  const gatewayFeeBps = input.gatewayFeeBps ?? 0;
  const wordPayment = addBasisPoints(input.pricePerWordAtomic, gatewayFeeBps);
  return {
    currency: "USDC",
    meteringUnit: "word",
    pricePerWordAtomic: `${input.pricePerWordAtomic}`,
    gatewayFeeBps,
    wordPaymentAtomic: `${wordPayment}`,
  };
}

export function usageForWords(input: {
  wordsDelivered: number;
  pricePerWordAtomic: bigint;
  gatewayFeeBps?: number;
}): WordUsageReport {
  const gatewayFeeBps = input.gatewayFeeBps ?? 0;
  const creatorAmount = input.pricePerWordAtomic * BigInt(input.wordsDelivered);
  const total = addBasisPoints(creatorAmount, gatewayFeeBps);
  return {
    unit: "word",
    wordsDelivered: input.wordsDelivered,
    creatorAmountAtomic: `${creatorAmount}`,
    rubiconFeeAtomic: `${total - creatorAmount}`,
    totalPaidAtomic: `${total}`,
  };
}
