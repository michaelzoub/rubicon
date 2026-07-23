import type { ArticleRecord, PublishedArticleRepository } from "../repositories/types.js";

const MAX_CANDIDATES = 3;

export interface SectionRoute {
  mode: "semantic" | "lexical";
  candidates: Array<{ sectionId: string; confidence: number }>;
}

function tokens(value: string): string[] {
  return value.toLocaleLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3);
}

function lexicalRoute(article: ArticleRecord, query: string): SectionRoute {
  const queryTokens = tokens(query);
  const ranked = article.sections
    .filter((section) => section.sectionId !== "full-article")
    .map((section) => {
      const headingTokens = new Set(tokens(section.heading));
      const matches = queryTokens.filter((token) => headingTokens.has(token)).length;
      return { sectionId: section.sectionId, confidence: queryTokens.length ? matches / queryTokens.length : 0 };
    })
    .sort((left, right) => right.confidence - left.confidence);
  const positive = ranked.filter((candidate) => candidate.confidence > 0);
  return { mode: "lexical", candidates: (positive.length ? positive : ranked).slice(0, MAX_CANDIDATES) };
}

/**
 * Private-content-aware ranking boundary. Embeddings yield IDs and scores only;
 * all buyer-visible metadata is joined later from the live ArticleRecord.
 */
export async function routeArticleSections(input: {
  article: ArticleRecord;
  query: string;
  repo: PublishedArticleRepository;
  embedder: ((query: string) => Promise<number[] | null>) | null;
}): Promise<SectionRoute> {
  if (input.embedder && input.repo.searchSections && input.query.trim()) {
    try {
      const queryEmbedding = await input.embedder(input.query);
      if (queryEmbedding) {
        const rows = await input.repo.searchSections({
          queryEmbedding,
          articleId: input.article.id,
          revision: input.article.revision,
          matchCount: MAX_CANDIDATES,
        });
        const validIds = new Set(input.article.sections.map((section) => section.sectionId));
        const candidates = rows
          .filter((row) =>
            row.articleId === input.article.id &&
            row.revision === input.article.revision &&
            validIds.has(row.sectionId) &&
            Number.isFinite(row.similarity)
          )
          .sort((left, right) => right.similarity - left.similarity)
          .slice(0, MAX_CANDIDATES)
          .map((row) => ({ sectionId: row.sectionId, confidence: Math.max(0, Math.min(1, row.similarity)) }));
        if (candidates.length) return { mode: "semantic", candidates };
      }
    } catch (error) {
      console.error("[gateway] scoped section retrieval failed, falling back to headings", error);
    }
  }
  return lexicalRoute(input.article, input.query);
}
