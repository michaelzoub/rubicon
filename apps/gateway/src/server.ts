import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import {
  canAffordNextWord,
  createSession,
  isSessionExpired,
  quotePerWord,
  recordWordDelivery,
  recordWordPayment,
  settlementNetworkInfo,
  usageForWords,
  lexicalSearch,
  type ArticleNavigation,
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
import type { ArticleRecord, LedgerRepository, PublishedArticleRepository } from "./repositories/types.js";
import { DefaultSellerAgent, type SellerAgent } from "./seller-agent/seller-agent.js";
import { DevelopmentPaymentVerifier, type PaymentVerifier } from "./payments/types.js";
import { selectionFromRequest, wordsForSelection } from "./words.js";
import { buildSearchResults } from "./search/search-service.js";
import { buildOpenApiDocument } from "./discovery/openapi.js";
import {
  affordableWordCount,
  authorizedWordCount,
  buildPaymentResponse,
  buildWordReceipt,
  normalizeChunkWords,
  PaidReadingWorkflow,
} from "./workflows/paid-reading.js";

export interface GatewayOptions {
  articleRepository: PublishedArticleRepository;
  ledger: LedgerRepository;
  sellerAgent?: SellerAgent;
  paymentVerifier?: PaymentVerifier;
  sessionTtlMs: number;
  /** Rubicon fee in basis points. Defaults to 0 — creators keep the full word price. */
  gatewayFeeBps?: number;
  gatewayBaseUrl?: string;
  logger?: boolean;
  /** Query embedder for semantic search. Null when OPENAI_API_KEY is unset (lexical fallback). */
  queryEmbedder?: ((q: string) => Promise<number[] | null>) | null;
  /** Version advertised in the /openapi.json discovery document. */
  version?: string;
}

const STOP_CONDITIONS: StreamStopCondition[] = [
  { kind: "sufficient_information", description: "Stop once the buyer agent has enough paid words for its task." },
  { kind: "max_words", description: "Stop after a buyer-selected word limit." },
  { kind: "max_payments", description: "Stop after a buyer-selected number of word payments." },
  { kind: "max_spend_atomic", description: "Stop before exceeding the buyer-selected atomic USDC spend limit." },
  { kind: "article_completed", description: "Stop automatically when the selected section or article is complete." },
  { kind: "payment_rejected", description: "Stop if authorization verification or settlement fails." },
];

const ENDPOINTS = [
  { method: "GET", path: "/health", description: "Gateway health check." },
  { method: "GET", path: "/v1/endpoints", description: "Lists gateway endpoints." },
  { method: "GET", path: "/openapi.json", description: "AgentCash/x402 discovery document (OpenAPI 3.1.0)." },
  { method: "GET", path: "/v1/repository", description: "Lists live articles available to buyer agents. Optional ?q= ranks results by search relevance." },
  { method: "GET", path: "/v1/search", description: "Semantic or lexical search over live articles. Requires ?q= query." },
  { method: "GET", path: "/v1/articles/:articleId/navigation", description: "Safe seller-agent navigation; no unpaid body text." },
  { method: "POST", path: "/v1/seller-agent/conversations", description: "Opens a conversation with an article's seller agent." },
  { method: "POST", path: "/v1/seller-agent/conversations/:conversationId/messages", description: "Sends a message to the seller agent." },
  { method: "POST", path: "/v1/sessions", description: "Opens a budgeted reading session and returns Circle / Arc authorization terms." },
  { method: "POST", path: "/v1/sessions/:sessionId/stream", description: "Preferred path: streams words against a session-level authorization." },
  { method: "POST", path: "/v1/sessions/:sessionId/payments", description: "Compatibility path: verifies a chunk or legacy one-word payment and releases authorized words." },
  { method: "GET", path: "/v1/sessions/:sessionId/events", description: "Server-sent word-level events." },
  { method: "POST", path: "/v1/sessions/:sessionId/abort", description: "Aborts a session." },
];

export function createGateway(options: GatewayOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  const events = new InMemoryEventBus();
  const sellerAgent = options.sellerAgent ?? new DefaultSellerAgent();
  const paymentVerifier: PaymentVerifier = options.paymentVerifier ?? new DevelopmentPaymentVerifier();
  const ledger = options.ledger;
  const articles = options.articleRepository;
  const gatewayFeeBps = options.gatewayFeeBps ?? 0;
  const gatewayBaseUrl = options.gatewayBaseUrl ?? `http://localhost:${process.env.GATEWAY_PORT ?? process.env.PORT ?? 8787}`;
  const agentApiKey = process.env.RUBICON_AGENT_API_KEY;
  const queryEmbedder = options.queryEmbedder ?? null;
  const paidReading = new PaidReadingWorkflow({
    articles,
    ledger,
    paymentVerifier,
    publish: (event) => events.publish(event),
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !agentApiKey ||
      request.url === "/health" ||
      request.url === "/openapi.json" ||
      request.url === "/favicon.ico"
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
    const navigation = await sellerAgent.navigate({ article, goal });
    return {
      articleId: article.id,
      sections: summarizeArticle(article).sections,
      sellerAgent: {
        recommendedSectionId: navigation.recommendedSectionId,
        alternativeSectionIds: navigation.alternativeSectionIds,
        sectionAssessments: navigation.sectionAssessments,
        rationale: navigation.rationale,
        safeHints: navigation.safeHints,
        withheld: navigation.withheld,
      },
      stopConditions: STOP_CONDITIONS,
    };
  }

  async function withPaymentTerms(summaries: ArticleSummary[]): Promise<ArticleSummary[]> {
    return Promise.all(
      summaries.map(async (summary) => {
        if (summary.accessMode === "free") {
          return summary;
        }
        const wallet = await articles.getCreatorWallet(summary.creatorId);
        if (!wallet?.verified) {
          return summary;
        }
        return {
          ...summary,
          paymentTerms: paymentTerms(summary.pricePerWordAtomic, wallet.address, wallet.network),
        };
      }),
    );
  }

  async function articleSummaryWithPaymentTerms(article: ArticleRecord): Promise<ArticleSummary> {
    const summary = summarizeArticle(article);
    if (article.accessMode === "free") {
      return summary;
    }
    const wallet = await articles.getCreatorWallet(article.creatorId);
    if (!wallet?.verified) {
      return summary;
    }
    return {
      ...summary,
      paymentTerms: paymentTerms(summary.pricePerWordAtomic, wallet.address, wallet.network),
    };
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
    const released: StreamChunkResponse["words"] = [];
    const startSequence = session.wordsDelivered;

    for (let offset = 0; offset < maxWords; offset += 1) {
      const sequence = session.wordsDelivered;
      const word = paidReading.nextWord(state, sequence);
      if (word === null) break;
      const key = maxWords === 1 ? idempotencyBase : `${idempotencyBase}:${sequence}`;
      const record = await ledger.recordFreeWordDelivery({
        sessionId: session.id,
        articleId: session.articleId,
        sequence,
        word,
        idempotencyKey: key,
      });
      if (record.duplicate) break;
      recordWordDelivery(session);
      released.push({ sequence, word, priceAtomic: "0" });
      events.publish({
        type: "article.word",
        sessionId: session.id,
        articleId: session.articleId,
        sequence,
        word,
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
        bundleSequence: typeof session.metadata.bundleSequence === "number" ? session.metadata.bundleSequence : 0,
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
      session.metadata = {
        ...session.metadata,
        bundleSequence: (typeof session.metadata.bundleSequence === "number" ? session.metadata.bundleSequence : 0) + 1,
      };
    }
    events.publish({
      type: "article.usage",
      sessionId: session.id,
      usage: usageForWords({ wordsDelivered: session.wordsDelivered, pricePerWordAtomic: 0n, gatewayFeeBps: 0 }),
      wordsPaid: 0,
      wordsDelivered: session.wordsDelivered,
      paidAtomic: "0",
    });
    const freeChunkRequests = freeChunkRequestMap(session);
    session.metadata = {
      ...session.metadata,
      freeChunkRequests: {
        ...freeChunkRequests,
        [idempotencyBase]: {
          startSequence,
          endSequence: startSequence + released.length,
          completed,
        },
      },
    };
    if (completed) await paidReading.complete(session, session.articleId);
    else await ledger.saveSession(session);

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
    const cached = freeChunkRequestMap(session)[idempotencyKey];
    if (!cached) return undefined;
    const deliveries = (await ledger.listDeliveries(session.id))
      .filter((entry) => entry.sequence >= cached.startSequence && entry.sequence < cached.endSequence)
      .sort((left, right) => left.sequence - right.sequence);
    const words = deliveries.map((entry) => ({ sequence: entry.sequence, word: entry.word, priceAtomic: "0" as const }));
    return {
      accepted: true,
      words,
      text: words.map((entry) => entry.word).join(" "),
      wordsPaid: 0,
      wordsDelivered: session.wordsDelivered,
      paidAtomic: "0",
      completed: cached.completed,
    };
  }

  function freeChunkRequestMap(session: SessionRecord): Record<string, { startSequence: number; endSequence: number; completed: boolean }> {
    const value = session.metadata.freeChunkRequests;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, { startSequence: number; endSequence: number; completed: boolean }>;
  }

  app.get("/health", async () => ({ ok: true }));

  app.get("/v1/endpoints", async () => ({ endpoints: ENDPOINTS }));

  // AgentCash / x402 discovery document. Public (exempt from the agent API key)
  // so discovery crawlers can read it without credentials.
  app.get("/openapi.json", async (_request, reply) => {
    reply.header("content-type", "application/json; charset=utf-8");
    return buildOpenApiDocument({
      baseUrl: gatewayBaseUrl,
      version: options.version ?? "0.1.0",
      contactEmail: process.env.RUBICON_CONTACT_EMAIL,
      apiKeyProtected: Boolean(agentApiKey),
    });
  });

  // Minimal favicon so discovery crawlers don't warn about a missing origin icon.
  const faviconSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#111"/><text x="16" y="22" font-size="18" text-anchor="middle" fill="#fff" font-family="sans-serif">R</text></svg>';
  app.get("/favicon.ico", async (_request, reply) => {
    reply.header("content-type", "image/svg+xml").header("cache-control", "public, max-age=86400");
    return faviconSvg;
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

  app.post<{ Body: StartSessionRequest | undefined }>("/v1/sessions", async (request, reply) => {
    // x402 discovery: a bare/unpaid probe of this paid endpoint (no articleId or
    // budget) must announce that payment is required — a 402 that precedes any
    // body/query validation — rather than a 400/404/500. Legitimate opens always
    // carry articleId + budget and fall through to the normal flow below.
    const body = request.body;
    if (!body || !body.articleId || !body.budget?.maxAmountAtomic) {
      return reply.code(402).send({
        error: "payment_required",
        message:
          "This endpoint sells article words metered per word in USDC (x402). Provide `articleId` and a `budget` to open a session; the response returns an x402 authorization whose recipient is the article creator's wallet. See /openapi.json.",
        meteringUnit: "word",
        asset: "USDC",
      });
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
      const record = await ledger.recordWordDelivery({
        sessionId: session.id,
        articleId: session.articleId,
        creatorId: session.creatorId,
        sequence,
        word: nextWord,
        priceAtomic: wordPaymentAtomic,
        creatorAmountAtomic: BigInt(usage.creatorAmountAtomic),
        rubiconFeeAtomic: BigInt(usage.rubiconFeeAtomic),
        paymentId: randomUUID(),
        network: verification.network,
        payTo: verification.payTo ?? session.sellerWallet,
        transactionHash: verification.transactionHash,
        transactionHashes: verification.transactionHashes,
        settlementId: verification.settlementId,
        settlementIds: verification.settlementIds,
        buyerWalletAddress: verification.buyerWalletAddress,
        transferId: verification.transferId,
        idempotencyKey,
      });
      if (!record.payment) {
        return reply.code(500).send({ error: "paid_delivery_missing_payment" });
      }
      if (record.duplicate) {
        // Lost an idempotency race; return the canonical word without re-charging.
        // The winning request emits completion + closes the session over SSE.
        return sendPaymentResponse(
          reply,
          buildPaymentResponse(
            session,
            record.delivery.word,
            record.delivery.sequence,
            wordPaymentAtomic,
            false,
            record.payment.transactionHash,
            record.payment.transactionHashes,
            record.payment.paymentId,
            record.payment.network,
            record.payment.payTo,
            record.payment.createdAt,
            record.payment.settlementId,
            record.payment.settlementIds,
            record.payment.buyerWalletAddress,
            record.payment.transferId,
          ),
        );
      }

      recordWordPayment(session, verification.amountAtomic);
      recordWordDelivery(session);
      await ledger.saveSession(session);

      events.publish({
        type: "word.payment_accepted",
        sessionId: session.id,
        sequence,
        paymentId: record.payment.paymentId,
        amountAtomic: `${wordPaymentAtomic}`,
        network: record.payment.network,
        payTo: record.payment.payTo,
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
          record.payment.paymentId,
          record.payment.network,
          record.payment.payTo,
          record.payment.createdAt,
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

      const released: StreamChunkResponse["words"] = [];
      const bundleSequence =
        typeof session.metadata.bundleSequence === "number" ? session.metadata.bundleSequence : 0;
      const bundlePaymentId = randomUUID();
      const bundleStartSequence = session.wordsDelivered;
      const bundleSettledAt = new Date().toISOString();
      let chunkCompleted = false;
      for (let offset = 0; offset < maxWords; offset += 1) {
        if (!canAffordNextWord(session, wordPaymentAtomic)) {
          break;
        }
        const nextWord = paidReading.nextWord(state, session.wordsDelivered);
        if (nextWord === null) {
          await paidReading.complete(session, state.article.id);
          chunkCompleted = true;
          break;
        }

        const sequence = session.wordsDelivered;
        const usage = usageForWords({
          wordsDelivered: 1,
          pricePerWordAtomic: session.pricePerWordAtomic,
          gatewayFeeBps: session.gatewayFeeBps,
        });
        const record = await ledger.recordWordDelivery({
          sessionId: session.id,
          articleId: session.articleId,
          creatorId: session.creatorId,
          sequence,
          word: nextWord,
          priceAtomic: wordPaymentAtomic,
          creatorAmountAtomic: BigInt(usage.creatorAmountAtomic),
          rubiconFeeAtomic: BigInt(usage.rubiconFeeAtomic),
          paymentId: randomUUID(),
          network: verification.network,
          payTo: verification.payTo ?? session.sellerWallet,
          transactionHash: verification.transactionHash,
          transactionHashes: verification.transactionHashes,
          settlementId: verification.settlementId,
          settlementIds: verification.settlementIds,
          buyerWalletAddress: verification.buyerWalletAddress,
          transferId: verification.transferId,
          idempotencyKey: `${idempotencyKey}:${sequence}`,
        });
        if (record.duplicate) {
          continue;
        }

        recordWordPayment(session, `${wordPaymentAtomic}`);
        recordWordDelivery(session);
        await ledger.saveSession(session);
        released.push({
          sequence,
          word: nextWord,
          priceAtomic: `${wordPaymentAtomic}`,
        });

        if (session.wordsDelivered >= state.words.length) {
          await paidReading.complete(session, session.articleId);
          chunkCompleted = true;
          break;
        }
      }

      const bundleText = released.map((entry) => entry.word).join(" ");
      const bundleAmountAtomic = wordPaymentAtomic * BigInt(released.length);
      const bundlePayment = buildWordReceipt(
        session,
        bundleStartSequence,
        bundleAmountAtomic,
        released.length > 0 ? bundlePaymentId : "",
        verification.network,
        verification.payTo ?? session.sellerWallet,
        bundleSettledAt,
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
        session.metadata = { ...session.metadata, bundleSequence: bundleSequence + 1 };
        await ledger.saveSession(session);
        events.publish({
          type: "word.payment_accepted",
          sessionId: session.id,
          sequence: bundleStartSequence,
          paymentId: bundlePaymentId,
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
          paymentId: bundlePaymentId,
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

    const history = (await ledger.listMessages(conversationId)).map((entry) => ({
      role: entry.role,
      content: entry.content,
    }));
    const result = await sellerAgent.respond({
      article,
      conversationId,
      goal,
      history,
      message,
    });
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
