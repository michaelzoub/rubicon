import { BatchFacilitatorClient, GatewayEvmScheme } from "@circle-fin/x402-batching/server";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequired, PaymentRequirements, SchemeNetworkServer } from "@x402/core/types";
import type { PaymentVerification, SessionRecord } from "@rubicon-caliga/core";
import type { PaymentRequiredInput, PaymentVerifier, PaymentVerifyInput } from "./types.js";
import { ACTIVE_X402_NETWORK, USDC_DECIMALS as ARC_USDC_DECIMALS } from "../chain.js";
import { SettlementQueue } from "./settlement-queue.js";

/**
 * Settlement outcome reported once a queued word-authorization clears (or fails)
 * behind the stream. The gateway uses it to backfill the persisted word-payment
 * receipt with Circle's transfer UUID.
 */
export interface SettlementOutcome {
  sessionId: string;
  sequence: number;
  success: boolean;
  settlementId?: string;
  settlementIds?: string[];
  transferId?: string;
  transactionHash?: string;
  transactionHashes?: string[];
  buyerWalletAddress?: `0x${string}`;
  network?: string;
  payTo?: `0x${string}`;
  amountAtomic?: `${bigint}`;
  reason?: string;
}

/**
 * Minimal slice of `x402ResourceServer` the verifier depends on. Declared as an
 * interface so tests can inject a double without standing up Circle's facilitator.
 */
export interface ResourceServerLike {
  initialize(): Promise<void>;
  findMatchingRequirements(
    available: PaymentRequirements[],
    payload: PaymentPayload,
  ): PaymentRequirements | undefined;
  verifyPayment(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }>;
  settlePayment(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<Record<string, unknown>>;
  createPaymentRequiredResponse(
    requirements: PaymentRequirements[],
    options: Record<string, unknown>,
  ): Promise<PaymentRequired>;
  buildPaymentRequirementsFromOptions(
    options: unknown[],
    context: Record<string, unknown>,
  ): Promise<PaymentRequirements[]>;
}

export interface CircleX402PaymentVerifierOptions {
  facilitatorUrl?: string;
  networks?: string[];
  maxTimeoutSeconds?: number;
  arcPrivateMainnet?: boolean;
  gatewayBaseUrl?: string;
  /**
   * Max verified word-authorizations to hold before flushing a settlement batch.
   * Each word still streams the instant its authorization is verified; this only
   * controls how many settlements are flushed together behind the stream.
   * Defaults to 25.
   */
  settlementBatchSize?: number;
  /**
   * Max time (ms) a verified authorization waits before its settlement batch is
   * flushed, even if the batch is not full. Defaults to 250ms.
   */
  settlementBatchIntervalMs?: number;
  /**
   * Invoked after each queued authorization settles (or fails). The gateway uses
   * it to backfill the persisted receipt with Circle's transfer UUID.
   */
  onSettled?: (outcome: SettlementOutcome) => void | Promise<void>;
  /**
   * Settle inline on the request path instead of batching behind the stream.
   * Defaults to false. Use only when a caller needs strict settle-before-release
   * (e.g. verify ~= settle latency, so batching buys nothing).
   */
  synchronousSettlement?: boolean;
  /** Injectable resource server for tests. Defaults to the real Circle-backed one. */
  resourceServer?: ResourceServerLike;
}

/**
 * Circle/x402 one-word payment verifier. Each accepted payment authorizes
 * exactly one word's price. The application contract stays one word per payment;
 * settlement is what gets batched.
 *
 * Streaming path (default): every word is gated on a cheap remote
 * `verifyPayment` — Circle confirms the signed EIP-3009/Gateway authorization is
 * valid AND funded — and only then is the word released. The expensive
 * `settlePayment` is moved off the response path into a batched, pipelined queue
 * that flushes behind the stream. A buyer therefore still cannot obtain a word
 * without a real, funded, correctly-scoped payment authorization, but the stream
 * no longer blocks on settlement finality.
 *
 * Exposure is bounded: if any queued settlement fails, the session is halted so
 * no further words are released, and the only loss is the in-flight batch of
 * nanopayments. This is the documented Circle batching tradeoff.
 */
export class CircleX402PaymentVerifier implements PaymentVerifier {
  private readonly resourceServer: ResourceServerLike;
  private readonly ready: Promise<void>;
  private readonly networks: Network[];
  private readonly maxTimeoutSeconds: number;
  private readonly synchronousSettlement: boolean;
  private readonly settlementQueue: SettlementQueue<QueuedSettlement>;
  /** Sessions with at least one failed settlement; further words are refused. */
  private readonly haltedSessions = new Set<string>();

  constructor(private readonly options: CircleX402PaymentVerifierOptions) {
    if (options.resourceServer) {
      this.resourceServer = options.resourceServer;
      this.ready = options.resourceServer.initialize();
    } else {
      const facilitator = new BatchFacilitatorClient(
        options.facilitatorUrl || options.arcPrivateMainnet
          ? { url: options.facilitatorUrl, arcPrivateMainnet: options.arcPrivateMainnet }
          : undefined,
      );
      const resourceServer = new x402ResourceServer([facilitator as unknown as FacilitatorClient]);
      resourceServer.register("eip155:*", new GatewayEvmScheme() as unknown as SchemeNetworkServer);
      this.resourceServer = resourceServer as unknown as ResourceServerLike;
      this.ready = resourceServer.initialize();
    }
    this.networks = (options.networks?.length ? options.networks : ["eip155:*"]) as Network[];
    // Circle Gateway requires the buyer's EIP-3009 `validBefore` to be at least 7
    // days in the future (it derives this from `maxTimeoutSeconds`). A shorter
    // window — e.g. the 60s that suits a plain x402 facilitator — is rejected
    // outright by the Arc Testnet Gateway. Default to 7 days + a small buffer.
    this.maxTimeoutSeconds = options.maxTimeoutSeconds ?? 604_900;
    this.synchronousSettlement = options.synchronousSettlement ?? false;
    this.settlementQueue = new SettlementQueue<QueuedSettlement>({
      batchSize: options.settlementBatchSize ?? 25,
      intervalMs: options.settlementBatchIntervalMs ?? 250,
      settle: (item) => this.settleQueued(item),
    });
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
    const response = await this.resourceServer.createPaymentRequiredResponse(requirements, {
      url: `${input.gatewayBaseUrl}/v1/sessions/${input.session.id}/payments`,
      description: `Rubicon one-word payment for ${input.article.title}`,
      serviceName: "rubicon-article-stream",
      mimeType: "application/json",
    });
    const requirement = requirements[0];
    if (!requirement) {
      throw new Error("Circle x402 verifier did not create a payment requirement");
    }
    const sequence = input.session.wordsDelivered;
    return {
      ...response,
      rubicon: {
        sessionId: input.session.id,
        articleId: input.article.id,
        sequence,
        meteringUnit: "word",
        amountAtomic: `${input.wordPaymentAtomic}`,
        asset: "USDC",
        network: requirement.network,
        payTo: input.sellerWallet,
        expiresAt: input.session.expiresAt.toISOString(),
        nonce: `${input.session.id}:${sequence}`,
        idempotencyKey: `${input.session.id}:${sequence}`,
      },
    } as PaymentRequired;
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

    // A prior word in this session failed to settle. Refuse to release any more
    // so unsettled exposure stays bounded to the already-flushed batch.
    if (this.haltedSessions.has(input.session.id)) {
      return { accepted: false, reason: "prior_settlement_failed" };
    }

    if (this.synchronousSettlement) {
      return this.settleInline(paymentPayload, requirements, input.session);
    }

    // Verify-gate: confirm with Circle that the signed authorization is valid AND
    // funded WITHOUT settling. This is the security boundary — an agent cannot
    // obtain a word without a real, funded, correctly-scoped authorization — and
    // it is cheaper than a full settlement, so the stream advances at verify
    // speed while settlement happens behind it.
    const verification = await this.resourceServer.verifyPayment(paymentPayload, requirements);
    if (!verification.isValid) {
      return { accepted: false, reason: verification.invalidReason ?? "payment_verification_failed" };
    }

    // `session.wordsDelivered` is the sequence of the word being paid for; the
    // server increments it only after we accept. Queue the verified
    // authorization for batched settlement keyed by that sequence.
    const sequence = input.session.wordsDelivered;
    this.settlementQueue.enqueue({
      sessionId: input.session.id,
      sequence,
      paymentPayload,
      requirements,
    });

    return {
      accepted: true,
      amountAtomic: requirements.amount as `${bigint}`,
      network: requirements.network,
      payTo: requirements.payTo as `0x${string}`,
      buyerWalletAddress: verification.payer as `0x${string}` | undefined,
      // settlementId/transferId are backfilled by onSettled once the batch clears.
    };
  }

  /** Flush any settlements queued behind the stream. Safe to call repeatedly. */
  async flush(): Promise<void> {
    await this.settlementQueue.flush();
  }

  /** Flush remaining settlements and stop background timers (graceful shutdown). */
  async drain(): Promise<void> {
    await this.settlementQueue.drain();
  }

  /** Legacy strict path: settle on the request path before releasing the word. */
  private async settleInline(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
    session: SessionRecord,
  ): Promise<PaymentVerification> {
    const settlement = await this.resourceServer.settlePayment(paymentPayload, requirements);
    if (!settlement.success) {
      logCircleSettlement("warn", {
        message: "circle_x402_settlement_failed",
        session,
        requirements,
        settlement,
      });
      return {
        accepted: false,
        reason:
          (settlement.errorReason as string) ??
          (settlement.errorMessage as string) ??
          "payment_settlement_failed",
      };
    }
    logCircleSettlement("info", {
      message: "circle_x402_settlement_succeeded",
      session,
      requirements,
      settlement,
    });
    return {
      accepted: true,
      amountAtomic: (settlement.amount ?? requirements.amount) as `${bigint}`,
      network: requirements.network,
      payTo: requirements.payTo as `0x${string}`,
      settlementId: settlementId(settlement),
      settlementIds: settlementIds(settlement),
      buyerWalletAddress: settlement.payer as `0x${string}` | undefined,
      transferId: transferIdFromSettlement(settlement),
    };
  }

  /** Settle one queued authorization and report the outcome to `onSettled`. */
  private async settleQueued(item: QueuedSettlement): Promise<void> {
    try {
      const settlement = await this.resourceServer.settlePayment(
        item.paymentPayload,
        item.requirements,
      );
      if (!settlement.success) {
        this.haltedSessions.add(item.sessionId);
        logCircleSettlement("warn", {
          message: "circle_x402_batched_settlement_failed",
          sessionId: item.sessionId,
          requirements: item.requirements,
          settlement,
        });
        await this.reportSettlement({
          sessionId: item.sessionId,
          sequence: item.sequence,
          success: false,
          reason:
            (settlement.errorReason as string) ??
            (settlement.errorMessage as string) ??
            "payment_settlement_failed",
        });
        return;
      }
      logCircleSettlement("info", {
        message: "circle_x402_batched_settlement_succeeded",
        sessionId: item.sessionId,
        requirements: item.requirements,
        settlement,
      });
      await this.reportSettlement({
        sessionId: item.sessionId,
        sequence: item.sequence,
        success: true,
        amountAtomic: (settlement.amount ?? item.requirements.amount) as `${bigint}`,
        network: item.requirements.network,
        payTo: item.requirements.payTo as `0x${string}`,
        settlementId: settlementId(settlement),
        settlementIds: settlementIds(settlement),
        transferId: transferIdFromSettlement(settlement),
        transactionHash: typeof settlement.transaction === "string" ? settlement.transaction : undefined,
        buyerWalletAddress: settlement.payer as `0x${string}` | undefined,
      });
    } catch (error) {
      // A settle that throws (network/facilitator error) also halts the session.
      this.haltedSessions.add(item.sessionId);
      await this.reportSettlement({
        sessionId: item.sessionId,
        sequence: item.sequence,
        success: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async reportSettlement(outcome: SettlementOutcome): Promise<void> {
    if (!this.options.onSettled) {
      return;
    }
    try {
      await this.options.onSettled(outcome);
    } catch (error) {
      console.error("[rubicon:circle-x402] onSettled handler failed", error);
    }
  }

  private async requirements(input: {
    session: SessionRecord;
    sellerWallet: `0x${string}`;
    wordPaymentAtomic: bigint;
    gatewayBaseUrl: string;
    articleId: string;
    author: string;
  }): Promise<PaymentRequirements[]> {
    const sequence = input.session.wordsDelivered;
    const network = this.networks[0] ?? (ACTIVE_X402_NETWORK as Network);
    return this.resourceServer.buildPaymentRequirementsFromOptions(
      [
        {
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
          sequence,
          author: input.author,
          meteringUnit: "word",
          amountAtomic: `${input.wordPaymentAtomic}`,
          asset: "USDC",
          payTo: input.sellerWallet,
          expiresAt: input.session.expiresAt.toISOString(),
          nonce: `${input.session.id}:${sequence}`,
          idempotencyKey: `${input.session.id}:${sequence}`,
        },
        },
      ],
      { sessionId: input.session.id, url: `${input.gatewayBaseUrl}/v1/sessions/${input.session.id}/payments` },
    );
  }
}

function settlementId(settlement: Record<string, unknown>): string | undefined {
  const value =
    settlement.gatewaySettlementId ??
    settlement.settlementId ??
    settlement.transferId ??
    settlement.transaction;
  return typeof value === "string" ? value : undefined;
}

function transferIdFromSettlement(settlement: Record<string, unknown>): string | undefined {
  const value = settlement.transferId ?? settlement.transaction;
  return typeof value === "string" ? value : undefined;
}

function settlementIds(settlement: Record<string, unknown>): string[] | undefined {
  const values = settlement.gatewaySettlementIds ?? settlement.settlementIds;
  if (Array.isArray(values)) {
    return values.filter((value): value is string => typeof value === "string");
  }
  const single = settlementId(settlement);
  return single ? [single] : undefined;
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
    session?: SessionRecord;
    sessionId?: string;
    requirements: PaymentRequirements;
    settlement: unknown;
  },
): void {
  const settlement = input.settlement as Record<string, unknown>;
  const log = {
    event: input.message,
    sessionId: input.session?.id ?? input.sessionId,
    articleId: input.session?.articleId,
    creatorId: input.session?.creatorId,
    network: input.requirements.network,
    payTo: input.requirements.payTo,
    amount: input.requirements.amount,
    maxTimeoutSeconds: input.requirements.maxTimeoutSeconds,
    settlement: pickSettlementFields(settlement),
  };
  console[level]("[rubicon:circle-x402]", JSON.stringify(log));
}

/** A verified word-authorization awaiting batched settlement behind the stream. */
interface QueuedSettlement {
  sessionId: string;
  sequence: number;
  paymentPayload: PaymentPayload;
  requirements: PaymentRequirements;
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
    "gatewaySettlementId",
    "gatewaySettlementIds",
    "settlementId",
    "settlementIds",
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
