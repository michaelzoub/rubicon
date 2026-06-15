import type { AtomicAmount } from "./money.js";
import type { PriceQuote, UsageReport } from "./pricing.js";
import type { SessionState } from "./session.js";

export interface Budget {
  currency: "USDC";
  maxAmountAtomic: AtomicAmount;
}

export interface StartSessionRequest {
  providerId: string;
  input: unknown;
  budget: Budget;
  metadata?: Record<string, unknown>;
}

export interface StartSessionResponse {
  sessionId: string;
  state: SessionState;
  quote: PriceQuote;
  paymentRequired?: unknown;
  heartbeatIntervalMs: number;
  expiresAt: string;
}

export interface PaymentHeartbeatRequest {
  paymentPayload: unknown;
}

export interface PaymentVerification {
  accepted: boolean;
  transferId?: string;
  amountAtomic?: AtomicAmount;
  reason?: string;
}

export type GatewayEvent =
  | { type: "session.started"; sessionId: string; state: SessionState; quote: PriceQuote }
  | { type: "session.heartbeat_accepted"; sessionId: string; paidAtomic: AtomicAmount; transferId?: string }
  | { type: "provider.output"; sessionId: string; chunk: unknown }
  | { type: "provider.usage"; sessionId: string; usage: UsageReport }
  | { type: "provider.completed"; sessionId: string; result: unknown }
  | { type: "provider.error"; sessionId: string; message: string }
  | { type: "session.aborted"; sessionId: string; reason: string }
  | { type: "session.closed"; sessionId: string; reason: string };

export interface ProviderJobRequest {
  sessionId: string;
  input: unknown;
  metadata?: Record<string, unknown>;
}
