/**
 * AgentCash-compatible OpenAPI 3.1.0 discovery document served at
 * `GET /openapi.json`. It lets x402/MPP agents discover Rubicon's endpoints and
 * the payment terms for paid reading.
 *
 * Payment note: the paid operation advertises a *dynamic* price because Rubicon
 * meters per word — the total depends on how many words the agent buys. The
 * actual recipient (`payTo`) is resolved per article at runtime from the
 * creator's verified wallet and delivered in the x402 402 challenge; it is
 * deliberately NOT hardcoded here.
 */

export interface OpenApiOptions {
  baseUrl: string;
  version: string;
  /** Optional contact email (info.contact.email). Enables ownership verification / merchant pages. */
  contactEmail?: string;
  /**
   * True when the gateway requires the agent API key (RUBICON_AGENT_API_KEY) on
   * every route. Discovery deployments normally run unprotected so x402 payment
   * — not a bearer token — is the gate; the doc reflects whichever is in effect.
   */
  apiKeyProtected?: boolean;
  /** Whether there is at least one article with a verified wallet on the Base lane's network. */
  agentCashPurchaseEnabled?: boolean;
  /** Decimal USD upper bound enforced by the Base x402 endpoint. */
  agentCashMaxPriceUsd?: string;
}

const X_GUIDANCE = [
  "Rubicon sells article content metered per word under a hard USDC budget cap.",
  "Discovery: GET /v1/repository lists live articles; GET /v1/search?q= ranks them by",
  "semantic/lexical relevance with a 0..1 confidence score; GET",
  "/v1/articles/{articleId}/navigation returns safe section metadata (no unpaid body text).",
  "Rubicon's separate Circle/Arc per-word session API is documented for the Rubicon SDK and is",
  "not an AgentCash discovery resource.",
].join(" ");

const ARTICLE_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    articleId: { type: "string" },
    title: { type: "string" },
    author: { type: "string" },
    state: { type: "string", enum: ["live"] },
    accessMode: { type: "string", enum: ["free", "paid"] },
    totalWords: { type: "integer" },
    pricePerWordAtomic: { type: "string", description: "Atomic USDC per word (6 decimals)." },
    maxArticlePriceAtomic: { type: "string" },
  },
} as const;

export function buildOpenApiDocument(options: OpenApiOptions): Record<string, unknown> {
  const contact = options.contactEmail ? { email: options.contactEmail } : undefined;

  // Auth-mode declaration so agents know how each route is gated. Free routes are
  // "unprotected" (security: []) unless the gateway runs behind the agent API
  // key, in which case every route requires the bearer scheme.
  const freeRouteSecurity = options.apiKeyProtected ? [{ agentApiKey: [] }] : [];
  const paidRouteSecurity = options.apiKeyProtected ? [{ agentApiKey: [] }] : [];
  const securityComponents = options.apiKeyProtected
    ? { securitySchemes: { agentApiKey: { type: "http", scheme: "bearer" } } }
    : undefined;

  return {
    openapi: "3.1.0",
    info: {
      title: "Rubicon",
      version: options.version,
      description: "Metered, per-word article purchasing for autonomous agents over x402 (USDC).",
      "x-guidance": [
        X_GUIDANCE,
        options.agentCashPurchaseEnabled
          ? "AgentCash purchase: POST /v1/x402/articles/{articleId} buys a whole article in one x402 USDC payment on Base (eip155:8453). The 402 challenge names the writer's verified Base wallet as payTo."
          : "No AgentCash-payable Base article is active until a writer has a verified wallet on the configured Base network.",
      ].join(" "),
      ...(contact ? { contact } : {}),
    },
    servers: [{ url: options.baseUrl }],
    "x-discovery": {
      // ownershipProofs deferred: added once a signing wallet is wired (see docs).
      ownershipProofs: [],
    },
    paths: {
      "/v1/repository": {
        get: {
          operationId: "listRepository",
          summary: "List live articles available to buyer agents.",
          security: freeRouteSecurity,
          parameters: [
            {
              name: "q",
              in: "query",
              required: false,
              description: "Optional query; when present, articles are returned ranked by search relevance.",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Live articles.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      repository: { type: "string" },
                      articles: { type: "array", items: ARTICLE_SUMMARY_SCHEMA },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/v1/search": {
        get: {
          operationId: "searchArticles",
          summary: "Semantic or lexical search over live articles.",
          security: freeRouteSecurity,
          parameters: [
            { name: "q", in: "query", required: true, description: "Search query.", schema: { type: "string" } },
            {
              name: "limit",
              in: "query",
              required: false,
              description: "Max results (1..50, default 20).",
              schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
            },
          ],
          responses: {
            "200": {
              description: "Ranked results with 0..1 confidence scores.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      query: { type: "string" },
                      mode: { type: "string", enum: ["semantic", "lexical"] },
                      results: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            article: ARTICLE_SUMMARY_SCHEMA,
                            score: { type: "number" },
                            matchedSections: { type: "array", items: { type: "object" } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "400": { description: "Missing q query parameter." },
          },
        },
      },
      "/v1/articles/{articleId}/navigation": {
        get: {
          operationId: "getArticleNavigation",
          summary: "Safe section navigation for an article (no unpaid body text).",
          security: freeRouteSecurity,
          parameters: [
            { name: "articleId", in: "path", required: true, schema: { type: "string" } },
            { name: "goal", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Section metadata and seller-agent guidance.",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "404": { description: "Article not available." },
          },
        },
      },
      ...(options.agentCashPurchaseEnabled ? { "/v1/x402/articles/{articleId}": {
        post: {
          operationId: "purchaseArticleOnBase",
          summary: "Buy a whole article in one x402 payment on Base USDC (AgentCash).",
          security: paidRouteSecurity,
          description:
            "AgentCash-facing purchase lane: pay once in USDC on Base (eip155:8453) and receive the full article body. An unpaid request returns an x402 v2 402 challenge (accepts[] on Base). This is a separate settlement lane from POST /v1/sessions, which meters per word and settles on Circle/Arc.",
          "x-payment-info": {
            protocols: [{ x402: {} }],
            price: {
              // Whole-article price varies per article; the exact atomic USDC
              // amount for the requested article is returned in the 402 challenge.
              mode: "dynamic",
              currency: "USD",
              min: "0.000001",
              max: options.agentCashMaxPriceUsd ?? "10",
            },
          },
          parameters: [{ name: "articleId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    articleId: {
                      type: "string",
                      description: "Article to purchase in full (redundant with the path parameter).",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Payment verified; full article body returned.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      articleId: { type: "string" },
                      title: { type: "string" },
                      author: { type: "string" },
                      totalWords: { type: "integer" },
                      body: { type: "string", description: "Full article markdown." },
                    },
                  },
                },
              },
            },
            "402": { description: "Payment Required (x402 v2 challenge, Base USDC)." },
            "404": { description: "Article not available." },
          },
        },
      } } : {}),
    },
    ...(securityComponents ? { components: securityComponents } : {}),
  };
}
