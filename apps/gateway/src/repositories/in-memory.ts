import type {
  ArticleSection,
  ArticleAccessMode,
  ArticleState,
  ArticleSummary,
  CreatorWallet,
  EarningsSummary,
  PaymentActivity,
  SellerAgentConfig,
  SellerAgentMessageRecord,
  SessionRecord,
  WalletNetwork,
  WordDeliveryRecord,
} from "@rubicon-caliga/core";
import { PUBLIC_ARTICLE_STATE } from "@rubicon-caliga/core";
import { hashBuyerAgentIdentity } from "../analytics/identity.js";
import { sectionsFromMarkdown, tokenizeWords } from "../words.js";
import type {
  ArticleRecord,
  LedgerRepository,
  PublishedArticleRepository,
  RecordWordDeliveryResult,
  RecordBundleResult,
  RecordFreeBundleInput,
  RecordPaidBundleInput,
  RecordedBundle,
  RecordSettlementRangeInput,
  SettlementEvidenceInput,
} from "./types.js";

export interface ArticleFixture {
  id: string;
  creatorId: string;
  creatorUsername: string;
  title: string;
  author: string;
  state?: ArticleState;
  accessMode?: ArticleAccessMode;
  pricePerWordAtomic: bigint;
  maxArticlePriceAtomic?: bigint;
  body: string;
  revision?: number;
  sellerAgentConfig?: SellerAgentConfig;
  sections?: ArticleSection[];
}

export interface CreatorWalletFixture {
  creatorId: string;
  address: `0x${string}`;
  network: WalletNetwork;
  verified?: boolean;
}

function buildArticleRecord(fixture: ArticleFixture): ArticleRecord {
  const words = tokenizeWords(fixture.body);
  const sections = fixture.sections ?? sectionsFromMarkdown(fixture.id, fixture.body);
  const now = new Date().toISOString();
  return {
    id: fixture.id,
    creatorId: fixture.creatorId,
    creatorUsername: fixture.creatorUsername,
    title: fixture.title,
    author: fixture.author,
    state: fixture.state ?? "live",
    accessMode: fixture.accessMode ?? "paid",
    pricePerWordAtomic: fixture.pricePerWordAtomic,
    maxArticlePriceAtomic: fixture.maxArticlePriceAtomic,
    totalWords: words.length,
    revision: fixture.revision ?? 1,
    sellerAgentConfig: fixture.sellerAgentConfig,
    body: fixture.body,
    words,
    sections,
    createdAt: now,
    updatedAt: now,
  };
}

export function summarizeArticle(article: ArticleRecord): ArticleSummary {
  const maxPrice =
    article.maxArticlePriceAtomic ?? article.pricePerWordAtomic * BigInt(article.totalWords);
  return {
    articleId: article.id,
    creatorId: article.creatorId,
    creatorUsername: article.creatorUsername,
    title: article.title,
    author: article.author,
    state: article.state,
    accessMode: article.accessMode,
    totalWords: article.totalWords,
    pricePerWordAtomic: `${article.pricePerWordAtomic}`,
    maxArticlePriceAtomic: `${maxPrice}`,
    sections: article.sections.map((section) => ({
      sectionId: section.sectionId,
      heading: section.heading,
      level: section.level,
      wordStart: section.wordStart,
      wordCount: section.wordCount,
    })),
  };
}

/**
 * In-memory development/test adapter for the shared published-article model.
 * In production this is backed by Postgres rows authored through
 * rubicon-marketing. Only `live` articles are exposed publicly.
 */
export class InMemoryPublishedArticleRepository implements PublishedArticleRepository {
  private readonly articles = new Map<string, ArticleRecord>();
  private readonly wallets = new Map<string, CreatorWallet>();
  private readonly baseWallets = new Map<string, CreatorWallet>();

  constructor(input?: { articles?: ArticleFixture[]; wallets?: CreatorWalletFixture[]; baseWallets?: CreatorWalletFixture[] }) {
    for (const fixture of input?.articles ?? []) {
      this.upsertArticle(fixture);
    }
    for (const wallet of input?.wallets ?? []) {
      this.upsertWallet(wallet);
    }
    for (const wallet of input?.baseWallets ?? []) {
      this.upsertBaseWallet(wallet);
    }
  }

  upsertArticle(fixture: ArticleFixture): void {
    this.articles.set(fixture.id, buildArticleRecord(fixture));
  }

  upsertWallet(fixture: CreatorWalletFixture): void {
    this.wallets.set(fixture.creatorId, {
      creatorId: fixture.creatorId,
      address: fixture.address,
      network: fixture.network,
      verified: fixture.verified ?? true,
    });
  }

  upsertBaseWallet(fixture: CreatorWalletFixture): void {
    this.baseWallets.set(fixture.creatorId, {
      creatorId: fixture.creatorId,
      address: fixture.address,
      network: fixture.network,
      verified: fixture.verified ?? true,
    });
  }

  async listPublishedArticles(): Promise<ArticleSummary[]> {
    return [...this.articles.values()]
      .filter((article) => article.state === PUBLIC_ARTICLE_STATE)
      .map((article) => summarizeArticle(article));
  }

  async getPublishedArticle(articleId: string): Promise<ArticleRecord | null> {
    const article = this.articles.get(articleId);
    if (!article || article.state !== PUBLIC_ARTICLE_STATE) {
      return null;
    }
    return article;
  }

  /** State-agnostic lookup for documented existing-session policies. */
  async getArticleAnyState(articleId: string): Promise<ArticleRecord | null> {
    return this.articles.get(articleId) ?? null;
  }

  async getArticleSections(articleId: string): Promise<ArticleSection[]> {
    return this.articles.get(articleId)?.sections ?? [];
  }

  async getCreatorWallet(creatorId: string): Promise<CreatorWallet | null> {
    return this.wallets.get(creatorId) ?? null;
  }

  async getCreatorBaseWallet(creatorId: string): Promise<CreatorWallet | null> {
    return this.baseWallets.get(creatorId) ?? null;
  }
}

interface InternalPayment extends PaymentActivity {
  creatorId: string;
  wordsCount?: number;
}

export class InMemoryLedgerRepository implements LedgerRepository {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly conversations = new Map<
    string,
    { id: string; articleId: string; creatorId: string; goal?: string }
  >();
  private readonly messages = new Map<string, SellerAgentMessageRecord[]>();
  private readonly deliveriesByKey = new Map<string, RecordWordDeliveryResult>();
  private readonly deliveriesBySeq = new Map<string, RecordWordDeliveryResult>();
  private readonly deliveriesBySession = new Map<string, WordDeliveryRecord[]>();
  private readonly paymentsBySession = new Map<string, InternalPayment[]>();
  private readonly bundlesByKey = new Map<string, RecordBundleResult>();
  private readonly bundlesById = new Map<string, RecordedBundle>();
  private readonly settlementKeys = new Set<string>();
  private readonly analyticsEvents: Array<Record<string, unknown>> = [];

  async createSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async saveSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async createConversation(input: {
    id: string;
    articleId: string;
    creatorId: string;
    goal?: string;
  }): Promise<void> {
    this.conversations.set(input.id, input);
  }

  async getConversation(
    conversationId: string,
  ): Promise<{ id: string; articleId: string; creatorId: string; goal?: string } | null> {
    return this.conversations.get(conversationId) ?? null;
  }

  async appendMessage(message: SellerAgentMessageRecord): Promise<void> {
    const list = this.messages.get(message.conversationId) ?? [];
    list.push(message);
    this.messages.set(message.conversationId, list);
  }

  async listMessages(conversationId: string): Promise<SellerAgentMessageRecord[]> {
    return [...(this.messages.get(conversationId) ?? [])];
  }

  async getDeliveryByIdempotencyKey(key: string): Promise<RecordWordDeliveryResult | null> {
    const existing = this.deliveriesByKey.get(key);
    if (!existing) {
      return null;
    }
    return { ...existing, duplicate: true };
  }

  async getBundleByIdempotencyKey(key: string): Promise<RecordBundleResult | null> {
    const existing = this.bundlesByKey.get(key);
    return existing ? { ...existing, duplicate: true } : null;
  }

  async recordPaidBundle(input: RecordPaidBundleInput): Promise<RecordBundleResult> {
    return this.recordBundle(input);
  }

  async recordFreeBundle(input: RecordFreeBundleInput): Promise<RecordBundleResult> {
    return this.recordBundle(input);
  }

  private async recordBundle(input: RecordPaidBundleInput | RecordFreeBundleInput): Promise<RecordBundleResult> {
    const duplicate = this.bundlesByKey.get(input.idempotencyKey);
    if (duplicate) return { ...duplicate, duplicate: true };
    if (input.words.length < 1 || input.words[0]?.sequence !== input.startSequence) {
      throw new Error("invalid_bundle_range");
    }
    const session = this.sessions.get(input.sessionId);
    if (!session) throw new Error("session_not_found");
    if (session.wordsDelivered !== input.startSequence) throw new Error("bundle_session_conflict");

    const wordsCount = input.words.length;
    const endSequence = input.startSequence + wordsCount - 1;
    if (input.words.some((word, offset) => word.sequence !== input.startSequence + offset)) {
      throw new Error("invalid_bundle_range");
    }
    const gross = input.accessMode === "paid" ? input.grossAmountAtomic : 0n;
    if (gross !== input.pricePerWordAtomic * BigInt(wordsCount)) throw new Error("bundle_amount_mismatch");
    const now = new Date().toISOString();
    const hasSettlement = input.accessMode === "paid" && input.settlement !== undefined;
    const bundle: RecordedBundle = {
      bundleId: input.bundleId,
      idempotencyKey: input.idempotencyKey,
      sessionId: input.sessionId,
      creatorId: input.creatorId,
      articleId: input.articleId,
      accessMode: input.accessMode,
      sectionId: input.sectionId,
      bundleSequence: input.bundleSequence,
      startSequence: input.startSequence,
      endSequence,
      wordsCount,
      pricePerWordAtomic: `${input.pricePerWordAtomic}`,
      grossAmountAtomic: `${gross}`,
      creatorAmountAtomic: `${input.accessMode === "paid" ? input.creatorAmountAtomic : 0n}`,
      rubiconFeeAtomic: `${input.accessMode === "paid" ? input.rubiconFeeAtomic : 0n}`,
      paymentId: input.accessMode === "paid" ? input.paymentId : undefined,
      authorizationReference: input.accessMode === "paid" ? input.authorizationReference : undefined,
      buyerWalletAddress: input.accessMode === "paid" ? input.buyerWalletAddress : undefined,
      network: input.accessMode === "paid" ? input.network : undefined,
      payTo: input.accessMode === "paid" ? input.payTo : undefined,
      paymentStatus: input.accessMode === "free" ? "free" : hasSettlement ? input.settlement!.status : "authorized",
      words: input.words.map((word) => ({ ...word })),
      createdAt: now,
      updatedAt: now,
    };

    session.wordsDelivered += wordsCount;
    if (input.accessMode === "paid") {
      session.wordsPaid += wordsCount;
      session.paidAtomic += gross;
    }
    session.metadata = { ...session.metadata, bundleSequence: input.bundleSequence + 1 };
    session.updatedAt = new Date(now);

    const result: RecordBundleResult = {
      duplicate: false,
      bundle,
      wordsDelivered: session.wordsDelivered,
      wordsPaid: session.wordsPaid,
      paidAtomic: `${session.paidAtomic}`,
    };
    this.bundlesByKey.set(input.idempotencyKey, result);
    this.bundlesById.set(input.bundleId, bundle);
    this.analyticsEvents.push(readBundleEvent(bundle));

    const payment: InternalPayment | undefined = input.accessMode === "paid" ? {
      paymentId: input.paymentId,
      sessionId: input.sessionId,
      articleId: input.articleId,
      creatorId: input.creatorId,
      sequence: input.startSequence,
      amountAtomic: `${gross}`,
      creatorAmountAtomic: `${input.creatorAmountAtomic}`,
      rubiconFeeAtomic: `${input.rubiconFeeAtomic}`,
      network: input.network,
      payTo: input.payTo,
      buyerWalletAddress: input.buyerWalletAddress,
      createdAt: now,
      wordsCount,
    } : undefined;
    if (payment) {
      this.paymentsBySession.set(input.sessionId, [...(this.paymentsBySession.get(input.sessionId) ?? []), payment]);
    }
    const deliveries: WordDeliveryRecord[] = input.words.map(({ sequence, word }) => ({
      sessionId: input.sessionId,
      articleId: input.articleId,
      sequence,
      word,
      priceAtomic: `${input.pricePerWordAtomic}`,
      paymentId: payment?.paymentId,
      createdAt: now,
    }));
    this.deliveriesBySession.set(input.sessionId, [...(this.deliveriesBySession.get(input.sessionId) ?? []), ...deliveries]);
    deliveries.forEach((delivery, offset) => {
      const deliveryResult: RecordWordDeliveryResult = { duplicate: false, delivery, payment };
      const deliveryKey = input.words.length === 1 ? input.idempotencyKey : `${input.idempotencyKey}:${delivery.sequence}`;
      this.deliveriesByKey.set(deliveryKey, deliveryResult);
      this.deliveriesBySeq.set(`${input.sessionId}:${delivery.sequence}`, deliveryResult);
      if (offset === 0) this.deliveriesByKey.set(input.idempotencyKey, deliveryResult);
    });
    if (input.accessMode === "paid" && input.settlement) {
      await this.recordSettlementForBundles(input.settlement);
    }
    return result;
  }

  async recordSettlementRange(input: RecordSettlementRangeInput): Promise<void> {
    const bundles = [...this.bundlesById.values()]
      .filter((bundle) => bundle.sessionId === input.sessionId
        && bundle.startSequence >= input.startSequence
        && bundle.endSequence <= input.endSequence);
    if (!hasSettlementEvidence(input)) {
      if (input.status === "failed") {
        for (const bundle of bundles) bundle.paymentStatus = "failed";
      }
      return;
    }
    const bundleIds = bundles.map((bundle) => bundle.bundleId);
    const settlement: SettlementEvidenceInput = { ...input, bundleIds };
    await this.recordSettlementForBundles(settlement);
  }

  private async recordSettlementForBundles(input: SettlementEvidenceInput): Promise<void> {
    if (this.settlementKeys.has(input.idempotencyKey)) return;
    if (!hasSettlementEvidence(input)) return;
    this.settlementKeys.add(input.idempotencyKey);
    for (const bundleId of input.bundleIds) {
      const bundle = this.bundlesById.get(bundleId);
      if (bundle) {
        bundle.paymentStatus = input.status;
        bundle.updatedAt = new Date().toISOString();
      }
    }
    this.analyticsEvents.push({
      eventId: `settlement:${input.idempotencyKey}:v1`,
      eventVersion: 1,
      eventType: "settlement_changed",
      occurredAt: new Date().toISOString(),
      bundleIds: input.bundleIds,
      providerReference: settlementProviderReference(input),
      status: input.status,
    });
  }

  /** Test/debug visibility; event payloads intentionally contain no word text. */
  listAnalyticsEvents(): Array<Record<string, unknown>> {
    return this.analyticsEvents.map((event) => ({ ...event }));
  }

  async listDeliveries(sessionId: string): Promise<WordDeliveryRecord[]> {
    return [...(this.deliveriesBySession.get(sessionId) ?? [])];
  }

  async listPayments(sessionId: string): Promise<PaymentActivity[]> {
    return (this.paymentsBySession.get(sessionId) ?? []).map(({ creatorId: _creatorId, ...rest }) => rest);
  }

  async earningsForArticle(articleId: string): Promise<EarningsSummary> {
    return this.sumEarnings((payment) => payment.articleId === articleId, { articleId });
  }

  async earningsForCreator(creatorId: string): Promise<EarningsSummary> {
    return this.sumEarnings((payment) => payment.creatorId === creatorId, { creatorId });
  }

  private sumEarnings(
    predicate: (payment: InternalPayment) => boolean,
    scope: { creatorId?: string; articleId?: string },
  ): EarningsSummary {
    let words = 0;
    let creatorAmount = 0n;
    let rubiconFee = 0n;
    let creatorId = scope.creatorId ?? "";
    for (const payments of this.paymentsBySession.values()) {
      for (const payment of payments) {
        if (!predicate(payment)) {
          continue;
        }
        words += payment.wordsCount ?? 1;
        creatorAmount += BigInt(payment.creatorAmountAtomic);
        rubiconFee += BigInt(payment.rubiconFeeAtomic);
        creatorId = payment.creatorId;
      }
    }
    return {
      creatorId,
      articleId: scope.articleId,
      wordsDelivered: words,
      creatorAmountAtomic: `${creatorAmount}`,
      rubiconFeeAtomic: `${rubiconFee}`,
    };
  }
}

function readBundleEvent(bundle: RecordedBundle): Record<string, unknown> {
  return {
    eventId: `read_bundle:${bundle.bundleId}:v1`,
    eventVersion: 1,
    eventType: "read_bundle_committed",
    occurredAt: bundle.createdAt,
    bundleId: bundle.bundleId,
    creatorId: bundle.creatorId,
    articleId: bundle.articleId,
    sessionId: bundle.sessionId,
    accessMode: bundle.accessMode,
    sectionId: bundle.sectionId,
    startSequence: bundle.startSequence,
    endSequence: bundle.endSequence,
    wordsCount: bundle.wordsCount,
    grossAmountAtomic: bundle.grossAmountAtomic,
    creatorAmountAtomic: bundle.creatorAmountAtomic,
    rubiconFeeAtomic: bundle.rubiconFeeAtomic,
    buyerAgentHash: hashBuyerAgentIdentity(bundle.buyerWalletAddress),
  };
}

function hasSettlementEvidence(
  input: Pick<SettlementEvidenceInput,
    "transferId" | "settlementId" | "settlementIds" | "transactionHash" | "transactionHashes">,
): boolean {
  return Boolean(
    input.transferId
    || input.settlementId
    || input.settlementIds?.length
    || input.transactionHash
    || input.transactionHashes?.length
  );
}

function settlementProviderReference(input: SettlementEvidenceInput): string {
  return input.transferId
    ?? input.settlementId
    ?? input.settlementIds?.[0]
    ?? input.transactionHash
    ?? input.transactionHashes?.[0]
    ?? "";
}
