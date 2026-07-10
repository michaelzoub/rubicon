import type { AtomicAmount } from "./money.js";
import type { ArticleAccessMode, ArticleState } from "./contract.js";
import type { WordUsageReport } from "./pricing.js";
import type { SessionState } from "./session.js";

export interface Budget {
  currency: "USDC";
  maxAmountAtomic: AtomicAmount;
}

export type AuthorizationMode = "session" | "chunk" | "word";
export type StreamMode = "bundled" | "word";

/** Safe public article metadata. Never includes unpaid body text. */
export interface ArticleSummary {
  articleId: string;
  creatorId: string;
  creatorUsername: string;
  title: string;
  author: string;
  state: ArticleState;
  /** Explicit access policy. Absent only on responses from pre-free-support gateways; treat as paid. */
  accessMode?: ArticleAccessMode;
  totalWords: number;
  pricePerWordAtomic: AtomicAmount;
  /** Maximum possible total price to read the whole article. */
  maxArticlePriceAtomic: AtomicAmount;
  /** Public seller settlement terms for paid reads. Present when a verified wallet exists. */
  paymentTerms?: SellerPaymentTerms;
  /** Canonical public references for this article's safe metadata. */
  sources?: ArticleSource[];
  sections: ArticleSectionSummary[];
}

export interface ArticleSource {
  title: string;
  url: string;
  type: "article_navigation";
}

export interface SellerPaymentTerms {
  asset: "USDC";
  network: string;
  networkLabel?: string;
  circleChain?: string;
  environment?: "testnet" | "mainnet" | "unknown";
  fundingMethod?: string;
  payTo: `0x${string}`;
  pricePerWordAtomic: AtomicAmount;
  meteringUnit: "word";
}

/** Safe per-section navigation metadata. Headings only, no body content. */
export interface ArticleSectionSummary {
  sectionId: string;
  heading: string;
  level: number;
  wordStart: number;
  wordCount: number;
}

/** One section in a ranked search response. Safe metadata + score only. */
export interface SectionMatch {
  sectionId: string;
  heading: string;
  /** Normalized 0..1 confidence that this section answers the query. */
  score: number;
}

/** One article in a ranked search response. Safe metadata + scores only. */
export interface SearchResultSummary {
  article: ArticleSummary;
  /** Normalized 0..1 confidence that this article answers the query. */
  score: number;
  matchedSections: SectionMatch[];
}

export interface SearchResponse {
  query: string;
  /** Whether embeddings were used ("semantic") or the lexical fallback ("lexical"). */
  mode: "semantic" | "lexical";
  results: SearchResultSummary[];
}

export interface ArticleNavigation {
  articleId: string;
  sections: ArticleSectionSummary[];
  /** Free, safe routing produced by the seller agent (no unpaid body text). */
  sellerAgent: SellerNavigationSummary;
  stopConditions: StreamStopCondition[];
}

export interface SellerNavigationSummary {
  recommendedSectionId: string;
  alternativeSectionIds: string[];
  /** Seller estimate derived from safe metadata, never unpaid article text. */
  sectionAssessments?: SellerSectionAssessment[];
  rationale: string;
  safeHints: string[];
  withheld: string[];
}

export interface SellerSectionAssessment {
  sectionId: string;
  /** Relative likelihood (0..1) that this section answers the buyer's exact goal. */
  expectedValue: number;
  /** Smallest prefix the seller expects to be useful. */
  minimumUsefulWords: number;
  rationale: string;
}

export interface StreamStopCondition {
  kind:
    | "max_words"
    | "max_payments"
    | "max_spend_atomic"
    | "sufficient_information"
    | "article_completed"
    | "payment_rejected";
  description: string;
  value?: string | number;
}

// ---------------------------------------------------------------------------
// Seller-agent conversations
// ---------------------------------------------------------------------------

export interface StartConversationRequest {
  articleId: string;
  goal?: string;
  message?: string;
}

export interface StartConversationResponse {
  conversationId: string;
  articleId: string;
  article: ArticleSummary;
  navigation: ArticleNavigation;
  messages: ConversationMessage[];
}

export interface SendConversationMessageRequest {
  message: string;
}

export interface SendConversationMessageResponse {
  conversationId: string;
  messages: ConversationMessage[];
  recommendedSectionId?: string;
}

export interface ConversationMessage {
  id: string;
  role: "buyer" | "seller";
  content: string;
  recommendedSectionId?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface StartSessionRequest {
  articleId: string;
  goal?: string;
  conversationId?: string;
  /** Single-section selection (legacy). Prefer `sectionIds`/`wordStart`+`wordCount`. */
  sectionId?: string;
  /**
   * Explicit purchase selection. Precedence when more than one is present:
   * `wordStart`+`wordCount` (word range) > `sectionIds` > `sectionId` > whole article.
   */
  sectionIds?: string[];
  /** Zero-based, article-global word offset for a word-range selection. */
  wordStart?: number;
  /** Number of words for a word-range selection (`[wordStart, wordStart+wordCount)`). */
  wordCount?: number;
  budget: Budget;
  /** Optional buyer estimate used to size a session or chunk authorization. */
  predictedWords?: number;
  metadata?: Record<string, unknown>;
}

export interface SessionAuthorizationRequired {
  sessionId: string;
  authorizationMode: AuthorizationMode;
  meteringUnit: "word";
  asset: "USDC";
  network?: string;
  payTo?: `0x${string}`;
  pricePerWordAtomic: AtomicAmount;
  /** Maximum USDC the buyer is willing to authorize for this session/chunk. */
  maxAuthorizedAtomic: AtomicAmount;
  /** Number of words covered by the current authorization cap. */
  maxAuthorizedWords: number;
  settlement: "actual_usage_on_close" | "actual_usage_per_chunk" | "per_word_compatibility";
  resource: string;
  expiresAt: string;
}

export interface StartSessionResponse {
  sessionId: string;
  state: SessionState;
  /** Explicit access policy. Absent only on responses from pre-free-support gateways; treat as paid. */
  accessMode?: ArticleAccessMode;
  article: ArticleSummary;
  navigation: ArticleNavigation;
  /** Price the creator earns for one word. */
  pricePerWordAtomic: AtomicAmount;
  /** Maximum possible total price for the whole article. */
  maxArticlePriceAtomic: AtomicAmount;
  conversationId: string;
  /** Exact amount the buyer pays to release one additional word. */
  wordPaymentAtomic: AtomicAmount;
  gatewayFeeBps: number;
  /** Circle / Arc payment requirement for a session or chunk authorization. */
  authorizationRequired?: SessionAuthorizationRequired;
  /** @deprecated Compatibility challenge for legacy one-word x402 clients. */
  paymentRequired?: unknown;
  expiresAt: string;
  authorizationMode?: AuthorizationMode;
  wordsAuthorized?: number;
  wordsPaid: number;
  wordsDelivered: number;
  paidAtomic: AtomicAmount;
}

/**
 * Authorization for a session stream. The gateway meters delivered words against
 * the authorized cap and settles actual usage when the session closes.
 */
export interface StreamAuthorizationRequest {
  authorizationPayload: unknown;
  idempotencyKey?: string;
  maxWords?: number;
}

/**
 * Chunk or legacy word-level payment. `idempotencyKey` ties the authorization to
 * a specific stream position so retries never release or charge words twice.
 */
export interface StreamPaymentRequest {
  paymentPayload: unknown;
  idempotencyKey?: string;
  /** Multi-word fallback cap. Omitted or 1 preserves legacy one-word behavior. */
  maxWords?: number;
}

export interface StreamPaymentResponse {
  accepted: boolean;
  sequence: number;
  word: string;
  priceAtomic: AtomicAmount;
  wordsPaid: number;
  wordsDelivered: number;
  paidAtomic: AtomicAmount;
  completed: boolean;
  /** Canonical settlement receipt for paid delivery. Absent for free content. */
  payment?: WordPaymentReceipt;
  authorizationMode?: AuthorizationMode;
  remainingAuthorizedAtomic?: AtomicAmount;
  /** On-chain settlement transaction hash, when the payment facilitator returns one. */
  transactionHash?: string;
  /** All on-chain settlement transaction hashes for this payment, when available. */
  transactionHashes?: string[];
  /** Gateway/facilitator settlement identifier, such as a Circle x402 transfer UUID. */
  settlementId?: string;
  settlementIds?: string[];
  buyerWalletAddress?: `0x${string}`;
  /** Gateway/facilitator transfer identifier, when distinct from an on-chain hash. */
  transferId?: string;
}

export interface StreamChunkResponse {
  accepted: boolean;
  words: Array<{
    sequence: number;
    word: string;
    priceAtomic: AtomicAmount;
    /** @deprecated Bundled reads now report one payment on the chunk response. */
    payment?: WordPaymentReceipt;
  }>;
  text: string;
  wordsPaid: number;
  wordsDelivered: number;
  paidAtomic: AtomicAmount;
  completed: boolean;
  authorizationMode?: AuthorizationMode;
  /** Canonical receipt for the bundled authorization that released these words. */
  payment?: WordPaymentReceipt;
  transactionHash?: string;
  transactionHashes?: string[];
  settlementId?: string;
  settlementIds?: string[];
  buyerWalletAddress?: `0x${string}`;
  transferId?: string;
}

export interface WordPaymentReceipt {
  paymentId: string;
  sessionId: string;
  articleId: string;
  sequence: number;
  meteringUnit: "word";
  amountAtomic: AtomicAmount;
  /** Present when one payment authorized more than one delivered word. */
  bundleSequence?: number;
  /** Present for bundle receipts; first delivered word sequence in the bundle. */
  startSequence?: number;
  /** Present for bundle receipts; last delivered word sequence in the bundle. */
  endSequence?: number;
  /** Number of words released by this payment. Defaults to 1 for legacy receipts. */
  wordsDelivered?: number;
  /** Creator price for each delivered word before bundle multiplication. */
  pricePerWordAtomic?: AtomicAmount;
  /** Text released by this payment. */
  text?: string;
  currency: "USDC";
  network?: string;
  payTo?: `0x${string}`;
  transactionHash?: string;
  transactionHashes?: string[];
  /** Gateway/facilitator settlement identifier, such as a Circle x402 transfer UUID. */
  settlementId?: string;
  settlementIds?: string[];
  buyerWalletAddress?: `0x${string}`;
  /** Gateway/facilitator transfer identifier, when distinct from an on-chain hash. */
  transferId?: string;
  settledAt: string;
}

export interface PaymentVerification {
  accepted: boolean;
  transactionHash?: string;
  transactionHashes?: string[];
  settlementId?: string;
  settlementIds?: string[];
  buyerWalletAddress?: `0x${string}`;
  transferId?: string;
  network?: string;
  payTo?: `0x${string}`;
  authorizationMode?: AuthorizationMode;
  maxAuthorizedAtomic?: AtomicAmount;
  maxAuthorizedWords?: number;
  amountAtomic?: AtomicAmount;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type GatewayEvent =
  | {
      type: "session.started";
      sessionId: string;
      articleId: string;
      state: SessionState;
      article: ArticleSummary;
      pricePerWordAtomic: AtomicAmount;
      wordPaymentAtomic: AtomicAmount;
    }
  | {
      type: "seller.message";
      sessionId: string;
      conversationId: string;
      role: "seller";
      message: string;
      recommendedSectionId?: string;
    }
  | {
      type: "authorization.accepted";
      sessionId: string;
      authorizationMode: AuthorizationMode;
      maxAuthorizedAtomic: AtomicAmount;
      maxAuthorizedWords: number;
      network?: string;
      payTo?: `0x${string}`;
    }
  | {
      type: "word.payment_accepted";
      sessionId: string;
      sequence: number;
      paymentId: string;
      amountAtomic: AtomicAmount;
      network?: string;
      payTo?: `0x${string}`;
      transactionHash?: string;
      transactionHashes?: string[];
      transferId?: string;
    }
  | {
      type: "article.word";
      sessionId: string;
      articleId: string;
      sequence: number;
      word: string;
      priceAtomic: AtomicAmount;
      totalWordsStreamed: number;
      totalPaidAtomic: AtomicAmount;
    }
  | {
      type: "article.bundle";
      sessionId: string;
      articleId: string;
      bundleSequence: number;
      startSequence: number;
      endSequence: number;
      words: Array<{ sequence: number; word: string; priceAtomic: AtomicAmount }>;
      text: string;
      wordCount: number;
      pricePerWordAtomic: AtomicAmount;
      amountAtomic: AtomicAmount;
      paymentId?: string;
      totalWordsStreamed: number;
      totalPaidAtomic: AtomicAmount;
    }
  | {
      type: "article.usage";
      sessionId: string;
      usage: WordUsageReport;
      wordsPaid: number;
      wordsDelivered: number;
      paidAtomic: AtomicAmount;
    }
  | {
      type: "article.completed";
      sessionId: string;
      articleId: string;
      totalWordsStreamed: number;
      totalPaidAtomic: AtomicAmount;
    }
  | { type: "article.error"; sessionId: string; message: string }
  | { type: "session.aborted"; sessionId: string; reason: string }
  | { type: "session.closed"; sessionId: string; reason: string };
