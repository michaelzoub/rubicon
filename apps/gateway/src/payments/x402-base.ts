/**
 * AgentCash-facing x402 (Base) purchase lane. Self-contained and additive: it
 * shares no state with Rubicon's primary Circle/Arc settlement path.
 *
 * It advertises a whole-article purchase on Base USDC to AgentCash agents and
 * emits a spec-correct x402 **v2** payment challenge — the exact shape the
 * AgentCash discovery checker validates (`x402Version: 2`, an `accepts[]` entry
 * with scheme/network/asset/payTo/amount/maxTimeoutSeconds, and the
 * `extensions.bazaar.schema` input/output block).
 *
 * Settlement note: an x402 "exact" payment on Base is collected by submitting the
 * buyer's signed EIP-3009 authorization on-chain, which requires a verifier with
 * on-chain access (Coinbase CDP or a self-hosted facilitator). There is no
 * credential-free way to *collect* Base funds. This module therefore ships a
 * safe default verifier that REFUSES any payment it cannot cryptographically
 * verify — the endpoint is discoverable and advertises payment, but never
 * releases paid content without a real, verified payment. Inject a real verifier
 * (CDP/facilitator-backed) via `BaseX402Verifier` to go live.
 */

import type { BaseX402Config } from "../chain-base.js";

/** A single x402 v2 payment requirement (the `accepts[]` entry AgentCash reads). */
export interface BaseAccept {
  scheme: "exact";
  network: string;
  asset: `0x${string}`;
  payTo: `0x${string}`;
  /** Atomic USDC amount (6 decimals). Present as both `amount` (v2) and `maxAmountRequired` (compat). */
  amount: `${bigint}`;
  maxAmountRequired: `${bigint}`;
  maxTimeoutSeconds: number;
  resource: string;
  description: string;
  mimeType: string;
  extra: Record<string, unknown>;
}

/** The full x402 v2 `402 Payment Required` challenge body. */
export interface BaseChallenge {
  x402Version: 2;
  error: string;
  /** Top-level resource descriptor required by the x402 v2 schema. */
  resource: { url: string; description: string; mimeType: string };
  accepts: BaseAccept[];
  extensions: {
    bazaar: {
      schema: {
        properties: {
          input: { properties: { body: Record<string, unknown> } };
          output: { properties: { example: Record<string, unknown> } };
        };
      };
    };
  };
}

export interface BuildBaseChallengeInput {
  config: BaseX402Config;
  /** Absolute URL of the purchase resource (the endpoint being paid for). */
  resource: string;
  /** Whole-article price in atomic USDC (6 decimals). */
  priceAtomic: bigint;
  articleId: string;
  title: string;
  totalWords: number;
  /**
   * Recipient of the USDC payment. Pass the article creator's wallet so funds
   * route directly to them on-chain (no gateway payout step). Falls back to the
   * configured gateway wallet when a creator wallet is unavailable.
   */
  payTo?: `0x${string}`;
}

/**
 * Build the x402 v2 challenge for a whole-article Base purchase. Deterministic —
 * no network calls — so it doubles as the discovery-probe response.
 */
export function buildBaseChallenge(input: BuildBaseChallengeInput): BaseChallenge {
  const amount = `${input.priceAtomic}` as `${bigint}`;
  const accept: BaseAccept = {
    scheme: "exact",
    network: input.config.network,
    asset: input.config.usdc,
    payTo: input.payTo ?? input.config.payTo,
    amount,
    maxAmountRequired: amount,
    maxTimeoutSeconds: input.config.maxTimeoutSeconds,
    resource: input.resource,
    description: `Rubicon whole-article purchase: ${input.title}`,
    mimeType: "application/json",
    // EIP-712 domain hints for the USDC EIP-3009 authorization the buyer signs.
    extra: { name: "USDC", version: "2" },
  };
  return {
    x402Version: 2,
    error: "payment_required",
    resource: {
      url: input.resource,
      description: `Rubicon whole-article purchase: ${input.title}`,
      mimeType: "application/json",
    },
    accepts: [accept],
    extensions: {
      bazaar: {
        schema: {
          properties: {
            input: {
              properties: {
                body: {
                  type: "object",
                  required: ["articleId"],
                  properties: {
                    articleId: { type: "string", description: "Article to purchase in full." },
                  },
                },
              },
            },
            output: {
              properties: {
                example: {
                  articleId: input.articleId,
                  title: input.title,
                  totalWords: input.totalWords,
                  body: "# <full article markdown returned after payment>",
                },
              },
            },
          },
        },
      },
    },
  };
}

/** Outcome of verifying a submitted x402 payment against a challenge. */
export type BaseVerifyResult =
  | { verified: true; payer?: string; transaction?: string }
  | { verified: false; reason: string };

/**
 * Verifies a buyer's submitted x402 payment for a Base accept. Implementations
 * are expected to be CDP- or facilitator-backed (on-chain verification/settle).
 */
export interface BaseX402Verifier {
  verify(input: { paymentHeader: string; accept: BaseAccept }): Promise<BaseVerifyResult>;
}

/**
 * Default verifier used when no CDP/facilitator verifier is configured. It never
 * accepts a payment — so the endpoint stays discoverable and payment-advertising
 * without ever handing out paid content for an unverifiable payment.
 */
export class UnconfiguredBaseVerifier implements BaseX402Verifier {
  async verify(): Promise<BaseVerifyResult> {
    return {
      verified: false,
      reason:
        "base_x402_verification_not_configured: set CDP_API_KEY_ID/CDP_API_KEY_SECRET to collect Base payments",
    };
  }
}

/** Minimal slice of x402ResourceServer the CDP verifier needs (for test injection). */
interface CdpResourceServerLike {
  initialize(): Promise<void>;
  verifyPayment(
    payload: unknown,
    requirements: unknown,
  ): Promise<{ isValid: boolean; invalidReason?: string; invalidMessage?: string; payer?: string }>;
  settlePayment(
    payload: unknown,
    requirements: unknown,
  ): Promise<{ success: boolean; errorReason?: string; errorMessage?: string; payer?: string; transaction?: string }>;
}

/**
 * Verifies and settles a buyer's x402 payment on Base through Coinbase's CDP
 * facilitator (the on-chain verifier AgentCash's guide requires for Base). It
 * verifies the signed authorization is valid AND funded, then settles it so the
 * USDC lands in the accept's `payTo` (the article creator's wallet), and only
 * then reports success so the gateway may release the article body.
 *
 * The buyer's payment must satisfy the requirements WE issued (from the accept),
 * not requirements the buyer supplies — so a forged `payTo`/amount cannot pass.
 */
export class CdpBaseVerifier implements BaseX402Verifier {
  private ready?: Promise<CdpResourceServerLike>;

  /** @param serverFactory Overridable for tests; defaults to a CDP-backed resource server. */
  constructor(
    private readonly network: string,
    private readonly serverFactory: () => Promise<CdpResourceServerLike> = () =>
      buildCdpResourceServer(network),
  ) {}

  private server(): Promise<CdpResourceServerLike> {
    if (!this.ready) this.ready = this.serverFactory();
    return this.ready;
  }

  async verify(input: { paymentHeader: string; accept: BaseAccept }): Promise<BaseVerifyResult> {
    let payload: unknown;
    try {
      const { decodePaymentSignatureHeader } = await import("@x402/core/http");
      payload = decodePaymentSignatureHeader(input.paymentHeader);
    } catch (error) {
      return { verified: false, reason: `malformed_payment_header: ${(error as Error).message}` };
    }

    // Requirements WE control — the buyer's signature must authorize exactly these.
    const requirements = {
      scheme: input.accept.scheme,
      network: input.accept.network,
      asset: input.accept.asset,
      amount: input.accept.amount,
      payTo: input.accept.payTo,
      maxTimeoutSeconds: input.accept.maxTimeoutSeconds,
      extra: input.accept.extra,
    };

    let server: CdpResourceServerLike;
    try {
      server = await this.server();
    } catch (error) {
      return { verified: false, reason: `cdp_facilitator_unavailable: ${(error as Error).message}` };
    }

    // A facilitator error (e.g. a malformed payment payload → CDP 400) must
    // surface as a clean refusal, never an unhandled throw that 500s the route.
    try {
      const verification = await server.verifyPayment(payload, requirements);
      if (!verification.isValid) {
        return { verified: false, reason: verification.invalidReason ?? "payment_verification_failed" };
      }
    } catch (error) {
      return { verified: false, reason: `payment_verification_error: ${(error as Error).message}` };
    }

    try {
      const settlement = await server.settlePayment(payload, requirements);
      if (!settlement.success) {
        return { verified: false, reason: settlement.errorReason ?? "payment_settlement_failed" };
      }
      return { verified: true, payer: settlement.payer, transaction: settlement.transaction };
    } catch (error) {
      return { verified: false, reason: `payment_settlement_error: ${(error as Error).message}` };
    }
  }
}

/** Build a CDP-facilitator-backed resource server for the Base `exact` scheme. */
async function buildCdpResourceServer(network: string): Promise<CdpResourceServerLike> {
  const [{ x402ResourceServer, HTTPFacilitatorClient }, { registerExactEvmScheme }, coinbase] =
    await Promise.all([
      import("@x402/core/server"),
      import("@x402/evm/exact/server"),
      import("@coinbase/x402"),
    ]);
  // `facilitator` reads CDP_API_KEY_ID / CDP_API_KEY_SECRET from the environment.
  const facilitatorClient = new HTTPFacilitatorClient(coinbase.facilitator);
  const server = new x402ResourceServer([facilitatorClient]);
  registerExactEvmScheme(server as never, { networks: [network as never] });
  await server.initialize();
  return server as unknown as CdpResourceServerLike;
}

/**
 * Construct the production Base verifier: a CDP-backed verifier when
 * CDP_API_KEY_ID / CDP_API_KEY_SECRET are set, otherwise the safe refusing
 * verifier so the endpoint stays discoverable without collecting.
 */
export function resolveBaseX402Verifier(
  network: string,
  env: NodeJS.ProcessEnv = process.env,
): BaseX402Verifier {
  if (env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET) {
    return new CdpBaseVerifier(network);
  }
  return new UnconfiguredBaseVerifier();
}
