import type { StartSessionResponse, StreamPaymentRequest } from "@rubicon-caliga/core";

/**
 * Produces the payment payload for exactly one word. Called once per word by the
 * SDK's read loop — application developers never assemble payments themselves.
 */
export interface AgentPaymentEngine {
  createWordPayment(session: StartSessionResponse): Promise<StreamPaymentRequest>;
}

/**
 * Development engine. Declares the one-word amount without settling real funds,
 * for use against a dev-mode gateway. NOT for production.
 */
export class StaticPaymentEngine implements AgentPaymentEngine {
  constructor(private readonly network = "eip155:5042002") {}

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
