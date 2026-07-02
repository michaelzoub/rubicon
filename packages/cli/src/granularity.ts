import type { ReadGranularity } from "@rubicon-caliga/agent-sdk/agent-client";
import { booleanFlag, stringFlag, type ParsedArgs } from "./args.js";
import { CliError } from "./errors.js";

/** Parse the buyer-facing payment/delivery unit. */
export function granularityFlag(parsed: ParsedArgs): ReadGranularity | undefined {
  const raw = stringFlag(parsed.flags, "granularity");
  if (raw === undefined) return undefined;
  if (raw === "word") return 1;
  if (raw === "section" || raw === "article") return raw;
  if (/^\d+$/.test(raw) && Number(raw) >= 1) return Number(raw);
  throw new CliError("INVALID_GRANULARITY", "--granularity must be word, a positive word count, section, or article.");
}

export function assertNoLegacyGranularityConflict(parsed: ParsedArgs, granularity: ReadGranularity | undefined): void {
  if (granularity === undefined) return;
  if (
    stringFlag(parsed.flags, "chunk-words") !== undefined ||
    stringFlag(parsed.flags, "stream-mode") !== undefined ||
    stringFlag(parsed.flags, "mode") !== undefined ||
    booleanFlag(parsed.flags, "per-word") ||
    booleanFlag(parsed.flags, "fast")
  ) {
    throw new CliError("MULTIPLE_GRANULARITIES", "--granularity cannot be combined with legacy stream/chunk flags.");
  }
}
