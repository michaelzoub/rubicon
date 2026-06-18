import type {
  ArticleSection,
  ArticleState,
  ArticleSummary,
  CreatorWallet,
  EarningsSummary,
  PaymentActivity,
  SellerAgentConfig,
  SellerAgentMessageRecord,
  SessionRecord,
  WalletNetwork,
  WordDeliveryRecord,
} from "@rubicon-caliga/core";
import { PUBLIC_ARTICLE_STATE } from "@rubicon-caliga/core";
import { sectionsFromMarkdown, tokenizeWords } from "../words.js";
import type {
  ArticleRecord,
  LedgerRepository,
  PublishedArticleRepository,
  RecordWordDeliveryInput,
  RecordWordDeliveryResult,
} from "./types.js";

export interface ArticleFixture {
  id: string;
  creatorId: string;
  creatorUsername: string;
  title: string;
  author: string;
  state?: ArticleState;
  pricePerWordAtomic: bigint;
  maxArticlePriceAtomic?: bigint;
  body: string;
  revision?: number;
  sellerAgentConfig?: SellerAgentConfig;
  sections?: ArticleSection[];
}

export interface CreatorWalletFixture {
  creatorId: string;
  address: `0x${string}`;
  network: WalletNetwork;
  verified?: boolean;
}

function buildArticleRecord(fixture: ArticleFixture): ArticleRecord {
  const words = tokenizeWords(fixture.body);
  const sections = fixture.sections ?? sectionsFromMarkdown(fixture.id, fixture.body);
  const now = new Date().toISOString();
  return {
    id: fixture.id,
    creatorId: fixture.creatorId,
    creatorUsername: fixture.creatorUsername,
    title: fixture.title,
    author: fixture.author,
    state: fixture.state ?? "live",
    pricePerWordAtomic: fixture.pricePerWordAtomic,
    maxArticlePriceAtomic: fixture.maxArticlePriceAtomic,
    totalWords: words.length,
    revision: fixture.revision ?? 1,
    sellerAgentConfig: fixture.sellerAgentConfig,
    body: fixture.body,
    words,
    sections,
    createdAt: now,
    updatedAt: now,
  };
}

export function summarizeArticle(article: ArticleRecord): ArticleSummary {
  const maxPrice =
    article.maxArticlePriceAtomic ?? article.pricePerWordAtomic * BigInt(article.totalWords);
  return {
    articleId: article.id,
    creatorId: article.creatorId,
    creatorUsername: article.creatorUsername,
    title: article.title,
    author: article.author,
    state: article.state,
    totalWords: article.totalWords,
    pricePerWordAtomic: `${article.pricePerWordAtomic}`,
    maxArticlePriceAtomic: `${maxPrice}`,
    sections: article.sections.map((section) => ({
      sectionId: section.sectionId,
      heading: section.heading,
      level: section.level,
      wordStart: section.wordStart,
      wordCount: section.wordCount,
    })),
  };
}

/**
 * In-memory development/test adapter for the shared published-article model.
 * In production this is backed by Postgres rows authored through
 * rubicon-marketing. Only `live` articles are exposed publicly.
 */
export class InMemoryPublishedArticleRepository implements PublishedArticleRepository {
  private readonly articles = new Map<string, ArticleRecord>();
  private readonly wallets = new Map<string, CreatorWallet>();

  constructor(input?: { articles?: ArticleFixture[]; wallets?: CreatorWalletFixture[] }) {
    for (const fixture of input?.articles ?? []) {
      this.upsertArticle(fixture);
    }
    for (const wallet of input?.wallets ?? []) {
      this.upsertWallet(wallet);
    }
  }

  upsertArticle(fixture: ArticleFixture): void {
    this.articles.set(fixture.id, buildArticleRecord(fixture));
  }

  upsertWallet(fixture: CreatorWalletFixture): void {
    this.wallets.set(fixture.creatorId, {
      creatorId: fixture.creatorId,
      address: fixture.address,
      network: fixture.network,
      verified: fixture.verified ?? true,
    });
  }

  async listPublishedArticles(): Promise<ArticleSummary[]> {
    return [...this.articles.values()]
      .filter((article) => article.state === PUBLIC_ARTICLE_STATE)
      .map((article) => summarizeArticle(article));
  }

  async getPublishedArticle(articleId: string): Promise<ArticleRecord | null> {
    const article = this.articles.get(articleId);
    if (!article || article.state !== PUBLIC_ARTICLE_STATE) {
      return null;
    }
    return article;
  }

  /** State-agnostic lookup for documented existing-session policies. */
  async getArticleAnyState(articleId: string): Promise<ArticleRecord | null> {
    return this.articles.get(articleId) ?? null;
  }

  async getArticleSections(articleId: string): Promise<ArticleSection[]> {
    return this.articles.get(articleId)?.sections ?? [];
  }

  async getCreatorWallet(creatorId: string): Promise<CreatorWallet | null> {
    return this.wallets.get(creatorId) ?? null;
  }
}

interface InternalPayment extends PaymentActivity {
  creatorId: string;
}

export class InMemoryLedgerRepository implements LedgerRepository {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly conversations = new Map<
    string,
    { id: string; articleId: string; creatorId: string; goal?: string }
  >();
  private readonly messages = new Map<string, SellerAgentMessageRecord[]>();
  private readonly deliveriesByKey = new Map<string, RecordWordDeliveryResult>();
  private readonly deliveriesBySeq = new Map<string, RecordWordDeliveryResult>();
  private readonly deliveriesBySession = new Map<string, WordDeliveryRecord[]>();
  private readonly paymentsBySession = new Map<string, InternalPayment[]>();

  async createSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async saveSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async createConversation(input: {
    id: string;
    articleId: string;
    creatorId: string;
    goal?: string;
  }): Promise<void> {
    this.conversations.set(input.id, input);
  }

  async getConversation(
    conversationId: string,
  ): Promise<{ id: string; articleId: string; creatorId: string; goal?: string } | null> {
    return this.conversations.get(conversationId) ?? null;
  }

  async appendMessage(message: SellerAgentMessageRecord): Promise<void> {
    const list = this.messages.get(message.conversationId) ?? [];
    list.push(message);
    this.messages.set(message.conversationId, list);
  }

  async listMessages(conversationId: string): Promise<SellerAgentMessageRecord[]> {
    return [...(this.messages.get(conversationId) ?? [])];
  }

  async getDeliveryByIdempotencyKey(key: string): Promise<RecordWordDeliveryResult | null> {
    const existing = this.deliveriesByKey.get(key);
    if (!existing) {
      return null;
    }
    return { ...existing, duplicate: true };
  }

  async recordWordDelivery(input: RecordWordDeliveryInput): Promise<RecordWordDeliveryResult> {
    const existingByKey = this.deliveriesByKey.get(input.idempotencyKey);
    if (existingByKey) {
      return { ...existingByKey, duplicate: true };
    }
    const seqKey = `${input.sessionId}:${input.sequence}`;
    const existingBySeq = this.deliveriesBySeq.get(seqKey);
    if (existingBySeq) {
      // A word must never be delivered twice for the same sequence.
      return { ...existingBySeq, duplicate: true };
    }

    const createdAt = new Date().toISOString();
    const delivery: WordDeliveryRecord = {
      sessionId: input.sessionId,
      articleId: input.articleId,
      sequence: input.sequence,
      word: input.word,
      priceAtomic: `${input.priceAtomic}`,
      paymentId: input.paymentId,
      createdAt,
    };
    const payment: InternalPayment = {
      paymentId: input.paymentId,
      sessionId: input.sessionId,
      articleId: input.articleId,
      creatorId: input.creatorId,
      sequence: input.sequence,
      amountAtomic: `${input.priceAtomic}`,
      creatorAmountAtomic: `${input.creatorAmountAtomic}`,
      rubiconFeeAtomic: `${input.rubiconFeeAtomic}`,
      network: input.network,
      payTo: input.payTo,
      transactionHash: input.transactionHash ?? input.transferId,
      transactionHashes: input.transactionHashes ?? (input.transactionHash || input.transferId ? [input.transactionHash ?? input.transferId!] : undefined),
      settlementId: input.settlementId,
      settlementIds: input.settlementIds,
      buyerWalletAddress: input.buyerWalletAddress,
      transferId: input.transferId,
      createdAt,
    };
    const result: RecordWordDeliveryResult = { duplicate: false, delivery, payment };
    this.deliveriesByKey.set(input.idempotencyKey, result);
    this.deliveriesBySeq.set(seqKey, result);
    this.deliveriesBySession.set(input.sessionId, [
      ...(this.deliveriesBySession.get(input.sessionId) ?? []),
      delivery,
    ]);
    this.paymentsBySession.set(input.sessionId, [
      ...(this.paymentsBySession.get(input.sessionId) ?? []),
      payment,
    ]);
    return result;
  }

  async listDeliveries(sessionId: string): Promise<WordDeliveryRecord[]> {
    return [...(this.deliveriesBySession.get(sessionId) ?? [])];
  }

  async listPayments(sessionId: string): Promise<PaymentActivity[]> {
    return (this.paymentsBySession.get(sessionId) ?? []).map(({ creatorId: _creatorId, ...rest }) => rest);
  }

  async earningsForArticle(articleId: string): Promise<EarningsSummary> {
    return this.sumEarnings((payment) => payment.articleId === articleId, { articleId });
  }

  async earningsForCreator(creatorId: string): Promise<EarningsSummary> {
    return this.sumEarnings((payment) => payment.creatorId === creatorId, { creatorId });
  }

  private sumEarnings(
    predicate: (payment: InternalPayment) => boolean,
    scope: { creatorId?: string; articleId?: string },
  ): EarningsSummary {
    let words = 0;
    let creatorAmount = 0n;
    let rubiconFee = 0n;
    let creatorId = scope.creatorId ?? "";
    for (const payments of this.paymentsBySession.values()) {
      for (const payment of payments) {
        if (!predicate(payment)) {
          continue;
        }
        words += 1;
        creatorAmount += BigInt(payment.creatorAmountAtomic);
        rubiconFee += BigInt(payment.rubiconFeeAtomic);
        creatorId = payment.creatorId;
      }
    }
    return {
      creatorId,
      articleId: scope.articleId,
      wordsDelivered: words,
      creatorAmountAtomic: `${creatorAmount}`,
      rubiconFeeAtomic: `${rubiconFee}`,
    };
  }
}
