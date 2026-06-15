import { AgentClient, CircleGatewayPaymentEngine, StaticPaymentEngine } from "@rubicon/agent-sdk";

const privateKey = process.env.CIRCLE_PRIVATE_KEY as `0x${string}` | undefined;

const client = new AgentClient({
  baseUrl: process.env.GATEWAY_BASE_URL ?? "http://localhost:8787",
  paymentEngine: privateKey
    ? new CircleGatewayPaymentEngine({
        chain: (process.env.CIRCLE_CHAIN ?? "arcTestnet") as never,
        privateKey,
      })
    : new StaticPaymentEngine(),
});

const session = await client.startSession({
  providerId: "mock-compute",
  input: { prompt: "stream a small metered job" },
  budget: { currency: "USDC", maxAmountAtomic: "50000" },
  metadata: { agent: "example-agent" },
});

console.log("started", session);

const stop = client.stream(session.sessionId, (event) => {
  console.log(event);
  if (event.type === "session.closed" || event.type === "session.aborted") {
    stop();
    process.exit(0);
  }
});

const heartbeat = setInterval(() => {
  void client.sendHeartbeat(session).catch((error) => {
    console.error(error);
    clearInterval(heartbeat);
    stop();
    process.exit(1);
  });
}, session.heartbeatIntervalMs);

await client.sendHeartbeat(session);
