import type { StartSessionResponse, StreamPaymentRequest } from "@rubicon-caliga/core";
import { x402Client } from "@x402/core/client";
import { registerBatchScheme } from "@circle-fin/x402-batching/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import {
  initiateDeveloperControlledWalletsClient,
  type CircleDeveloperControlledWalletsClient,
} from "@circle-fin/developer-controlled-wallets";
import type { AgentPaymentEngine } from "./payment-engine.js";

export interface CircleAgentWalletEngineOptions {
  /** Circle API key that controls the Agent Wallet. */
  apiKey: string;
  /** Entity secret registered for the Circle developer account. */
  entitySecret: string;
  /** The Agent Wallet that holds USDC and signs each one-word payment. */
  walletId: string;
  /**
   * The wallet's on-chain address. Optional — when omitted it is resolved once
   * from the Circle API via `getWallet` before the first payment is signed.
   */
  walletAddress?: `0x${string}`;
  /** Override the Circle API base URL (e.g. sandbox vs. production). */
  baseUrl?: string;
  /** Pre-built Circle client. Mainly an injection point for tests. */
  client?: CircleDeveloperControlledWalletsClient;
}

/** The minimal EIP-712 signing request the x402 client hands to a signer. */
interface TypedDataRequest {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * viem-shaped signer (`{ address, signTypedData }`) that delegates EIP-712
 * signing to a Circle Agent Wallet over the API instead of holding a raw
 * private key. Satisfies both the batch (`BatchEvmSigner`) and exact
 * (`ClientEvmSigner`) signer contracts used by the Circle x402 schemes.
 */
class CircleAgentWalletSigner {
  // Populated before the first signature — either from options or via getWallet.
  address: `0x${string}` = "0x0000000000000000000000000000000000000000";
  private resolved = false;
  private resolving?: Promise<void>;

  constructor(
    private readonly client: CircleDeveloperControlledWalletsClient,
    private readonly walletId: string,
    address?: `0x${string}`,
  ) {
    if (address) {
      this.address = address;
      this.resolved = true;
    }
  }

  /** Resolves and caches the wallet's on-chain address (idempotent). */
  async ensureAddress(): Promise<void> {
    if (this.resolved) return;
    if (!this.resolving) {
      this.resolving = this.client.getWallet({ id: this.walletId }).then((res) => {
        const address = res.data?.wallet.address;
        if (!address) {
          throw new Error(`Circle wallet ${this.walletId} did not return an on-chain address`);
        }
        this.address = address as `0x${string}`;
        this.resolved = true;
      });
    }
    return this.resolving;
  }

  async signTypedData(typed: TypedDataRequest): Promise<`0x${string}`> {
    // The schemes read `address` synchronously while building the payload, so
    // make sure it is resolved before we sign.
    await this.ensureAddress();
    const res = await this.client.signTypedData({
      walletId: this.walletId,
      data: serializeTypedData(toEip712Payload(typed)),
      memo: "Rubicon one-word payment",
    });
    const signature = res.data?.signature;
    if (!signature) {
      throw new Error("Circle Agent Wallet did not return a signature for the x402 payment");
    }
    return signature as `0x${string}`;
  }
}

/**
 * Circle Agent Wallet engine. Signs the gateway's one-word x402 terms with a
 * custodial Circle Agent Wallet — the recommended buyer setup — so the agent
 * never handles a local signing key. Settlement may be batched by Circle, but
 * each signed payload still corresponds to exactly one word.
 */
export class CircleAgentWalletEngine implements AgentPaymentEngine {
  private readonly x402 = new x402Client();
  private readonly signer: CircleAgentWalletSigner;

  constructor(options: CircleAgentWalletEngineOptions) {
    const client =
      options.client ??
      initiateDeveloperControlledWalletsClient({
        apiKey: options.apiKey,
        entitySecret: options.entitySecret,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      });
    this.signer = new CircleAgentWalletSigner(client, options.walletId, options.walletAddress);
    // Gasless Gateway batching with an `exact` EIP-3009 fallback. The signer is
    // a custodial Circle Agent Wallet, not a local private key.
    registerBatchScheme(this.x402, {
      signer: this.signer,
      fallbackScheme: new ExactEvmScheme(this.signer),
    });
  }

  async createWordPayment(session: StartSessionResponse): Promise<StreamPaymentRequest> {
    if (!session.paymentRequired) {
      throw new Error("Session did not include an x402 one-word payment requirement");
    }
    // Resolve the wallet address up front so the synchronous `address` read
    // inside createPaymentPayload sees a real value.
    await this.signer.ensureAddress();
    return {
      paymentPayload: await this.x402.createPaymentPayload(session.paymentRequired as never),
    };
  }
}

/**
 * Circle's signTypedData API expects a complete EIP-712 document as a JSON
 * string. The x402 schemes pass viem-style typed data, which omits the implicit
 * `EIP712Domain` type, so add it back from whichever domain fields are present.
 *
 * Exported for unit testing — application code never calls this directly.
 */
/**
 * Serialize an EIP-712 document to the JSON string Circle's API expects. The
 * `exact` fallback scheme passes the authorization's `value`/`validAfter`/
 * `validBefore` as bigints, which `JSON.stringify` cannot encode — emit them as
 * decimal strings (the EIP-712 JSON convention) instead of throwing.
 *
 * Exported for unit testing — application code never calls this directly.
 */
export function serializeTypedData(typed: ReturnType<typeof toEip712Payload>): string {
  return JSON.stringify(typed, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

export function toEip712Payload(typed: TypedDataRequest) {
  const domain = typed.domain ?? {};
  const types = { ...(typed.types as Record<string, unknown>) };
  if (!types.EIP712Domain) {
    types.EIP712Domain = eip712DomainFields(domain);
  }
  return {
    domain,
    types,
    primaryType: typed.primaryType,
    message: eip712PrimaryMessage(typed.message, types, typed.primaryType),
  };
}

function eip712DomainFields(domain: Record<string, unknown>): Array<{ name: string; type: string }> {
  const candidates: Array<[string, string]> = [
    ["name", "string"],
    ["version", "string"],
    ["chainId", "uint256"],
    ["verifyingContract", "address"],
    ["salt", "bytes32"],
  ];
  return candidates
    .filter(([field]) => domain[field] !== undefined)
    .map(([name, type]) => ({ name, type }));
}

function eip712PrimaryMessage(
  message: Record<string, unknown>,
  types: Record<string, unknown>,
  primaryType: string,
): Record<string, unknown> {
  const fields = types[primaryType];
  if (!Array.isArray(fields)) {
    return message;
  }

  const allowed = new Set(
    fields
      .map((field) => (isEip712Field(field) ? field.name : undefined))
      .filter((name): name is string => Boolean(name)),
  );
  if (allowed.size === 0) {
    return message;
  }

  return Object.fromEntries(Object.entries(message).filter(([key]) => allowed.has(key)));
}

function isEip712Field(field: unknown): field is { name: string; type: string } {
  return (
    typeof field === "object" &&
    field !== null &&
    typeof (field as { name?: unknown }).name === "string" &&
    typeof (field as { type?: unknown }).type === "string"
  );
}
