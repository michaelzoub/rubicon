import { GatewayClient } from "@circle-fin/x402-batching/client";

// Buyer-side funding helper for a real Arc testnet run.
//
//   pnpm --filter @rubicon-caliga/agent-example fund          # show balances
//   pnpm --filter @rubicon-caliga/agent-example fund 0.1      # deposit 0.1 USDC into Gateway
//
// Reads CIRCLE_PRIVATE_KEY / CIRCLE_CHAIN / CIRCLE_RPC_URL from the root .env.

const privateKey = process.env.CIRCLE_PRIVATE_KEY as `0x${string}` | undefined;
if (!privateKey) {
  throw new Error("CIRCLE_PRIVATE_KEY is not set — fill it in .env before funding.");
}

const gateway = new GatewayClient({
  chain: (process.env.CIRCLE_CHAIN ?? "arcTestnet") as never,
  privateKey,
  rpcUrl: process.env.CIRCLE_RPC_URL,
});

const depositAmount = process.argv[2];

console.log("buyer address:", gateway.address);
console.log("chain:", gateway.getChainName());

const before = await gateway.getBalances();
console.log("balances (before):", before);

if (depositAmount) {
  console.log(`depositing ${depositAmount} USDC into Circle Gateway…`);
  const result = await gateway.deposit(depositAmount);
  console.log("deposit result:", result);
  const after = await gateway.getBalances();
  console.log("balances (after):", after);
} else {
  console.log("\nNo deposit amount passed. To deposit, e.g.:");
  console.log("  pnpm --filter @rubicon-caliga/agent-example fund 0.1");
}
