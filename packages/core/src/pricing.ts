import { addBasisPoints } from "./money.js";

export type MeteringUnit = "word";

export interface PriceQuote {
  currency: "USDC";
  chunkWords: number;
  meteringUnit: MeteringUnit;
  unitPriceAtomic: `${bigint}`;
  gatewayFeeBps: number;
  chargePerWordAtomic: `${bigint}`;
  chargePerChunkAtomic: `${bigint}`;
}

export interface UsageReport {
  unit: MeteringUnit;
  quantity: number;
  authorCostAtomic: `${bigint}`;
  gatewayFeeAtomic: `${bigint}`;
  totalCostAtomic: `${bigint}`;
}

export function quotePerWords(input: {
  unitPriceAtomic: bigint;
  chunkWords: number;
  gatewayFeeBps: number;
}): PriceQuote {
  const chargePerWord = addBasisPoints(input.unitPriceAtomic, input.gatewayFeeBps);
  const chargePerChunk = chargePerWord * BigInt(input.chunkWords);
  return {
    currency: "USDC",
    chunkWords: input.chunkWords,
    meteringUnit: "word",
    unitPriceAtomic: `${input.unitPriceAtomic}`,
    gatewayFeeBps: input.gatewayFeeBps,
    chargePerWordAtomic: `${chargePerWord}`,
    chargePerChunkAtomic: `${chargePerChunk}`,
  };
}

export function usageForWords(input: {
  wordCount: number;
  unitPriceAtomic: bigint;
  gatewayFeeBps: number;
}): UsageReport {
  const authorCost = input.unitPriceAtomic * BigInt(input.wordCount);
  const total = addBasisPoints(authorCost, input.gatewayFeeBps);
  return {
    unit: "word",
    quantity: input.wordCount,
    authorCostAtomic: `${authorCost}`,
    gatewayFeeAtomic: `${total - authorCost}`,
    totalCostAtomic: `${total}`,
  };
}
