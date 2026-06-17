import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  canAffordNextWord,
  createSession,
  isSessionExpired,
  quotePerWord,
  recordWordDelivery,
  recordWordPayment,
  usageForWords,
  type ArticleNavigation,
  type ArticleSummary,
  type ConversationMessage,
  type GatewayEvent,
  type SellerAgentMessageRecord,
  type SendConversationMessageRequest,
  type SendConversationMessageResponse,
  type SessionRecord,
  type StartConversationRequest,
  type StartConversationResponse,
  type StartSessionRequest,
  type StartSessionResponse,
  type StreamPaymentRequest,
  type StreamPaymentResponse,
  type StreamStopCondition,
  type WordPaymentReceipt,
} from "@rubicon-caliga/core";
import { InMemoryEventBus } from "./stores/event-bus.js";
import { summarizeArticle } from "./repositories/in-memory.js";
import type { ArticleRecord, LedgerRepository, PublishedArticleRepository } from "./repositories/types.js";
import { DefaultSellerAgent, type SellerAgent } from "./seller-agent/seller-agent.js";
import { DevelopmentPaymentVerifier, type PaymentVerifier } from "./payments/types.js";
import { wordsForSection } from "./words.js";

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
}

interface StreamState {
  article: ArticleRecord;
  words: string[];
  sectionId: string;
}

const STOP_CONDITIONS: StreamStopCondition[] = [
  { kind: "sufficient_information", description: "Stop once the buyer agent has enough paid words for its task." },
  { kind: "max_words", description: "Stop after a buyer-selected word limit." },
  { kind: "max_payments", description: "Stop after a buyer-selected number of word payments." },
  { kind: "max_spend_atomic", description: "Stop before exceeding the buyer-selected atomic USDC spend limit." },
  { kind: "article_completed", description: "Stop automatically when the selected section or article is complete." },
  { kind: "payment_rejected", description: "Stop if a one-word payment fails verification or settlement." },
];

const ENDPOINTS = [
  { method: "GET", path: "/health", description: "Gateway health check." },
  { method: "GET", path: "/v1/endpoints", description: "Lists gateway endpoints." },
  { method: "GET", path: "/v1/repository", description: "Lists live articles available to buyer agents." },
  { method: "GET", path: "/v1/articles/:articleId/navigation", description: "Safe seller-agent navigation; no unpaid body text." },
  { method: "POST", path: "/v1/seller-agent/conversations", description: "Opens a conversation with an article's seller agent." },
  { method: "POST", path: "/v1/seller-agent/conversations/:conversationId/messages", description: "Sends a message to the seller agent." },
  { method: "POST", path: "/v1/sessions", description: "Opens a budgeted reading session and returns the one-word payment requirement." },
  { method: "POST", path: "/v1/sessions/:sessionId/payments", description: "Verifies one word payment and releases exactly one word." },
  { method: "GET", path: "/v1/sessions/:sessionId/events", description: "Server-sent word-level events." },
  { method: "POST", path: "/v1/sessions/:sessionId/abort", description: "Aborts a session." },
];

export function createGateway(options: GatewayOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  const events = new InMemoryEventBus();
  const sellerAgent = options.sellerAgent ?? new DefaultSellerAgent();
  const paymentVerifier = options.paymentVerifier ?? new DevelopmentPaymentVerifier();
  const ledger = options.ledger;
  const articles = options.articleRepository;
  const gatewayFeeBps = options.gatewayFeeBps ?? 0;
  const gatewayBaseUrl = options.gatewayBaseUrl ?? `http://localhost:${process.env.GATEWAY_PORT ?? process.env.PORT ?? 8787}`;
  const agentApiKey = process.env.RUBICON_AGENT_API_KEY;
  const streamStates = new Map<string, StreamState>();

  app.addHook("onRequest", async (request, reply) => {
    if (!agentApiKey || request.url === "/health") {
      return;
    }
    const authorization = request.headers.authorization;
    const expected = `Bearer ${agentApiKey}`;
    if (authorization !== expected) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  async function buildNavigation(article: ArticleRecord, goal?: string): Promise<ArticleNavigation> {
    const navigation = await sellerAgent.navigate({ article, goal });
    return {
      articleId: article.id,
      sections: summarizeArticle(article).sections,
      sellerAgent: {
        recommendedSectionId: navigation.recommendedSectionId,
        alternativeSectionIds: navigation.alternativeSectionIds,
        rationale: navigation.rationale,
        safeHints: navigation.safeHints,
        withheld: navigation.withheld,
      },
      stopConditions: STOP_CONDITIONS,
    };
  }

  app.get("/health", async () => ({ ok: true }));

  app.get("/v1/endpoints", async () => ({ endpoints: ENDPOINTS }));

  app.get("/v1/repository", async () => ({
    repository: "articles",
    articles: await articles.listPublishedArticles(),
  }));

  app.get("/v1/articles", async () => ({
    repository: "articles",
    articles: await articles.listPublishedArticles(),
  }));

  app.get<{ Params: { articleId: string }; Querystring: { goal?: string } }>(
    "/v1/articles/:articleId/navigation",
    async (request, reply) => {
      const article = await articles.getPublishedArticle(request.params.articleId);
      if (!article) {
        return reply.code(404).send({ error: "article_not_available" });
      }
      return {
        article: summarizeArticle(article),
        navigation: await buildNavigation(article, request.query.goal),
      };
    },
  );

  app.post<{ Body: StartConversationRequest }>("/v1/seller-agent/conversations", async (request, reply) => {
    const article = await articles.getPublishedArticle(request.body.articleId);
    if (!article) {
      return reply.code(404).send({ error: "article_not_available" });
    }
    const conversationId = crypto.randomUUID();
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
      article: summarizeArticle(article),
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

  app.post<{ Body: StartSessionRequest }>("/v1/sessions", async (request, reply) => {
    const article = await articles.getPublishedArticle(request.body.articleId);
    if (!article) {
      // Draft, paused, archived, deleted, or unknown — never start a paid session.
      return reply.code(404).send({ error: "article_not_available" });
    }

    const wallet = await articles.getCreatorWallet(article.creatorId);
    if (!wallet) {
      return reply.code(409).send({ error: "creator_wallet_not_configured" });
    }
    if (!wallet.verified) {
      return reply.code(409).send({ error: "creator_wallet_unverified" });
    }

    const sectionId = request.body.sectionId ?? "full-article";
    const slice = wordsForSection(article.words, article.sections, sectionId);
    if (!slice) {
      return reply.code(404).send({ error: "section_not_found" });
    }

    const quote = quotePerWord({ pricePerWordAtomic: article.pricePerWordAtomic, gatewayFeeBps });

    let conversationId = request.body.conversationId;
    if (conversationId) {
      const existing = await ledger.getConversation(conversationId);
      if (!existing || existing.articleId !== article.id) {
        return reply.code(404).send({ error: "conversation_not_found" });
      }
    } else {
      conversationId = crypto.randomUUID();
      await ledger.createConversation({
        id: conversationId,
        articleId: article.id,
        creatorId: article.creatorId,
        goal: request.body.goal,
      });
    }

    const session = createSession({
      articleId: article.id,
      creatorId: article.creatorId,
      conversationId,
      goal: request.body.goal,
      sectionId,
      budget: request.body.budget,
      pricePerWordAtomic: article.pricePerWordAtomic,
      gatewayFeeBps,
      sellerWallet: wallet.address,
      metadata: request.body.metadata,
      ttlMs: options.sessionTtlMs,
    });
    await ledger.createSession(session);
    streamStates.set(session.id, { article, words: slice.words, sectionId });

    const paymentRequired = await paymentVerifier.createPaymentRequired?.({
      session,
      article,
      sellerWallet: wallet.address,
      wordPaymentAtomic: BigInt(quote.wordPaymentAtomic),
      gatewayBaseUrl,
    });

    const summary = summarizeArticle(article);
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
      article: summary,
      navigation: await buildNavigation(article, request.body.goal),
      pricePerWordAtomic: quote.pricePerWordAtomic,
      maxArticlePriceAtomic: summary.maxArticlePriceAtomic,
      conversationId,
      wordPaymentAtomic: quote.wordPaymentAtomic,
      gatewayFeeBps,
      paymentRequired,
      expiresAt: session.expiresAt.toISOString(),
      wordsPaid: 0,
      wordsDelivered: 0,
      paidAtomic: "0",
    };
    return reply.code(201).send(response);
  });

  app.post<{ Params: { sessionId: string }; Body: StreamPaymentRequest }>(
    "/v1/sessions/:sessionId/payments",
    async (request, reply) => {
      const session = await ledger.getSession(request.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      const sequence = session.wordsDelivered;
      const idempotencyKey = request.body.idempotencyKey ?? `${session.id}:${sequence}`;

      // Idempotency: a retried payment must not release or charge a word twice.
      // Checked before state guards so retries of the final word stay idempotent.
      const cached = await ledger.getDeliveryByIdempotencyKey(idempotencyKey);
      if (cached) {
        return sendPaymentResponse(
          reply,
          buildPaymentResponse(
            session,
            cached.delivery.word,
            cached.delivery.sequence,
            BigInt(cached.delivery.priceAtomic),
            session.state === "completed",
            cached.payment.transactionHash ?? cached.payment.transferId,
            cached.payment.transactionHashes,
            cached.payment.paymentId,
            cached.payment.network,
            cached.payment.payTo,
            cached.payment.createdAt,
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

      // The next word the buyer is paying for. Decided before settlement; only
      // emitted after a verified payment. Never reveals future words.
      const state = await resolveStreamState(session);
      if (!state) {
        return reply.code(404).send({ error: "article_unavailable" });
      }
      const next = await sellerAgent.selectNextWord({
        article: state.article,
        words: state.words,
        nextIndex: sequence,
        sectionId: state.sectionId,
      });
      if (next.word === null) {
        await complete(session, state.article.id);
        return reply.send(
          buildPaymentResponse(session, "", sequence, wordPaymentAtomic, true),
        );
      }

      if (!canAffordNextWord(session, wordPaymentAtomic)) {
        await closeSession(session, "budget_exhausted");
        return reply.code(402).send({ error: "budget_exhausted" });
      }

      const verification = await paymentVerifier.verify({ session, wordPaymentAtomic, payment: request.body });
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
        word: next.word,
        priceAtomic: wordPaymentAtomic,
        creatorAmountAtomic: BigInt(usage.creatorAmountAtomic),
        rubiconFeeAtomic: BigInt(usage.rubiconFeeAtomic),
        paymentId: crypto.randomUUID(),
        network: verification.network,
        payTo: verification.payTo ?? session.sellerWallet,
        transactionHash: verification.transactionHash ?? verification.transferId,
        transactionHashes: paymentTransactionHashes(verification.transactionHash, verification.transactionHashes, verification.transferId),
        transferId: verification.transferId,
        idempotencyKey,
      });
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
            record.payment.transactionHash ?? record.payment.transferId,
            record.payment.transactionHashes,
            record.payment.paymentId,
            record.payment.network,
            record.payment.payTo,
            record.payment.createdAt,
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
        transactionHash: verification.transactionHash ?? verification.transferId,
        transactionHashes: paymentTransactionHashes(verification.transactionHash, verification.transactionHashes, verification.transferId),
        transferId: verification.transferId,
      });
      events.publish({
        type: "article.word",
        sessionId: session.id,
        articleId: session.articleId,
        sequence,
        word: next.word,
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

      const completed = next.done;
      if (completed) {
        await complete(session, session.articleId);
      }

      return sendPaymentResponse(
        reply,
        buildPaymentResponse(
          session,
          next.word,
          sequence,
          wordPaymentAtomic,
          completed,
          verification.transactionHash ?? verification.transferId,
          paymentTransactionHashes(verification.transactionHash, verification.transactionHashes, verification.transferId),
          record.payment.paymentId,
          record.payment.network,
          record.payment.payTo,
          record.payment.createdAt,
        ),
      );
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
      await closeSession(session, request.body?.reason ?? "agent_cancelled");
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
      id: crypto.randomUUID(),
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
      id: crypto.randomUUID(),
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

  async function resolveStreamState(session: SessionRecord): Promise<StreamState | undefined> {
    const existing = streamStates.get(session.id);
    if (existing) {
      return existing;
    }
    // Rebuild after a restart. Existing sessions continue even if the article is
    // now paused (documented policy): we reload the article by id regardless of
    // public state when possible.
    const article =
      (await maybeGetAnyState(session.articleId)) ?? (await articles.getPublishedArticle(session.articleId));
    if (!article) {
      return undefined;
    }
    const slice = wordsForSection(article.words, article.sections, session.sectionId);
    if (!slice) {
      return undefined;
    }
    const rebuilt: StreamState = { article, words: slice.words, sectionId: session.sectionId ?? "full-article" };
    streamStates.set(session.id, rebuilt);
    return rebuilt;
  }

  async function maybeGetAnyState(articleId: string): Promise<ArticleRecord | null> {
    const repo = articles as PublishedArticleRepository & {
      getArticleAnyState?(id: string): Promise<ArticleRecord | null>;
    };
    if (typeof repo.getArticleAnyState === "function") {
      return repo.getArticleAnyState(articleId);
    }
    return null;
  }

  async function complete(session: SessionRecord, articleId: string): Promise<void> {
    session.state = "completed";
    await ledger.saveSession(session);
    streamStates.delete(session.id);
    events.publish({
      type: "article.completed",
      sessionId: session.id,
      articleId,
      totalWordsStreamed: session.wordsDelivered,
      totalPaidAtomic: `${session.paidAtomic}`,
    });
    events.publish({ type: "session.closed", sessionId: session.id, reason: "article_completed" });
  }

  async function closeSession(session: SessionRecord, reason: string): Promise<void> {
    session.state = reason === "budget_exhausted" ? "expired" : "aborted";
    await ledger.saveSession(session);
    streamStates.delete(session.id);
    events.publish({ type: "session.aborted", sessionId: session.id, reason });
  }

  function buildPaymentResponse(
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
  ): StreamPaymentResponse {
    const hashes = transactionHashes ?? (transactionHash ? [transactionHash] : undefined);
    const payment: WordPaymentReceipt | undefined = paymentId
      ? {
          paymentId,
          sessionId: session.id,
          articleId: session.articleId,
          sequence,
          meteringUnit: "word",
          amountAtomic: `${priceAtomic}`,
          currency: "USDC",
          network,
          payTo,
          transactionHash,
          transactionHashes: hashes,
          transferId: transactionHash,
          settledAt,
        }
      : undefined;
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
      transactionHashes: hashes,
      transferId: transactionHash,
    };
  }

  function paymentTransactionHashes(
    transactionHash?: string,
    transactionHashes?: string[],
    transferId?: string,
  ): string[] | undefined {
    return transactionHashes ?? (transactionHash || transferId ? [transactionHash ?? transferId!] : undefined);
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
