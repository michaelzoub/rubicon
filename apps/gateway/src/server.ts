import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import {
  canAffordNextWord,
  createSession,
  isSessionExpired,
  quotePerWord,
  settlementNetworkInfo,
  usageForWords,
  lexicalSearch,
  type ArticleNavigation,
  type AnalyzeAuthorshipRequest,
  type AnalyzeAuthorshipResponse,
  type ArticleSummary,
  type ConversationMessage,
  type GatewayEvent,
  type SearchResponse,
  type SellerAgentMessageRecord,
  type SellerPaymentTerms,
  type SendConversationMessageRequest,
  type SendConversationMessageResponse,
  type SessionRecord,
  type StartConversationRequest,
  type StartConversationResponse,
  type StartSessionRequest,
  type StartSessionResponse,
  type StreamChunkResponse,
  type StreamPaymentRequest,
  type StreamPaymentResponse,
  type StreamStopCondition,
} from "@rubicon-caliga/core";
import { InMemoryEventBus } from "./stores/event-bus.js";
import { summarizeArticle } from "./repositories/in-memory.js";
import type {
  ArticleRecord,
  LedgerRepository,
  PublishedArticleRepository,
  RecordBundleResult,
  SettlementEvidenceInput,
} from "./repositories/types.js";
import { DevelopmentPaymentVerifier, type PaymentVerifier, type PaymentVerificationResult } from "./payments/types.js";
import { selectionFromRequest, wordsForSelection } from "./words.js";
import { buildSearchResults } from "./search/search-service.js";
import { routeArticleSections } from "./search/section-router.js";
import { buildOpenApiDocument } from "./discovery/openapi.js";
import { RUBICON_W_LOGO_SVG } from "./discovery/w-logo.js";
import { resolveBaseX402Config, type BaseX402Config } from "./chain-base.js";
import {
  buildBaseChallenge,
  publicIconUrl,
  resolveBaseX402Verifier,
  type BaseX402Verifier,
} from "./payments/x402-base.js";
import {
  affordableWordCount,
  authorizedWordCount,
  buildPaymentResponse,
  buildWordReceipt,
  normalizeChunkWords,
  PaidReadingWorkflow,
} from "./workflows/paid-reading.js";
import type { AnalyticsHealth } from "./analytics/types.js";
import { createAuthorshipProviderRegistry } from "./authorship/registry.js";
import { AuthorshipProviderError, type AuthorshipProvider } from "./authorship/types.js";

export interface GatewayOptions {
  articleRepository: PublishedArticleRepository;
  ledger: LedgerRepository;
  paymentVerifier?: PaymentVerifier;
  sessionTtlMs: number;
  /** Rubicon fee in basis points. Defaults to 0 — creators keep the full word price. */
  gatewayFeeBps?: number;
  gatewayBaseUrl?: string;
  logger?: boolean;
  /** Resolved deployment environment included in logs and health responses. */
  appEnv?: "development" | "staging" | "production";
  /** Selected environment profile. Defaults to process.env for direct test construction. */
  env?: NodeJS.ProcessEnv;
  /** Query embedder for semantic search. Null when OPENAI_API_KEY is unset (lexical fallback). */
  queryEmbedder?: ((q: string) => Promise<number[] | null>) | null;
  /** Version advertised in the /openapi.json discovery document. */
  version?: string;
  /**
   * Verifier for the AgentCash x402 (Base) purchase lane. Defaults to a safe
   * verifier that refuses any payment it cannot verify (so the endpoint is
   * discoverable and payment-advertising, but never releases content without a
   * real, verified Base payment). Inject a CDP/facilitator-backed verifier to
   * collect funds.
   */
  baseX402Verifier?: BaseX402Verifier;
  /** Read-only outbox/worker health. Analytics availability never gates reads. */
  analyticsHealth?: () => Promise<AnalyticsHealth>;
  /** Test seam for the fixed authorship-provider allowlist. */
  authorshipProviders?: ReadonlyMap<string, AuthorshipProvider>;
}

const STOP_CONDITIONS: StreamStopCondition[] = [
  { kind: "sufficient_information", description: "Stop once the buyer agent has enough paid words for its task." },
  { kind: "max_words", description: "Stop after a buyer-selected word limit." },
  { kind: "max_payments", description: "Stop after a buyer-selected number of word payments." },
  { kind: "max_spend_atomic", description: "Stop before exceeding the buyer-selected atomic USDC spend limit." },
  { kind: "article_completed", description: "Stop automatically when the selected section or article is complete." },
  { kind: "payment_rejected", description: "Stop if authorization verification or settlement fails." },
];

function applyBundleCounters(session: SessionRecord, record: RecordBundleResult): void {
  session.wordsDelivered = record.wordsDelivered;
  session.wordsPaid = record.wordsPaid;
  session.paidAtomic = BigInt(record.paidAtomic);
  session.metadata = { ...session.metadata, bundleSequence: record.bundle.bundleSequence + 1 };
  session.updatedAt = new Date(record.bundle.updatedAt);
}

function streamResponseFromBundle(record: RecordBundleResult, completed: boolean): StreamChunkResponse {
  const words = record.bundle.words.map(({ sequence, word }) => ({
    sequence,
    word,
    priceAtomic: record.bundle.pricePerWordAtomic,
  }));
  return {
    accepted: true,
    words,
    text: words.map((entry) => entry.word).join(" "),
    wordsPaid: record.wordsPaid,
    wordsDelivered: record.wordsDelivered,
    paidAtomic: record.paidAtomic,
    completed,
    authorizationMode: record.bundle.accessMode === "paid" ? "chunk" : undefined,
  };
}

function paidChunkResponseFromBundle(record: RecordBundleResult, session: SessionRecord): StreamChunkResponse {
  const response = streamResponseFromBundle(record, session.state === "completed");
  const text = response.text;
  return {
    ...response,
    authorizationMode: "chunk",
    payment: buildWordReceipt(
      session,
      record.bundle.startSequence,
      BigInt(record.bundle.grossAmountAtomic),
      record.bundle.paymentId,
      record.bundle.network,
      record.bundle.payTo,
      record.bundle.createdAt,
      undefined,
      undefined,
      undefined,
      undefined,
      record.bundle.buyerWalletAddress,
      undefined,
      {
        bundleSequence: record.bundle.bundleSequence,
        startSequence: record.bundle.startSequence,
        endSequence: record.bundle.endSequence,
        wordsDelivered: record.bundle.wordsCount,
        pricePerWordAtomic: BigInt(record.bundle.pricePerWordAtomic),
        text,
      },
    ),
  };
}

function settlementEvidenceFromVerification(
  verification: PaymentVerificationResult,
  bundleId: string,
): SettlementEvidenceInput | undefined {
  const providerReference = verification.transferId
    ?? verification.settlementId
    ?? verification.settlementIds?.[0]
    ?? verification.transactionHash
    ?? verification.transactionHashes?.[0];
  if (!providerReference) return undefined;
  const provider = verification.network === "development" ? "development" : "circle-x402";
  return {
    provider,
    status: "completed",
    idempotencyKey: `${provider}:${providerReference}:completed`,
    bundleIds: [bundleId],
    network: verification.network,
    payTo: verification.payTo,
    buyerWalletAddress: verification.buyerWalletAddress,
    transactionHash: verification.transactionHash,
    transactionHashes: verification.transactionHashes,
    settlementId: verification.settlementId,
    settlementIds: verification.settlementIds,
    transferId: verification.transferId,
    initiatedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
  };
}

// AgentCash/x402scan validates the schema carried by a runtime 402 in addition
// to the OpenAPI document. Keep this in sync with the /v1/sessions operation:
// it is only metadata, never buyer-supplied payment or article state.
const SESSION_DISCOVERY_BAZAAR_SCHEMA = {
  properties: {
    input: {
      properties: {
        body: {
          type: "object",
          required: ["articleId", "budget"],
          properties: {
            articleId: { type: "string", description: "Published article ID to read." },
            budget: {
              type: "object",
              required: ["currency", "maxAmountAtomic"],
              properties: {
                currency: { type: "string", const: "USDC" },
                maxAmountAtomic: { type: "string", pattern: "^[0-9]+$" },
              },
            },
            goal: { type: "string" },
            sectionIds: { type: "array", items: { type: "string" } },
            wordStart: { type: "integer", minimum: 0 },
            wordCount: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    output: {
      properties: {
        example: {
          sessionId: "session_example",
          accessMode: "paid",
          authorizationMode: "word",
          wordPaymentAtomic: "100",
          expiresAt: "2026-07-10T00:00:00.000Z",
        },
      },
    },
  },
} as const;

const ENDPOINTS = [
  { method: "GET", path: "/health", description: "Gateway health check." },
  { method: "GET", path: "/health/analytics", description: "Analytics outbox backlog and worker health." },
  { method: "GET", path: "/v1/endpoints", description: "Lists gateway endpoints." },
  { method: "GET", path: "/openapi.json", description: "AgentCash/x402 discovery document (OpenAPI 3.1.0)." },
  { method: "GET", path: "/v1/repository", description: "Lists live articles available to buyer agents. Optional ?q= ranks results by search relevance." },
  { method: "GET", path: "/v1/search", description: "Semantic or lexical search over live articles. Requires ?q= query." },
  { method: "GET", path: "/v1/articles/:articleId/navigation", description: "Safe seller-agent navigation; no unpaid body text." },
  { method: "POST", path: "/v1/seller-agent/conversations", description: "Opens a conversation with an article's seller agent." },
  { method: "POST", path: "/v1/seller-agent/conversations/:conversationId/messages", description: "Sends a message to the seller agent." },
  { method: "POST", path: "/v1/authorship/analyze", description: "Optionally analyzes a private article before a paid session is created." },
  { method: "POST", path: "/v1/x402/articles/:articleId", description: "AgentCash lane: buy a whole article in one x402 USDC payment on Base. Unpaid requests return the x402 402 challenge." },
  { method: "POST", path: "/v1/sessions", description: "Opens a budgeted reading session and returns Circle / Arc authorization terms." },
  { method: "POST", path: "/v1/sessions/:sessionId/stream", description: "Preferred path: streams words against a session-level authorization." },
  { method: "POST", path: "/v1/sessions/:sessionId/payments", description: "Compatibility path: verifies a chunk or legacy one-word payment and releases authorized words." },
  { method: "GET", path: "/v1/sessions/:sessionId/events", description: "Server-sent word-level events." },
  { method: "POST", path: "/v1/sessions/:sessionId/abort", description: "Aborts a session." },
];

export function createGateway(options: GatewayOptions): FastifyInstance {
  const runtimeEnv = options.env ?? process.env;
  const appEnv = options.appEnv ?? (
    runtimeEnv.APP_ENV === "staging" || runtimeEnv.APP_ENV === "production"
      ? runtimeEnv.APP_ENV
      : "development"
  );
  const app = Fastify({
    logger: options.logger === false ? false : {
      base: { appEnv },
      redact: ["req.headers.x-rubicon-pangram-api-key", "headers.x-rubicon-pangram-api-key"],
    },
  });
  const events = new InMemoryEventBus();
  const paymentVerifier: PaymentVerifier = options.paymentVerifier ?? new DevelopmentPaymentVerifier();
  const ledger = options.ledger;
  const articles = options.articleRepository;
  const gatewayFeeBps = options.gatewayFeeBps ?? 0;
  const gatewayBaseUrl = options.gatewayBaseUrl ?? `http://localhost:${runtimeEnv.GATEWAY_PORT ?? runtimeEnv.PORT ?? 8787}`;
  const agentApiKey = runtimeEnv.RUBICON_AGENT_API_KEY;
  const queryEmbedder = options.queryEmbedder ?? null;
  const authorshipProviders = options.authorshipProviders ?? createAuthorshipProviderRegistry();
  // AgentCash x402 (Base) purchase lane. Config is env-driven and isolated from
  // the Circle/Arc path; a bad config disables the lane rather than crashing boot.
  let baseX402Config: BaseX402Config | undefined;
  try {
    baseX402Config = resolveBaseX402Config(runtimeEnv);
  } catch (error) {
    app.log.warn(`[gateway] Base x402 lane disabled: ${(error as Error).message}`);
  }
  const baseX402Verifier: BaseX402Verifier =
    options.baseX402Verifier ?? resolveBaseX402Verifier(baseX402Config?.network ?? "eip155:8453", runtimeEnv);
  const paidReading = new PaidReadingWorkflow({
    articles,
    ledger,
    paymentVerifier,
    publish: (event) => events.publish(event),
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !agentApiKey ||
      request.url.startsWith("/health") ||
      request.url === "/openapi.json" ||
      request.url === "/favicon.ico" ||
      // AgentCash x402 (Base) purchase lane is gated by x402 payment, not the
      // agent bearer token — keep it reachable so discovery crawlers can probe it.
      request.url.startsWith("/v1/x402/")
    ) {
      return;
    }
    const authorization = request.headers.authorization;
    const expected = `Bearer ${agentApiKey}`;
    if (authorization !== expected) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  // Flush settlements batched behind the stream before the process exits.
  app.addHook("onClose", async () => {
    await paymentVerifier.drain?.().catch(() => {});
  });

  async function buildNavigation(article: ArticleRecord, goal?: string): Promise<ArticleNavigation> {
    const route = await routeArticleSections({ article, query: goal ?? "", repo: articles, embedder: queryEmbedder });
    const candidates = route.candidates;
    const recommended = article.sections.find((section) => section.sectionId === candidates[0]?.sectionId)
      ?? article.sections.find((section) => section.sectionId !== "full-article")
      ?? article.sections[0];
    const alternatives = candidates.slice(1)
      .map((candidate) => candidate.sectionId)
      .filter((sectionId) => article.sections.some((section) => section.sectionId === sectionId));
    const confidence = candidates[0]?.confidence ?? 0;
    return {
      articleId: article.id,
      sections: summarizeArticle(article).sections,
      sellerAgent: {
        recommendedSectionId: recommended?.sectionId ?? "full-article",
        alternativeSectionIds: alternatives,
        retrievalMode: route.mode,
        confidence,
        sectionAssessments: candidates.map((candidate) => {
          const section = article.sections.find((item) => item.sectionId === candidate.sectionId)!;
          return {
            sectionId: section.sectionId,
            expectedValue: candidate.confidence,
            minimumUsefulWords: Math.min(section.wordCount, Math.max(1, Math.ceil(section.wordCount * 0.35))),
            rationale: "Validated section-routing signal.",
          };
        }),
        rationale: confidence < 0.35
          ? "This is a low-confidence navigation match; consider the alternatives."
          : "This is the closest validated section match.",
        safeHints: recommended ? [
          `The closest match is “${recommended.heading}” (${recommended.wordCount} words).`,
          article.accessMode === "free"
            ? "This article is free to read."
            : `Price: ${article.pricePerWordAtomic} atomic USDC per word.`,
        ] : ["No narrower section is available; use the full article reading path."],
        withheld: ["section body text", "quotes", "summaries", "conclusions", "extracted facts"],
      },
      stopConditions: STOP_CONDITIONS,
    };
  }

  async function withPaymentTerms(summaries: ArticleSummary[]): Promise<ArticleSummary[]> {
    return Promise.all(
      summaries.map(async (summary) => {
        const withSources = {
          ...summary,
          sources: articleSources(summary.articleId),
        };
        if (summary.accessMode === "free") {
          return withSources;
        }
        const wallet = await articles.getCreatorWallet(summary.creatorId);
        if (!wallet?.verified) {
          return withSources;
        }
        return {
          ...withSources,
          paymentTerms: paymentTerms(summary.pricePerWordAtomic, wallet.address, wallet.network),
        };
      }),
    );
  }

  async function articleSummaryWithPaymentTerms(article: ArticleRecord): Promise<ArticleSummary> {
    const summary = summarizeArticle(article);
    const withSources = {
      ...summary,
      sources: articleSources(article.id),
    };
    if (article.accessMode === "free") {
      return withSources;
    }
    const wallet = await articles.getCreatorWallet(article.creatorId);
    if (!wallet?.verified) {
      return withSources;
    }
    return {
      ...withSources,
      paymentTerms: paymentTerms(summary.pricePerWordAtomic, wallet.address, wallet.network),
    };
  }

  function articleSources(articleId: string) {
    return [{
      title: "Rubicon article navigation",
      url: new URL(`/v1/articles/${encodeURIComponent(articleId)}/navigation`, gatewayBaseUrl).href,
      type: "article_navigation" as const,
    }];
  }

  function paymentTerms(
    pricePerWordAtomic: `${bigint}`,
    payTo: `0x${string}`,
    network: string,
  ): SellerPaymentTerms {
    const networkInfo = settlementNetworkInfo(network);
    return {
      asset: "USDC",
      network,
      networkLabel: networkInfo.networkLabel,
      circleChain: networkInfo.circleChain,
      environment: networkInfo.environment,
      fundingMethod: networkInfo.fundingMethod,
      payTo,
      pricePerWordAtomic,
      meteringUnit: "word",
    };
  }

  async function releaseFreeChunk(
    session: SessionRecord,
    requestedWords: number,
    idempotencyBase: string,
  ): Promise<StreamChunkResponse | undefined> {
    if (session.accessMode !== "free" || session.pricePerWordAtomic !== 0n) return undefined;
    const state = await paidReading.resolveStreamState(session);
    if (!state) return undefined;
    const remaining = Math.max(0, state.words.length - session.wordsDelivered);
    const maxWords = Math.min(requestedWords, remaining);
    const startSequence = session.wordsDelivered;
    const existing = await ledger.getBundleByIdempotencyKey(idempotencyBase);
    if (existing) {
      applyBundleCounters(session, existing);
      return streamResponseFromBundle(existing, session.state === "completed");
    }
    const words = state.words.slice(startSequence, startSequence + maxWords)
      .map((word, offset) => ({ sequence: startSequence + offset, word }));
    if (words.length === 0) {
      return {
        accepted: true,
        words: [],
        text: "",
        wordsPaid: 0,
        wordsDelivered: session.wordsDelivered,
        paidAtomic: "0",
        completed: true,
      };
    }
    const bundleSequence = typeof session.metadata.bundleSequence === "number" ? session.metadata.bundleSequence : 0;
    const record = await ledger.recordFreeBundle({
      accessMode: "free",
      bundleId: randomUUID(),
      idempotencyKey: idempotencyBase,
      sessionId: session.id,
      creatorId: session.creatorId,
      articleId: session.articleId,
      sectionId: session.sectionId,
      bundleSequence,
      startSequence,
      words,
      pricePerWordAtomic: 0n,
    });
    applyBundleCounters(session, record);
    const released: StreamChunkResponse["words"] = record.bundle.words.map(({ sequence, word }) => ({ sequence, word, priceAtomic: "0" }));
    for (const entry of released) {
      events.publish({
        type: "article.word",
        sessionId: session.id,
        articleId: session.articleId,
        sequence: entry.sequence,
        word: entry.word,
        priceAtomic: "0",
        totalWordsStreamed: session.wordsDelivered,
        totalPaidAtomic: "0",
      });
    }

    const text = released.map((entry) => entry.word).join(" ");
    const completed = session.wordsDelivered >= state.words.length;
    if (released.length > 0) {
      events.publish({
        type: "article.bundle",
        sessionId: session.id,
        articleId: session.articleId,
        bundleSequence,
        startSequence,
        endSequence: startSequence + released.length - 1,
        words: released,
        text,
        wordCount: released.length,
        pricePerWordAtomic: "0",
        amountAtomic: "0",
        totalWordsStreamed: session.wordsDelivered,
        totalPaidAtomic: "0",
      });
    }
    events.publish({
      type: "article.usage",
      sessionId: session.id,
      usage: usageForWords({ wordsDelivered: session.wordsDelivered, pricePerWordAtomic: 0n, gatewayFeeBps: 0 }),
      wordsPaid: 0,
      wordsDelivered: session.wordsDelivered,
      paidAtomic: "0",
    });
    if (completed) await paidReading.complete(session, session.articleId);

    return {
      accepted: true,
      words: released,
      text,
      wordsPaid: 0,
      wordsDelivered: session.wordsDelivered,
      paidAtomic: "0",
      completed,
    };
  }

  async function cachedFreeChunk(
    session: SessionRecord,
    idempotencyKey: string | undefined,
  ): Promise<StreamChunkResponse | undefined> {
    if (!idempotencyKey) return undefined;
    const cached = await ledger.getBundleByIdempotencyKey(idempotencyKey);
    if (!cached || cached.bundle.accessMode !== "free") return undefined;
    applyBundleCounters(session, cached);
    return streamResponseFromBundle(cached, session.state === "completed");
  }

  app.get("/health", async () => ({ ok: true, appEnv }));
  app.get("/health/analytics", async () => ({
    appEnv,
    ...(options.analyticsHealth
      ? await options.analyticsHealth()
      : ({ enabled: false, backlogSize: 0, poisonEventCount: 0, workerRunning: false } satisfies AnalyticsHealth)),
  }));

  app.get("/v1/endpoints", async () => ({ endpoints: ENDPOINTS }));

  // AgentCash / x402 discovery document. Public (exempt from the agent API key)
  // so discovery crawlers can read it without credentials.
  app.get("/openapi.json", async (_request, reply) => {
    const agentCashArticle = await firstBaseEligiblePaidArticle();
    reply.header("content-type", "application/json; charset=utf-8");
    return buildOpenApiDocument({
      baseUrl: gatewayBaseUrl,
      version: options.version ?? "0.1.0",
      // Public merchant contact for x402/AgentCash ownership verification.
      contactEmail: runtimeEnv.RUBICON_CONTACT_EMAIL ?? "micacao15@gmail.com",
      agentCashPurchaseEnabled: Boolean(agentCashArticle),
      agentCashMaxPriceUsd: baseX402Config
        ? decimalUsd(baseX402Config.maxArticlePriceAtomic)
        : undefined,
    });
  });

  // Match the public Rubicon brand asset that x402scan displays for this origin.
  // The source is rubicon-marketing/public/w_logo.svg, served on white so the
  // dark mark remains legible in crawler and browser favicon surfaces.
  app.get("/w_logo.svg", async (_request, reply) => {
    reply.header("content-type", "image/svg+xml").header("cache-control", "public, max-age=86400");
    return RUBICON_W_LOGO_SVG;
  });
  app.get("/favicon.ico", async (_request, reply) => {
    reply.header("content-type", "image/svg+xml").header("cache-control", "public, max-age=86400");
    return RUBICON_W_LOGO_SVG;
  });

  function requestLogStorageFailure(reply: FastifyReply, error: unknown): void {
    reply.log.error({ err: error }, "failed to load article repository from Supabase");
  }

  async function listRepository(reply: FastifyReply, q?: string): Promise<{ repository: "articles"; articles: ArticleSummary[] } | FastifyReply> {
    try {
      const summaries = await withPaymentTerms(await articles.listPublishedArticles());
      if (!q || !q.trim()) {
        return { repository: "articles", articles: summaries };
      }
      // When ?q= is present, rank/filter by lexical search but keep the exact
      // { repository, articles } shape (no score fields — thin alias).
      const ranked = lexicalSearch(summaries, q, summaries.length);
      return { repository: "articles", articles: ranked.map((result) => result.article) };
    } catch (error) {
      requestLogStorageFailure(reply, error);
      return reply.code(500).send({ error: "repository_unavailable", message: "Unable to load the article repository." });
    }
  }

  app.get<{ Querystring: { q?: string } }>("/v1/repository", async (request, reply) => listRepository(reply, request.query.q));

  app.get<{ Querystring: { q?: string } }>("/v1/articles", async (request, reply) => listRepository(reply, request.query.q));

  app.get<{ Querystring: { q?: string; limit?: string } }>("/v1/search", async (request, reply) => {
    const q = request.query.q;
    if (!q || !q.trim()) {
      return reply.code(400).send({ error: "missing_query", message: "The q parameter is required for search." });
    }
    const parsedLimit = request.query.limit ? Number(request.query.limit) : 20;
    const limit = Number.isInteger(parsedLimit) ? Math.max(1, Math.min(50, parsedLimit)) : 20;
    try {
      const response: SearchResponse = await buildSearchResults({
        query: q,
        limit,
        repo: articles,
        embedder: queryEmbedder,
        withPaymentTerms,
      });
      return reply.send(response);
    } catch (error) {
      requestLogStorageFailure(reply, error);
      return reply.code(500).send({ error: "search_unavailable", message: "Unable to perform search at this time." });
    }
  });

  app.get<{ Params: { articleId: string }; Querystring: { goal?: string } }>(
    "/v1/articles/:articleId/navigation",
    async (request, reply) => {
      const article = await articles.getPublishedArticle(request.params.articleId);
      if (!article) {
        return reply.code(404).send({ error: "article_not_available" });
      }
      return {
        article: await articleSummaryWithPaymentTerms(article),
        navigation: await buildNavigation(article, request.query.goal),
      };
    },
  );

  app.post<{ Body: AnalyzeAuthorshipRequest }>("/v1/authorship/analyze", async (request, reply) => {
    const body = request.body;
    if (!body || body.provider !== "pangram" || typeof body.articleId !== "string") {
      return reply.code(400).send({ error: "invalid_authorship_request" });
    }
    const apiKeyHeader = request.headers["x-rubicon-pangram-api-key"];
    const apiKey = Array.isArray(apiKeyHeader) ? undefined : apiKeyHeader;
    if (!apiKey || apiKey.length > 512) {
      return reply.code(503).send({ error: "authorship_unavailable" });
    }
    const article = await articles.getPublishedArticle(body.articleId);
    if (!article) return reply.code(404).send({ error: "article_not_available" });
    const provider = authorshipProviders.get(body.provider);
    if (!provider) return reply.code(400).send({ error: "unsupported_authorship_provider" });
    try {
      const response: AnalyzeAuthorshipResponse = {
        articleId: article.id,
        provider: provider.name,
        metrics: await provider.analyze({ text: article.body, apiKey }),
      };
      return reply.send(response);
    } catch (error) {
      const kind = error instanceof AuthorshipProviderError ? error.kind : "error";
      // Deliberately omit the provider exception and response from logs and output.
      return reply.code(kind === "unavailable" ? 503 : 502).send({
        error: kind === "unavailable" ? "authorship_unavailable" : "authorship_error",
      });
    }
  });

  app.post<{ Body: StartConversationRequest }>("/v1/seller-agent/conversations", async (request, reply) => {
    const article = await articles.getPublishedArticle(request.body.articleId);
    if (!article) {
      return reply.code(404).send({ error: "article_not_available" });
    }
    const conversationId = randomUUID();
    await ledger.createConversation({
      id: conversationId,
      articleId: article.id,
      creatorId: article.creatorId,
      goal: request.body.goal,
    });

    const messages: ConversationMessage[] = [];
    if (request.body.message) {
      messages.push(
        ...(await runConversationTurn(article, conversationId, request.body.goal, request.body.message)),
      );
    }

    const response: StartConversationResponse = {
      conversationId,
      articleId: article.id,
      article: await articleSummaryWithPaymentTerms(article),
      navigation: await buildNavigation(article, request.body.goal),
      messages,
    };
    return reply.code(201).send(response);
  });

  app.post<{ Params: { conversationId: string }; Body: SendConversationMessageRequest }>(
    "/v1/seller-agent/conversations/:conversationId/messages",
    async (request, reply) => {
      const conversation = await ledger.getConversation(request.params.conversationId);
      if (!conversation) {
        return reply.code(404).send({ error: "conversation_not_found" });
      }
      const article = await articles.getPublishedArticle(conversation.articleId);
      if (!article) {
        return reply.code(404).send({ error: "article_not_available" });
      }
      if (!request.body.message?.trim()) {
        return reply.code(400).send({ error: "message_required" });
      }
      const messages = await runConversationTurn(
        article,
        conversation.id,
        conversation.goal,
        request.body.message,
      );
      const sellerMessage = messages.find((message) => message.role === "seller");
      const response: SendConversationMessageResponse = {
        conversationId: conversation.id,
        messages,
        recommendedSectionId: sellerMessage?.recommendedSectionId,
      };
      return reply.send(response);
    },
  );

  // Representative x402 402 challenge for discovery crawlers (e.g. x402scan) that
  // probe POST /v1/sessions with a synthesized body. Built from a live *paid*
  // article so the challenge's shape, network, asset and atomic amount match a
  // real purchase; the per-article payTo and exact price are still resolved per
  // real session. Cached briefly so repeated probes don't re-hit the payment
  // facilitator. The ephemeral session is never persisted, remembered, or streamed.
  function isConfiguredBaseCreatorWallet(wallet: { address: `0x${string}`; network: string; verified: boolean } | null | undefined): wallet is { address: `0x${string}`; network: string; verified: true } {
    return Boolean(
      baseX402Config &&
        wallet?.verified &&
        wallet.network === baseX402Config.network &&
        /^0x[a-fA-F0-9]{40}$/.test(wallet.address),
    );
  }

  async function baseCreatorWallet(article: ArticleRecord): Promise<`0x${string}` | undefined> {
    const wallet = await articles.getCreatorBaseWallet(article.creatorId);
    return isConfiguredBaseCreatorWallet(wallet) ? wallet.address : undefined;
  }

  function baseArticlePriceAtomic(article: ArticleRecord): bigint | undefined {
    if (!baseX402Config) return undefined;
    const price = article.pricePerWordAtomic * BigInt(article.words.length);
    return price > 0n && price <= baseX402Config.maxArticlePriceAtomic ? price : undefined;
  }

  function decimalUsd(atomic: bigint): string {
    const whole = atomic / 1_000_000n;
    const fraction = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : `${whole}`;
  }

  // First Base-ready article — used only for discovery probes. A writer must
  // have a verified wallet on the exact Base network, and its price must fit the
  // advertised OpenAPI maximum. Never manufacture a challenge to a platform
  // wallet merely to make discovery look healthy.
  async function firstBaseEligiblePaidArticle(): Promise<ArticleRecord | undefined> {
    if (!baseX402Config) return undefined;
    try {
      for (const summary of await articles.listPublishedArticles()) {
        if (summary.accessMode === "free") continue;
        const article = await articles.getPublishedArticle(summary.articleId);
        if (
          article &&
          article.accessMode === "paid" &&
          baseArticlePriceAtomic(article) !== undefined &&
          await baseCreatorWallet(article)
        ) {
          return article;
        }
      }
    } catch {
      // Fall through; caller handles the empty case.
    }
    return undefined;
  }

  let discoveryChallenge: { value: unknown; expires: number } | undefined;
  async function buildDiscoveryChallenge(): Promise<unknown> {
    if (!paymentVerifier.createPaymentRequired) return undefined;
    if (discoveryChallenge && discoveryChallenge.expires > Date.now()) {
      return discoveryChallenge.value;
    }
    try {
      for (const summary of await articles.listPublishedArticles()) {
        if (summary.accessMode === "free") continue;
        const article = await articles.getPublishedArticle(summary.articleId);
        if (!article || article.accessMode !== "paid" || article.pricePerWordAtomic <= 0n) continue;
        const wallet = await articles.getCreatorWallet(article.creatorId);
        if (!wallet?.verified) continue;
        const quote = quotePerWord({ pricePerWordAtomic: article.pricePerWordAtomic, gatewayFeeBps });
        const session = createSession({
          articleId: article.id,
          creatorId: article.creatorId,
          accessMode: "paid",
          budget: { currency: "USDC", maxAmountAtomic: quote.wordPaymentAtomic },
          pricePerWordAtomic: article.pricePerWordAtomic,
          gatewayFeeBps,
          sellerWallet: wallet.address,
          metadata: { __discoveryProbe: true },
          ttlMs: options.sessionTtlMs,
        });
        const challenge = withSessionDiscoverySchema(await paymentVerifier.createPaymentRequired({
          session,
          article,
          sellerWallet: wallet.address,
          wordPaymentAtomic: BigInt(quote.wordPaymentAtomic),
          gatewayBaseUrl,
        }));
        discoveryChallenge = { value: challenge, expires: Date.now() + 5 * 60_000 };
        return challenge;
      }
    } catch {
      // Discovery probes must never 500/404; fall back to the static 402 body.
    }
    return undefined;
  }

  function withSessionDiscoverySchema(paymentRequired: unknown): unknown {
    if (!paymentRequired || typeof paymentRequired !== "object" || Array.isArray(paymentRequired)) {
      return paymentRequired;
    }
    const challenge = paymentRequired as Record<string, unknown>;
    const extensions = challenge.extensions;
    const existingExtensions = extensions && typeof extensions === "object" && !Array.isArray(extensions)
      ? extensions as Record<string, unknown>
      : {};
    const existingBazaar = existingExtensions.bazaar;
    return {
      ...challenge,
      extensions: {
        ...existingExtensions,
        bazaar: {
          ...(existingBazaar && typeof existingBazaar === "object" && !Array.isArray(existingBazaar)
            ? existingBazaar
            : {}),
          schema: SESSION_DISCOVERY_BAZAAR_SCHEMA,
        },
      },
    };
  }

  // A budget cap is only real when it is a non-negative integer string of atomic
  // USDC. Discovery probes send schema placeholders (e.g. "string"), which fail here.
  function isAtomicAmount(value: unknown): value is `${bigint}` {
    return typeof value === "string" && /^\d+$/.test(value);
  }

  // Answer an unpaid discovery probe with the richest 402 we can produce: a real
  // x402 challenge (with `accepts`) when a paid article exists, else a static
  // payment-required body. Always 402 — never 400/404 — so x402scan registers it.
  async function respondPaymentRequired(reply: FastifyReply): Promise<FastifyReply> {
    const challenge = await buildDiscoveryChallenge();
    if (challenge) return sendPaymentRequired(reply, challenge);
    return reply.code(402).send({
      error: "payment_required",
      message:
        "This endpoint sells article words metered per word in USDC (x402). Provide `articleId` and a `budget` to open a session; the response returns an x402 authorization whose recipient is the article creator's wallet. See /openapi.json.",
      meteringUnit: "word",
      asset: "USDC",
    });
  }

  // AgentCash x402 (Base) purchase lane. Buy a whole article in one USDC payment
  // on Base. Unpaid requests (including discovery probes) get an x402 v2 402
  // challenge; a request carrying a verified X-PAYMENT gets the full body. This
  // lane is independent of the Circle/Arc metered session flow.
  app.post<{ Params: { articleId: string } }>("/v1/x402/articles/:articleId", async (request, reply) => {
    if (!baseX402Config) {
      return reply.code(503).send({ error: "base_x402_lane_unavailable" });
    }
    // Discovery crawlers probe this path with the literal `{articleId}`
    // placeholder. Detect that (braces/empty) and answer with a representative
    // challenge from a live paid article so the probe still validates — mirroring
    // the /v1/sessions discovery-probe behaviour. Concrete-but-unknown ids 404.
    const requested = request.params.articleId ?? "";
    const isPlaceholder = /[{}]/.test(requested) || requested.trim() === "";
    let article = isPlaceholder ? null : await articles.getPublishedArticle(requested);
    if (article && (article.accessMode !== "paid" || article.pricePerWordAtomic <= 0n)) {
      article = null; // free/unpriced — not sellable on this paid lane
    }
    if (!article) {
      if (!isPlaceholder) {
        return reply.code(404).send({ error: "article_not_available" });
      }
      article = (await firstBaseEligiblePaidArticle()) ?? null;
      if (!article) {
        // Nothing paid to advertise yet; still answer the probe with a 402.
        return reply.code(402).send({ error: "payment_required", asset: "USDC", network: baseX402Config.network });
      }
    }

    const priceAtomic = baseArticlePriceAtomic(article);
    if (priceAtomic === undefined) {
      return reply.code(422).send({
        error: "article_price_exceeds_x402_limit",
        maxAmountAtomic: baseX402Config.maxArticlePriceAtomic.toString(),
      });
    }
    const resource = `${gatewayBaseUrl}/v1/x402/articles/${article.id}`;
    // Route funds only to the article creator's verified wallet on the exact
    // configured Base network. Failing closed here prevents a stale Arc wallet
    // or a gateway fallback from receiving an AgentCash payment.
    const payTo = await baseCreatorWallet(article);
    if (!payTo) {
      return reply.code(409).send({ error: "creator_base_wallet_not_configured" });
    }
    const challenge = buildBaseChallenge({
      config: baseX402Config,
      resource,
      priceAtomic,
      articleId: article.id,
      title: article.title,
      totalWords: article.words.length,
      payTo,
      iconUrl: publicIconUrl(resource),
    });

    // No payment presented → return the x402 challenge (this is also the
    // discovery-probe response). Always 402, never 400/404 for a real article.
    const paymentHeader =
      (request.headers["x-payment"] as string | undefined) ??
      (request.headers["x-payment-response"] as string | undefined);
    if (!paymentHeader) {
      reply.header("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(challenge), "utf8").toString("base64"));
      return reply.code(402).send(challenge);
    }

    const verification = await baseX402Verifier.verify({ paymentHeader, accept: challenge.accepts[0]! });
    if (!verification.verified) {
      // Cannot verify (e.g. no verifier configured, or invalid payment) → refuse
      // by re-issuing the challenge. Never release content on an unverified pay.
      reply.header("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(challenge), "utf8").toString("base64"));
      return reply.code(402).send({ ...challenge, reason: verification.reason });
    }

    if (verification.transaction) {
      reply.header("PAYMENT-RESPONSE", JSON.stringify({ transaction: verification.transaction, payer: verification.payer }));
    }
    return reply.code(200).send({
      articleId: article.id,
      title: article.title,
      author: article.author,
      totalWords: article.words.length,
      body: article.body,
    });
  });

  app.post<{ Body: StartSessionRequest | undefined }>("/v1/sessions", async (request, reply) => {
    // x402 discovery: an unpaid probe of this paid endpoint must reach the x402
    // 402 payment challenge *before* body validation — never a 400/404/500.
    // x402scan synthesizes the request from the OpenAPI schema, so it sends
    // placeholder values (e.g. a non-numeric `budget.maxAmountAtomic`). Treat any
    // request without a real, well-formed budget cap as such a probe and answer
    // with a 402 challenge. Legitimate opens carry a valid atomic budget cap and
    // a real articleId, and fall through to the normal flow (which still 404s a
    // draft/paused/unknown article — those reference real, well-formed budgets).
    const body = request.body;
    if (!body || !body.articleId || !isAtomicAmount(body.budget?.maxAmountAtomic)) {
      return respondPaymentRequired(reply);
    }
    const article = await articles.getPublishedArticle(body.articleId);
    if (!article) {
      // Draft, paused, archived, deleted, or unknown — never start a paid session.
      return reply.code(404).send({ error: "article_not_available" });
    }

    if (article.accessMode === "free" && article.pricePerWordAtomic !== 0n) {
      return reply.code(409).send({ error: "free_article_has_nonzero_price" });
    }
    if (article.accessMode === "paid" && article.pricePerWordAtomic <= 0n) {
      return reply.code(409).send({ error: "article_pricing_not_configured" });
    }

    const wallet = article.accessMode === "paid"
      ? await articles.getCreatorWallet(article.creatorId)
      : undefined;
    if (article.accessMode === "paid" && !wallet) {
      return reply.code(409).send({ error: "creator_wallet_not_configured" });
    }
    if (article.accessMode === "paid" && !wallet?.verified) {
      return reply.code(409).send({ error: "creator_wallet_unverified" });
    }

    const selection = selectionFromRequest(body);
    const resolved = wordsForSelection(article.words, article.sections, selection);
    if (!resolved.ok) {
      const status = resolved.code === "section_not_found" ? 404 : 400;
      return reply.code(status).send({ error: resolved.code });
    }
    const sectionId = resolved.label;
    // Persist the resolved selection server-side so a stream rebuilt after a
    // restart reproduces the exact same billable word set (never re-read from
    // buyer input mid-session).
    const metadata = { ...(body.metadata ?? {}), __selection: selection };

    const quote = quotePerWord({ pricePerWordAtomic: article.pricePerWordAtomic, gatewayFeeBps });

    let conversationId = body.conversationId;
    if (conversationId) {
      const existing = await ledger.getConversation(conversationId);
      if (!existing || existing.articleId !== article.id) {
        return reply.code(404).send({ error: "conversation_not_found" });
      }
    } else {
      conversationId = randomUUID();
      await ledger.createConversation({
        id: conversationId,
        articleId: article.id,
        creatorId: article.creatorId,
        goal: body.goal,
      });
    }

    const session = createSession({
      articleId: article.id,
      creatorId: article.creatorId,
      accessMode: article.accessMode,
      conversationId,
      goal: body.goal,
      sectionId,
      budget: body.budget,
      pricePerWordAtomic: article.pricePerWordAtomic,
      gatewayFeeBps,
      sellerWallet: wallet?.address,
      metadata,
      ttlMs: options.sessionTtlMs,
    });

    const paymentRequired = article.accessMode === "paid"
      ? await paymentVerifier.createPaymentRequired?.({
          session,
          article,
          sellerWallet: wallet!.address,
          wordPaymentAtomic: BigInt(quote.wordPaymentAtomic),
          gatewayBaseUrl,
        })
      : undefined;
    session.paymentRequired = paymentRequired;
    if (article.accessMode === "paid") {
      logPaymentRequirementIssued(reply, session, paymentRequired, quote.wordPaymentAtomic, wallet!.address);
    }

    await ledger.createSession(session);
    paidReading.rememberSession(session.id, { article, words: resolved.words, sectionId });

    const summary = await articleSummaryWithPaymentTerms(article);
    const wordsAuthorized = article.accessMode === "free"
      ? resolved.words.length
      : authorizedWordCount(body.budget.maxAmountAtomic, quote.wordPaymentAtomic);
    events.publish({
      type: "session.started",
      sessionId: session.id,
      articleId: article.id,
      state: session.state,
      article: summary,
      pricePerWordAtomic: quote.pricePerWordAtomic,
      wordPaymentAtomic: quote.wordPaymentAtomic,
    });

    const response: StartSessionResponse = {
      sessionId: session.id,
      state: session.state,
      accessMode: article.accessMode,
      article: summary,
      navigation: await buildNavigation(article, body.goal),
      pricePerWordAtomic: quote.pricePerWordAtomic,
      maxArticlePriceAtomic: summary.maxArticlePriceAtomic,
      conversationId,
      wordPaymentAtomic: quote.wordPaymentAtomic,
      gatewayFeeBps,
      paymentRequired,
      authorizationMode: article.accessMode === "paid" ? "word" : undefined,
      wordsAuthorized,
      expiresAt: session.expiresAt.toISOString(),
      wordsPaid: 0,
      wordsDelivered: 0,
      paidAtomic: "0",
    };
    return reply.code(201).send(response);
  });

  app.post<{ Params: { sessionId: string }; Body: Partial<StreamPaymentRequest> | undefined }>(
    "/v1/sessions/:sessionId/payments",
    async (request, reply) => {
      const session = await ledger.getSession(request.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      const sequence = session.wordsDelivered;
      if (session.accessMode === "free") {
        const idempotencyKey = request.body?.idempotencyKey ?? `${session.id}:free:${sequence}`;
        const cached = await ledger.getDeliveryByIdempotencyKey(idempotencyKey);
        if (cached) {
          return reply.send(
            buildPaymentResponse(
              session,
              cached.delivery.word,
              cached.delivery.sequence,
              0n,
              session.state === "completed",
            ),
          );
        }
        if (session.state === "completed" || session.state === "aborted" || session.state === "expired") {
          return reply.code(409).send({ error: `session_${session.state}` });
        }
        if (isSessionExpired(session)) {
          session.state = "expired";
          await ledger.saveSession(session);
          events.publish({ type: "session.closed", sessionId: session.id, reason: "session_expired" });
          return reply.code(410).send({ error: "session_expired" });
        }
        const result = await releaseFreeChunk(session, 1, idempotencyKey);
        if (!result) return reply.code(404).send({ error: "article_unavailable" });
        const entry = result.words[0];
        return reply.send(
          buildPaymentResponse(
            session,
            entry?.word ?? "",
            entry?.sequence ?? sequence,
            0n,
            result.completed,
          ),
        );
      }
      const payment = paymentRequestFromHttp(request.body, (name) => request.headers[name.toLowerCase()]);
      if (!payment.paymentPayload) {
        return sendPaymentRequired(reply, session.paymentRequired);
      }
      const streamPayment = payment as StreamPaymentRequest;
      const idempotencyKey = payment.idempotencyKey ?? idempotencyKeyFromPaymentPayload(payment.paymentPayload) ?? `${session.id}:${sequence}`;

      // Idempotency: a retried payment must not release or charge a word twice.
      // Checked before state guards so retries of the final word stay idempotent.
      const cached = await ledger.getDeliveryByIdempotencyKey(idempotencyKey);
      if (cached) {
        if (!cached.payment) {
          return reply.code(500).send({ error: "paid_delivery_missing_payment" });
        }
        return sendPaymentResponse(
          reply,
          buildPaymentResponse(
            session,
            cached.delivery.word,
            cached.delivery.sequence,
            BigInt(cached.delivery.priceAtomic),
            session.state === "completed",
            cached.payment.transactionHash,
            cached.payment.transactionHashes,
            cached.payment.paymentId,
            cached.payment.network,
            cached.payment.payTo,
            cached.payment.createdAt,
            cached.payment.settlementId,
            cached.payment.settlementIds,
            cached.payment.buyerWalletAddress,
            cached.payment.transferId,
          ),
        );
      }

      if (session.state === "completed" || session.state === "aborted" || session.state === "expired") {
        return reply.code(409).send({ error: `session_${session.state}` });
      }
      if (isSessionExpired(session)) {
        session.state = "expired";
        await ledger.saveSession(session);
        events.publish({ type: "session.closed", sessionId: session.id, reason: "session_expired" });
        return reply.code(402).send({ error: "session_expired" });
      }

      const quote = quotePerWord({ pricePerWordAtomic: session.pricePerWordAtomic, gatewayFeeBps: session.gatewayFeeBps });
      const wordPaymentAtomic = BigInt(quote.wordPaymentAtomic);

      // Resolve the next word from server-owned session state before settlement;
      // emit it only after a verified payment. Never reveal future words.
      const state = await paidReading.resolveStreamState(session);
      if (!state) {
        return reply.code(404).send({ error: "article_unavailable" });
      }
      const nextWord = paidReading.nextWord(state, sequence);
      if (nextWord === null) {
        await paidReading.complete(session, state.article.id);
        return reply.send(
          buildPaymentResponse(session, "", sequence, wordPaymentAtomic, true),
        );
      }

      if (!canAffordNextWord(session, wordPaymentAtomic)) {
        await paidReading.close(session, "budget_exhausted");
        return reply.code(402).send({ error: "budget_exhausted" });
      }

      const verification = await paymentVerifier.verify({ session, wordPaymentAtomic, payment: streamPayment });
      logPaymentAttempt(reply, session, sequence, idempotencyKey, streamPayment, verification);
      if (!verification.accepted || !verification.amountAtomic) {
        // A failed payment releases no word and does not advance the session.
        return reply.code(402).send({ error: verification.reason ?? "payment_rejected" });
      }
      if (BigInt(verification.amountAtomic) !== wordPaymentAtomic) {
        return reply.code(402).send({
          error: "payment_amount_mismatch",
          expectedAmountAtomic: quote.wordPaymentAtomic,
          receivedAmountAtomic: verification.amountAtomic,
        });
      }

      const usage = usageForWords({
        wordsDelivered: 1,
        pricePerWordAtomic: session.pricePerWordAtomic,
        gatewayFeeBps: session.gatewayFeeBps,
      });
      const bundleId = randomUUID();
      const paymentId = randomUUID();
      const bundleSequence = typeof session.metadata.bundleSequence === "number" ? session.metadata.bundleSequence : 0;
      const settlement = settlementEvidenceFromVerification(verification, bundleId);
      const record = await ledger.recordPaidBundle({
        accessMode: "paid",
        bundleId,
        bundleSequence,
        sessionId: session.id,
        articleId: session.articleId,
        creatorId: session.creatorId,
        sectionId: session.sectionId,
        startSequence: sequence,
        words: [{ sequence, word: nextWord }],
        pricePerWordAtomic: wordPaymentAtomic,
        grossAmountAtomic: wordPaymentAtomic,
        creatorAmountAtomic: BigInt(usage.creatorAmountAtomic),
        rubiconFeeAtomic: BigInt(usage.rubiconFeeAtomic),
        paymentId,
        authorizationReference: idempotencyKey,
        network: verification.network,
        payTo: verification.payTo ?? session.sellerWallet,
        buyerWalletAddress: verification.buyerWalletAddress,
        idempotencyKey,
        settlement,
      });
      applyBundleCounters(session, record);
      if (!record.duplicate) verification.afterCommit?.({ startSequence: sequence, words: 1 });
      if (record.duplicate) {
        // Lost an idempotency race; return the canonical word without re-charging.
        // The winning request emits completion + closes the session over SSE.
        return sendPaymentResponse(
          reply,
          buildPaymentResponse(
            session,
            record.bundle.words[0]?.word ?? "",
            record.bundle.startSequence,
            wordPaymentAtomic,
            false,
            verification.transactionHash,
            verification.transactionHashes,
            record.bundle.paymentId,
            record.bundle.network,
            record.bundle.payTo,
            record.bundle.createdAt,
            verification.settlementId,
            verification.settlementIds,
            record.bundle.buyerWalletAddress,
            verification.transferId,
          ),
        );
      }

      events.publish({
        type: "word.payment_accepted",
        sessionId: session.id,
        sequence,
        paymentId: record.bundle.paymentId!,
        amountAtomic: `${wordPaymentAtomic}`,
        network: record.bundle.network,
        payTo: record.bundle.payTo,
        transactionHash: verification.transactionHash,
        transactionHashes: verification.transactionHashes,
        transferId: verification.transferId,
      });
      events.publish({
        type: "article.word",
        sessionId: session.id,
        articleId: session.articleId,
        sequence,
        word: nextWord,
        priceAtomic: `${wordPaymentAtomic}`,
        totalWordsStreamed: session.wordsDelivered,
        totalPaidAtomic: `${session.paidAtomic}`,
      });
      events.publish({
        type: "article.usage",
        sessionId: session.id,
        usage: usageForWords({
          wordsDelivered: session.wordsDelivered,
          pricePerWordAtomic: session.pricePerWordAtomic,
          gatewayFeeBps: session.gatewayFeeBps,
        }),
        wordsPaid: session.wordsPaid,
        wordsDelivered: session.wordsDelivered,
        paidAtomic: `${session.paidAtomic}`,
      });

      const completed = session.wordsDelivered >= state.words.length;
      if (completed) {
        await paidReading.complete(session, session.articleId);
      }

      return sendPaymentResponse(
        reply,
        buildPaymentResponse(
          session,
          nextWord,
          sequence,
          wordPaymentAtomic,
          completed,
          verification.transactionHash,
          verification.transactionHashes,
          record.bundle.paymentId,
          record.bundle.network,
          record.bundle.payTo,
          record.bundle.createdAt,
          verification.settlementId,
          verification.settlementIds,
          verification.buyerWalletAddress,
          verification.transferId,
        ),
      );
    },
  );

  app.post<{ Params: { sessionId: string }; Body: StreamPaymentRequest | undefined }>(
    "/v1/sessions/:sessionId/stream",
    async (request, reply) => {
      const session = await ledger.getSession(request.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      if (session.accessMode === "free") {
        const cached = await cachedFreeChunk(session, request.body?.idempotencyKey);
        if (cached) return reply.send(cached);
      } else {
        const retryKey = request.body?.idempotencyKey
          ?? idempotencyKeyFromPaymentPayload(request.body?.paymentPayload);
        if (retryKey) {
          const cached = await ledger.getBundleByIdempotencyKey(retryKey);
          if (cached) {
            applyBundleCounters(session, cached);
            return reply.send(paidChunkResponseFromBundle(cached, session));
          }
        }
      }
      if (session.state === "completed" || session.state === "aborted" || session.state === "expired") {
        return reply.code(409).send({ error: `session_${session.state}` });
      }
      if (isSessionExpired(session)) {
        session.state = "expired";
        await ledger.saveSession(session);
        events.publish({ type: "session.closed", sessionId: session.id, reason: "session_expired" });
        return reply.code(402).send({ error: "session_expired" });
      }

      const streamPayment = request.body;
      if (session.accessMode === "free") {
        const maxWords = normalizeChunkWords(streamPayment?.maxWords);
        const idempotencyKey = streamPayment?.idempotencyKey ?? `${session.id}:free:${session.wordsDelivered}:${maxWords}`;
        const result = await releaseFreeChunk(session, maxWords, idempotencyKey);
        if (!result) return reply.code(404).send({ error: "article_unavailable" });
        return reply.send(result);
      }
      if (!streamPayment?.paymentPayload) {
        return sendPaymentRequired(reply, session.paymentRequired);
      }

      const quote = quotePerWord({ pricePerWordAtomic: session.pricePerWordAtomic, gatewayFeeBps: session.gatewayFeeBps });
      const wordPaymentAtomic = BigInt(quote.wordPaymentAtomic);

      const state = await paidReading.resolveStreamState(session);
      if (!state) {
        return reply.code(404).send({ error: "article_unavailable" });
      }
      const remainingArticleWords = Math.max(0, state.words.length - session.wordsDelivered);
      const maxWords = Math.min(
        normalizeChunkWords(streamPayment.maxWords),
        affordableWordCount(session, wordPaymentAtomic),
        remainingArticleWords,
      );
      if (maxWords < 1) {
        if (remainingArticleWords < 1) {
          await paidReading.complete(session, state.article.id);
          return reply.send({
            accepted: true,
            words: [],
            text: "",
            wordsPaid: session.wordsPaid,
            wordsDelivered: session.wordsDelivered,
            paidAtomic: `${session.paidAtomic}`,
            completed: true,
            authorizationMode: "chunk",
          } satisfies StreamChunkResponse);
        }
        await paidReading.close(session, "budget_exhausted");
        return reply.code(402).send({ error: "budget_exhausted" });
      }

      const chunkPaymentAtomic = wordPaymentAtomic * BigInt(maxWords);
      const idempotencyKey =
        streamPayment.idempotencyKey ??
        idempotencyKeyFromPaymentPayload(streamPayment.paymentPayload) ??
        `${session.id}:${session.wordsDelivered}:${maxWords}`;
      const cachedBundle = await ledger.getBundleByIdempotencyKey(idempotencyKey);
      if (cachedBundle) {
        applyBundleCounters(session, cachedBundle);
        return reply.send(paidChunkResponseFromBundle(cachedBundle, session));
      }
      const verification = await paymentVerifier.verify({
        session,
        wordPaymentAtomic: chunkPaymentAtomic,
        payment: { ...streamPayment, maxWords },
      });
      logPaymentAttempt(reply, session, session.wordsDelivered, idempotencyKey, { ...streamPayment, maxWords }, verification);
      if (!verification.accepted || !verification.amountAtomic) {
        return reply.code(402).send({ error: verification.reason ?? "payment_rejected" });
      }
      if (BigInt(verification.amountAtomic) !== chunkPaymentAtomic) {
        return reply.code(402).send({
          error: "payment_amount_mismatch",
          expectedAmountAtomic: `${chunkPaymentAtomic}`,
          receivedAmountAtomic: verification.amountAtomic,
        });
      }

      const bundleSequence =
        typeof session.metadata.bundleSequence === "number" ? session.metadata.bundleSequence : 0;
      const bundleId = randomUUID();
      const bundlePaymentId = randomUUID();
      const bundleStartSequence = session.wordsDelivered;
      const bundleSettledAt = new Date().toISOString();
      const bundleWords = state.words.slice(bundleStartSequence, bundleStartSequence + maxWords)
        .map((word, offset) => ({ sequence: bundleStartSequence + offset, word }));
      const creatorAmountAtomic = session.pricePerWordAtomic * BigInt(bundleWords.length);
      const bundleAmountAtomic = wordPaymentAtomic * BigInt(bundleWords.length);
      const settlement = settlementEvidenceFromVerification(verification, bundleId);
      const record = await ledger.recordPaidBundle({
        accessMode: "paid",
        bundleId,
        idempotencyKey,
        sessionId: session.id,
        creatorId: session.creatorId,
        articleId: session.articleId,
        sectionId: session.sectionId,
        bundleSequence,
        startSequence: bundleStartSequence,
        words: bundleWords,
        pricePerWordAtomic: wordPaymentAtomic,
        grossAmountAtomic: bundleAmountAtomic,
        creatorAmountAtomic,
        rubiconFeeAtomic: bundleAmountAtomic - creatorAmountAtomic,
        paymentId: bundlePaymentId,
        authorizationReference: idempotencyKey,
        buyerWalletAddress: verification.buyerWalletAddress,
        network: verification.network,
        payTo: verification.payTo ?? session.sellerWallet,
        settlement,
      });
      applyBundleCounters(session, record);
      if (!record.duplicate) verification.afterCommit?.({ startSequence: bundleStartSequence, words: bundleWords.length });
      const released: StreamChunkResponse["words"] = record.bundle.words.map(({ sequence, word }) => ({
        sequence,
        word,
        priceAtomic: `${wordPaymentAtomic}`,
      }));

      const bundleText = released.map((entry) => entry.word).join(" ");
      const chunkCompleted = session.wordsDelivered >= state.words.length;
      if (chunkCompleted) await paidReading.complete(session, session.articleId);
      const bundlePayment = buildWordReceipt(
        session,
        bundleStartSequence,
        bundleAmountAtomic,
        record.bundle.paymentId ?? "",
        verification.network,
        verification.payTo ?? session.sellerWallet,
        record.bundle.createdAt ?? bundleSettledAt,
        verification.transactionHash,
        verification.transactionHashes,
        verification.settlementId,
        verification.settlementIds,
        verification.buyerWalletAddress,
        verification.transferId,
        {
          bundleSequence,
          startSequence: bundleStartSequence,
          endSequence: bundleStartSequence + released.length - 1,
          wordsDelivered: released.length,
          pricePerWordAtomic: wordPaymentAtomic,
          text: bundleText,
        },
      );
      if (released.length > 0) {
        events.publish({
          type: "word.payment_accepted",
          sessionId: session.id,
          sequence: bundleStartSequence,
          paymentId: record.bundle.paymentId!,
          amountAtomic: `${bundleAmountAtomic}`,
          network: verification.network,
          payTo: verification.payTo ?? session.sellerWallet,
          transactionHash: verification.transactionHash,
          transactionHashes: verification.transactionHashes,
          transferId: verification.transferId,
        });
        events.publish({
          type: "article.bundle",
          sessionId: session.id,
          articleId: session.articleId,
          bundleSequence,
          startSequence: bundleStartSequence,
          endSequence: bundleStartSequence + released.length - 1,
          words: released.map((entry) => ({ sequence: entry.sequence, word: entry.word, priceAtomic: entry.priceAtomic })),
          text: bundleText,
          wordCount: released.length,
          pricePerWordAtomic: `${wordPaymentAtomic}`,
          amountAtomic: `${bundleAmountAtomic}`,
          paymentId: record.bundle.paymentId,
          totalWordsStreamed: session.wordsDelivered,
          totalPaidAtomic: `${session.paidAtomic}`,
        });
      }
      events.publish({
        type: "article.usage",
        sessionId: session.id,
        usage: usageForWords({
          wordsDelivered: session.wordsDelivered,
          pricePerWordAtomic: session.pricePerWordAtomic,
          gatewayFeeBps: session.gatewayFeeBps,
        }),
        wordsPaid: session.wordsPaid,
        wordsDelivered: session.wordsDelivered,
        paidAtomic: `${session.paidAtomic}`,
      });

      const response: StreamChunkResponse = {
        accepted: true,
        words: released,
        text: bundleText,
        wordsPaid: session.wordsPaid,
        wordsDelivered: session.wordsDelivered,
        paidAtomic: `${session.paidAtomic}`,
        completed: chunkCompleted,
        authorizationMode: "chunk",
        payment: bundlePayment,
        transactionHash: verification.transactionHash,
        transactionHashes: verification.transactionHashes,
        settlementId: verification.settlementId,
        settlementIds: verification.settlementIds,
        buyerWalletAddress: verification.buyerWalletAddress,
        transferId: verification.transferId,
      };
      return reply.send(response);
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/payments",
    async (request, reply) => {
      const session = await ledger.getSession(request.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      if (session.state === "completed" || session.state === "aborted" || session.state === "expired") {
        return reply.code(409).send({ error: `session_${session.state}` });
      }
      if (isSessionExpired(session)) {
        session.state = "expired";
        await ledger.saveSession(session);
        events.publish({ type: "session.closed", sessionId: session.id, reason: "session_expired" });
        return reply.code(402).send({ error: "session_expired" });
      }
      if (session.accessMode === "free") {
        return reply.code(204).send();
      }
      return sendPaymentRequired(reply, session.paymentRequired);
    },
  );

  app.get<{ Params: { sessionId: string } }>("/v1/sessions/:sessionId/events", async (request, reply) => {
    const session = await ledger.getSession(request.params.sessionId);
    if (!session) {
      return reply.code(404).send({ error: "session_not_found" });
    }
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const unsubscribe = events.subscribe(request.params.sessionId, (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    request.raw.on("close", unsubscribe);
  });

  app.post<{ Params: { sessionId: string }; Body: { reason?: string } }>(
    "/v1/sessions/:sessionId/abort",
    async (request, reply) => {
      const session = await ledger.getSession(request.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      await paidReading.close(session, request.body?.reason ?? "agent_cancelled");
      return reply.send({ aborted: true });
    },
  );

  async function runConversationTurn(
    article: ArticleRecord,
    conversationId: string,
    goal: string | undefined,
    message: string,
  ): Promise<ConversationMessage[]> {
    const now = new Date().toISOString();
    const buyerMessage: SellerAgentMessageRecord = {
      id: randomUUID(),
      conversationId,
      articleId: article.id,
      role: "buyer",
      content: message,
      createdAt: now,
    };
    await ledger.appendMessage(buyerMessage);

    const navigation = await buildNavigation(article, [goal, message].filter(Boolean).join(" "));
    const recommendedSectionId = navigation.sellerAgent.recommendedSectionId;
    const recommended = navigation.sections.find((section) => section.sectionId === recommendedSectionId);
    const alternatives = navigation.sellerAgent.alternativeSectionIds
      .map((sectionId) => navigation.sections.find((section) => section.sectionId === sectionId)?.heading)
      .filter((heading): heading is string => Boolean(heading));
    const result = {
      recommendedSectionId,
      reply: recommended
        ? `The closest match is “${recommended.heading}”.${alternatives.length ? ` Alternatives: ${alternatives.map((heading) => `“${heading}”`).join(", ")}.` : ""}`
        : "No narrower section match is available; use the full article reading path.",
    };
    const sellerMessage: SellerAgentMessageRecord = {
      id: randomUUID(),
      conversationId,
      articleId: article.id,
      role: "seller",
      content: result.reply,
      createdAt: new Date().toISOString(),
    };
    await ledger.appendMessage(sellerMessage);

    return [
      { id: buyerMessage.id, role: "buyer", content: buyerMessage.content, createdAt: buyerMessage.createdAt },
      {
        id: sellerMessage.id,
        role: "seller",
        content: sellerMessage.content,
        recommendedSectionId: result.recommendedSectionId,
        createdAt: sellerMessage.createdAt,
      },
    ];
  }

  function logPaymentRequirementIssued(
    reply: FastifyReply,
    session: SessionRecord,
    paymentRequired: unknown,
    amountAtomic: `${bigint}`,
    payTo: `0x${string}`,
  ): void {
    const requirement = firstAccept(paymentRequired);
    reply.log.info(
      {
        event: "rubicon.payment_requirement_issued",
        timestamp: new Date().toISOString(),
        sessionId: session.id,
        articleId: session.articleId,
        sequence: session.wordsDelivered,
        meteringUnit: "word",
        amountAtomic,
        asset: "USDC",
        network: requirement?.network,
        payTo,
        idempotencyKey: `${session.id}:${session.wordsDelivered}`,
        nonce: `${session.id}:${session.wordsDelivered}`,
        expiresAt: session.expiresAt.toISOString(),
      },
      "issued payment authorization requirement",
    );
  }

  function logPaymentAttempt(
    reply: FastifyReply,
    session: SessionRecord,
    sequence: number,
    idempotencyKey: string,
    payment: StreamPaymentRequest,
    verification: { accepted: boolean; reason?: string; network?: string; payTo?: `0x${string}`; amountAtomic?: `${bigint}` },
  ): void {
    reply.log.info(
      {
        event: "rubicon.payment_attempt",
        timestamp: new Date().toISOString(),
        sessionId: session.id,
        articleId: session.articleId,
        sequence,
        idempotencyKey,
        hasPaymentPayload: payment.paymentPayload !== undefined,
        accepted: verification.accepted,
        reason: verification.reason,
        amountAtomic: verification.amountAtomic,
        network: verification.network,
        payTo: verification.payTo ?? session.sellerWallet,
      },
      "processed payment authorization attempt",
    );
  }

  function firstAccept(paymentRequired: unknown): { network?: string } | undefined {
    const accepts = (paymentRequired as { accepts?: Array<{ network?: string }> } | undefined)?.accepts;
    return Array.isArray(accepts) ? accepts[0] : undefined;
  }

  function paymentRequestFromHttp(
    body: Partial<StreamPaymentRequest> | undefined,
    getHeader: (name: string) => string | string[] | undefined,
  ): Partial<StreamPaymentRequest> {
    if (body?.paymentPayload !== undefined) {
      return body;
    }
    const header = firstHeader(getHeader("payment-signature") ?? getHeader("PAYMENT-SIGNATURE") ?? getHeader("x-payment"));
    if (!header) {
      return body ?? {};
    }
    try {
      return {
        ...body,
        paymentPayload: decodePaymentSignatureHeader(header),
      };
    } catch {
      return body ?? {};
    }
  }

  function firstHeader(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }

  function idempotencyKeyFromPaymentPayload(paymentPayload: unknown): string | undefined {
    const key = (paymentPayload as PaymentPayload | undefined)?.accepted?.extra?.idempotencyKey;
    return typeof key === "string" ? key : undefined;
  }

  function sendPaymentRequired(reply: FastifyReply, paymentRequired: unknown) {
    if (!paymentRequired) {
      return reply.code(402).send({ error: "payment_required" });
    }
    reply.header("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired as PaymentRequired));
    return reply.code(402).send(paymentRequired);
  }

  function sendPaymentResponse(reply: FastifyReply, response: StreamPaymentResponse) {
    if (response.payment) {
      reply.header("PAYMENT-RESPONSE", JSON.stringify(response.payment));
    }
    return reply.send(response);
  }

  return app;
}

export type { ArticleSummary, GatewayEvent };
