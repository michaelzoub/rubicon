import { booleanFlag, stringFlag, type ParsedArgs } from "./args.js";
import { CliError } from "./errors.js";

export interface ReadSelectionFlags {
  sectionIds: string[] | undefined;
  wordStart: number | undefined;
  wordCount: number | undefined;
  whole: boolean;
}

/**
 * Parse the explicit read-selection flags for `rubicon read`:
 *   --whole                 whole article
 *   --sections a,b,c        union of named sections (document order)
 *   --words <start>:<count> a word range [start, start+count)
 * Returns undefined fields when the corresponding flag is absent. Throws
 * {@link CliError} on malformed input; mutual-exclusivity across modes is
 * enforced by the caller.
 */
export function parseSelectionFlags(parsed: ParsedArgs): ReadSelectionFlags {
  const whole = booleanFlag(parsed.flags, "whole");
  const sectionsRaw = stringFlag(parsed.flags, "sections");
  const wordsRaw = stringFlag(parsed.flags, "words");

  let sectionIds: string[] | undefined;
  if (sectionsRaw !== undefined) {
    sectionIds = sectionsRaw.split(",").map((value) => value.trim()).filter(Boolean);
    if (sectionIds.length === 0) {
      throw new CliError("INVALID_SECTIONS", "--sections requires at least one section id.");
    }
  }

  let wordStart: number | undefined;
  let wordCount: number | undefined;
  if (wordsRaw !== undefined) {
    const match = /^(\d+):(\d+)$/.exec(wordsRaw.trim());
    if (!match) {
      throw new CliError("INVALID_WORDS", "--words must be <start>:<count>, e.g. --words 40:29.");
    }
    wordStart = Number(match[1]);
    wordCount = Number(match[2]);
    if (wordCount < 1) {
      throw new CliError("INVALID_WORDS", "--words count must be at least 1.");
    }
  }

  return { sectionIds, wordStart, wordCount, whole };
}

/** Count how many explicit selection modes are active (for mutual-exclusivity checks). */
export function explicitSelectionModeCount(flags: ReadSelectionFlags): number {
  return [flags.whole, flags.sectionIds !== undefined, flags.wordStart !== undefined].filter(Boolean).length;
}
