import type { AtomicAmount } from "./money.js";
import type { ArticleState } from "./contract.js";
import type { WordUsageReport } from "./pricing.js";
import type { SessionState } from "./session.js";

export interface Budget {
  currency: "USDC";
  maxAmountAtomic: AtomicAmount;
}

/** Safe public article metadata. Never includes unpaid body text. */
export interface ArticleSummary {
  articleId: string;
  creatorId: string;
  creatorUsername: string;
  title: string;
  author: string;
  state: ArticleState;
  totalWords: number;
  pricePerWordAtomic: AtomicAmount;
  /** Maximum possible total price to read the whole article. */
  maxArticlePriceAtomic: AtomicAmount;
  sections: ArticleSectionSummary[];
}

/** Safe per-section navigation metadata. Headings only, no body content. */
export interface ArticleSectionSummary {
  sectionId: string;
  heading: string;
  level: number;
  wordStart: number;
  wordCount: number;
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
  rationale: string;
  safeHints: string[];
  withheld: string[];
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
  sectionId?: string;
  budget: Budget;
  metadata?: Record<string, unknown>;
}

export interface StartSessionResponse {
  sessionId: string;
  state: SessionState;
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
  /** x402 payment requirement for one word (when Circle/x402 is enabled). */
  paymentRequired?: unknown;
  expiresAt: string;
  wordsPaid: number;
  wordsDelivered: number;
  paidAtomic: AtomicAmount;
}

/**
 * One word-level payment. `idempotencyKey` ties a payment to a specific next
 * word sequence so retries never release or charge for a word twice.
 */
export interface StreamPaymentRequest {
  paymentPayload: unknown;
  idempotencyKey?: string;
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
  /** On-chain settlement transaction hash returned by the payment facilitator. */
  transactionHash?: string;
  /** All on-chain settlement transaction hashes for this payment, when available. */
  transactionHashes?: string[];
  /** Backwards-compatible alias for transactionHash. */
  transferId?: string;
}

export interface PaymentVerification {
  accepted: boolean;
  transactionHash?: string;
  transactionHashes?: string[];
  transferId?: string;
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
      type: "word.payment_accepted";
      sessionId: string;
      sequence: number;
      paymentId: string;
      amountAtomic: AtomicAmount;
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
