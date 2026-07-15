import { createHash } from "node:crypto";

/** Stable analytics identity without exposing the buyer wallet to ClickHouse. */
export function hashBuyerAgentIdentity(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
