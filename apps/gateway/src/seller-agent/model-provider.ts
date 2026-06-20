/**
 * Pluggable model/provider abstraction that powers a seller agent's navigation
 * and conversation. A provider only ever receives *safe* article context —
 * titles, headings, word ranges, and pricing. It never receives unpaid body
 * text, so its outputs cannot leak unpaid content.
 */

export interface SafeSectionContext {
  sectionId: string;
  heading: string;
  level: number;
  wordStart: number;
  wordCount: number;
}

export interface SafeArticleContext {
  articleId: string;
  title: string;
  author: string;
  totalWords: number;
  pricePerWordAtomic: string;
  maxArticlePriceAtomic: string;
  sections: SafeSectionContext[];
}

export interface SellerNavigationContext {
  article: SafeArticleContext;
  goal?: string;
  candidateSectionIds?: string[];
}

export interface SellerConversationContext {
  article: SafeArticleContext;
  goal?: string;
  history: Array<{ role: "buyer" | "seller"; content: string }>;
  message: string;
}

export interface SellerModelNavigation {
  recommendedSectionId: string;
  alternativeSectionIds: string[];
  rationale: string;
  sectionAssessments?: Array<{
    sectionId: string;
    expectedValue: number;
    minimumUsefulWords: number;
    rationale: string;
  }>;
}

export interface SellerModelReply {
  reply: string;
  recommendedSectionId?: string;
}

export interface SellerModelProvider {
  /** Identifier such as "deterministic-dev" or "anthropic:claude-opus-4-8". */
  readonly id: string;
  navigate(context: SellerNavigationContext): Promise<SellerModelNavigation>;
  converse(context: SellerConversationContext): Promise<SellerModelReply>;
}

function tokenizeGoal(value: string | undefined): string[] {
  return (value ?? "")
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function rankSections(context: SellerNavigationContext | SellerConversationContext): SafeSectionContext[] {
  const goalTokens = tokenizeGoal(context.goal);
  const candidates = new Set(
    "candidateSectionIds" in context ? context.candidateSectionIds ?? [] : [],
  );
  const messageTokens =
    "message" in context ? tokenizeGoal(context.message) : ([] as string[]);
  const tokens = [...goalTokens, ...messageTokens];
  return [...context.article.sections]
    .map((section) => {
      const heading = section.heading.toLocaleLowerCase();
      const score =
        (candidates.has(section.sectionId) ? 3 : 0) +
        tokens.filter((token) => heading.includes(token)).length;
      return { section, score };
    })
    .sort((left, right) => right.score - left.score || left.section.wordStart - right.section.wordStart)
    .map((entry) => entry.section);
}

/**
 * Deterministic development fallback. It ranks sections purely by heading/goal
 * token overlap so the repository runs locally with no external model key.
 *
 * THIS IS DEVELOPMENT BEHAVIOR. It is a navigation heuristic, not the full
 * production seller agent — it does not reason over article content, only over
 * safe headings and pricing. Configure a real `SellerModelProvider` in
 * production.
 */
export class DeterministicSellerModelProvider implements SellerModelProvider {
  readonly id = "deterministic-dev";

  async navigate(context: SellerNavigationContext): Promise<SellerModelNavigation> {
    const ranked = rankSections(context).filter((section) => section.sectionId !== "full-article");
    const pool = ranked.length > 0 ? ranked : context.article.sections;
    const top = pool.slice(0, 3);
    const recommended = top[0] ?? context.article.sections[0];
    return {
      recommendedSectionId: recommended?.sectionId ?? "full-article",
      alternativeSectionIds: top.slice(1).map((section) => section.sectionId),
      rationale: recommended
        ? `Section "${recommended.heading}" is the closest match to the buyer goal based on section headings (${recommended.wordCount} words at ~${context.article.pricePerWordAtomic} atomic USDC each).`
        : "No sections are available; the full article is the only reading path.",
      sectionAssessments: top.map((section, index) => ({
        sectionId: section.sectionId,
        expectedValue: Math.max(0.2, 0.9 - index * 0.25),
        minimumUsefulWords: Math.min(section.wordCount, Math.max(1, Math.ceil(section.wordCount * 0.35))),
        rationale: `Rank ${index + 1} from goal-to-heading relevance; ${section.wordCount} paid words available.`,
      })),
    };
  }

  async converse(context: SellerConversationContext): Promise<SellerModelReply> {
    const navigation = await this.navigate(context);
    const recommended = context.article.sections.find(
      (section) => section.sectionId === navigation.recommendedSectionId,
    );
    const reply = recommended
      ? `For "${context.message.trim() || context.goal || "your goal"}", I'd start in "${recommended.heading}" (${recommended.wordCount} words). I can't share the text until you pay per word, but that section's heading is the best free signal. You pay ${context.article.pricePerWordAtomic} atomic USDC per word and can stop whenever you have enough.`
      : `I can only point you to section headings for free. You pay ${context.article.pricePerWordAtomic} atomic USDC per word and can stop whenever you have enough.`;
    return { reply, recommendedSectionId: navigation.recommendedSectionId };
  }
}

/**
 * Wraps a configured text-completion language model into a seller model
 * provider. The completion function only ever sees safe context, and the JSON
 * response is validated against the real section list before use, so a model
 * cannot hallucinate or leak unpaid content into navigation.
 */
export class TextCompletionSellerModelProvider implements SellerModelProvider {
  private readonly fallback = new DeterministicSellerModelProvider();

  constructor(
    readonly id: string,
    private readonly complete: (input: { system: string; prompt: string }) => Promise<string>,
  ) {}

  async navigate(context: SellerNavigationContext): Promise<SellerModelNavigation> {
    const system =
      "You are a seller agent for a paywalled article. Use only the provided safe metadata. Never reveal unpaid body text or facts. Rank sections for the exact goal and reply ONLY with JSON: {\"recommendedSectionId\":string,\"alternativeSectionIds\":string[],\"rationale\":string,\"sectionAssessments\":[{\"sectionId\":string,\"expectedValue\":number from 0 to 1,\"minimumUsefulWords\":positive integer,\"rationale\":string}]}. Prefer concise self-contained sections for small budgets and include conclusions, counterarguments, or practical details when useful.";
    const prompt = JSON.stringify({ goal: context.goal, article: context.article });
    try {
      const parsed = JSON.parse(await this.complete({ system, prompt })) as Partial<SellerModelNavigation>;
      const valid = context.article.sections.some((s) => s.sectionId === parsed.recommendedSectionId);
      if (!valid || typeof parsed.recommendedSectionId !== "string") {
        return this.fallback.navigate(context);
      }
      return {
        recommendedSectionId: parsed.recommendedSectionId,
        alternativeSectionIds: (parsed.alternativeSectionIds ?? []).filter((id) =>
          context.article.sections.some((s) => s.sectionId === id),
        ),
        rationale: typeof parsed.rationale === "string" ? parsed.rationale : "Recommended from section headings.",
        sectionAssessments: (parsed.sectionAssessments ?? []).flatMap((assessment) => {
          const section = context.article.sections.find((candidate) => candidate.sectionId === assessment.sectionId);
          if (!section || !Number.isFinite(assessment.expectedValue) || !Number.isInteger(assessment.minimumUsefulWords)) return [];
          return [{
            sectionId: section.sectionId,
            expectedValue: Math.max(0, Math.min(1, assessment.expectedValue)),
            minimumUsefulWords: Math.max(1, Math.min(section.wordCount, assessment.minimumUsefulWords)),
            rationale: typeof assessment.rationale === "string" ? assessment.rationale : "Seller metadata assessment.",
          }];
        }),
      };
    } catch {
      return this.fallback.navigate(context);
    }
  }

  async converse(context: SellerConversationContext): Promise<SellerModelReply> {
    const system =
      "You are a seller agent for a paywalled article. Help the buyer find the right starting section using ONLY safe metadata. Never reveal unpaid body text, quotes, conclusions, summaries, or facts. Reply ONLY with JSON: {\"reply\":string,\"recommendedSectionId\":string}.";
    const prompt = JSON.stringify({
      goal: context.goal,
      message: context.message,
      history: context.history,
      article: context.article,
    });
    try {
      const parsed = JSON.parse(await this.complete({ system, prompt })) as Partial<SellerModelReply>;
      if (typeof parsed.reply !== "string") {
        return this.fallback.converse(context);
      }
      const recommended = context.article.sections.some((s) => s.sectionId === parsed.recommendedSectionId)
        ? parsed.recommendedSectionId
        : undefined;
      return { reply: parsed.reply, recommendedSectionId: recommended };
    } catch {
      return this.fallback.converse(context);
    }
  }
}
