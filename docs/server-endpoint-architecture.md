# Current Server Endpoint Architecture

This diagram reflects the current Fastify gateway in
`apps/gateway/src/server.ts` and its runtime wiring in `apps/gateway/src/index.ts`.
It focuses on the public `/v1/*` endpoints and how each route talks to storage,
seller-agent logic, payment settlement, and streaming events.

```mermaid
flowchart LR
  Buyer["Buyer agent / packages/agent-sdk"]
  Gateway["Fastify gateway\napps/gateway/src/server.ts"]
  Auth["Optional bearer auth\nRUBICON_AGENT_API_KEY\nonRequest hook"]

  subgraph Routes["Public HTTP routes"]
    Health["GET /health"]
    Endpoints["GET /v1/endpoints"]
    Repository["GET /v1/repository\nGET /v1/articles"]
    Navigation["GET /v1/articles/:articleId/navigation"]
    StartConversation["POST /v1/seller-agent/conversations"]
    SendMessage["POST /v1/seller-agent/conversations/:conversationId/messages"]
    StartSession["POST /v1/sessions"]
    InspectPayment["GET /v1/sessions/:sessionId/payments"]
    PayWord["POST /v1/sessions/:sessionId/payments"]
    Events["GET /v1/sessions/:sessionId/events"]
    Abort["POST /v1/sessions/:sessionId/abort"]
  end

  subgraph ArticleRepo["PublishedArticleRepository\nproduction: SupabasePublishedArticleRepository"]
    Supabase["Supabase\narticles, creators, article_sections,\ncreator_wallets"]
  end

  subgraph RuntimeLedger["LedgerRepository\nproduction: PostgresLedgerRepository\nfallback: InMemoryLedgerRepository"]
    Sessions["stream_sessions"]
    Conversations["seller_agent_conversations"]
    Messages["seller_agent_messages"]
    Payments["word_payments"]
    Deliveries["word_deliveries"]
    Receipts["settlement_receipts"]
  end

  subgraph Seller["SellerAgent"]
    SafeModel["navigate/respond\nsafe article context only"]
    StreamModel["selectNextWord\none paid word at a time"]
    OpenAI["Optional OpenAI Responses API\nwhen OPENAI_API_KEY is set"]
    Deterministic["Deterministic local fallback\nwhen no model key is set"]
  end

  subgraph PaymentsSvc["PaymentVerifier"]
    DevVerifier["DevelopmentPaymentVerifier\nlocal no-settlement mode"]
    CircleVerifier["CircleX402PaymentVerifier"]
    X402["x402 resource server"]
    Circle["Circle x402 facilitator / Gateway"]
    CreatorWallet["Verified creator wallet\nUSDC recipient"]
  end

  subgraph EventsBus["InMemoryEventBus"]
    History["Last 100 events per session"]
    SSE["SSE subscribers"]
  end

  Buyer --> Gateway
  Gateway --> Auth
  Auth --> Routes

  Health --> Gateway
  Endpoints --> Gateway

  Repository --> ArticleRepo
  Navigation --> ArticleRepo
  Navigation --> Seller

  StartConversation --> ArticleRepo
  StartConversation --> RuntimeLedger
  StartConversation --> Seller
  SendMessage --> RuntimeLedger
  SendMessage --> ArticleRepo
  SendMessage --> Seller

  StartSession --> ArticleRepo
  StartSession --> RuntimeLedger
  StartSession --> Seller
  StartSession --> PaymentsSvc
  StartSession --> EventsBus

  InspectPayment --> RuntimeLedger
  InspectPayment --> PaymentsSvc

  PayWord --> RuntimeLedger
  PayWord --> ArticleRepo
  PayWord --> Seller
  PayWord --> PaymentsSvc
  PayWord --> EventsBus

  Events --> RuntimeLedger
  Events --> EventsBus
  Abort --> RuntimeLedger
  Abort --> EventsBus

  ArticleRepo --> Supabase
  RuntimeLedger --> Sessions
  RuntimeLedger --> Conversations
  RuntimeLedger --> Messages
  RuntimeLedger --> Payments
  RuntimeLedger --> Deliveries
  RuntimeLedger --> Receipts

  Seller --> SafeModel
  Seller --> StreamModel
  SafeModel --> OpenAI
  SafeModel --> Deterministic

  PaymentsSvc --> DevVerifier
  PaymentsSvc --> CircleVerifier
  CircleVerifier --> X402
  X402 --> Circle
  Circle --> CreatorWallet

  EventsBus --> History
  EventsBus --> SSE
  SSE --> Buyer
```

## Runtime Wiring

`apps/gateway/src/index.ts` creates the production server process:

- Article reads always use `SupabasePublishedArticleRepository`, configured from
  `SUPABASE_URL` and a service, anon, publishable, or public anon key.
- Runtime ledger writes use `PostgresLedgerRepository` when `DATABASE_URL` is set.
  Otherwise the gateway falls back to `InMemoryLedgerRepository`.
- Payments use `CircleX402PaymentVerifier` when `RUBICON_PAYMENTS=circle`.
  Otherwise they use `DevelopmentPaymentVerifier`.
- The seller agent uses OpenAI through `TextCompletionSellerModelProvider` when
  `OPENAI_API_KEY` is set. Otherwise it uses the deterministic local provider.
- All `/v1/*` routes require `Authorization: Bearer <RUBICON_AGENT_API_KEY>` when
  `RUBICON_AGENT_API_KEY` is configured. `GET /health` remains public.

## Endpoint Communication Map

| Endpoint | Primary job | Reads from | Writes to | Talks to |
| --- | --- | --- | --- | --- |
| `GET /health` | Liveness check | none | none | none |
| `GET /v1/endpoints` | Return static route index | static `ENDPOINTS` array | none | none |
| `GET /v1/repository`, `GET /v1/articles` | List live articles with safe metadata and payment terms | Supabase articles, sections, creators, verified wallets | none | none |
| `GET /v1/articles/:articleId/navigation` | Return article summary plus safe seller-agent navigation | Supabase article, sections, creator wallet | none | SellerAgent `navigate` |
| `POST /v1/seller-agent/conversations` | Create a seller-agent conversation and optionally run the first turn | Supabase article and wallet | `seller_agent_conversations`, optional `seller_agent_messages` | SellerAgent `navigate` and optional `respond` |
| `POST /v1/seller-agent/conversations/:conversationId/messages` | Continue an existing seller-agent conversation | Ledger conversation/messages, Supabase article | `seller_agent_messages` | SellerAgent `respond` |
| `POST /v1/sessions` | Start a budgeted reading session and issue a one-word payment requirement | Supabase article, sections, verified creator wallet, optional ledger conversation | `stream_sessions`, optional `seller_agent_conversations` | PaymentVerifier `createPaymentRequired`, SellerAgent `navigate`, InMemoryEventBus |
| `GET /v1/sessions/:sessionId/payments` | Inspect the current x402 payment challenge for a session | `stream_sessions` | may update session state to `expired` | Payment challenge response, InMemoryEventBus on expiry |
| `POST /v1/sessions/:sessionId/payments` | Verify or settle one payment, release exactly one word, record receipt | `stream_sessions`, idempotency records, article stream state or repository fallback | `word_payments`, `word_deliveries`, `settlement_receipts`, updated `stream_sessions` | PaymentVerifier `verify`, SellerAgent `selectNextWord`, InMemoryEventBus |
| `GET /v1/sessions/:sessionId/events` | Stream session events over SSE | `stream_sessions`, event history | none | InMemoryEventBus subscribe |
| `POST /v1/sessions/:sessionId/abort` | Stop an active session | `stream_sessions` | updated `stream_sessions` | InMemoryEventBus |

## Core Paid-Word Flow

```mermaid
sequenceDiagram
  autonumber
  participant B as Buyer agent
  participant G as Fastify gateway
  participant A as Article repository
  participant L as Runtime ledger
  participant S as SellerAgent
  participant P as PaymentVerifier
  participant C as Circle/x402
  participant E as InMemoryEventBus

  B->>G: POST /v1/sessions { articleId, budget, sectionId? }
  G->>A: getPublishedArticle(articleId)
  G->>A: getCreatorWallet(creatorId)
  G->>L: get/create conversation
  G->>P: createPaymentRequired(session, article, wallet, one-word price)
  P-->>G: x402 PaymentRequired for /payments
  G->>L: createSession(session)
  G->>E: publish session.started
  G->>S: navigate(article, goal)
  G-->>B: 201 StartSessionResponse

  loop one word per accepted payment
    B->>G: POST /v1/sessions/:sessionId/payments { paymentPayload, idempotencyKey }
    G->>L: getSession(sessionId)
    G->>L: getDeliveryByIdempotencyKey(idempotencyKey)
    alt duplicate idempotency key
      L-->>G: existing delivery and payment
      G-->>B: same StreamPaymentResponse, no new charge
    else new payment
      G->>S: selectNextWord(article slice, wordsDelivered)
      G->>P: verify(session, amount, payment)
      alt Circle/x402 mode
        P->>C: settlePayment(paymentPayload, matching requirements)
        C-->>P: settlement result, transaction/settlement IDs
      else development mode
        P-->>G: accepted synthetic transferId
      end
      P-->>G: accepted payment verification
      G->>L: recordWordDelivery(payment + word + settlement receipt)
      G->>L: saveSession(updated counters)
      G->>E: publish word.payment_accepted
      G->>E: publish article.word
      G->>E: publish article.usage
      opt last word in selected path
        G->>L: saveSession(state = completed)
        G->>E: publish article.completed / session.closed
      end
      G-->>B: StreamPaymentResponse with one word and receipt
    end
  end
```

## Safety and Integrity Boundaries

- Repository and navigation endpoints never expose article body text. They only
  return safe metadata: title, author, headings, section ranges, pricing, and
  seller-agent hints.
- `POST /v1/sessions/:sessionId/payments` decides the next word before
  settlement but only emits it after payment verification succeeds.
- Idempotency is enforced before state guards, so retried payment requests return
  the already released word instead of charging again.
- The ledger records payment and word delivery atomically in Postgres. The main
  uniqueness boundaries are the idempotency key and the session word sequence.
- Existing sessions can rebuild stream state from the article repository after a
  process restart. New sessions still require the article to be live.
- SSE events are in-memory only. They replay the last 100 events for a session to
  current process subscribers, but they are not durable across process restarts.
