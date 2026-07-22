import type {
  ArticleSection,
  ArticleAccessMode,
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
  accessMode: ArticleAccessMode;
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
  /** Separate, verified Base-mainnet recipient for AgentCash whole-article x402. */
  getCreatorBaseWallet(creatorId: string): Promise<CreatorWallet | null>;
  /**
   * Semantic top-k search over section embeddings. Absent or returning empty
   * signals the caller to fall back to lexical scoring. Implemented by the
   * Supabase adapter (pgvector RPC); the in-memory demo adapter does not
   * implement it so demo mode is lexical-only.
   */
  searchSections?(input: {
    queryEmbedding: number[];
    articleId: string;
    revision: number;
    matchCount: number;
  }): Promise<Array<{ articleId: string; sectionId: string; revision: number; similarity: number }>>;
}

export interface RecordWordDeliveryResult {
  /** True when an existing record matched the idempotency key (retry). */
  duplicate: boolean;
  delivery: WordDeliveryRecord;
  /** Present only for paid delivery. */
  payment?: PaymentActivity;
}

export type BundlePaymentStatus = "free" | "authorized" | "pending" | "confirmed" | "completed" | "failed";

export interface BundleWordInput {
  sequence: number;
  word: string;
}

export interface RecordedBundle {
  bundleId: string;
  idempotencyKey: string;
  sessionId: string;
  creatorId: string;
  articleId: string;
  accessMode: "paid" | "free";
  sectionId?: string;
  bundleSequence: number;
  startSequence: number;
  endSequence: number;
  wordsCount: number;
  pricePerWordAtomic: `${bigint}`;
  grossAmountAtomic: `${bigint}`;
  creatorAmountAtomic: `${bigint}`;
  rubiconFeeAtomic: `${bigint}`;
  paymentId?: string;
  authorizationReference?: string;
  buyerWalletAddress?: `0x${string}`;
  network?: string;
  payTo?: `0x${string}`;
  paymentStatus: BundlePaymentStatus;
  words: BundleWordInput[];
  createdAt: string;
  updatedAt: string;
}

interface RecordBundleBaseInput {
  bundleId: string;
  idempotencyKey: string;
  sessionId: string;
  creatorId: string;
  articleId: string;
  sectionId?: string;
  bundleSequence: number;
  startSequence: number;
  words: BundleWordInput[];
  pricePerWordAtomic: bigint;
}

export interface RecordPaidBundleInput extends RecordBundleBaseInput {
  accessMode: "paid";
  grossAmountAtomic: bigint;
  creatorAmountAtomic: bigint;
  rubiconFeeAtomic: bigint;
  paymentId: string;
  authorizationReference: string;
  buyerWalletAddress?: `0x${string}`;
  network?: string;
  payTo?: `0x${string}`;
  settlement?: SettlementEvidenceInput;
}

export interface RecordFreeBundleInput extends RecordBundleBaseInput {
  accessMode: "free";
  pricePerWordAtomic: 0n;
}

export interface RecordBundleResult {
  duplicate: boolean;
  bundle: RecordedBundle;
  wordsDelivered: number;
  wordsPaid: number;
  paidAtomic: `${bigint}`;
}

export interface SettlementEvidenceInput {
  provider: string;
  status: Exclude<BundlePaymentStatus, "free" | "authorized">;
  idempotencyKey: string;
  bundleIds: string[];
  network?: string;
  payTo?: `0x${string}`;
  buyerWalletAddress?: `0x${string}`;
  transactionHash?: string;
  transactionHashes?: string[];
  settlementId?: string;
  settlementIds?: string[];
  transferId?: string;
  initiatedAt?: string;
  confirmedAt?: string;
  failedAt?: string;
}

export interface RecordSettlementRangeInput extends Omit<SettlementEvidenceInput, "bundleIds"> {
  sessionId: string;
  startSequence: number;
  endSequence: number;
}

/**
 * Persistent ledger for runtime sessions, conversations, authoritative read
 * bundles, optional word audits, and evidence-based settlements. Bundle writes
 * are idempotent and constraint-protected so a range is never delivered or
 * charged twice.
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
  getBundleByIdempotencyKey(key: string): Promise<RecordBundleResult | null>;
  /**
   * Commit one authorized paid bundle, its optional bulk word audit rows,
   * durable session counters, and one sanitized outbox event atomically.
   */
  recordPaidBundle(input: RecordPaidBundleInput): Promise<RecordBundleResult>;
  /** Same transaction boundary as paid bundles, with exact zero amounts. */
  recordFreeBundle(input: RecordFreeBundleInput): Promise<RecordBundleResult>;
  listDeliveries(sessionId: string): Promise<WordDeliveryRecord[]>;
  listPayments(sessionId: string): Promise<PaymentActivity[]>;
  earningsForArticle(articleId: string): Promise<EarningsSummary>;
  earningsForCreator(creatorId: string): Promise<EarningsSummary>;

  /** Persist provider evidence and link it to every covered bundle atomically. */
  recordSettlementRange?(input: RecordSettlementRangeInput): Promise<void>;
}
