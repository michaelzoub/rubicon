import { formatAtomicUsdc } from "@rubicon-caliga/core";
import type { ArticleSummary, ArticleNavigation, SellerPaymentTerms } from "@rubicon-caliga/core";
import type { ReadReceipt } from "@rubicon-caliga/agent-sdk";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function printJsonEvent(type: string, value: unknown): void {
  printJson({ type, ...asRecord(value) });
}

export function articleJson(article: ArticleSummary): Record<string, unknown> {
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
    paymentTerms: article.paymentTerms,
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
  return [
    "Payment terms:",
    `- Asset: ${terms.asset}`,
    `- Network: ${terms.networkLabel ?? terms.network}`,
    `- Pay to: ${terms.payTo}`,
    `- Price/word: ${formatAtomic(terms.pricePerWordAtomic)} USDC`,
  ];
}

export function humanNavigation(navigation: ArticleNavigation): string {
  const seller = navigation.sellerAgent;
  const lines = [
    `Recommended section: ${seller.recommendedSectionId}`,
    `Alternatives: ${seller.alternativeSectionIds.length ? seller.alternativeSectionIds.join(", ") : "none"}`,
    `Rationale: ${seller.rationale}`,
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
    lines.push(`- Network: ${receipt.network}`);
  }
  return lines.join("\n");
}

export function formatAtomic(value: string | bigint): string {
  return formatAtomicUsdc(typeof value === "bigint" ? value : BigInt(value));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : { value };
}
