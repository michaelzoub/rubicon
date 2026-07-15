/**
 * The public, machine-readable contract served by `GET /openapi.json`.
 *
 * x402scan uses this as its marketplace catalog. The Base whole-article
 * endpoint is the only independently payable AgentCash resource; Rubicon's
 * session and seller-agent APIs are internal workflow routes and are excluded.
 */

export interface OpenApiOptions {
  baseUrl: string;
  version: string;
  /** Public contact used by x402scan/Poncho ownership verification. */
  contactEmail?: string;
  /** Whether a currently published article can be bought on the Base x402 lane. */
  agentCashPurchaseEnabled?: boolean;
  /** Decimal USD ceiling enforced by the Base purchase route. */
  agentCashMaxPriceUsd?: string;
}

const X_GUIDANCE = [
  "Use GET /v1/repository or GET /v1/search to find live articles, then GET",
  "/v1/articles/{articleId}/navigation or the seller conversation endpoints to choose safe sections.",
  "POST /v1/sessions opens a hard-capped reading session. Sessions for free articles",
  "stream at no cost; paid sessions return Circle/Arc x402 terms and only release words after",
  "a verified payment. POST /v1/x402/articles/{articleId} is the standalone Base USDC",
  "whole-article purchase resource: call it without X-PAYMENT to receive an x402 v2 challenge.",
].join(" ");

const ATOMIC_USDC = {
  type: "string",
  pattern: "^[0-9]+$",
  description: "Atomic USDC amount (1 USDC = 1,000,000 atomic units).",
} as const;

const ERROR = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" }, message: { type: "string" } },
} as const;

const ARTICLE_SUMMARY = {
  type: "object",
  required: [
    "articleId",
    "title",
    "author",
    "state",
    "accessMode",
    "totalWords",
    "pricePerWordAtomic",
  ],
  properties: {
    articleId: { type: "string" },
    title: { type: "string" },
    author: { type: "string" },
    creatorUsername: { type: "string" },
    state: { type: "string", enum: ["live"] },
    accessMode: { type: "string", enum: ["free", "paid"] },
    totalWords: { type: "integer", minimum: 0 },
    pricePerWordAtomic: ATOMIC_USDC,
    maxArticlePriceAtomic: ATOMIC_USDC,
    sections: { type: "array", items: { $ref: "#/components/schemas/ArticleSection" } },
    sources: {
      type: "array",
      minItems: 1,
      items: { $ref: "#/components/schemas/ArticleSource" },
    },
    paymentTerms: { $ref: "#/components/schemas/SellerPaymentTerms" },
  },
} as const;

const ARTICLE_ID = {
  name: "articleId",
  in: "path",
  required: true,
  schema: { type: "string", minLength: 1 },
} as const;
const SESSION_ID = {
  name: "sessionId",
  in: "path",
  required: true,
  schema: { type: "string", minLength: 1 },
} as const;
const CONVERSATION_ID = {
  name: "conversationId",
  in: "path",
  required: true,
  schema: { type: "string", minLength: 1 },
} as const;
const ERROR_RESPONSE = {
  description: "Request could not be completed.",
  content: { "application/json": { schema: ERROR } },
} as const;

function jsonResponse(
  description: string,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return { description, content: { "application/json": { schema } } };
}

/** Build the OpenAPI document for the gateway's complete public HTTP surface. */
export function buildOpenApiDocument(options: OpenApiOptions): Record<string, unknown> {
  const contact = options.contactEmail ? { contact: { email: options.contactEmail } } : {};
  // Free/control-plane operations intentionally use an explicit empty security
  // array. It prevents a top-level auth default from accidentally turning public
  // discovery/navigation into an identity- or payment-gated resource.
  const free = { security: [] as never[] };

  const document = {
    openapi: "3.1.0",
    info: {
      title: "Rubicon",
      version: options.version,
      description: "Discover, evaluate, and purchase creator articles with hard USDC budget caps.",
      "x-guidance": X_GUIDANCE,
      ...contact,
    },
    externalDocs: {
      description: "Canonical Rubicon OpenAPI source.",
      url: new URL("/openapi.json", options.baseUrl).href,
    },
    servers: [{ url: options.baseUrl, description: "Rubicon gateway" }],
    paths: {
      "/openapi.json": {
        get: {
          operationId: "getOpenApiDocument",
          summary: "Get this machine-readable OpenAPI discovery document.",
          ...free,
          responses: {
            "200": jsonResponse("OpenAPI 3.1 discovery document.", {
              type: "object",
              required: ["openapi", "info", "paths"],
              properties: {
                openapi: { type: "string", const: "3.1.0" },
                info: { type: "object" },
                paths: { type: "object" },
              },
            }),
          },
        },
      },
      "/health": {
        get: {
          operationId: "health",
          summary: "Gateway health check.",
          ...free,
          responses: {
            "200": jsonResponse("Gateway is healthy.", {
              type: "object",
              required: ["ok", "appEnv"],
              properties: {
                ok: { type: "boolean", const: true },
                appEnv: { type: "string", enum: ["development", "staging", "production"] },
              },
            }),
          },
        },
      },
      "/v1/endpoints": {
        get: {
          operationId: "listEndpoints",
          summary: "List the gateway routes and their descriptions.",
          ...free,
          responses: {
            "200": jsonResponse("Gateway endpoint list.", {
              type: "object",
              required: ["endpoints"],
              properties: {
                endpoints: { type: "array", items: { $ref: "#/components/schemas/Endpoint" } },
              },
            }),
          },
        },
      },
      "/v1/repository": {
        get: repositoryOperation(
          "listRepository",
          "List all live articles available to buyer agents.",
        ),
      },
      "/v1/articles": {
        get: repositoryOperation("listArticles", "Alias for the live article repository."),
      },
      "/v1/search": {
        get: {
          operationId: "searchArticles",
          summary: "Semantic or lexical search over live article metadata.",
          ...free,
          parameters: [
            {
              name: "q",
              in: "query",
              required: true,
              description: "Search query.",
              schema: { type: "string", minLength: 1 },
            },
            {
              name: "limit",
              in: "query",
              required: false,
              description: "Maximum results, 1 to 50 (default 20).",
              schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
            },
          ],
          responses: {
            "200": jsonResponse("Ranked safe article metadata.", {
              $ref: "#/components/schemas/SearchResponse",
            }),
            "400": ERROR_RESPONSE,
            "500": ERROR_RESPONSE,
          },
        },
      },
      "/v1/articles/{articleId}/navigation": {
        get: {
          operationId: "getArticleNavigation",
          summary: "Get safe section navigation without releasing unpaid article text.",
          ...free,
          parameters: [
            ARTICLE_ID,
            { name: "goal", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            "200": jsonResponse("Safe navigation and seller guidance.", {
              $ref: "#/components/schemas/NavigationResponse",
            }),
            "404": ERROR_RESPONSE,
          },
        },
      },
      "/v1/seller-agent/conversations": {
        post: {
          operationId: "startSellerConversation",
          summary: "Open a seller-agent conversation for an article.",
          ...free,
          requestBody: requestBody("#/components/schemas/StartConversationRequest"),
          responses: {
            "201": jsonResponse("Conversation started.", {
              $ref: "#/components/schemas/StartConversationResponse",
            }),
            "404": ERROR_RESPONSE,
          },
        },
      },
      "/v1/seller-agent/conversations/{conversationId}/messages": {
        post: {
          operationId: "sendSellerConversationMessage",
          summary: "Send a question to an existing seller-agent conversation.",
          ...free,
          parameters: [CONVERSATION_ID],
          requestBody: requestBody("#/components/schemas/SendConversationMessageRequest"),
          responses: {
            "200": jsonResponse("Seller-agent reply.", {
              $ref: "#/components/schemas/SendConversationMessageResponse",
            }),
            "400": ERROR_RESPONSE,
            "404": ERROR_RESPONSE,
          },
        },
      },
      "/v1/sessions": {
        post: {
          operationId: "startReadingSession",
          summary: "Open a hard-capped reading session for a free or paid article.",
          description:
            "This is the primary metered purchase resource. For paid articles it returns x402 authorization terms, and paid delivery operations require the resulting x402 payment payload before releasing words. Free articles create a no-cost session. An invalid or unpaid discovery probe receives a valid x402 v2 402 challenge before body validation.",
          ...free,
          requestBody: requestBody("#/components/schemas/StartSessionRequest"),
          responses: {
            "201": jsonResponse("Session opened.", {
              $ref: "#/components/schemas/StartSessionResponse",
            }),
            "402": paymentRequiredResponse("x402 challenge for a paid-reading discovery probe."),
            "404": ERROR_RESPONSE,
            "409": ERROR_RESPONSE,
          },
        },
      },
      "/v1/sessions/{sessionId}/stream": {
        post: {
          operationId: "streamSessionWords",
          summary: "Release a chunk of a session's words.",
          description:
            "Free sessions return words without payment. Paid sessions return the session's x402 v2 challenge until a valid payment payload is supplied; content is never released before verification.",
          ...free,
          parameters: [SESSION_ID],
          requestBody: requestBody("#/components/schemas/StreamPaymentRequest", false),
          responses: {
            "200": jsonResponse("Released word chunk.", {
              $ref: "#/components/schemas/StreamChunkResponse",
            }),
            "402": paymentRequiredResponse("Payment required for a paid session."),
            "404": ERROR_RESPONSE,
            "409": ERROR_RESPONSE,
          },
        },
      },
      "/v1/sessions/{sessionId}/payments": {
        get: {
          operationId: "getSessionPaymentChallenge",
          summary: "Retrieve the next x402 challenge for a paid session.",
          description:
            "Free sessions return 204. Paid sessions return the valid x402 v2 Payment Required challenge in both the body and PAYMENT-REQUIRED header.",
          ...free,
          parameters: [SESSION_ID],
          responses: {
            "204": { description: "Free session; no payment is required." },
            "402": paymentRequiredResponse("Payment required for a paid session."),
            "404": ERROR_RESPONSE,
            "409": ERROR_RESPONSE,
          },
        },
        post: {
          operationId: "payForNextSessionWord",
          summary: "Pay for and release the next word of a session.",
          description:
            "Free sessions release the next word at no cost. Paid sessions require a valid x402 v2 payment payload and otherwise return the PAYMENT-REQUIRED challenge.",
          ...free,
          parameters: [SESSION_ID],
          requestBody: requestBody("#/components/schemas/StreamPaymentRequest", false),
          responses: {
            "200": jsonResponse("Next word and receipt.", {
              $ref: "#/components/schemas/StreamPaymentResponse",
            }),
            "402": paymentRequiredResponse("Payment required for a paid session."),
            "404": ERROR_RESPONSE,
            "409": ERROR_RESPONSE,
          },
        },
      },
      "/v1/sessions/{sessionId}/events": {
        get: {
          operationId: "subscribeSessionEvents",
          summary: "Subscribe to session events with Server-Sent Events.",
          ...free,
          parameters: [SESSION_ID],
          responses: {
            "200": {
              description: "SSE stream of session events.",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
            "404": ERROR_RESPONSE,
          },
        },
      },
      "/v1/sessions/{sessionId}/abort": {
        post: {
          operationId: "abortSession",
          summary: "Close a session without releasing more words.",
          ...free,
          parameters: [SESSION_ID],
          requestBody: requestBody("#/components/schemas/AbortSessionRequest", false),
          responses: {
            "200": jsonResponse("Session aborted.", {
              type: "object",
              required: ["aborted"],
              properties: { aborted: { type: "boolean", const: true } },
            }),
            "404": ERROR_RESPONSE,
          },
        },
      },
      ...(options.agentCashPurchaseEnabled
        ? {
            "/v1/x402/articles/{articleId}": {
              post: {
                operationId: "purchaseArticleOnBase",
                summary: "Buy a whole article in one x402 payment on Base USDC.",
                description:
                  "The payable AgentCash resource. Call without X-PAYMENT to obtain an x402 v2 402 challenge. The challenge's accepts[0] contains the exact atomic USDC amount and the selected article creator's verified Base wallet.",
                security: [],
                "x-payment-info": {
                  protocols: [{ x402: {} }],
                  price: {
                    mode: "dynamic",
                    currency: "USD",
                    min: "0.000001",
                    max: options.agentCashMaxPriceUsd ?? "10",
                  },
                },
                parameters: [ARTICLE_ID],
                requestBody: requestBody("#/components/schemas/PurchaseArticleRequest", false),
                responses: {
                  "200": jsonResponse("Verified payment; full article body.", {
                    $ref: "#/components/schemas/PurchasedArticle",
                  }),
                  "402": paymentRequiredResponse("Payment Required (x402 v2, Base USDC)."),
                  "404": ERROR_RESPONSE,
                  "409": ERROR_RESPONSE,
                  "422": ERROR_RESPONSE,
                },
              },
            },
          }
        : {}),
    },
    components: {
      schemas: {
        Error: ERROR,
        AtomicUsdc: ATOMIC_USDC,
        Endpoint: {
          type: "object",
          required: ["method", "path", "description"],
          properties: {
            method: { type: "string" },
            path: { type: "string" },
            description: { type: "string" },
          },
        },
        ArticleSection: {
          type: "object",
          required: ["sectionId", "heading", "wordStart", "wordCount"],
          properties: {
            sectionId: { type: "string" },
            heading: { type: "string" },
            level: { type: "integer" },
            wordStart: { type: "integer", minimum: 0 },
            wordCount: { type: "integer", minimum: 0 },
          },
        },
        ArticleSource: {
          type: "object",
          required: ["title", "url", "type"],
          properties: {
            title: { type: "string", minLength: 1 },
            url: { type: "string", format: "uri" },
            type: { type: "string", const: "article_navigation" },
          },
        },
        SellerPaymentTerms: {
          type: "object",
          properties: {
            asset: { type: "string", const: "USDC" },
            network: { type: "string" },
            payTo: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
            pricePerWordAtomic: ATOMIC_USDC,
            meteringUnit: { type: "string", const: "word" },
          },
        },
        ArticleSummary: ARTICLE_SUMMARY,
        RepositoryResponse: {
          type: "object",
          required: ["repository", "articles"],
          properties: {
            repository: { type: "string", const: "articles" },
            articles: { type: "array", items: ARTICLE_SUMMARY },
          },
        },
        SearchResponse: {
          type: "object",
          required: ["query", "mode", "results"],
          properties: {
            query: { type: "string" },
            mode: { type: "string", enum: ["semantic", "lexical"] },
            results: {
              type: "array",
              items: {
                type: "object",
                required: ["article", "score", "matchedSections"],
                properties: {
                  article: ARTICLE_SUMMARY,
                  score: { type: "number", minimum: 0, maximum: 1 },
                  matchedSections: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        sectionId: { type: "string" },
                        heading: { type: "string" },
                        score: { type: "number", minimum: 0, maximum: 1 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        NavigationResponse: {
          type: "object",
          required: ["article", "navigation"],
          properties: {
            article: ARTICLE_SUMMARY,
            navigation: {
              type: "object",
              properties: {
                articleId: { type: "string" },
                sections: { type: "array", items: { $ref: "#/components/schemas/ArticleSection" } },
                sellerAgent: { type: "object" },
                stopConditions: { type: "array", items: { type: "object" } },
              },
            },
          },
        },
        ConversationMessage: {
          type: "object",
          required: ["id", "role", "content", "createdAt"],
          properties: {
            id: { type: "string" },
            role: { type: "string", enum: ["buyer", "seller"] },
            content: { type: "string" },
            recommendedSectionId: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        StartConversationRequest: {
          type: "object",
          required: ["articleId"],
          properties: {
            articleId: { type: "string", minLength: 1 },
            goal: { type: "string" },
            message: { type: "string" },
          },
        },
        StartConversationResponse: {
          type: "object",
          required: ["conversationId", "articleId", "article", "navigation", "messages"],
          properties: {
            conversationId: { type: "string" },
            articleId: { type: "string" },
            article: ARTICLE_SUMMARY,
            navigation: { type: "object" },
            messages: {
              type: "array",
              items: { $ref: "#/components/schemas/ConversationMessage" },
            },
          },
        },
        SendConversationMessageRequest: {
          type: "object",
          required: ["message"],
          properties: { message: { type: "string", minLength: 1 } },
        },
        SendConversationMessageResponse: {
          type: "object",
          required: ["conversationId", "messages"],
          properties: {
            conversationId: { type: "string" },
            messages: {
              type: "array",
              items: { $ref: "#/components/schemas/ConversationMessage" },
            },
            recommendedSectionId: { type: "string" },
          },
        },
        Budget: {
          type: "object",
          required: ["currency", "maxAmountAtomic"],
          properties: { currency: { type: "string", const: "USDC" }, maxAmountAtomic: ATOMIC_USDC },
        },
        StartSessionRequest: {
          type: "object",
          required: ["articleId", "budget"],
          properties: {
            articleId: { type: "string", minLength: 1 },
            goal: { type: "string" },
            conversationId: { type: "string" },
            sectionId: { type: "string" },
            sectionIds: { type: "array", items: { type: "string" } },
            wordStart: { type: "integer", minimum: 0 },
            wordCount: { type: "integer", minimum: 1 },
            budget: { $ref: "#/components/schemas/Budget" },
            predictedWords: { type: "integer", minimum: 1 },
            metadata: { type: "object", additionalProperties: true },
          },
        },
        StartSessionResponse: {
          type: "object",
          required: [
            "sessionId",
            "state",
            "article",
            "pricePerWordAtomic",
            "wordPaymentAtomic",
            "expiresAt",
            "wordsPaid",
            "wordsDelivered",
            "paidAtomic",
          ],
          properties: {
            sessionId: { type: "string" },
            state: { type: "string" },
            accessMode: { type: "string", enum: ["free", "paid"] },
            article: ARTICLE_SUMMARY,
            navigation: { type: "object" },
            pricePerWordAtomic: ATOMIC_USDC,
            maxArticlePriceAtomic: ATOMIC_USDC,
            conversationId: { type: "string" },
            wordPaymentAtomic: ATOMIC_USDC,
            gatewayFeeBps: { type: "integer", minimum: 0 },
            paymentRequired: { $ref: "#/components/schemas/X402Challenge" },
            authorizationMode: { type: "string", enum: ["word", "chunk"] },
            wordsAuthorized: { type: "integer", minimum: 0 },
            expiresAt: { type: "string", format: "date-time" },
            wordsPaid: { type: "integer", minimum: 0 },
            wordsDelivered: { type: "integer", minimum: 0 },
            paidAtomic: ATOMIC_USDC,
          },
        },
        StreamPaymentRequest: {
          type: "object",
          properties: {
            paymentPayload: {
              description:
                "x402 v2 payment payload. It may also be supplied as the X-PAYMENT header.",
              type: "object",
              additionalProperties: true,
            },
            idempotencyKey: { type: "string" },
            maxWords: { type: "integer", minimum: 1 },
          },
        },
        Word: {
          type: "object",
          required: ["sequence", "word", "priceAtomic"],
          properties: {
            sequence: { type: "integer", minimum: 0 },
            word: { type: "string" },
            priceAtomic: ATOMIC_USDC,
          },
        },
        WordPaymentReceipt: {
          type: "object",
          required: [
            "paymentId",
            "sessionId",
            "articleId",
            "sequence",
            "amountAtomic",
            "currency",
            "settledAt",
          ],
          properties: {
            paymentId: { type: "string" },
            sessionId: { type: "string" },
            articleId: { type: "string" },
            sequence: { type: "integer" },
            amountAtomic: ATOMIC_USDC,
            currency: { type: "string", const: "USDC" },
            network: { type: "string" },
            payTo: { type: "string" },
            settlementId: { type: "string" },
            transactionHash: { type: "string" },
            settledAt: { type: "string", format: "date-time" },
          },
        },
        StreamChunkResponse: {
          type: "object",
          required: [
            "accepted",
            "words",
            "text",
            "wordsPaid",
            "wordsDelivered",
            "paidAtomic",
            "completed",
          ],
          properties: {
            accepted: { type: "boolean" },
            words: { type: "array", items: { $ref: "#/components/schemas/Word" } },
            text: { type: "string" },
            wordsPaid: { type: "integer", minimum: 0 },
            wordsDelivered: { type: "integer", minimum: 0 },
            paidAtomic: ATOMIC_USDC,
            completed: { type: "boolean" },
            authorizationMode: { type: "string", enum: ["word", "chunk"] },
            payment: { $ref: "#/components/schemas/WordPaymentReceipt" },
          },
        },
        StreamPaymentResponse: {
          type: "object",
          required: [
            "accepted",
            "sequence",
            "word",
            "priceAtomic",
            "wordsPaid",
            "wordsDelivered",
            "paidAtomic",
            "completed",
          ],
          properties: {
            accepted: { type: "boolean" },
            sequence: { type: "integer", minimum: 0 },
            word: { type: "string" },
            priceAtomic: ATOMIC_USDC,
            wordsPaid: { type: "integer", minimum: 0 },
            wordsDelivered: { type: "integer", minimum: 0 },
            paidAtomic: ATOMIC_USDC,
            completed: { type: "boolean" },
            payment: { $ref: "#/components/schemas/WordPaymentReceipt" },
          },
        },
        AbortSessionRequest: { type: "object", properties: { reason: { type: "string" } } },
        PurchaseArticleRequest: {
          type: "object",
          properties: {
            articleId: {
              type: "string",
              description: "Optional redundant copy of the articleId path parameter.",
            },
          },
        },
        PurchasedArticle: {
          type: "object",
          required: ["articleId", "title", "author", "totalWords", "body"],
          properties: {
            articleId: { type: "string" },
            title: { type: "string" },
            author: { type: "string" },
            totalWords: { type: "integer", minimum: 0 },
            body: {
              type: "string",
              description: "Full article markdown, returned only after verified payment.",
            },
          },
        },
        X402Challenge: {
          type: "object",
          required: ["x402Version", "accepts"],
          properties: {
            x402Version: { type: "integer", const: 2 },
            accepts: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["scheme", "network", "asset", "payTo", "amount"],
                properties: {
                  scheme: { type: "string" },
                  network: { type: "string" },
                  asset: { type: "string" },
                  payTo: { type: "string" },
                  amount: ATOMIC_USDC,
                  maxTimeoutSeconds: { type: "integer" },
                },
              },
            },
          },
        },
      },
    },
  };

  // x402scan uses this document as a marketplace catalog, not as an inventory
  // of internal workflow routes. Only the standalone Base purchase is payable;
  // safe discovery is free, while sessions and seller conversations stay out
  // of the catalog.
  const purchasePath = "/v1/x402/articles/{articleId}";
  const paths = document.paths as Record<string, unknown>;
  const publicPaths = [
    "/health",
    "/v1/repository",
    "/v1/articles",
    "/v1/search",
    "/v1/articles/{articleId}/navigation",
  ];
  const discoverablePaths = Object.fromEntries(
    publicPaths
      .filter((path) => paths[path])
      .map((path) => [path, paths[path]]),
  );
  if (options.agentCashPurchaseEnabled && paths[purchasePath]) {
    discoverablePaths[purchasePath] = paths[purchasePath];
  }
  return { ...document, paths: discoverablePaths };
}

function requestBody(schemaRef: string, required = true): Record<string, unknown> {
  return { required, content: { "application/json": { schema: { $ref: schemaRef } } } };
}

function paymentRequiredResponse(description: string): Record<string, unknown> {
  return {
    description,
    headers: {
      "PAYMENT-REQUIRED": {
        description:
          "Base64-encoded x402 v2 PaymentRequired challenge, identical to the response body.",
        schema: { type: "string" },
      },
    },
    content: { "application/json": { schema: { $ref: "#/components/schemas/X402Challenge" } } },
  };
}

function repositoryOperation(operationId: string, summary: string): Record<string, unknown> {
  return {
    operationId,
    summary,
    security: [],
    parameters: [
      {
        name: "q",
        in: "query",
        required: false,
        description: "Optional relevance query.",
        schema: { type: "string" },
      },
    ],
    responses: {
      "200": jsonResponse("Live article summaries.", {
        $ref: "#/components/schemas/RepositoryResponse",
      }),
      "500": ERROR_RESPONSE,
    },
  };
}
