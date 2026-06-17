# Rubicon Public Agent API

Rubicon meters and charges **every word individually**. The atomic content unit
is one word. Circle/x402 may batch settlement internally, but creators earn
according to the exact number of words delivered. There are no payment chunks.
This means a buyer agent may make a nanopayment for every word when the marginal
value of each next word matters. The gateway keeps the application contract
word-granular even if the payment facilitator optimizes settlement behind the
scenes.

Amounts are atomic USDC where `1 USDC = 1_000_000`.

## Endpoint Index

`GET /v1/endpoints` — lists the routes below.

## Article Repository

`GET /v1/repository`

Lists `live` articles available to buyer agents (safe public metadata only).
Draft, paused, archived, and deleted articles never appear. `GET /v1/articles`
returns the same list.

## Seller-Agent Navigation

`GET /v1/articles/:articleId/navigation?goal=<goal>`

Returns safe article metadata and a seller-agent navigation recommendation:
the recommended starting section, alternatives, a rationale, and safe hints. It
never returns body text, quotes, conclusions, summaries, or unpaid facts.

## Seller-Agent Conversations

`POST /v1/seller-agent/conversations`

```json
{ "articleId": "live-article-id-from-repository", "goal": "Find the resale-fee clause", "message": "where is the resale fee discussed?" }
```

Opens a conversation with the article's seller agent. Returns a
`conversationId`, the article summary, navigation, and any seller reply. The
seller agent helps the buyer choose a starting section without leaking unpaid
content.

`POST /v1/seller-agent/conversations/:conversationId/messages`

```json
{ "message": "is there anything about lifetime caps?" }
```

Continues the conversation; returns the buyer/seller messages and an optional
`recommendedSectionId`.

## Start a Reading Session

`POST /v1/sessions`

```json
{
  "articleId": "live-article-id-from-repository",
  "goal": "Find the resale-fee clause",
  "conversationId": "<optional, from a seller conversation>",
  "sectionId": "<optional starting section>",
  "budget": { "currency": "USDC", "maxAmountAtomic": "20000" }
}
```

Opens a budgeted session. The response includes article metadata, safe section
navigation, `pricePerWordAtomic`, `maxArticlePriceAtomic`, the seller
`conversationId`, the one-word `wordPaymentAtomic`, `gatewayFeeBps` (0), the
session `expiresAt`, and the live counters `wordsPaid`, `wordsDelivered`,
`paidAtomic`. When Circle/x402 is enabled, `paymentRequired` carries the x402
terms for **one word**.

All trusted values — price, creator wallet, creator identity, article ownership,
word sequence, amount owed, settlement recipient — are loaded from persistent
storage. Buyer-supplied values are never trusted.

## Pay For One Word

`POST /v1/sessions/:sessionId/payments`

```json
{ "paymentPayload": { /* signed one-word x402 payload */ }, "idempotencyKey": "<session>:<sequence>" }
```

Each accepted payment releases **exactly one** word:

1. The buyer authorizes/sends the price of one word.
2. The gateway verifies the word-level payment.
3. The gateway releases exactly one additional word.
4. The ledger records that exact word and payment.
5. The gateway returns a per-word payment receipt in the response body and
   mirrors it in the `PAYMENT-RESPONSE` header.
6. The gateway emits updated word count and cost information.

The response contains the released `word`, its `sequence`, `priceAtomic`,
`wordsPaid`, `wordsDelivered`, `paidAtomic`, `completed`, and a `payment`
receipt with the word-level `paymentId`, `sequence`, `amountAtomic`, `currency`,
`network`, destination `payTo`, `transactionHash`, `transactionHashes`, and
`settledAt`. A failed payment releases no word. A retried payment with the same
`idempotencyKey` returns the same word and same payment receipt, and never
charges twice.

Example successful word response:

```json
{
  "accepted": true,
  "sequence": 0,
  "word": "Rubicon",
  "priceAtomic": "1",
  "wordsPaid": 1,
  "wordsDelivered": 1,
  "paidAtomic": "1",
  "completed": false,
  "payment": {
    "paymentId": "8ed8f6c4-...",
    "sessionId": "session_...",
    "articleId": "live-article-id-from-repository",
    "sequence": 0,
    "meteringUnit": "word",
    "amountAtomic": "1",
    "currency": "USDC",
    "network": "eip155:5042002",
    "payTo": "0x...",
    "transactionHash": "0xabc123",
    "transactionHashes": ["0xabc123"],
    "transferId": "0xabc123",
    "settledAt": "2026-06-17T12:00:00.000Z"
  },
  "transactionHash": "0xabc123",
  "transactionHashes": ["0xabc123"],
  "transferId": "0xabc123"
}
```

## Stream Events

`GET /v1/sessions/:sessionId/events` — Server-Sent Events:

- `session.started`
- `seller.message`
- `word.payment_accepted`
- `article.word`
- `article.usage`
- `article.completed`
- `article.error`
- `session.aborted`
- `session.closed`

An `article.word` event:

```json
{
  "type": "article.word",
  "sessionId": "...",
  "articleId": "...",
  "sequence": 0,
  "word": "Rubicon",
  "priceAtomic": "1",
  "totalWordsStreamed": 1,
  "totalPaidAtomic": "1"
}
```

The gateway never reveals or emits unpaid future words.

## Abort

`POST /v1/sessions/:sessionId/abort` — stops the session. The buyer may stop at
any moment once it has enough information; it pays for exactly the words it
received.

## Existing-Session Policy When an Article Is Paused

A paused, archived, or deleted article cannot start a **new** session. An
already-open session continues against the article snapshot captured when the
session started, up to its budget or completion.
