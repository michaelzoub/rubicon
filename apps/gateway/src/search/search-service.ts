import type {
  ArticleSummary,
  SearchResponse,
  SearchResultSummary,
  SectionMatch,
} from "@rubicon-caliga/core";
import { lexicalConfidence, lexicalSectionConfidence } from "@rubicon-caliga/core";
import type { PublishedArticleRepository } from "../repositories/types.js";

/**
 * Tunable scoring constants (heuristics, not physical constants).
 *
 * For text-embedding-3-small, raw cosine similarity clusters ~0.1 (unrelated)
 * to ~0.6 (strongly related). We rescale to 0..1 so a single confidence floor
 * works across both semantic and lexical modes.
 */
const SEM_FLOOR = 0.20;
const SEM_CEIL = 0.55;
/** Mean bonus weight: one strong section drives the score, the mean breaks ties. */
const MEAN_BONUS = 0.15;
/** How many sections to retrieve from the vector index per query. */
const SEMANTIC_MATCH_COUNT = 40;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Rescale raw cosine similarity (0..1) into a normalized 0..1 confidence. */
function semanticConfidence(similarity: number): number {
  return clamp01((similarity - SEM_FLOOR) / (SEM_CEIL - SEM_FLOOR));
}

export interface BuildSearchResultsInput {
  query: string;
  limit: number;
  repo: PublishedArticleRepository;
  embedder: ((q: string) => Promise<number[] | null>) | null;
  /** Enriches summaries with seller payment terms, identical to /v1/repository. */
  withPaymentTerms: (summaries: ArticleSummary[]) => Promise<ArticleSummary[]>;
}

interface SemanticSectionHit {
  articleId: string;
  sectionId: string;
  confidence: number;
}

/**
 * Build a ranked SearchResponse. Tries semantic search first (when an embedder
 * and repo.searchSections are both available), falling back to lexical scoring
 * per-article. Articles with zero score are dropped. Never exposes unpaid body
 * text — only safe ArticleSummary metadata and normalized scores.
 */
export async function buildSearchResults(input: BuildSearchResultsInput): Promise<SearchResponse> {
  const summaries = await input.withPaymentTerms(await input.repo.listPublishedArticles());

  // Attempt semantic search.
  let semanticHits: Map<string, SemanticSectionHit[]> | null = null;
  if (input.embedder && input.repo.searchSections) {
    const embedding = await input.embedder(input.query);
    if (embedding) {
      try {
        // Repository search is deliberately article-scoped. Discovery iterates
        // the live summaries so an embedding from another article or revision
        // can never be joined into this result.
        const revisionedSummaries = summaries.filter(
          (summary): summary is typeof summary & { revision: number } => Number.isInteger(summary.revision),
        );
        const rows = (await Promise.all(revisionedSummaries.map((summary) =>
          input.repo.searchSections!({
            queryEmbedding: embedding,
            articleId: summary.articleId,
            revision: summary.revision,
            matchCount: SEMANTIC_MATCH_COUNT,
          })
        ))).flat();
        if (rows.length > 0) {
          semanticHits = new Map();
          for (const row of rows) {
            const summary = summaries.find((candidate) => candidate.articleId === row.articleId);
            if (!summary || summary.revision === undefined || row.revision !== summary.revision) continue;
            const list = semanticHits.get(row.articleId) ?? [];
            list.push({
              articleId: row.articleId,
              sectionId: row.sectionId,
              confidence: semanticConfidence(row.similarity),
            });
            semanticHits.set(row.articleId, list);
          }
        }
      } catch (error) {
        // A vector search failure must never crash the request — fall back to lexical.
        console.error("[gateway] semantic search failed, falling back to lexical", error);
        semanticHits = null;
      }
    }
  }

  const results: SearchResultSummary[] = [];
  let anySemantic = false;

  for (const summary of summaries) {
    const sectionMatches: SectionMatch[] = [];
    let mode: "semantic" | "lexical" = "lexical";

    const hits = semanticHits?.get(summary.articleId);
    if (hits && hits.length > 0) {
      mode = "semantic";
      anySemantic = true;
      // Build section confidence from semantic hits, joined to the summary's
      // sections for safe heading text.
      const sectionMap = new Map(summary.sections.map((section) => [section.sectionId, section]));
      for (const hit of hits) {
        const section = sectionMap.get(hit.sectionId);
        sectionMatches.push({
          sectionId: hit.sectionId,
          heading: section?.heading ?? hit.sectionId,
          score: hit.confidence,
        });
      }
    } else {
      // Lexical fallback for this article.
      sectionMatches.push(
        ...summary.sections
          .map((section) => ({
            sectionId: section.sectionId,
            heading: section.heading,
            score: lexicalSectionConfidence(summary, section, input.query),
          }))
          .filter((match) => match.score > 0),
      );
    }

    // Article score: max section confidence + mean bonus, clamped to 0..1.
    if (sectionMatches.length === 0) {
      // No section-level matches — use the article-level lexical score.
      const lexicalScore = lexicalConfidence(summary, input.query);
      if (lexicalScore <= 0) continue;
      results.push({ article: summary, score: lexicalScore, matchedSections: [] });
      continue;
    }

    const scores = sectionMatches.map((match) => match.score);
    const maxScore = Math.max(...scores);
    const meanScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    const articleScore = clamp01(maxScore + MEAN_BONUS * meanScore);

    if (articleScore <= 0) continue;

    const sortedMatches = [...sectionMatches].sort((left, right) => right.score - left.score);
    results.push({ article: summary, score: articleScore, matchedSections: sortedMatches });
    void mode; // mode is tracked via anySemantic at the response level
  }

  const sorted = results
    .sort((left, right) => right.score - left.score)
    .slice(0, input.limit);

  return {
    query: input.query,
    mode: anySemantic ? "semantic" : "lexical",
    results: sorted,
  };
}

export { SEM_FLOOR, SEM_CEIL, MEAN_BONUS };
