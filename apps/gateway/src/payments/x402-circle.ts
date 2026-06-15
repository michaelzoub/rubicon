import { BatchFacilitatorClient, GatewayEvmScheme } from "@circle-fin/x402-batching/server";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequired, PaymentRequirements, SchemeNetworkServer } from "@x402/core/types";
import type { PaymentHeartbeatRequest, PaymentVerification, SessionRecord } from "@rubicon/core";
import type { PaymentVerifier, ProviderConfig } from "../server.js";

export interface CircleX402PaymentVerifierOptions {
  sellerAddress: `0x${string}`;
  facilitatorUrl?: string;
  networks?: string[];
  maxTimeoutSeconds?: number;
}

export class CircleX402PaymentVerifier implements PaymentVerifier {
  private readonly resourceServer: x402ResourceServer;
  private readonly ready: Promise<void>;
  private readonly networks: Network[];
  private readonly maxTimeoutSeconds: number;

  constructor(private readonly options: CircleX402PaymentVerifierOptions) {
    const facilitator = new BatchFacilitatorClient(
      options.facilitatorUrl ? { url: options.facilitatorUrl } : undefined,
    );
    this.resourceServer = new x402ResourceServer([facilitator as unknown as FacilitatorClient]);
    this.resourceServer.register("eip155:*", new GatewayEvmScheme() as unknown as SchemeNetworkServer);
    this.ready = this.resourceServer.initialize();
    this.networks = (options.networks?.length ? options.networks : ["eip155:*"]) as Network[];
    this.maxTimeoutSeconds = options.maxTimeoutSeconds ?? 60;
  }

  async createPaymentRequired(input: {
    session: SessionRecord;
    provider: ProviderConfig;
    amountAtomic: `${bigint}`;
    gatewayBaseUrl: string;
  }): Promise<PaymentRequired> {
    await this.ready;
    const requirements = await this.requirements(input);
    return this.resourceServer.createPaymentRequiredResponse(requirements, {
      url: `${input.gatewayBaseUrl}/v1/sessions/${input.session.id}/heartbeats`,
      description: `Streaming heartbeat for session ${input.session.id}`,
      serviceName: input.provider.id,
      mimeType: "application/json",
    });
  }

  async verify(session: SessionRecord, heartbeat: PaymentHeartbeatRequest): Promise<PaymentVerification> {
    await this.ready;
    const paymentPayload = heartbeat.paymentPayload as PaymentPayload | undefined;
    if (!paymentPayload) {
      return { accepted: false, reason: "missing_x402_payment_payload" };
    }

    const requirements = this.resourceServer.findMatchingRequirements(
      await this.requirementsForSession(session),
      paymentPayload,
    );
    if (!requirements) {
      return { accepted: false, reason: "payment_does_not_match_session_terms" };
    }

    const verification = await this.resourceServer.verifyPayment(paymentPayload, requirements);
    if (!verification.isValid) {
      return {
        accepted: false,
        reason: verification.invalidReason ?? verification.invalidMessage ?? "payment_invalid",
      };
    }

    const settlement = await this.resourceServer.settlePayment(paymentPayload, requirements);
    if (!settlement.success) {
      return {
        accepted: false,
        reason: settlement.errorReason ?? settlement.errorMessage ?? "payment_settlement_failed",
      };
    }

    return {
      accepted: true,
      amountAtomic: (settlement.amount ?? requirements.amount) as `${bigint}`,
      transferId: settlement.transaction,
    };
  }

  private async requirements(input: {
    session: SessionRecord;
    provider: ProviderConfig;
    amountAtomic: `${bigint}`;
    gatewayBaseUrl: string;
  }): Promise<PaymentRequirements[]> {
    return this.resourceServer.buildPaymentRequirementsFromOptions(
      this.networks.map((network) => ({
        scheme: "exact",
        network,
        payTo: this.options.sellerAddress,
        price: { amount: input.amountAtomic, asset: "USDC" },
        maxTimeoutSeconds: this.maxTimeoutSeconds,
        extra: {
          sessionId: input.session.id,
          providerId: input.provider.id,
          meteringUnit: input.provider.meteringUnit,
        },
      })),
      { sessionId: input.session.id, url: `${input.gatewayBaseUrl}/v1/sessions/${input.session.id}/heartbeats` },
    );
  }

  private async requirementsForSession(session: SessionRecord): Promise<PaymentRequirements[]> {
    const amountAtomic = session.metadata.heartbeatChargeAtomic;
    const providerSnapshot = session.metadata.providerSnapshot;
    const gatewayBaseUrl = session.metadata.gatewayBaseUrl;
    if (typeof amountAtomic !== "string" || typeof gatewayBaseUrl !== "string" || !isProviderSnapshot(providerSnapshot)) {
      throw new Error("session_missing_x402_pricing_metadata");
    }

    return this.requirements({
      session,
      amountAtomic: amountAtomic as `${bigint}`,
      gatewayBaseUrl,
      provider: {
        id: providerSnapshot.id,
        baseUrl: providerSnapshot.baseUrl,
        sharedSecret: providerSnapshot.sharedSecret,
        unitPriceAtomic: BigInt(providerSnapshot.unitPriceAtomic),
        unitsPerInterval: providerSnapshot.unitsPerInterval,
        meteringUnit: providerSnapshot.meteringUnit,
      },
    });
  }
}

function isProviderSnapshot(value: unknown): value is {
  id: string;
  baseUrl: string;
  sharedSecret: string;
  unitPriceAtomic: string;
  unitsPerInterval: number;
  meteringUnit: ProviderConfig["meteringUnit"];
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.baseUrl === "string" &&
    typeof record.sharedSecret === "string" &&
    typeof record.unitPriceAtomic === "string" &&
    typeof record.unitsPerInterval === "number" &&
    typeof record.meteringUnit === "string"
  );
}
