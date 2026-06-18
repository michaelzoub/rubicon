import type { StartSessionResponse, StreamAuthorizationRequest, StreamPaymentRequest } from "@rubicon-caliga/core";

/**
 * Produces Circle / Arc authorization payloads for Rubicon reads. Preferred
 * engines authorize a whole session once; fallback engines authorize chunks.
 * Legacy one-word payloads remain supported for older gateways and tests.
 */
export interface AgentPaymentEngine {
  createSessionAuthorization?(session: StartSessionResponse): Promise<StreamAuthorizationRequest>;
  createChunkPayment?(session: StartSessionResponse, input: { nextSequence: number; maxWords: number }): Promise<StreamPaymentRequest>;
  /** @deprecated Compatibility path for one-word x402 gateways. */
  createWordPayment(session: StartSessionResponse): Promise<StreamPaymentRequest>;
}

/**
 * Development engine. Declares the authorized amount without settling real
 * funds, for use against a dev-mode gateway. NOT for production.
 */
export class StaticPaymentEngine implements AgentPaymentEngine {
  constructor(private readonly network = "eip155:5042002") {}

  async createSessionAuthorization(session: StartSessionResponse): Promise<StreamAuthorizationRequest> {
    return {
      authorizationPayload: {
        scheme: "development-static",
        network: this.network,
        sessionId: session.sessionId,
        amountAtomic: session.authorizationRequired?.maxAuthorizedAtomic ?? session.maxArticlePriceAtomic,
        meteringUnit: "word",
        authorizationMode: "session",
      },
    };
  }

  async createChunkPayment(session: StartSessionResponse, input: { nextSequence: number; maxWords: number }): Promise<StreamPaymentRequest> {
    const amountAtomic = BigInt(session.wordPaymentAtomic) * BigInt(input.maxWords);
    return {
      paymentPayload: {
        scheme: "development-static",
        network: this.network,
        sessionId: session.sessionId,
        amountAtomic: `${amountAtomic}`,
        meteringUnit: "word",
        authorizationMode: "chunk",
        maxWords: input.maxWords,
        nextSequence: input.nextSequence,
      },
      maxWords: input.maxWords,
    };
  }

  async createWordPayment(session: StartSessionResponse): Promise<StreamPaymentRequest> {
    return {
      paymentPayload: {
        scheme: "development-static",
        network: this.network,
        sessionId: session.sessionId,
        amountAtomic: session.wordPaymentAtomic,
        meteringUnit: "word",
      },
    };
  }
}
