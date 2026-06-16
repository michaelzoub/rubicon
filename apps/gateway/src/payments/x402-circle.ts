import { BatchFacilitatorClient, GatewayEvmScheme } from "@circle-fin/x402-batching/server";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequired, PaymentRequirements, SchemeNetworkServer } from "@x402/core/types";
import type { SessionRecord, StreamPaymentRequest, PaymentVerification } from "@rubicon-caliga/core";
import type { ArticleRecord, AuthorRecord, PaymentVerifier } from "../server.js";

export interface CircleX402PaymentVerifierOptions {
  facilitatorUrl?: string;
  networks?: string[];
  maxTimeoutSeconds?: number;
  arcPrivateMainnet?: boolean;
}

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
    this.maxTimeoutSeconds = options.maxTimeoutSeconds ?? 60;
  }

  async createPaymentRequired(input: {
    session: SessionRecord;
    article: ArticleRecord;
    author: AuthorRecord;
    amountAtomic: `${bigint}`;
    gatewayBaseUrl: string;
  }): Promise<PaymentRequired> {
    await this.ready;
    const requirements = await this.requirements(input);
    return this.resourceServer.createPaymentRequiredResponse(requirements, {
      url: `${input.gatewayBaseUrl}/v1/sessions/${input.session.id}/payments`,
      description: `Rubicon word stream payment for ${input.article.title}`,
      serviceName: "rubicon-article-stream",
      mimeType: "application/json",
    });
  }

  async verify(session: SessionRecord, payment: StreamPaymentRequest): Promise<PaymentVerification> {
    await this.ready;
    const paymentPayload = payment.paymentPayload as PaymentPayload | undefined;
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
    article: ArticleRecord;
    author: AuthorRecord;
    amountAtomic: `${bigint}`;
    gatewayBaseUrl: string;
  }): Promise<PaymentRequirements[]> {
    return this.resourceServer.buildPaymentRequirementsFromOptions(
      this.networks.map((network) => ({
        scheme: "exact",
        network,
        payTo: input.author.walletAddress,
        // Circle's GatewayEvmScheme registers a USDC money parser that turns a dollar
        // amount into the correct on-chain USDC asset for the network. Passing a bare
        // `{ asset: "USDC" }` bypasses it and the facilitator rejects it as
        // `unsupported_asset`, so price must be USDC dollars (6 decimals).
        price: usdcDollarsFromAtomic(input.amountAtomic),
        maxTimeoutSeconds: this.maxTimeoutSeconds,
        extra: {
          sessionId: input.session.id,
          articleId: input.article.articleId,
          authorUsername: input.article.authorUsername,
          meteringUnit: "word",
        },
      })),
      { sessionId: input.session.id, url: `${input.gatewayBaseUrl}/v1/sessions/${input.session.id}/payments` },
    );
  }

  private async requirementsForSession(session: SessionRecord): Promise<PaymentRequirements[]> {
    const amountAtomic = session.metadata.paymentChunkAtomic;
    const articleSnapshot = session.metadata.articleSnapshot;
    const gatewayBaseUrl = session.metadata.gatewayBaseUrl;
    if (typeof amountAtomic !== "string" || typeof gatewayBaseUrl !== "string" || !isArticleSnapshot(articleSnapshot)) {
      throw new Error("session_missing_x402_pricing_metadata");
    }

    return this.requirements({
      session,
      amountAtomic: amountAtomic as `${bigint}`,
      gatewayBaseUrl,
      article: {
        articleId: articleSnapshot.articleId,
        authorUsername: articleSnapshot.authorUsername,
        title: articleSnapshot.articleId,
        content: "",
        pricePerWordAtomic: BigInt(articleSnapshot.pricePerWordAtomic),
      },
      author: {
        authorUsername: articleSnapshot.authorUsername,
        walletAddress: articleSnapshot.sellerAddress,
      },
    });
  }
}

const USDC_DECIMALS = 6n;

// Convert an atomic USDC amount (e.g. "1") to a decimal dollar string (e.g. "0.000001")
// for the x402 money parser, which resolves it to the network's USDC asset.
function usdcDollarsFromAtomic(amountAtomic: string): string {
  const atomic = BigInt(amountAtomic);
  const divisor = 10n ** USDC_DECIMALS;
  const whole = atomic / divisor;
  const fraction = (atomic % divisor).toString().padStart(Number(USDC_DECIMALS), "0");
  return `${whole}.${fraction}`;
}

function isArticleSnapshot(value: unknown): value is {
  articleId: string;
  authorUsername: string;
  sellerAddress: `0x${string}`;
  pricePerWordAtomic: string;
  paymentChunkWords: number;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.articleId === "string" &&
    typeof record.authorUsername === "string" &&
    typeof record.sellerAddress === "string" &&
    typeof record.pricePerWordAtomic === "string" &&
    typeof record.paymentChunkWords === "number"
  );
}
