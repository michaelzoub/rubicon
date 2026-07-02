import type {
  GatewayEvent,
  SessionRecord,
  StreamPaymentResponse,
  WordPaymentReceipt,
} from "@rubicon-caliga/core";
import type { PaymentVerifier } from "../payments/types.js";
import type { ArticleRecord, LedgerRepository, PublishedArticleRepository } from "../repositories/types.js";
import { wordsForSection } from "../words.js";

export interface StreamState {
  article: ArticleRecord;
  words: string[];
  sectionId: string;
}

interface PaidReadingWorkflowOptions {
  articles: PublishedArticleRepository;
  ledger: LedgerRepository;
  paymentVerifier: PaymentVerifier;
  publish: (event: GatewayEvent) => void;
}

/** Owns server-side reading state and paid-session lifecycle transitions. */
export class PaidReadingWorkflow {
  private readonly streamStates = new Map<string, StreamState>();

  constructor(private readonly options: PaidReadingWorkflowOptions) {}

  rememberSession(sessionId: string, state: StreamState): void {
    this.streamStates.set(sessionId, state);
  }

  nextWord(state: StreamState, nextIndex: number): string | null {
    if (nextIndex < 0 || nextIndex >= state.words.length) return null;
    return state.words[nextIndex] ?? null;
  }

  async resolveStreamState(session: SessionRecord): Promise<StreamState | undefined> {
    const existing = this.streamStates.get(session.id);
    if (existing) return existing;
    const article =
      (await this.getArticleAnyState(session.articleId)) ??
      (await this.options.articles.getPublishedArticle(session.articleId));
    if (!article) return undefined;
    const slice = wordsForSection(article.words, article.sections, session.sectionId);
    if (!slice) return undefined;
    const rebuilt = { article, words: slice.words, sectionId: session.sectionId ?? "full-article" };
    this.streamStates.set(session.id, rebuilt);
    return rebuilt;
  }

  async complete(session: SessionRecord, articleId: string): Promise<void> {
    session.state = "completed";
    await this.options.ledger.saveSession(session);
    this.streamStates.delete(session.id);
    await this.options.paymentVerifier.flush?.().catch(() => {});
    this.options.publish({
      type: "article.completed",
      sessionId: session.id,
      articleId,
      totalWordsStreamed: session.wordsDelivered,
      totalPaidAtomic: `${session.paidAtomic}`,
    });
    this.options.publish({ type: "session.closed", sessionId: session.id, reason: "article_completed" });
  }

  async close(session: SessionRecord, reason: string): Promise<void> {
    session.state = reason === "budget_exhausted" ? "expired" : "aborted";
    await this.options.ledger.saveSession(session);
    this.streamStates.delete(session.id);
    await this.options.paymentVerifier.flush?.().catch(() => {});
    this.options.publish({ type: "session.aborted", sessionId: session.id, reason });
  }

  private async getArticleAnyState(articleId: string): Promise<ArticleRecord | null> {
    const repository = this.options.articles as PublishedArticleRepository & {
      getArticleAnyState?(id: string): Promise<ArticleRecord | null>;
    };
    return typeof repository.getArticleAnyState === "function"
      ? repository.getArticleAnyState(articleId)
      : null;
  }
}

/** Domain decisions and response construction for paid-reading workflows. */
export function authorizedWordCount(maxAmountAtomic: `${bigint}`, wordPaymentAtomic: `${bigint}`): number {
  return safeNumber(BigInt(maxAmountAtomic) / BigInt(wordPaymentAtomic));
}

export function affordableWordCount(session: SessionRecord, wordPaymentAtomic: bigint): number {
  const remaining = BigInt(session.budget.maxAmountAtomic) - session.paidAtomic;
  return remaining <= 0n ? 0 : safeNumber(remaining / wordPaymentAtomic);
}

export function normalizeChunkWords(maxWords: number | undefined): number {
  if (maxWords === undefined) return 32;
  if (!Number.isInteger(maxWords) || maxWords < 1) return 1;
  // The route still clamps this to the remaining budget and selected article
  // range. Do not impose a hidden 256-word ceiling: clients may intentionally
  // authorize a complete section or article as one payment unit.
  return maxWords;
}

export function buildPaymentResponse(
  session: SessionRecord,
  word: string,
  sequence: number,
  priceAtomic: bigint,
  completed: boolean,
  transactionHash?: string,
  transactionHashes?: string[],
  paymentId = "",
  network?: string,
  payTo?: `0x${string}`,
  settledAt = new Date().toISOString(),
  settlementId?: string,
  settlementIds?: string[],
  buyerWalletAddress?: `0x${string}`,
  transferId?: string,
): StreamPaymentResponse {
  const payment = buildWordReceipt(
    session,
    sequence,
    priceAtomic,
    paymentId,
    network,
    payTo,
    settledAt,
    transactionHash,
    transactionHashes,
    settlementId,
    settlementIds,
    buyerWalletAddress,
    transferId,
  );
  return {
    accepted: true,
    sequence,
    word,
    priceAtomic: `${priceAtomic}`,
    wordsPaid: session.wordsPaid,
    wordsDelivered: session.wordsDelivered,
    paidAtomic: `${session.paidAtomic}`,
    completed,
    payment,
    transactionHash,
    transactionHashes: transactionHashes ?? (transactionHash ? [transactionHash] : undefined),
    settlementId,
    settlementIds,
    buyerWalletAddress,
    transferId,
  };
}

export function buildWordReceipt(
  session: SessionRecord,
  sequence: number,
  priceAtomic: bigint,
  paymentId = "",
  network?: string,
  payTo?: `0x${string}`,
  settledAt = new Date().toISOString(),
  transactionHash?: string,
  transactionHashes?: string[],
  settlementId?: string,
  settlementIds?: string[],
  buyerWalletAddress?: `0x${string}`,
  transferId?: string,
  bundle?: {
    bundleSequence: number;
    startSequence: number;
    endSequence: number;
    wordsDelivered: number;
    pricePerWordAtomic: bigint;
    text: string;
  },
): WordPaymentReceipt | undefined {
  if (!paymentId) return undefined;
  return {
    paymentId,
    sessionId: session.id,
    articleId: session.articleId,
    sequence,
    meteringUnit: "word",
    amountAtomic: `${priceAtomic}`,
    bundleSequence: bundle?.bundleSequence,
    startSequence: bundle?.startSequence,
    endSequence: bundle?.endSequence,
    wordsDelivered: bundle?.wordsDelivered,
    pricePerWordAtomic: bundle ? `${bundle.pricePerWordAtomic}` : undefined,
    text: bundle?.text,
    currency: "USDC",
    network,
    payTo,
    transactionHash,
    transactionHashes: transactionHashes ?? (transactionHash ? [transactionHash] : undefined),
    settlementId,
    settlementIds,
    buyerWalletAddress,
    transferId,
    settledAt,
  };
}

function safeNumber(value: bigint): number {
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(value > maxSafe ? maxSafe : value);
}
