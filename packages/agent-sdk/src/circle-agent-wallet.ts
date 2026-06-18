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
      data: JSON.stringify(toEip712Payload(typed)),
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
 * never handles a raw EOA private key. Settlement may be batched by Circle, but
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
    // Same buyer wiring as CircleGatewayPaymentEngine: gasless Gateway batching
    // with an `exact` EIP-3009 fallback. The only difference is the signer —
    // here a custodial wallet rather than a local private key.
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
export function toEip712Payload(typed: TypedDataRequest) {
  const domain = typed.domain ?? {};
  const types = { ...(typed.types as Record<string, unknown>) };
  if (!types.EIP712Domain) {
    types.EIP712Domain = eip712DomainFields(domain);
  }
  return { domain, types, primaryType: typed.primaryType, message: typed.message };
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
