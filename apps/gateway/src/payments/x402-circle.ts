import { BatchFacilitatorClient, GatewayEvmScheme } from "@circle-fin/x402-batching/server";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequired, PaymentRequirements, SchemeNetworkServer } from "@x402/core/types";
import type { PaymentVerification, SessionRecord } from "@rubicon-caliga/core";
import type { PaymentRequiredInput, PaymentVerifier, PaymentVerifyInput } from "./types.js";
import { USDC_DECIMALS as ARC_USDC_DECIMALS } from "../chain.js";

export interface CircleX402PaymentVerifierOptions {
  facilitatorUrl?: string;
  networks?: string[];
  maxTimeoutSeconds?: number;
  arcPrivateMainnet?: boolean;
  gatewayBaseUrl?: string;
}

/**
 * Circle/x402 one-word payment verifier. Each accepted payment settles exactly
 * one word's price. Circle may batch settlement internally, but the Rubicon
 * contract remains one word per payment.
 */
export class CircleX402PaymentVerifier implements PaymentVerifier {
  private readonly resourceServer: x402ResourceServer;
  private readonly ready: Promise<void>;
  private readonly networks: Network[];
  private readonly maxTimeoutSeconds: number;

  constructor(private readonly options: CircleX402PaymentVerifierOptions) {
    const facilitator = new BatchFacilitatorClient(
      options.facilitatorUrl || options.arcPrivateMainnet
        ? { url: options.facilitatorUrl, arcPrivateMainnet: options.arcPrivateMainnet }
        : undefined,
    );
    this.resourceServer = new x402ResourceServer([facilitator as unknown as FacilitatorClient]);
    this.resourceServer.register("eip155:*", new GatewayEvmScheme() as unknown as SchemeNetworkServer);
    this.ready = this.resourceServer.initialize();
    this.networks = (options.networks?.length ? options.networks : ["eip155:*"]) as Network[];
    // Circle Gateway requires the buyer's EIP-3009 `validBefore` to be at least 7
    // days in the future (it derives this from `maxTimeoutSeconds`). A shorter
    // window — e.g. the 60s that suits a plain x402 facilitator — is rejected
    // outright by the Arc Testnet Gateway. Default to 7 days + a small buffer.
    this.maxTimeoutSeconds = options.maxTimeoutSeconds ?? 604_900;
  }

  async createPaymentRequired(input: PaymentRequiredInput): Promise<PaymentRequired> {
    await this.ready;
    const requirements = await this.requirements({
      session: input.session,
      sellerWallet: input.sellerWallet,
      wordPaymentAtomic: input.wordPaymentAtomic,
      gatewayBaseUrl: input.gatewayBaseUrl,
      articleId: input.article.id,
      author: input.article.author,
    });
    return this.resourceServer.createPaymentRequiredResponse(requirements, {
      url: `${input.gatewayBaseUrl}/v1/sessions/${input.session.id}/payments`,
      description: `Rubicon one-word payment for ${input.article.title}`,
      serviceName: "rubicon-article-stream",
      mimeType: "application/json",
    });
  }

  async verify(input: PaymentVerifyInput): Promise<PaymentVerification> {
    await this.ready;
    const paymentPayload = input.payment.paymentPayload as PaymentPayload | undefined;
    if (!paymentPayload) {
      return { accepted: false, reason: "missing_x402_payment_payload" };
    }

    const issuedRequirements = paymentRequirementsFromSession(input.session);
    if (!issuedRequirements.length) {
      return { accepted: false, reason: "missing_session_payment_requirements" };
    }

    const requirements = this.resourceServer.findMatchingRequirements(
      issuedRequirements,
      paymentPayload,
    );
    if (!requirements) {
      return { accepted: false, reason: "payment_does_not_match_session_terms" };
    }

    // Recommended seller flow (Circle x402 seller how-to): call settle() directly
    // rather than verify()+settle(). Gateway's settle() is optimized for low
    // latency and guarantees settlement, so a separate verify() is a redundant
    // round-trip on every word. findMatchingRequirements above already enforces
    // that the payment matches this session's seller, network, and amount.
    const settlement = await this.resourceServer.settlePayment(paymentPayload, requirements);
    if (!settlement.success) {
      logCircleSettlement("warn", {
        message: "circle_x402_settlement_failed",
        session: input.session,
        requirements,
        settlement,
      });
      return {
        accepted: false,
        reason: settlement.errorReason ?? settlement.errorMessage ?? "payment_settlement_failed",
      };
    }

    logCircleSettlement("info", {
      message: "circle_x402_settlement_succeeded",
      session: input.session,
      requirements,
      settlement,
    });

    return {
      accepted: true,
      amountAtomic: (settlement.amount ?? requirements.amount) as `${bigint}`,
      network: requirements.network,
      payTo: requirements.payTo as `0x${string}`,
      transactionHash: settlement.transaction,
      transactionHashes: [settlement.transaction],
      transferId: settlement.transaction,
    };
  }

  private async requirements(input: {
    session: SessionRecord;
    sellerWallet: `0x${string}`;
    wordPaymentAtomic: bigint;
    gatewayBaseUrl: string;
    articleId: string;
    author: string;
  }): Promise<PaymentRequirements[]> {
    return this.resourceServer.buildPaymentRequirementsFromOptions(
      this.networks.map((network) => ({
        scheme: "exact",
        network,
        payTo: input.sellerWallet,
        // Circle's GatewayEvmScheme registers a USDC money parser that turns a
        // dollar amount into the correct on-chain USDC asset. Price must be USDC
        // dollars (6 decimals). One word === one payment.
        price: usdcDollarsFromAtomic(`${input.wordPaymentAtomic}`),
        maxTimeoutSeconds: this.maxTimeoutSeconds,
        extra: {
          sessionId: input.session.id,
          articleId: input.articleId,
          author: input.author,
          meteringUnit: "word",
        },
      })),
      { sessionId: input.session.id, url: `${input.gatewayBaseUrl}/v1/sessions/${input.session.id}/payments` },
    );
  }
}

const USDC_DECIMALS = BigInt(ARC_USDC_DECIMALS);

// Convert an atomic USDC amount (e.g. "1") to a decimal dollar string
// (e.g. "0.000001") for the x402 money parser.
function usdcDollarsFromAtomic(amountAtomic: string): string {
  const atomic = BigInt(amountAtomic);
  const divisor = 10n ** USDC_DECIMALS;
  const whole = atomic / divisor;
  const fraction = (atomic % divisor).toString().padStart(Number(USDC_DECIMALS), "0");
  return `${whole}.${fraction}`;
}

function paymentRequirementsFromSession(session: SessionRecord): PaymentRequirements[] {
  const paymentRequired = session.paymentRequired as { accepts?: PaymentRequirements[] } | undefined;
  return Array.isArray(paymentRequired?.accepts) ? paymentRequired.accepts : [];
}

function logCircleSettlement(
  level: "info" | "warn",
  input: {
    message: string;
    session: SessionRecord;
    requirements: PaymentRequirements;
    settlement: unknown;
  },
): void {
  const settlement = input.settlement as Record<string, unknown>;
  const log = {
    event: input.message,
    sessionId: input.session.id,
    articleId: input.session.articleId,
    creatorId: input.session.creatorId,
    network: input.requirements.network,
    payTo: input.requirements.payTo,
    amount: input.requirements.amount,
    maxTimeoutSeconds: input.requirements.maxTimeoutSeconds,
    settlement: pickSettlementFields(settlement),
  };
  console[level]("[rubicon:circle-x402]", JSON.stringify(log));
}

function pickSettlementFields(settlement: Record<string, unknown>): Record<string, unknown> {
  const allowed = [
    "success",
    "amount",
    "asset",
    "network",
    "payer",
    "payTo",
    "transaction",
    "transferId",
    "error",
    "errorCode",
    "errorReason",
    "errorMessage",
    "message",
    "status",
  ];
  return Object.fromEntries(
    allowed
      .filter((key) => settlement[key] !== undefined)
      .map((key) => [key, settlement[key]]),
  );
}
