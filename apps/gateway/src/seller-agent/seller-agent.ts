import type { SellerNavigationSummary } from "@rubicon-caliga/core";
import type { ArticleRecord } from "../repositories/types.js";
import {
  DeterministicSellerModelProvider,
  type SafeArticleContext,
  type SellerModelProvider,
} from "./model-provider.js";

export interface SellerNavigationInput {
  article: ArticleRecord;
  goal?: string;
  candidateSectionIds?: string[];
}

export interface SellerNavigationResult extends SellerNavigationSummary {
  modelId: string;
}

export interface SellerConversationInput {
  article: ArticleRecord;
  conversationId: string;
  goal?: string;
  history: Array<{ role: "buyer" | "seller"; content: string }>;
  message: string;
}

export interface SellerConversationResult {
  reply: string;
  recommendedSectionId?: string;
  modelId: string;
}

/**
 * First-class seller agent. It represents one article, understands its title,
 * sections, author, and pricing, and talks to buyer agents through safe,
 * independently callable navigation and conversation endpoints.
 *
 * Safety invariants:
 *  - Its unpaid outputs (navigate/respond) only reveal safe navigation
 *    information.
 *  - It never includes unpaid quotes, conclusions, facts, or summaries in free
 *    navigation responses.
 *  - Paid word delivery belongs to the session stream, not this agent.
 */
export interface SellerAgent {
  navigate(input: SellerNavigationInput): Promise<SellerNavigationResult>;
  respond(input: SellerConversationInput): Promise<SellerConversationResult>;
}

const WITHHELD = [
  "section body text",
  "quotes",
  "conclusions",
  "specific facts not present in headings",
  "summaries of unpaid content",
];

function safeArticleContext(article: ArticleRecord): SafeArticleContext {
  const maxPrice =
    article.maxArticlePriceAtomic ?? article.pricePerWordAtomic * BigInt(article.totalWords);
  return {
    articleId: article.id,
    title: article.title,
    author: article.author,
    totalWords: article.totalWords,
    pricePerWordAtomic: `${article.pricePerWordAtomic}`,
    maxArticlePriceAtomic: `${maxPrice}`,
    // Headings and ranges only — never body text.
    sections: article.sections.map((section) => ({
      sectionId: section.sectionId,
      heading: section.heading,
      level: section.level,
      wordStart: section.wordStart,
      wordCount: section.wordCount,
    })),
  };
}

export class DefaultSellerAgent implements SellerAgent {
  constructor(private readonly model: SellerModelProvider = new DeterministicSellerModelProvider()) {}

  async navigate(input: SellerNavigationInput): Promise<SellerNavigationResult> {
    const article = safeArticleContext(input.article);
    const navigation = await this.model.navigate({
      article,
      goal: input.goal,
      candidateSectionIds: input.candidateSectionIds,
    });
    const recommended = article.sections.find(
      (section) => section.sectionId === navigation.recommendedSectionId,
    );
    return {
      modelId: this.model.id,
      recommendedSectionId: navigation.recommendedSectionId,
      alternativeSectionIds: navigation.alternativeSectionIds,
      sectionAssessments: navigation.sectionAssessments,
      rationale: navigation.rationale,
      safeHints: [
        recommended
          ? `Start at section "${recommended.sectionId}" ("${recommended.heading}"), ${recommended.wordCount} words.`
          : "Use the full article reading path.",
        `Each word costs ${article.pricePerWordAtomic} atomic USDC; stop whenever you have enough.`,
      ],
      withheld: WITHHELD,
    };
  }

  async respond(input: SellerConversationInput): Promise<SellerConversationResult> {
    const reply = await this.model.converse({
      article: safeArticleContext(input.article),
      goal: input.goal,
      history: input.history,
      message: input.message,
    });
    return { modelId: this.model.id, reply: reply.reply, recommendedSectionId: reply.recommendedSectionId };
  }

}
