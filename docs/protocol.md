# Streaming Protocol

## Endpoint Index

`GET /v1/endpoints`

Returns the currently exposed gateway endpoints.

## Article Repository

`GET /v1/repository`

Returns existing article summaries from the configured repository. `GET /v1/articles` returns the same article list for compatibility.

## Free Article Navigation

`GET /v1/articles/:articleId/navigation`

Returns free title/header metadata, section IDs, word ranges, and stop-condition guidance. It does not return section body content.

## Neutral Seller Agent

`POST /v1/seller-agent/navigation`

Requires:

```text
authorization: Bearer $SELLER_AGENT_API_KEY
```

Request:

```json
{
  "articleId": "rubicon-streaming-001",
  "buyerGoal": "understand how neutral seller guidance works",
  "maxSpendAtomic": "50000"
}
```

Returns neutral section routing hints derived only from free headers and pricing metadata. It must not summarize hidden article content.

## Start Article Stream

`POST /v1/sessions`

```json
{
  "articleId": "rubicon-streaming-001",
  "budget": { "maxAmountAtomic": "50000", "currency": "USDC" },
  "metadata": { "agent": "demo" }
}
```

The client may send `query` instead of `articleId` when the server supports lookup.
The client may send `sectionId` to stream only a selected section from the free navigation headers.

Returns a session, article summary, per-word quote, and payment chunk size. Amounts are denominated in USDC atomic units where `1 USDC = 1_000_000`.

When Circle/x402 is enabled, the response also includes `paymentRequired`, the x402 terms the agent signs for each chunk payment.

## Stream Payment

`POST /v1/sessions/:sessionId/payments`

```json
{
  "paymentPayload": {
    "x402Version": 2,
    "accepted": {},
    "payload": {}
  }
}
```

The agent SDK can create this payload from the session's `paymentRequired` object using Circle's batch x402 client. Each accepted payment must match `quote.chargePerChunkAtomic` and unlocks the next paid word chunk.

## Stream Events

`GET /v1/sessions/:sessionId/events`

Server-sent events:

- `session.started`
- `session.payment_accepted`
- `article.chunk`
- `article.usage`
- `article.completed`
- `article.error`
- `session.aborted`
- `session.closed`
