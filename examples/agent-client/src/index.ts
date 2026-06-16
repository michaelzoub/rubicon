import { AgentClient, CircleGatewayPaymentEngine, StaticPaymentEngine } from "@rubicon-caliga/agent-sdk";

const privateKey = process.env.CIRCLE_PRIVATE_KEY as `0x${string}` | undefined;

const client = new AgentClient({
  baseUrl: process.env.GATEWAY_BASE_URL ?? "http://localhost:8787",
  paymentEngine: privateKey
    ? new CircleGatewayPaymentEngine({
        chain: (process.env.CIRCLE_CHAIN ?? "arcTestnet") as never,
        privateKey,
        rpcUrl: process.env.CIRCLE_RPC_URL,
      })
    : new StaticPaymentEngine(),
});

const session = await client.startSession({
  articleId: process.env.DEMO_ARTICLE_ID ?? "rubicon-streaming-001",
  budget: { currency: "USDC", maxAmountAtomic: "50000" },
  metadata: { agent: "example-agent" },
});

console.log("started", session);

let paymentInFlight = false;
let streamClosed = false;

async function payForNextChunk(): Promise<void> {
  if (paymentInFlight || streamClosed) {
    return;
  }
  paymentInFlight = true;
  try {
    await client.sendPayment(session);
  } catch (error) {
    console.error(error);
    stop();
    process.exit(1);
  } finally {
    paymentInFlight = false;
  }
}

const stop = client.stream(session.sessionId, (event) => {
  console.log(event);
  if (event.type === "article.usage") {
    void payForNextChunk();
  }
  if (event.type === "session.closed" || event.type === "session.aborted") {
    streamClosed = true;
    stop();
    process.exit(0);
  }
});

await payForNextChunk();
