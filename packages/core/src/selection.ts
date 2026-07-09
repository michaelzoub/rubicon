import type { ArticleSection } from "./contract.js";

/**
 * What the buyer chose to purchase within one article. Every mode ultimately
 * resolves to an ordered set of article-global word indices (see
 * {@link resolveSelection}); pricing and settlement stay purely count-based, so
 * a non-contiguous union of sections is billed exactly like a single range.
 *
 *  - `article`  — the whole article (equivalent to the `full-article` section).
 *  - `sections` — the union of one or more named sections, in document order.
 *  - `words`    — an explicit range: `wordCount` words starting at the
 *                 zero-based, article-global offset `wordStart` (i.e. `[n, n+k)`).
 */
export type ReadSelection =
  | { mode: "article" }
  | { mode: "sections"; sectionIds: string[] }
  | { mode: "words"; wordStart: number; wordCount: number };

export type SelectionErrorCode =
  | "section_not_found"
  | "no_sections"
  | "invalid_range"
  | "empty_selection";

/** Thrown when a selection cannot be resolved against the article. */
export class SelectionError extends Error {
  constructor(
    public readonly code: SelectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SelectionError";
  }
}

type SectionRange = Pick<ArticleSection, "sectionId" | "wordStart" | "wordCount">;

/**
 * Resolve a {@link ReadSelection} to the ordered, de-duplicated list of
 * article-global word indices to deliver. The caller slices its trusted word
 * array with these indices, so the result is always clamped to `[0, totalWords)`
 * and can never authorize more words than the article can yield.
 *
 * Throws {@link SelectionError} for structurally invalid selections (unknown
 * section, empty section list, negative/zero range, or a selection that resolves
 * to zero deliverable words).
 */
export function resolveSelection(
  totalWords: number,
  sections: ReadonlyArray<SectionRange>,
  selection: ReadSelection,
): number[] {
  const total = Math.max(0, Math.floor(totalWords));
  const clampIndex = (value: number): number => Math.max(0, Math.min(value, total));

  let indices: number[];

  if (selection.mode === "article") {
    indices = range(0, total);
  } else if (selection.mode === "sections") {
    if (selection.sectionIds.length === 0) {
      throw new SelectionError("no_sections", "Select at least one section.");
    }
    const seen = new Set<number>();
    for (const sectionId of selection.sectionIds) {
      if (sectionId === "full-article") {
        for (const index of range(0, total)) seen.add(index);
        continue;
      }
      const section = sections.find((candidate) => candidate.sectionId === sectionId);
      if (!section) {
        throw new SelectionError("section_not_found", `Unknown section "${sectionId}".`);
      }
      const start = clampIndex(section.wordStart);
      const end = clampIndex(section.wordStart + section.wordCount);
      for (const index of range(start, end)) seen.add(index);
    }
    // Union of sections, ordered by article position (document order).
    indices = [...seen].sort((left, right) => left - right);
  } else {
    if (!Number.isInteger(selection.wordStart) || !Number.isInteger(selection.wordCount)) {
      throw new SelectionError("invalid_range", "wordStart and wordCount must be integers.");
    }
    if (selection.wordStart < 0 || selection.wordCount <= 0) {
      throw new SelectionError("invalid_range", "wordStart must be >= 0 and wordCount must be > 0.");
    }
    const start = clampIndex(selection.wordStart);
    const end = clampIndex(selection.wordStart + selection.wordCount);
    indices = range(start, end);
  }

  if (indices.length === 0) {
    throw new SelectionError("empty_selection", "The selection resolves to zero deliverable words.");
  }
  return indices;
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let index = start; index < end; index += 1) out.push(index);
  return out;
}
