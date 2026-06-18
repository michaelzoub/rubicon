import type { StartSessionResponse, StreamPaymentRequest } from "@rubicon-caliga/core";
import { x402Client } from "@x402/core/client";
import { registerBatchScheme, type GatewayClientConfig } from "@circle-fin/x402-batching/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Produces the payment payload for exactly one word. Called once per word by the
 * SDK's read loop — application developers never assemble payments themselves.
 */
export interface AgentPaymentEngine {
  createWordPayment(session: StartSessionResponse): Promise<StreamPaymentRequest>;
}

/**
 * Minimal EIP-712 signer the x402 schemes need. Both `@x402/evm`'s exact scheme
 * and Circle's batch scheme accept any object shaped like this — a viem
 * `LocalAccount` (raw key) and a custodial Circle Agent Wallet both qualify, so
 * the gateway engine never has to hold a raw private key.
 */
export interface EvmTypedDataSigner {
  address: `0x${string}`;
  signTypedData(params: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
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

export type CircleGatewayPaymentEngineOptions =
  // Raw-key path: the controller hands the SDK a private key (an EOA the
  // controller funds directly). Convenient for tests; not custodial.
  | GatewayClientConfig
  // Custodial path: a pre-built signer (e.g. a Circle Agent Wallet) signs the
  // x402 terms without exposing a private key to the SDK.
  | { signer: EvmTypedDataSigner };

/**
 * Circle/x402 engine. Signs the gateway's one-word `paymentRequired` terms.
 * Circle may batch settlement internally, but each signed payload corresponds to
 * exactly one word.
 *
 * Accepts either a raw `privateKey` (a controller-provisioned EOA) or a custodial
 * `signer` (a Circle Agent Wallet — see {@link CircleAgentWalletPaymentEngine}).
 */
export class CircleGatewayPaymentEngine implements AgentPaymentEngine {
  private readonly client = new x402Client();
  private readonly signer: EvmTypedDataSigner;

  constructor(options: CircleGatewayPaymentEngineOptions) {
    this.signer =
      "signer" in options ? options.signer : privateKeyToAccount(options.privateKey);
    // Recommended buyer integration (Circle x402 buyer how-to): register the
    // gasless batched scheme with an `exact` fallback. `registerBatchScheme`
    // wires a CompositeEvmScheme that uses Gateway batching when the seller
    // supports it and falls back to a standard EIP-3009 `exact` payment
    // otherwise — no per-request routing logic needed. The signer can be a raw
    // viem account or a custodial Circle Agent Wallet; the scheme only needs an
    // address and `signTypedData`.
    registerBatchScheme(this.client, {
      signer: this.signer,
      fallbackScheme: new ExactEvmScheme(this.signer),
    });
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

/**
 * The slice of Circle's Developer-Controlled Wallets client the custodial signer
 * uses. The real client from `@circle-fin/developer-controlled-wallets`
 * satisfies this structurally, so callers can pass an already-initiated client
 * (sharing one instance, custom `baseUrl`, etc.) instead of credentials.
 */
export interface CircleWalletsClient {
  getWallet(input: { id: string }): Promise<{ data?: { wallet?: { address: string } } }>;
  signTypedData(input: {
    walletId: string;
    data: string;
    memo?: string;
  }): Promise<{ data?: { signature?: string } }>;
}

export type CircleAgentWalletPaymentEngineOptions = {
  /** Circle wallet id of the custodial Agent Wallet that pays for words. */
  walletId: string;
  /**
   * Wallet EVM address. Optional — if omitted the engine resolves it once via
   * `getWallet` before the first payment.
   */
  address?: `0x${string}`;
} & (
  | {
      /** An already-initiated Circle Developer-Controlled Wallets client. */
      client: CircleWalletsClient;
    }
  | {
      /** Circle API key. Used to initiate a client when `client` is not passed. */
      apiKey: string;
      /** Circle entity secret. */
      entitySecret: string;
      /** Optional Circle API base URL (defaults to Circle's production URL). */
      baseUrl?: string;
    }
);

// EIP-712 domain fields, in canonical order. We rebuild the `EIP712Domain` type
// entry from whichever fields the x402 scheme actually populated, because viem-
// style `signTypedData` callers omit it (viem derives it internally) while
// Circle's API expects the full typed-data document.
const EIP712_DOMAIN_FIELDS: ReadonlyArray<{ name: string; type: string }> = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt", type: "bytes32" },
];

function eip712DomainTypes(domain: Record<string, unknown>): Array<{ name: string; type: string }> {
  return EIP712_DOMAIN_FIELDS.filter((field) => domain[field.name] !== undefined);
}

// Typed-data messages can carry bigint fields (e.g. amounts); JSON can't encode
// those, so serialize them as decimal strings — the EIP-712 JSON convention.
function serializeTypedData(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

/**
 * Custodial signer backed by a Circle Developer-Controlled / Agent Wallet. The
 * SDK never sees a private key — every word's EIP-712 authorization is signed by
 * Circle's API against the wallet the controller provisioned and funded.
 */
export class CircleWalletSigner implements EvmTypedDataSigner {
  address: `0x${string}`;
  private resolvedClient?: CircleWalletsClient;
  private addressResolved: boolean;
  private ready?: Promise<void>;

  constructor(private readonly options: CircleAgentWalletPaymentEngineOptions) {
    this.address = options.address ?? "0x0000000000000000000000000000000000000000";
    this.addressResolved = options.address !== undefined;
    if ("client" in options) {
      this.resolvedClient = options.client;
    }
  }

  /**
   * Resolve the Circle client and the wallet address. Idempotent; safe to call
   * before every payment. Must run before {@link signTypedData}.
   */
  async ensureReady(): Promise<void> {
    if (this.ready) {
      return this.ready;
    }
    this.ready = (async () => {
      if (!this.resolvedClient) {
        if (!("apiKey" in this.options)) {
          throw new Error("CircleWalletSigner requires either a `client` or `apiKey`/`entitySecret`");
        }
        const { initiateDeveloperControlledWalletsClient } = await import(
          "@circle-fin/developer-controlled-wallets"
        );
        this.resolvedClient = initiateDeveloperControlledWalletsClient({
          apiKey: this.options.apiKey,
          entitySecret: this.options.entitySecret,
          ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {}),
        }) as unknown as CircleWalletsClient;
      }
      if (!this.addressResolved) {
        const wallet = await this.resolvedClient.getWallet({ id: this.options.walletId });
        const address = wallet.data?.wallet?.address;
        if (!address) {
          throw new Error(`Circle wallet ${this.options.walletId} returned no address`);
        }
        this.address = address as `0x${string}`;
        this.addressResolved = true;
      }
    })();
    return this.ready;
  }

  async signTypedData(params: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`> {
    if (!this.resolvedClient) {
      throw new Error("CircleWalletSigner.signTypedData called before ensureReady()");
    }
    const typedData = {
      domain: params.domain,
      types: { EIP712Domain: eip712DomainTypes(params.domain), ...params.types },
      primaryType: params.primaryType,
      message: params.message,
    };
    const response = await this.resolvedClient.signTypedData({
      walletId: this.options.walletId,
      data: serializeTypedData(typedData),
    });
    const signature = response.data?.signature;
    if (!signature) {
      throw new Error("Circle signTypedData returned no signature");
    }
    return signature as `0x${string}`;
  }
}

/**
 * Circle-native, custodial one-word payment engine. Unlike
 * {@link CircleGatewayPaymentEngine} with a raw `privateKey`, this engine holds
 * no key: a Circle Agent Wallet (provisioned, funded, and policy-bounded by the
 * wallet controller) signs each word's x402 authorization through Circle's API.
 *
 * The controller should create the Agent Wallet, fund it, and set spending
 * policies before the agent starts a paid read — the SDK only consumes the
 * already-configured wallet and keeps enforcing the user's confirmed budget.
 * See https://developers.circle.com/agent-stack/agent-wallets
 */
export class CircleAgentWalletPaymentEngine implements AgentPaymentEngine {
  private readonly signer: CircleWalletSigner;
  private readonly inner: CircleGatewayPaymentEngine;

  constructor(options: CircleAgentWalletPaymentEngineOptions) {
    this.signer = new CircleWalletSigner(options);
    this.inner = new CircleGatewayPaymentEngine({ signer: this.signer });
  }

  /** The wallet EVM address, once {@link CircleWalletSigner.ensureReady} has run. */
  get address(): `0x${string}` {
    return this.signer.address;
  }

  async createWordPayment(session: StartSessionResponse): Promise<StreamPaymentRequest> {
    await this.signer.ensureReady();
    return this.inner.createWordPayment(session);
  }
}
