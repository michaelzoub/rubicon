export interface SettlementNetworkInfo {
  network: string;
  networkLabel: string;
  circleChain?: string;
  environment: "testnet" | "mainnet" | "unknown";
  fundingMethod: string;
  buyerWalletExplanation?: string;
}

const ARC_TESTNET: SettlementNetworkInfo = {
  network: "eip155:5042002",
  networkLabel: "Arc Testnet",
  circleChain: "ARC-TESTNET",
  environment: "testnet",
  fundingMethod:
    "Circle testnet funds on ARC-TESTNET. Use Circle's testnet faucet / Gateway testnet funding flow; do not send mainnet fiat or crypto.",
  buyerWalletExplanation:
    "Circle CLI signs with the Agent Wallet, while x402/Gateway receipts may show the Gateway backing EOA that actually authorizes settlement.",
};

const NETWORKS: SettlementNetworkInfo[] = [ARC_TESTNET];

export function settlementNetworkInfo(network: string | undefined): SettlementNetworkInfo {
  if (!network) {
    return {
      network: "",
      networkLabel: "Unknown",
      environment: "unknown",
      fundingMethod: "Funding method unknown. Inspect the article paymentTerms.network before funding.",
    };
  }
  const normalized = network.trim().toLowerCase();
  const found = NETWORKS.find(
    (candidate) =>
      candidate.network.toLowerCase() === normalized ||
      candidate.networkLabel.toLowerCase() === normalized ||
      candidate.circleChain?.toLowerCase() === normalized ||
      normalized === "arc-testnet",
  );
  if (found) return found;
  return {
    network,
    networkLabel: network,
    environment: network.toLowerCase().includes("test") ? "testnet" : "unknown",
    fundingMethod: "Funding method unknown. Confirm the mapped Circle chain before funding.",
  };
}
