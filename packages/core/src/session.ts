import { randomUUID } from "node:crypto";

import type { AtomicAmount } from "./money.js";
import type { Budget } from "./protocol.js";

export type SessionState = "open" | "active" | "completed" | "aborted" | "expired";

/**
 * Runtime state for one budgeted reading session. All trusted values
 * (pricePerWordAtomic, gatewayFeeBps, sellerWallet, creatorId) are loaded from
 * persistent storage when the session is created — never from buyer input.
 */
export interface SessionRecord {
  id: string;
  articleId: string;
  creatorId: string;
  conversationId?: string;
  goal?: string;
  sectionId?: string;
  budget: Budget;
  /** Trusted price snapshot, copied from the stored article at session start. */
  pricePerWordAtomic: bigint;
  gatewayFeeBps: number;
  /** Trusted settlement recipient, copied from the verified creator wallet. */
  sellerWallet: `0x${string}`;
  metadata: Record<string, unknown>;
  state: SessionState;
  /** Words the buyer has paid for (one payment === one word). */
  wordsPaid: number;
  /** Words actually delivered to the buyer. */
  wordsDelivered: number;
  /** Total atomic USDC the buyer has paid in this session. */
  paidAtomic: bigint;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export function createSession(input: {
  id?: string;
  articleId: string;
  creatorId: string;
  conversationId?: string;
  goal?: string;
  sectionId?: string;
  budget: Budget;
  pricePerWordAtomic: bigint;
  gatewayFeeBps: number;
  sellerWallet: `0x${string}`;
  metadata?: Record<string, unknown>;
  ttlMs: number;
}): SessionRecord {
  const now = new Date();
  return {
    id: input.id ?? randomUUID(),
    articleId: input.articleId,
    creatorId: input.creatorId,
    conversationId: input.conversationId,
    goal: input.goal,
    sectionId: input.sectionId,
    budget: input.budget,
    pricePerWordAtomic: input.pricePerWordAtomic,
    gatewayFeeBps: input.gatewayFeeBps,
    sellerWallet: input.sellerWallet,
    metadata: input.metadata ?? {},
    state: "open",
    wordsPaid: 0,
    wordsDelivered: 0,
    paidAtomic: 0n,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + input.ttlMs),
  };
}

/** Whether one more word payment fits inside the session budget. */
export function canAffordNextWord(session: SessionRecord, wordPaymentAtomic: bigint): boolean {
  return session.paidAtomic + wordPaymentAtomic <= BigInt(session.budget.maxAmountAtomic);
}

/** Record that one word's payment has been accepted. */
export function recordWordPayment(session: SessionRecord, amountAtomic: AtomicAmount): SessionRecord {
  session.paidAtomic += BigInt(amountAtomic);
  session.wordsPaid += 1;
  session.updatedAt = new Date();
  if (session.state === "open") {
    session.state = "active";
  }
  return session;
}

/** Record that one paid word has been delivered. */
export function recordWordDelivery(session: SessionRecord): SessionRecord {
  session.wordsDelivered += 1;
  session.updatedAt = new Date();
  return session;
}

export function isSessionExpired(session: SessionRecord, now = new Date()): boolean {
  return session.expiresAt.getTime() <= now.getTime();
}
