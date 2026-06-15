export const USDC_ATOMIC_UNITS = 1_000_000n;

export type AtomicAmount = `${bigint}`;

export function parseUsdcToAtomic(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  const paddedFraction = `${fraction}000000`.slice(0, 6);
  return BigInt(whole) * USDC_ATOMIC_UNITS + BigInt(paddedFraction);
}

export function formatAtomicUsdc(amount: bigint): string {
  const whole = amount / USDC_ATOMIC_UNITS;
  const fraction = `${amount % USDC_ATOMIC_UNITS}`.padStart(6, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
}

export function addBasisPoints(amount: bigint, basisPoints: number): bigint {
  return amount + (amount * BigInt(basisPoints)) / 10_000n;
}
