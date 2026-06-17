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
  WordDeliveryRecord,
} from "@rubicon-caliga/core";

/**
 * Full, server-side article record. May include private body content that must
 * never be revealed to a buyer before the corresponding word is paid for.
 */
export interface ArticleRecord {
  id: string;
  creatorId: string;
  creatorUsername: string;
  title: string;
  author: string;
  state: ArticleState;
  pricePerWordAtomic: bigint;
  maxArticlePriceAtomic?: bigint;
  totalWords: number;
  revision: number;
  sellerAgentConfig?: SellerAgentConfig;
  /** Private full article body. The atomic billing units come from this. */
  body: string;
  /** Tokenized body — the ordered list of billable words. */
  words: string[];
  sections: ArticleSection[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Read access to creator data managed by rubicon-marketing through shared
 * persistent storage. Only `live` articles are exposed here.
 *
 * Rubicon never relies on environment variables for production article or
 * creator data — this interface is the only production source.
 */
export interface PublishedArticleRepository {
  listPublishedArticles(): Promise<ArticleSummary[]>;
  getPublishedArticle(articleId: string): Promise<ArticleRecord | null>;
  getArticleSections(articleId: string): Promise<ArticleSection[]>;
  getCreatorWallet(creatorId: string): Promise<CreatorWallet | null>;
}

export interface RecordWordDeliveryInput {
  sessionId: string;
  articleId: string;
  creatorId: string;
  sequence: number;
  word: string;
  priceAtomic: bigint;
  creatorAmountAtomic: bigint;
  rubiconFeeAtomic: bigint;
  paymentId: string;
  transferId?: string;
  /** Ties this payment+delivery to one specific next word; retries are no-ops. */
  idempotencyKey: string;
}

export interface RecordWordDeliveryResult {
  /** True when an existing record matched the idempotency key (retry). */
  duplicate: boolean;
  delivery: WordDeliveryRecord;
  payment: PaymentActivity;
}

/**
 * Persistent ledger for runtime sessions, conversations, word deliveries, and
 * word payments. Word delivery and payment operations are idempotent and
 * constraint-protected so a word is never delivered or charged twice.
 */
export interface LedgerRepository {
  createSession(session: SessionRecord): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  saveSession(session: SessionRecord): Promise<void>;

  createConversation(input: {
    id: string;
    articleId: string;
    creatorId: string;
    goal?: string;
  }): Promise<void>;
  getConversation(
    conversationId: string,
  ): Promise<{ id: string; articleId: string; creatorId: string; goal?: string } | null>;
  appendMessage(message: SellerAgentMessageRecord): Promise<void>;
  listMessages(conversationId: string): Promise<SellerAgentMessageRecord[]>;

  getDeliveryByIdempotencyKey(key: string): Promise<RecordWordDeliveryResult | null>;
  /**
   * Atomically record one accepted word payment and the single word it
   * releases. Enforces unique (sessionId, sequence) and unique idempotencyKey.
   */
  recordWordDelivery(input: RecordWordDeliveryInput): Promise<RecordWordDeliveryResult>;

  listDeliveries(sessionId: string): Promise<WordDeliveryRecord[]>;
  listPayments(sessionId: string): Promise<PaymentActivity[]>;
  earningsForArticle(articleId: string): Promise<EarningsSummary>;
  earningsForCreator(creatorId: string): Promise<EarningsSummary>;
}
