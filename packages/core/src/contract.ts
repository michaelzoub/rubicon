import type { AtomicAmount } from "./money.js";

/**
 * Shared API contract between Rubicon (this gateway) and the rubicon-marketing
 * Next.js application. Both repositories agree on these shapes, the article
 * states, pricing units (atomic USDC, 1 USDC = 1_000_000), word-counting rules,
 * wallet format, creator ownership, and seller-agent configuration.
 *
 * These types describe the shared persistent data model. The marketing app owns
 * creator authentication and creator-facing CRUD; Rubicon reads published data
 * and writes runtime read/earnings activity.
 */

/**
 * Lifecycle of an article. Only `live` articles are consumable by buyer agents
 * or visible in the public repository.
 */
export type ArticleState = "draft" | "live" | "paused" | "archived" | "deleted";

export const PUBLIC_ARTICLE_STATE: ArticleState = "live";

export type WalletNetwork = string; // CAIP-2 string, e.g. "eip155:5042002"

export interface Creator {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
}

export interface CreatorProfile {
  creatorId: string;
  bio?: string;
  avatarUrl?: string;
}

export interface CreatorWallet {
  creatorId: string;
  /** Verified receiving wallet. Settlement always pays this address. */
  address: `0x${string}`;
  network: WalletNetwork;
  verified: boolean;
}

export interface ArticleSection {
  id: string;
  articleId: string;
  /** Stable slug used by buyer agents for navigation. */
  sectionId: string;
  heading: string;
  level: number;
  /** Zero-based word index where this section's body begins. */
  wordStart: number;
  wordCount: number;
  ordinal: number;
}

/**
 * Optional per-article seller-agent configuration. Agreed between Rubicon and
 * rubicon-marketing; absent values fall back to gateway defaults.
 */
export interface SellerAgentConfig {
  persona?: string;
  /** Identifier of a configured model/provider, e.g. "anthropic:claude-opus-4-8". */
  model?: string;
  /** Extra navigation guidance the creator wants the seller agent to follow. */
  guidance?: string;
}

export interface Article {
  id: string;
  creatorId: string;
  title: string;
  author: string;
  state: ArticleState;
  pricePerWordAtomic: AtomicAmount;
  /** Optional creator-set cap on the total price of the article. */
  maxArticlePriceAtomic?: AtomicAmount;
  totalWords: number;
  revision: number;
  sellerAgentConfig?: SellerAgentConfig;
  createdAt: string;
  updatedAt: string;
}

export interface EarningsSummary {
  creatorId: string;
  articleId?: string;
  wordsDelivered: number;
  creatorAmountAtomic: AtomicAmount;
  rubiconFeeAtomic: AtomicAmount;
}

export interface PaymentActivity {
  paymentId: string;
  sessionId: string;
  articleId: string;
  sequence: number;
  amountAtomic: AtomicAmount;
  creatorAmountAtomic: AtomicAmount;
  rubiconFeeAtomic: AtomicAmount;
  network?: string;
  payTo?: `0x${string}`;
  transactionHash?: string;
  transactionHashes?: string[];
  settlementId?: string;
  settlementIds?: string[];
  buyerWalletAddress?: `0x${string}`;
  transferId?: string;
  createdAt: string;
}

export interface SellerAgentMessageRecord {
  id: string;
  conversationId: string;
  sessionId?: string;
  articleId: string;
  role: "buyer" | "seller";
  content: string;
  createdAt: string;
}

export interface StreamSessionRecord {
  id: string;
  articleId: string;
  creatorId: string;
  conversationId?: string;
  state: string;
  wordsPaid: number;
  wordsDelivered: number;
  paidAtomic: AtomicAmount;
  budgetAtomic: AtomicAmount;
  createdAt: string;
  expiresAt: string;
}

export interface WordDeliveryRecord {
  sessionId: string;
  articleId: string;
  sequence: number;
  word: string;
  priceAtomic: AtomicAmount;
  paymentId: string;
  createdAt: string;
}

export interface ApiError {
  error: string;
  message?: string;
  details?: Record<string, unknown>;
}
