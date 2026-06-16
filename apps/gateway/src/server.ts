import Fastify, { type FastifyInstance } from "fastify";
import {
  canPay,
  createSession,
  quotePerWords,
  recordPayment,
  usageForWords,
  type ArticleHeader,
  type ArticleNavigation,
  type ArticleSummary,
  type GatewayEvent,
  type PaymentVerification,
  type SessionRecord,
  type StartSessionRequest,
  type StartSessionResponse,
  type StreamPaymentRequest,
} from "@rubicon-caliga/core";
import { InMemoryEventBus } from "./stores/event-bus.js";
import { InMemorySessionStore } from "./stores/session-store.js";

export interface ArticleRecord {
  articleId: string;
  authorUsername: string;
  title: string;
  content: string;
  pricePerWordAtomic: bigint;
  maxPriceAtomic?: bigint;
}

export interface AuthorRecord {
  authorUsername: string;
  walletAddress: `0x${string}`;
}

export interface ArticleRepository {
  listArticleSummaries(): Promise<ArticleSummary[]>;
  resolveArticle(request: Pick<StartSessionRequest, "articleId" | "query">): Promise<ArticleRecord | undefined>;
  resolveAuthor(authorUsername: string): Promise<AuthorRecord | undefined>;
}

export interface GatewayOptions {
  articleRepository?: ArticleRepository;
  articles?: ArticleRecord[];
  authors?: AuthorRecord[];
  sellerAgentApiKey?: string;
  paymentChunkWords: number;
  sessionTtlMs: number;
  gatewayFeeBps: number;
  gatewayBaseUrl?: string;
  paymentVerifier?: PaymentVerifier;
}

export interface PaymentVerifier {
  verify(session: SessionRecord, payment: StreamPaymentRequest): Promise<PaymentVerification>;
  createPaymentRequired?(input: {
    session: SessionRecord;
    article: ArticleRecord;
    author: AuthorRecord;
    amountAtomic: `${bigint}`;
    gatewayBaseUrl: string;
  }): Promise<unknown>;
}

class DevelopmentPaymentVerifier implements PaymentVerifier {
  async verify(session: SessionRecord, payment: StreamPaymentRequest): Promise<PaymentVerification> {
    const payload = payment.paymentPayload as { amountAtomic?: string } | undefined;
    return {
      accepted: true,
      amountAtomic: (payload?.amountAtomic ?? "0") as `${bigint}`,
      transferId: `dev_${session.id}_${Date.now()}`,
    };
  }

  async createPaymentRequired(input: { amountAtomic: `${bigint}` }): Promise<unknown> {
    return {
      x402Version: 2,
      resource: { url: "development://stream-payment" },
      accepts: [
        {
          scheme: "development-static",
          network: "development",
          amount: input.amountAtomic,
          asset: "USDC",
          payTo: "development",
          maxTimeoutSeconds: 60,
        },
      ],
    };
  }
}

export class InMemoryArticleRepository implements ArticleRepository {
  private readonly articles: ArticleRecord[];
  private readonly articleById: Map<string, ArticleRecord>;
  private readonly authorByUsername: Map<string, AuthorRecord>;

  constructor(input: { articles: ArticleRecord[]; authors: AuthorRecord[] }) {
    this.articles = input.articles;
    this.articleById = new Map(input.articles.map((article) => [article.articleId, article]));
    this.authorByUsername = new Map(input.authors.map((author) => [author.authorUsername, author]));
  }

  async listArticleSummaries(): Promise<ArticleSummary[]> {
    return this.articles.map((article) => summarizeArticle(article));
  }

  async resolveArticle(request: Pick<StartSessionRequest, "articleId" | "query">): Promise<ArticleRecord | undefined> {
    if (request.articleId) {
      return this.articleById.get(request.articleId);
    }
    if (!request.query) {
      return undefined;
    }
    const query = request.query.toLocaleLowerCase();
    return this.articles.find(
      (article) =>
        article.title.toLocaleLowerCase().includes(query) ||
        article.content.toLocaleLowerCase().includes(query),
    );
  }

  async resolveAuthor(authorUsername: string): Promise<AuthorRecord | undefined> {
    return this.authorByUsername.get(authorUsername);
  }
}

interface StreamState {
  article: ArticleRecord;
  articleSummary: ArticleSummary;
  author: AuthorRecord;
  words: string[];
  wordOffset: number;
}

interface EndpointDescription {
  method: string;
  path: string;
  name: string;
  description: string;
}

const endpointDescriptions: EndpointDescription[] = [
  {
    method: "GET",
    path: "/health",
    name: "health",
    description: "Gateway health check.",
  },
  {
    method: "GET",
    path: "/v1/endpoints",
    name: "endpoints",
    description: "Lists the gateway endpoints exposed by this service.",
  },
  {
    method: "GET",
    path: "/v1/repository",
    name: "repository",
    description: "Shows existing article summaries and free article headers from the configured article repository.",
  },
  {
    method: "GET",
    path: "/v1/articles",
    name: "articles",
    description: "Alias for the repository article summaries.",
  },
  {
    method: "GET",
    path: "/v1/articles/:articleId/navigation",
    name: "article_navigation",
    description: "Returns neutral, free article headers and stop conditions without revealing article content.",
  },
  {
    method: "POST",
    path: "/v1/seller-agent/navigation",
    name: "seller_agent_navigation",
    description: "Authenticated neutral seller-agent route that helps buyers choose headers without revealing content.",
  },
  {
    method: "POST",
    path: "/v1/sessions",
    name: "start_article_stream",
    description: "Starts a budgeted article stream and returns x402 payment requirements.",
  },
  {
    method: "POST",
    path: "/v1/sessions/:sessionId/payments",
    name: "stream_nanopayment",
    description: "Verifies and settles one x402 nanopayment before releasing the next word chunk.",
  },
  {
    method: "GET",
    path: "/v1/sessions/:sessionId/events",
    name: "stream_events",
    description: "Server-sent events for paid article chunks and usage.",
  },
  {
    method: "POST",
    path: "/v1/sessions/:sessionId/abort",
    name: "abort_stream",
    description: "Aborts an active stream session.",
  },
];

export function createGateway(options: GatewayOptions): FastifyInstance {
  const app = Fastify({ logger: true });
  const sessions = new InMemorySessionStore();
  const events = new InMemoryEventBus();
  const paymentVerifier = options.paymentVerifier ?? new DevelopmentPaymentVerifier();
  const articleRepository =
    options.articleRepository ??
    new InMemoryArticleRepository({
      articles: options.articles ?? [],
      authors: options.authors ?? [],
    });
  const streamStates = new Map<string, StreamState>();

  app.get("/health", async () => ({ ok: true }));

  app.get("/v1/endpoints", async () => ({
    endpoints: endpointDescriptions,
  }));

  app.get("/v1/repository", async () => repositoryResponse(articleRepository));

  app.get("/v1/articles", async () => repositoryResponse(articleRepository));

  app.get<{ Params: { articleId: string } }>("/v1/articles/:articleId/navigation", async (request, reply) => {
    const article = await articleRepository.resolveArticle({ articleId: request.params.articleId });
    if (!article) {
      return reply.code(404).send({ error: "article_not_found" });
    }

    return {
      article: summarizeArticle(article),
      navigation: navigationForArticle(article),
    };
  });

  app.post<{
    Body: {
      articleId: string;
      buyerGoal?: string;
      candidateSectionIds?: string[];
      maxSpendAtomic?: `${bigint}`;
    };
  }>("/v1/seller-agent/navigation", async (request, reply) => {
    if (!isSellerAgentAuthorized(request.headers.authorization, options.sellerAgentApiKey)) {
      return reply.code(401).send({ error: "seller_agent_unauthorized" });
    }

    const article = await articleRepository.resolveArticle({ articleId: request.body.articleId });
    if (!article) {
      return reply.code(404).send({ error: "article_not_found" });
    }

    return {
      article: summarizeArticle(article),
      sellerAgent: sellerAgentNavigation(article, {
        buyerGoal: request.body.buyerGoal,
        candidateSectionIds: request.body.candidateSectionIds,
        maxSpendAtomic: request.body.maxSpendAtomic,
      }),
    };
  });

  app.post<{ Body: StartSessionRequest }>("/v1/sessions", async (request, reply) => {
    const article = await articleRepository.resolveArticle(request.body);
    if (!article) {
      return reply.code(404).send({ error: "article_not_found" });
    }

    const author = await articleRepository.resolveAuthor(article.authorUsername);
    if (!author) {
      return reply.code(500).send({ error: "author_wallet_not_configured" });
    }
    const articleSummary = summarizeArticle(article);
    const section = resolveSection(article, request.body.sectionId);
    if (!section) {
      return reply.code(404).send({ error: "section_not_found" });
    }

    const session = createSession({
      articleId: article.articleId,
      query: request.body.query,
      sectionId: request.body.sectionId,
      budget: request.body.budget,
      metadata: request.body.metadata,
      ttlMs: options.sessionTtlMs,
    });
    sessions.set(session);

    const quote = quotePerWords({
      unitPriceAtomic: article.pricePerWordAtomic,
      chunkWords: options.paymentChunkWords,
      gatewayFeeBps: options.gatewayFeeBps,
    });
    const paymentChunkAtomic = quote.chargePerChunkAtomic;

    session.metadata.paymentChunkAtomic = paymentChunkAtomic;
    session.metadata.chargePerWordAtomic = quote.chargePerWordAtomic;
    session.metadata.gatewayBaseUrl = options.gatewayBaseUrl ?? `http://localhost:${process.env.GATEWAY_PORT ?? 8787}`;
    session.metadata.articleSnapshot = {
      articleId: article.articleId,
      authorUsername: article.authorUsername,
      sellerAddress: author.walletAddress,
      pricePerWordAtomic: `${article.pricePerWordAtomic}`,
      paymentChunkWords: options.paymentChunkWords,
    };
    sessions.set(session);
    streamStates.set(session.id, {
      article,
      articleSummary,
      author,
      words: section.words,
      wordOffset: section.wordStart,
    });

    const paymentRequired = await paymentVerifier.createPaymentRequired?.({
      session,
      article,
      author,
      amountAtomic: paymentChunkAtomic,
      gatewayBaseUrl: session.metadata.gatewayBaseUrl as string,
    });

    events.publish({
      type: "session.started",
      sessionId: session.id,
      state: session.state,
      article: articleSummary,
      quote,
    });

    const response: StartSessionResponse = {
      sessionId: session.id,
      state: session.state,
      article: articleSummary,
      navigation: navigationForArticle(article),
      quote,
      paymentRequired,
      paymentChunkWords: options.paymentChunkWords,
      expiresAt: session.expiresAt.toISOString(),
    };

    return reply.code(201).send(response);
  });

  app.post<{ Params: { sessionId: string }; Body: StreamPaymentRequest }>(
    "/v1/sessions/:sessionId/payments",
    async (request, reply) => {
      const session = sessions.get(request.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      const verification = await paymentVerifier.verify(session, request.body);
      if (!verification.accepted || !verification.amountAtomic) {
        await closeSession(session, verification.reason ?? "payment_rejected");
        return reply.code(402).send({ error: verification.reason ?? "payment_rejected" });
      }

      const charge = BigInt(verification.amountAtomic);
      const expectedCharge = expectedPaymentAtomic(session);
      if (charge !== expectedCharge) {
        await closeSession(session, "payment_amount_mismatch");
        return reply.code(402).send({
          error: "payment_amount_mismatch",
          expectedAmountAtomic: `${expectedCharge}`,
          receivedAmountAtomic: `${charge}`,
        });
      }

      if (!canPay(session, charge)) {
        await closeSession(session, "budget_exhausted");
        return reply.code(402).send({ error: "budget_exhausted" });
      }

      const streamState = streamStates.get(session.id);
      if (!streamState) {
        await closeSession(session, "stream_state_unavailable");
        return reply.code(404).send({ error: "article_unavailable" });
      }

      recordPayment(session, verification.amountAtomic);
      sessions.set(session);

      const wordsUnlocked = wordsPaidFor(session, charge);
      events.publish({
        type: "session.payment_accepted",
        sessionId: session.id,
        paidAtomic: `${session.paidAtomic}`,
        wordsUnlocked,
        transferId: verification.transferId,
      });

      const streamed = streamPaidWords(session, streamState, wordsUnlocked);
      sessions.set(session);

      if (streamed.completed) {
        session.state = "completed";
        sessions.set(session);
        events.publish({
          type: "article.completed",
          sessionId: session.id,
          articleId: streamState.article.articleId,
          totalWordsStreamed: session.wordsStreamed,
        });
        events.publish({ type: "session.closed", sessionId: session.id, reason: "article_completed" });
        streamStates.delete(session.id);
      }

      return reply.send({
        accepted: true,
        paidAtomic: `${session.paidAtomic}`,
        wordsStreamed: session.wordsStreamed,
        completed: streamed.completed,
      });
    },
  );

  app.get<{ Params: { sessionId: string } }>("/v1/sessions/:sessionId/events", async (request, reply) => {
    if (!sessions.get(request.params.sessionId)) {
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
      const session = sessions.get(request.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      await closeSession(session, request.body.reason ?? "agent_cancelled");
      return reply.send({ aborted: true });
    },
  );

  async function closeSession(session: SessionRecord, reason: string): Promise<void> {
    session.state = reason === "budget_exhausted" ? "expired" : "aborted";
    sessions.set(session);
    streamStates.delete(session.id);
    events.publish({ type: "session.aborted", sessionId: session.id, reason });
  }

  function streamPaidWords(
    session: SessionRecord,
    streamState: StreamState,
    wordsUnlocked: number,
  ): { completed: boolean } {
    const remaining = streamState.words.length - session.wordsStreamed;
    const count = Math.min(wordsUnlocked, remaining);
    if (count <= 0) {
      return { completed: session.wordsStreamed >= streamState.words.length };
    }

    const start = session.wordsStreamed;
    const chunk = streamState.words.slice(start, start + count);
    const text = chunk.join(" ");
    const usage = usageForWords({
      wordCount: count,
      unitPriceAtomic: streamState.article.pricePerWordAtomic,
      gatewayFeeBps: options.gatewayFeeBps,
    });

    session.wordsStreamed += count;
    session.spentAtomic += BigInt(usage.totalCostAtomic);

    events.publish({
      type: "article.chunk",
      sessionId: session.id,
      articleId: streamState.article.articleId,
      index: streamState.wordOffset + start,
      text,
      words: count,
    });
    events.publish({
      type: "article.usage",
      sessionId: session.id,
      usage,
      wordsStreamed: session.wordsStreamed,
    });

    return { completed: session.wordsStreamed >= streamState.words.length };
  }

  return app;
}

function summarizeArticle(article: ArticleRecord): ArticleSummary {
  const totalWords = tokenizeWords(article.content).length;
  const maxPriceAtomic = article.maxPriceAtomic ?? article.pricePerWordAtomic * BigInt(totalWords);
  return {
    articleId: article.articleId,
    authorUsername: article.authorUsername,
    title: article.title,
    totalWords,
    maxPriceAtomic: `${maxPriceAtomic}`,
    headers: headersForArticle(article),
  };
}

async function repositoryResponse(articleRepository: ArticleRepository): Promise<{
  repository: "articles";
  articles: ArticleSummary[];
}> {
  return {
    repository: "articles",
    articles: await articleRepository.listArticleSummaries(),
  };
}

function tokenizeWords(content: string): string[] {
  return content.trim().split(/\s+/).filter(Boolean);
}

function navigationForArticle(article: ArticleRecord): ArticleNavigation {
  return {
    headers: headersForArticle(article),
    neutralSeller: {
      role: "neutral_article_navigator",
      guidance:
        "Use the free headers to choose a sectionId, budget, and stop conditions. The gateway will not summarize, preview, or reveal paid article content before settlement.",
      reveals: ["article title", "author username", "section headers", "section word ranges", "pricing"],
      withholds: ["section body text", "claims", "conclusions", "quotes", "specific facts not present in headers"],
    },
    stopConditions: [
      {
        kind: "sufficient_information",
        description: "Stop once the buyer agent has enough paid text for its task.",
      },
      {
        kind: "max_words",
        description: "Stop after a buyer-selected word limit.",
      },
      {
        kind: "max_payments",
        description: "Stop after a buyer-selected number of nanopayments.",
      },
      {
        kind: "max_spend_atomic",
        description: "Stop before exceeding the buyer-selected atomic USDC spend limit.",
      },
      {
        kind: "article_completed",
        description: "Stop automatically when the selected section or article is complete.",
      },
      {
        kind: "payment_rejected",
        description: "Stop if x402 verification or settlement fails.",
      },
    ],
  };
}

function sellerAgentNavigation(
  article: ArticleRecord,
  request: {
    buyerGoal?: string;
    candidateSectionIds?: string[];
    maxSpendAtomic?: `${bigint}`;
  },
): {
  role: "neutral_article_navigator";
  selectedSectionIds: string[];
  hints: string[];
  constraints: string[];
  withholds: string[];
} {
  const headers = headersForArticle(article);
  const goalTokens = tokenizeGoal(request.buyerGoal);
  const candidateIds = new Set(request.candidateSectionIds ?? []);
  const ranked = headers
    .map((header) => ({
      header,
      score:
        (candidateIds.has(header.sectionId) ? 3 : 0) +
        goalTokens.filter((token) => header.heading.toLocaleLowerCase().includes(token)).length,
    }))
    .sort((left, right) => right.score - left.score || left.header.wordStart - right.header.wordStart);
  const selected = ranked.filter((entry) => entry.score > 0).slice(0, 3);
  const fallback = ranked.slice(0, Math.min(3, ranked.length));
  const selectedHeaders = selected.length > 0 ? selected.map((entry) => entry.header) : fallback.map((entry) => entry.header);

  return {
    role: "neutral_article_navigator",
    selectedSectionIds: selectedHeaders.map((header) => header.sectionId),
    hints: selectedHeaders.map(
      (header) =>
        `Consider sectionId "${header.sectionId}" ("${header.heading}") because its header is the closest safe navigation signal available.`,
    ),
    constraints: [
      "Only title, author, headers, word ranges, and pricing were used.",
      "No body text, claims, conclusions, quotes, or hidden article facts were inspected or revealed.",
      request.maxSpendAtomic ? `Buyer max spend: ${request.maxSpendAtomic} atomic USDC.` : "Buyer max spend not supplied.",
    ],
    withholds: ["section body text", "critical article facts", "summaries", "quotes", "conclusions"],
  };
}

function tokenizeGoal(value: string | undefined): string[] {
  return (value ?? "")
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function isSellerAgentAuthorized(authorization: string | undefined, apiKey: string | undefined): boolean {
  if (!apiKey) {
    return false;
  }
  return authorization === `Bearer ${apiKey}`;
}

function headersForArticle(article: ArticleRecord): ArticleHeader[] {
  const fullArticleHeader: ArticleHeader = {
    sectionId: "full-article",
    heading: "Full article",
    level: 1,
    wordStart: 0,
    wordCount: tokenizeWords(article.content).length,
  };
  const explicitHeaders = articleHeadersFromMarkdown(article.content);
  if (explicitHeaders.length > 0) {
    return [fullArticleHeader, ...explicitHeaders];
  }

  return [fullArticleHeader];
}

function articleHeadersFromMarkdown(content: string): ArticleHeader[] {
  const lines = content.split(/\r?\n/);
  const headers: Array<{
    sectionId: string;
    heading: string;
    level: number;
    headerWordStart: number;
    contentWordStart: number;
  }> = [];
  let wordStart = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    const lineWordCount = tokenizeWords(line).length;
    const match = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (match) {
      headers.push({
        sectionId: slugify(match[2]),
        heading: match[2].trim(),
        level: match[1].length,
        headerWordStart: wordStart,
        contentWordStart: wordStart + lineWordCount,
      });
    }
    wordStart += lineWordCount;
  }

  return headers.map((header, index) => {
    const next = headers[index + 1];
    return {
      sectionId: header.sectionId,
      heading: header.heading,
      level: header.level,
      wordStart: header.contentWordStart,
      wordCount: (next?.headerWordStart ?? wordStart) - header.contentWordStart,
    };
  });
}

function resolveSection(article: ArticleRecord, sectionId: string | undefined): { words: string[]; wordStart: number } | undefined {
  const words = tokenizeWords(article.content);
  if (!sectionId) {
    return { words, wordStart: 0 };
  }

  const header = headersForArticle(article).find((candidate) => candidate.sectionId === sectionId);
  if (!header) {
    return undefined;
  }

  return {
    words: words.slice(header.wordStart, header.wordStart + header.wordCount),
    wordStart: header.wordStart,
  };
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

function expectedPaymentAtomic(session: SessionRecord): bigint {
  const paymentChunkAtomic = session.metadata.paymentChunkAtomic;
  if (typeof paymentChunkAtomic !== "string") {
    throw new Error("session_missing_payment_chunk_metadata");
  }
  return BigInt(paymentChunkAtomic);
}

function wordsPaidFor(session: SessionRecord, paymentAtomic: bigint): number {
  const chargePerWordAtomic = session.metadata.chargePerWordAtomic;
  if (typeof chargePerWordAtomic !== "string") {
    throw new Error("session_missing_word_pricing_metadata");
  }
  const perWord = BigInt(chargePerWordAtomic);
  if (perWord <= 0n) {
    return 0;
  }
  return Number(paymentAtomic / perWord);
}
