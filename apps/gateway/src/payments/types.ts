import type { PaymentVerification, SessionRecord, StreamPaymentRequest } from "@rubicon-caliga/core";
import type { ArticleRecord } from "../repositories/types.js";

export interface PaymentVerifyInput {
  session: SessionRecord;
  /** Exact amount required to release exactly one additional word. */
  wordPaymentAtomic: bigint;
  payment: StreamPaymentRequest;
}

export interface PaymentRequiredInput {
  session: SessionRecord;
  article: ArticleRecord;
  /** Trusted settlement recipient loaded from the verified creator wallet. */
  sellerWallet: `0x${string}`;
  wordPaymentAtomic: bigint;
  gatewayBaseUrl: string;
}

/**
 * Verifies a single one-word payment and, optionally, produces the x402 payment
 * requirement for one word. The transport may batch settlement internally, but
 * the application contract is always exactly one word per payment.
 */
export interface PaymentVerifier {
  verify(input: PaymentVerifyInput): Promise<PaymentVerification>;
  createPaymentRequired?(input: PaymentRequiredInput): Promise<unknown>;
}

/**
 * Development verifier. Accepts the declared one-word amount without settling
 * real funds so the repo runs locally with no payment provider. NOT for
 * production — it performs no on-chain verification.
 */
export class DevelopmentPaymentVerifier implements PaymentVerifier {
  async verify(input: PaymentVerifyInput): Promise<PaymentVerification> {
    const payload = input.payment.paymentPayload as { amountAtomic?: string; reject?: boolean } | undefined;
    if (payload?.reject) {
      return { accepted: false, reason: "payment_rejected" };
    }
    const amountAtomic = (payload?.amountAtomic ?? `${input.wordPaymentAtomic}`) as `${bigint}`;
    return {
      accepted: true,
      amountAtomic,
      network: "development",
      payTo: input.session.sellerWallet,
      transferId: `dev_${input.session.id}_${input.session.wordsDelivered}`,
    };
  }

  async createPaymentRequired(input: PaymentRequiredInput): Promise<unknown> {
    return {
      x402Version: 2,
      resource: { url: `${input.gatewayBaseUrl}/v1/sessions/${input.session.id}/payments` },
      accepts: [
        {
          scheme: "development-static",
          network: "development",
          amount: `${input.wordPaymentAtomic}`,
          asset: "USDC",
          payTo: input.sellerWallet,
          maxTimeoutSeconds: 60,
          extra: { meteringUnit: "word" },
        },
      ],
    };
  }
}
