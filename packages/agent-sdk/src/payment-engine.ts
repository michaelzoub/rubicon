import type { PaymentHeartbeatRequest, StartSessionResponse } from "@rubicon-caliga/core";
import { x402Client } from "@x402/core/client";
import { registerBatchScheme, type GatewayClientConfig } from "@circle-fin/x402-batching/client";
import { privateKeyToAccount } from "viem/accounts";

export interface AgentPaymentEngine {
  createHeartbeat(session: StartSessionResponse): Promise<PaymentHeartbeatRequest>;
}

export class StaticPaymentEngine implements AgentPaymentEngine {
  constructor(private readonly network = "eip155:5042002") {}

  async createHeartbeat(session: StartSessionResponse): Promise<PaymentHeartbeatRequest> {
    return {
      paymentPayload: {
        scheme: "development-static",
        network: this.network,
        sessionId: session.sessionId,
        amountAtomic: session.quote.chargePerIntervalAtomic,
      },
    };
  }
}

export type CircleGatewayPaymentEngineOptions = GatewayClientConfig;

export class CircleGatewayPaymentEngine implements AgentPaymentEngine {
  private readonly client = new x402Client();

  constructor(private readonly options: CircleGatewayPaymentEngineOptions) {}

  async createHeartbeat(session: StartSessionResponse): Promise<PaymentHeartbeatRequest> {
    if (!session.paymentRequired) {
      throw new Error("Session did not include x402 payment requirements");
    }
    const account = privateKeyToAccount(this.options.privateKey);
    registerBatchScheme(this.client, { signer: account });

    return {
      paymentPayload: await this.client.createPaymentPayload(session.paymentRequired as never),
    };
  }
}
