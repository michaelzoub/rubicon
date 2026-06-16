import type { AtomicAmount } from "./money.js";
import type { Budget } from "./protocol.js";

export type SessionState = "quoted" | "active" | "closing" | "completed" | "aborted" | "expired";

export interface SessionRecord {
  id: string;
  articleId: string;
  query?: string;
  sectionId?: string;
  budget: Budget;
  metadata: Record<string, unknown>;
  state: SessionState;
  paidAtomic: bigint;
  spentAtomic: bigint;
  wordsStreamed: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export function createSession(input: {
  articleId: string;
  query?: string;
  sectionId?: string;
  budget: Budget;
  metadata?: Record<string, unknown>;
  ttlMs: number;
}): SessionRecord {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    articleId: input.articleId,
    query: input.query,
    sectionId: input.sectionId,
    budget: input.budget,
    metadata: input.metadata ?? {},
    state: "quoted",
    paidAtomic: 0n,
    spentAtomic: 0n,
    wordsStreamed: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + input.ttlMs),
  };
}

export function canPay(session: SessionRecord, nextPaymentAtomic: bigint): boolean {
  return session.paidAtomic + nextPaymentAtomic <= BigInt(session.budget.maxAmountAtomic);
}

export function recordPayment(session: SessionRecord, amountAtomic: AtomicAmount): SessionRecord {
  session.paidAtomic += BigInt(amountAtomic);
  session.updatedAt = new Date();
  if (session.state === "quoted") {
    session.state = "active";
  }
  return session;
}
