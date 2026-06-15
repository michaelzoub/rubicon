import { addBasisPoints } from "./money.js";

export type MeteringUnit = "second" | "token" | "image" | "request" | "custom";

export interface PriceQuote {
  currency: "USDC";
  intervalMs: number;
  meteringUnit: MeteringUnit;
  unitPriceAtomic: `${bigint}`;
  gatewayFeeBps: number;
  chargePerIntervalAtomic: `${bigint}`;
}

export interface UsageReport {
  unit: MeteringUnit;
  quantity: number;
  providerCostAtomic: `${bigint}`;
  gatewayFeeAtomic: `${bigint}`;
  totalCostAtomic: `${bigint}`;
}

export function quotePerInterval(input: {
  unitPriceAtomic: bigint;
  unitsPerInterval: number;
  intervalMs: number;
  meteringUnit: MeteringUnit;
  gatewayFeeBps: number;
}): PriceQuote {
  const providerCost = input.unitPriceAtomic * BigInt(input.unitsPerInterval);
  const total = addBasisPoints(providerCost, input.gatewayFeeBps);
  return {
    currency: "USDC",
    intervalMs: input.intervalMs,
    meteringUnit: input.meteringUnit,
    unitPriceAtomic: `${input.unitPriceAtomic}`,
    gatewayFeeBps: input.gatewayFeeBps,
    chargePerIntervalAtomic: `${total}`,
  };
}
