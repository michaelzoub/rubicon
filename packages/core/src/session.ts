import type { AtomicAmount } from "./money.js";
import type { Budget } from "./protocol.js";

export type SessionState = "quoted" | "active" | "closing" | "completed" | "aborted" | "expired";

export interface SessionRecord {
  id: string;
  providerId: string;
  input: unknown;
  budget: Budget;
  metadata: Record<string, unknown>;
  state: SessionState;
  paidAtomic: bigint;
  spentAtomic: bigint;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export function createSession(input: {
  providerId: string;
  payload: unknown;
  budget: Budget;
  metadata?: Record<string, unknown>;
  ttlMs: number;
}): SessionRecord {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    providerId: input.providerId,
    input: input.payload,
    budget: input.budget,
    metadata: input.metadata ?? {},
    state: "quoted",
    paidAtomic: 0n,
    spentAtomic: 0n,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + input.ttlMs),
  };
}

export function canSpend(session: SessionRecord, nextChargeAtomic: bigint): boolean {
  return session.spentAtomic + nextChargeAtomic <= BigInt(session.budget.maxAmountAtomic);
}

export function recordPayment(session: SessionRecord, amountAtomic: AtomicAmount): SessionRecord {
  session.paidAtomic += BigInt(amountAtomic);
  session.updatedAt = new Date();
  if (session.state === "quoted") {
    session.state = "active";
  }
  return session;
}
