import { formatAtomicUsdc, settlementNetworkInfo } from "@rubicon-caliga/core";
import type { ArticleSummary, ArticleNavigation, SellerPaymentTerms } from "@rubicon-caliga/core";
import type { ReadReceipt } from "@rubicon-caliga/agent-sdk/agent-client";
import type { StoredReceipt } from "./receipts.js";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function printJsonEvent(type: string, value: unknown): void {
  printJson({ type, ...asRecord(value) });
}

export function articleJson(article: ArticleSummary): Record<string, unknown> {
  const paymentTerms = article.paymentTerms ? enrichedPaymentTerms(article.paymentTerms) : undefined;
  return {
    articleId: article.articleId,
    title: article.title,
    author: article.author,
    creatorId: article.creatorId,
    creatorUsername: article.creatorUsername,
    state: article.state,
    totalWords: article.totalWords,
    pricePerWordAtomic: article.pricePerWordAtomic,
    maxArticlePriceAtomic: article.maxArticlePriceAtomic,
    paymentTerms,
    sections: article.sections,
  };
}

export function humanArticle(article: ArticleSummary): string {
  const lines = [
    `Article: ${article.title}`,
    `ID: ${article.articleId}`,
    `Author: ${article.author}`,
    `Creator: ${article.creatorUsername}`,
    `Words: ${article.totalWords.toLocaleString("en-US")}`,
    `Price/word: ${formatAtomic(article.pricePerWordAtomic)} USDC`,
    `Max article price: ${formatAtomic(article.maxArticlePriceAtomic)} USDC`,
  ];
  if (article.paymentTerms) {
    lines.push("", ...humanPaymentTerms(article.paymentTerms));
  }
  if (article.sections.length > 0) {
    lines.push("", "Sections:");
    for (const section of article.sections) {
      lines.push(`- ${section.sectionId}: ${section.heading} (${section.wordCount.toLocaleString("en-US")} words)`);
    }
  }
  return lines.join("\n");
}

export function humanPaymentTerms(terms: SellerPaymentTerms): string[] {
  const enriched = enrichedPaymentTerms(terms);
  return [
    "Payment terms:",
    `- Asset: ${enriched.asset}`,
    `- Network: ${enriched.networkLabel ?? enriched.network}`,
    enriched.circleChain ? `- Circle chain: ${enriched.circleChain}` : undefined,
    enriched.environment ? `- Environment: ${enriched.environment}` : undefined,
    enriched.fundingMethod ? `- Funding: ${enriched.fundingMethod}` : undefined,
    `- Pay to: ${terms.payTo}`,
    `- Price/word: ${formatAtomic(terms.pricePerWordAtomic)} USDC`,
  ].filter((line): line is string => line !== undefined);
}

export function humanNavigation(navigation: ArticleNavigation): string {
  const seller = navigation.sellerAgent;
  const recommendedReadCommand = recommendedReadCommandFor(navigation.articleId, seller.recommendedSectionId);
  const lines = [
    `Recommended section: ${seller.recommendedSectionId}`,
    `Alternatives: ${seller.alternativeSectionIds.length ? seller.alternativeSectionIds.join(", ") : "none"}`,
    `Rationale: ${seller.rationale}`,
    `Recommended read: ${recommendedReadCommand}`,
  ];
  if (seller.safeHints.length > 0) {
    lines.push("", "Safe hints:", ...seller.safeHints.map((hint) => `- ${hint}`));
  }
  if (seller.withheld.length > 0) {
    lines.push("", "Withheld:", ...seller.withheld.map((notice) => `- ${notice}`));
  }
  if (navigation.sections.length > 0) {
    lines.push("", "Sections:");
    for (const section of navigation.sections) {
      lines.push(`- ${section.sectionId}: ${section.heading} (${section.wordCount.toLocaleString("en-US")} words)`);
    }
  }
  return lines.join("\n");
}

export function humanReceipt(receipt: ReadReceipt): string {
  const networkInfo = settlementNetworkInfo(receipt.network);
  const lines = [
    "Receipt:",
    `- Session: ${receipt.sessionId}`,
    `- Article: ${receipt.articleId}`,
    `- Words read: ${receipt.wordsRead.toLocaleString("en-US")}`,
    `- Amount paid: ${formatAtomic(receipt.amountPaidAtomic)} USDC`,
    `- Stop reason: ${receipt.stopReason}`,
  ];
  if (receipt.settlementIds.length > 0) {
    lines.push(`- Settlement IDs: ${receipt.settlementIds.join(", ")}`);
  }
  if (receipt.transactionHashes.length > 0) {
    lines.push(`- Transaction hashes: ${receipt.transactionHashes.join(", ")}`);
  }
  if (receipt.buyerWalletAddress) {
    lines.push(`- Buyer wallet: ${receipt.buyerWalletAddress}`);
  }
  if (receipt.sellerPayTo) {
    lines.push(`- Seller pay to: ${receipt.sellerPayTo}`);
  }
  if (receipt.network) {
    lines.push(`- Network: ${networkInfo.networkLabel} (${receipt.network})`);
  }
  if (networkInfo.circleChain) {
    lines.push(`- Circle chain: ${networkInfo.circleChain}`);
  }
  if (receipt.buyerWalletAddress && networkInfo.buyerWalletExplanation) {
    lines.push(`- Buyer wallet note: ${networkInfo.buyerWalletExplanation}`);
  }
  return lines.join("\n");
}

export function receiptSummaryJson(stored: StoredReceipt): Record<string, unknown> {
  return {
    receiptId: stored.receiptId,
    savedAt: stored.savedAt,
    ...readReceiptSummaryJson(stored.receipt),
  };
}

export function readReceiptSummaryJson(receipt: ReadReceipt): Record<string, unknown> {
  const networkInfo = settlementNetworkInfo(receipt.network);
  return {
    articleId: receipt.articleId,
    sessionId: receipt.sessionId,
    wordsRead: receipt.wordsRead,
    amountPaidAtomic: receipt.amountPaidAtomic,
    amountPaidUsdc: formatAtomic(receipt.amountPaidAtomic),
    stopReason: receipt.stopReason,
    completed: receipt.completed,
    buyerWalletAddress: receipt.buyerWalletAddress,
    sellerPayTo: receipt.sellerPayTo,
    network: receipt.network,
    circleChain: networkInfo.circleChain,
    buyerWalletExplanation: receipt.buyerWalletAddress ? networkInfo.buyerWalletExplanation : undefined,
    settlementIds: receipt.settlementIds,
    transactionHashes: receipt.transactionHashes,
    text: receipt.text,
  };
}

export function humanReceiptSummary(receipt: ReadReceipt, receiptId?: string): string {
  const networkInfo = settlementNetworkInfo(receipt.network);
  const lines = [
    "Summary:",
    receiptId ? `- Receipt ID: ${receiptId}` : undefined,
    `- Article: ${receipt.articleId}`,
    `- Words read: ${receipt.wordsRead.toLocaleString("en-US")}`,
    `- Amount paid: ${formatAtomic(receipt.amountPaidAtomic)} USDC`,
    `- Stop reason: ${receipt.stopReason}`,
    receipt.buyerWalletAddress ? `- Buyer wallet: ${receipt.buyerWalletAddress}` : undefined,
    receipt.sellerPayTo ? `- Seller pay to: ${receipt.sellerPayTo}` : undefined,
    receipt.network ? `- Network: ${networkInfo.networkLabel} (${receipt.network})` : undefined,
    networkInfo.circleChain ? `- Circle chain: ${networkInfo.circleChain}` : undefined,
    receipt.buyerWalletAddress && networkInfo.buyerWalletExplanation
      ? `- Buyer wallet note: ${networkInfo.buyerWalletExplanation}`
      : undefined,
    "",
    receipt.text,
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

export function formatAtomic(value: string | bigint): string {
  return formatAtomicUsdc(typeof value === "bigint" ? value : BigInt(value));
}

export function recommendedReadCommandFor(articleId: string, sectionId: string): string {
  return `rubicon read ${articleId} --section ${sectionId} --stop-after-section --max-usdc <amount>`;
}

function enrichedPaymentTerms(terms: SellerPaymentTerms): SellerPaymentTerms {
  const networkInfo = settlementNetworkInfo(terms.network);
  return {
    ...terms,
    networkLabel: terms.networkLabel ?? networkInfo.networkLabel,
    circleChain: terms.circleChain ?? networkInfo.circleChain,
    environment: terms.environment ?? networkInfo.environment,
    fundingMethod: terms.fundingMethod ?? networkInfo.fundingMethod,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : { value };
}
