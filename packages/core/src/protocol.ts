import type { AtomicAmount } from "./money.js";
import type { PriceQuote, UsageReport } from "./pricing.js";
import type { SessionState } from "./session.js";

export interface Budget {
  currency: "USDC";
  maxAmountAtomic: AtomicAmount;
}

export interface StartSessionRequest {
  articleId?: string;
  query?: string;
  sectionId?: string;
  budget: Budget;
  metadata?: Record<string, unknown>;
}

export interface StartSessionResponse {
  sessionId: string;
  state: SessionState;
  article: ArticleSummary;
  navigation: ArticleNavigation;
  quote: PriceQuote;
  paymentRequired?: unknown;
  paymentChunkWords: number;
  expiresAt: string;
}

export interface ArticleSummary {
  articleId: string;
  authorUsername: string;
  title: string;
  totalWords: number;
  maxPriceAtomic: AtomicAmount;
  headers: ArticleHeader[];
}

export interface ArticleHeader {
  sectionId: string;
  heading: string;
  level: number;
  wordStart: number;
  wordCount: number;
}

export interface ArticleNavigation {
  headers: ArticleHeader[];
  neutralSeller: {
    role: "neutral_article_navigator";
    guidance: string;
    reveals: string[];
    withholds: string[];
  };
  stopConditions: StreamStopCondition[];
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

export interface StreamPaymentRequest {
  paymentPayload: unknown;
}

export interface PaymentVerification {
  accepted: boolean;
  transferId?: string;
  amountAtomic?: AtomicAmount;
  reason?: string;
}

export type GatewayEvent =
  | { type: "session.started"; sessionId: string; state: SessionState; article: ArticleSummary; quote: PriceQuote }
  | {
      type: "session.payment_accepted";
      sessionId: string;
      paidAtomic: AtomicAmount;
      wordsUnlocked: number;
      transferId?: string;
    }
  | { type: "article.chunk"; sessionId: string; articleId: string; index: number; text: string; words: number }
  | { type: "article.usage"; sessionId: string; usage: UsageReport; wordsStreamed: number }
  | { type: "article.completed"; sessionId: string; articleId: string; totalWordsStreamed: number }
  | { type: "article.error"; sessionId: string; message: string }
  | { type: "session.aborted"; sessionId: string; reason: string }
  | { type: "session.closed"; sessionId: string; reason: string };
