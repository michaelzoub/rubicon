import type { StartSessionResponse, StreamPaymentRequest } from "@rubicon-caliga/core";
import { x402Client } from "@x402/core/client";
import { registerBatchScheme, type GatewayClientConfig } from "@circle-fin/x402-batching/client";
import { privateKeyToAccount } from "viem/accounts";

export interface AgentPaymentEngine {
  createPayment(session: StartSessionResponse): Promise<StreamPaymentRequest>;
}

export class StaticPaymentEngine implements AgentPaymentEngine {
  constructor(private readonly network = "eip155:5042002") {}

  async createPayment(session: StartSessionResponse): Promise<StreamPaymentRequest> {
    return {
      paymentPayload: {
        scheme: "development-static",
        network: this.network,
        sessionId: session.sessionId,
        amountAtomic: session.quote.chargePerChunkAtomic,
      },
    };
  }
}

export type CircleGatewayPaymentEngineOptions = GatewayClientConfig;

export class CircleGatewayPaymentEngine implements AgentPaymentEngine {
  private readonly client = new x402Client();
  private readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor(private readonly options: CircleGatewayPaymentEngineOptions) {
    this.account = privateKeyToAccount(this.options.privateKey);
    registerBatchScheme(this.client, { signer: this.account });
  }

  async createPayment(session: StartSessionResponse): Promise<StreamPaymentRequest> {
    if (!session.paymentRequired) {
      throw new Error("Session did not include x402 payment requirements");
    }

    return {
      paymentPayload: await this.client.createPaymentPayload(session.paymentRequired as never),
    };
  }
}
