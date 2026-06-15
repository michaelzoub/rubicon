import { ProviderServer } from "@rubicon/provider-sdk";

const server = new ProviderServer({
  providerId: "mock-compute",
  gatewayBaseUrl: process.env.GATEWAY_BASE_URL ?? "http://localhost:8787",
  sharedSecret: process.env.PROVIDER_SHARED_SECRET ?? "dev-provider-secret",
  handler: async (job, context) => {
    for (let second = 1; second <= 5; second += 1) {
      if (context.signal.aborted) {
        return;
      }
      await delay(1_000);
      await context.emitOutput({
        text: `chunk ${second}: processed ${JSON.stringify(job.input)}`,
      });
      await context.reportUsage({
        unit: "second",
        quantity: 1,
        providerCostAtomic: "100",
        gatewayFeeAtomic: "2",
        totalCostAtomic: "102",
      });
    }

    await context.complete({ ok: true, summary: "mock compute completed" });
  },
});

await server.listen(Number(process.env.PROVIDER_PORT ?? 8790));

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
