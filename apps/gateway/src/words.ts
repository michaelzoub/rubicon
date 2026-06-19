import type { ArticleSection } from "@rubicon-caliga/core";

/**
 * The atomic content unit in Rubicon is one word. A word is a maximal run of
 * non-whitespace characters. This is the single, shared word-counting rule used
 * for pricing, billing, section ranges, and earnings — it must match the rule
 * used by rubicon-marketing when it computes `totalWords`.
 */
export function tokenizeWords(content: string): string[] {
  return content.trim().split(/\s+/).filter(Boolean);
}

export function countWords(content: string): number {
  return tokenizeWords(content).length;
}

export function slugify(value: string): string {
  const slug = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

/**
 * Derive article sections from markdown headings. Used by the development
 * fixture adapter; the Postgres adapter reads stored `article_sections` rows
 * authored through rubicon-marketing instead.
 */
export function sectionsFromMarkdown(articleId: string, content: string): ArticleSection[] {
  const lines = content.split(/\r?\n/);
  const raw: Array<{
    sectionId: string;
    heading: string;
    level: number;
    headerWordStart: number;
    contentWordStart: number;
  }> = [];
  let wordStart = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    const lineWordCount = tokenizeWords(line).length;
    const match = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (match) {
      const hashes = match[1] ?? "";
      const heading = match[2] ?? "";
      raw.push({
        sectionId: slugify(heading),
        heading: heading.trim(),
        level: hashes.length,
        headerWordStart: wordStart,
        contentWordStart: wordStart + lineWordCount,
      });
    }
    wordStart += lineWordCount;
  }

  const totalWords = wordStart;
  const full: ArticleSection = {
    id: `${articleId}:full-article`,
    articleId,
    sectionId: "full-article",
    heading: "Full article",
    level: 1,
    wordStart: 0,
    wordCount: totalWords,
    ordinal: 0,
  };

  const headings = raw.map((header, index) => {
    const next = raw[index + 1];
    const wordCount = (next?.headerWordStart ?? totalWords) - header.contentWordStart;
    const section: ArticleSection = {
      id: `${articleId}:${header.sectionId}`,
      articleId,
      sectionId: header.sectionId,
      heading: header.heading,
      level: header.level,
      wordStart: header.contentWordStart,
      wordCount,
      ordinal: index + 1,
    };
    return section;
  });

  return [full, ...headings];
}

/**
 * Reconcile advertised section ranges against the actual tokenized word array.
 *
 * The gateway always slices delivered words out of `tokenizeWords(body)`, so the
 * advertised counts a buyer signs against must never exceed what that array can
 * yield. Stored `word_start`/`word_count` (authored by rubicon-marketing) can
 * drift from the body — e.g. a later edit shortened the text but the section
 * rows or `total_words` were not recomputed. Left unclamped, a buyer could sign
 * an authorization for more words than the gateway can deliver, and the
 * EIP-3009 value would exceed what gets sliced. Clamping here makes every
 * advertised range a subset of the sliceable words so the two clamps agree.
 */
export function clampSectionsToWords(
  words: string[],
  sections: ArticleSection[],
): ArticleSection[] {
  const total = words.length;
  return sections.map((section) => {
    const wordStart = Math.max(0, Math.min(section.wordStart, total));
    const wordCount = Math.max(0, Math.min(section.wordCount, total - wordStart));
    if (wordStart === section.wordStart && wordCount === section.wordCount) {
      return section;
    }
    return { ...section, wordStart, wordCount };
  });
}

/** Resolve the ordered word list for a section (or the whole article). */
export function wordsForSection(
  words: string[],
  sections: ArticleSection[],
  sectionId: string | undefined,
): { words: string[]; wordStart: number } | undefined {
  if (!sectionId || sectionId === "full-article") {
    return { words, wordStart: 0 };
  }
  const section = sections.find((candidate) => candidate.sectionId === sectionId);
  if (!section) {
    return undefined;
  }
  return {
    words: words.slice(section.wordStart, section.wordStart + section.wordCount),
    wordStart: section.wordStart,
  };
}
