import { createGateway } from "./server.js";
import { CircleX402PaymentVerifier } from "./payments/x402-circle.js";

const port = Number(process.env.GATEWAY_PORT ?? 8787);
const gatewayBaseUrl = process.env.GATEWAY_BASE_URL ?? `http://localhost:${port}`;
const providerBaseUrl = process.env.PROVIDER_BASE_URL ?? "http://localhost:8790";
const providerSharedSecret = process.env.PROVIDER_SHARED_SECRET ?? "dev-provider-secret";
const sellerAddress = process.env.CIRCLE_SELLER_ADDRESS as `0x${string}` | undefined;

const gateway = createGateway({
  gatewayBaseUrl,
  heartbeatIntervalMs: 1_000,
  sessionTtlMs: 15 * 60_000,
  gatewayFeeBps: Number(process.env.GATEWAY_FEE_BPS ?? 250),
  paymentVerifier: sellerAddress
    ? new CircleX402PaymentVerifier({
        sellerAddress,
        facilitatorUrl: process.env.CIRCLE_FACILITATOR_URL,
        networks: process.env.CIRCLE_X402_NETWORKS?.split(",").map((network) => network.trim()).filter(Boolean),
      })
    : undefined,
  providers: {
    "mock-compute": {
      id: "mock-compute",
      baseUrl: providerBaseUrl,
      sharedSecret: providerSharedSecret,
      unitPriceAtomic: BigInt(process.env.MOCK_PROVIDER_UNIT_PRICE_ATOMIC ?? "1"),
      unitsPerInterval: 1,
      meteringUnit: "second",
    },
  },
});

await gateway.listen({ port, host: "0.0.0.0" });
