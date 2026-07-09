import type { ArticleSummary, SearchResultSummary, SectionMatch } from "./protocol.js";

/**
 * Stopwords excluded from query term matching. Shared by the gateway search
 * endpoint and the CLI `buy` flow so there is one source of truth for lexical
 * scoring. Tunable — these are common English filler words, not physical
 * constants.
 */
const STOP_WORDS = new Set([
  "and", "are", "article", "about", "explain", "find", "for", "from", "how",
  "into", "one", "purchase", "summarize", "the", "this", "what", "with",
]);

/**
 * Extract meaningful query terms: lowercase, split on non-alphanumeric, drop
 * tokens shorter than 3 characters and stopwords.
 */
export function meaningfulTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term));
}

/**
 * Normalized 0..1 lexical confidence: fraction of meaningful query terms that
 * appear (as substrings) in the article's safe metadata (title + section
 * headings). Returns 0 when the query has no meaningful terms.
 */
export function lexicalConfidence(article: ArticleSummary, query: string): number {
  const terms = meaningfulTerms(query);
  if (terms.length === 0) return 0;
  const text = [article.title, ...article.sections.map((section) => section.heading)]
    .join(" ")
    .toLowerCase();
  const matched = terms.filter((term) => text.includes(term)).length;
  return matched / terms.length;
}

/**
 * Per-section lexical confidence: fraction of meaningful query terms matched
 * in the section heading (and the article title, which applies to every section).
 */
export function lexicalSectionConfidence(
  article: ArticleSummary,
  section: ArticleSummary["sections"][number],
  query: string,
): number {
  const terms = meaningfulTerms(query);
  if (terms.length === 0) return 0;
  const text = [article.title, section.heading].join(" ").toLowerCase();
  const matched = terms.filter((term) => text.includes(term)).length;
  return matched / terms.length;
}

/**
 * Rank articles by lexical confidence and return normalized 0..1 results.
 * Articles with a score of 0 (no term matches) are excluded. Results are sorted
 * by score descending and limited to `limit`.
 */
export function lexicalSearch(
  summaries: ArticleSummary[],
  query: string,
  limit: number,
): SearchResultSummary[] {
  return summaries
    .map((article) => {
      const sectionMatches: SectionMatch[] = article.sections
        .map((section) => ({
          sectionId: section.sectionId,
          heading: section.heading,
          score: lexicalSectionConfidence(article, section, query),
        }))
        .filter((match) => match.score > 0)
        .sort((left, right) => right.score - left.score);
      const score = lexicalConfidence(article, query);
      return { article, score, matchedSections: sectionMatches } satisfies SearchResultSummary;
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export { STOP_WORDS as LEXICAL_STOP_WORDS };
