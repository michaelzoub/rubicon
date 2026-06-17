import type { StartSessionResponse, StreamPaymentRequest } from "@rubicon-caliga/core";
import { x402Client } from "@x402/core/client";
import { registerBatchScheme, type GatewayClientConfig } from "@circle-fin/x402-batching/client";
import { privateKeyToAccount } from "viem/accounts";

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

export type CircleGatewayPaymentEngineOptions = GatewayClientConfig;

/**
 * Circle/x402 engine. Signs the gateway's one-word `paymentRequired` terms.
 * Circle may batch settlement internally, but each signed payload corresponds to
 * exactly one word.
 */
export class CircleGatewayPaymentEngine implements AgentPaymentEngine {
  private readonly client = new x402Client();
  private readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor(private readonly options: CircleGatewayPaymentEngineOptions) {
    this.account = privateKeyToAccount(this.options.privateKey);
    registerBatchScheme(this.client, { signer: this.account });
  }

  async createWordPayment(session: StartSessionResponse): Promise<StreamPaymentRequest> {
    if (!session.paymentRequired) {
      throw new Error("Session did not include an x402 one-word payment requirement");
    }
    return {
      paymentPayload: await this.client.createPaymentPayload(session.paymentRequired as never),
    };
  }
}
