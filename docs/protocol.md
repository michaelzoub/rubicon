# Rubicon Public Agent API

Rubicon charges by the word, but the payment network does not run once per
word. The atomic metering unit is still exactly one delivered word: every word
has a sequence, price, usage record, and creator earning. Circle / Arc payment
authorization is scoped to a reading session by default, or to a multi-word
chunk when the buyer wallet cannot support a full-session cap.

Amounts are atomic USDC where `1 USDC = 1_000_000`.

## Protocol Shape

1. The buyer agent discovers safe article metadata and asks the seller agent
   where to start. No unpaid body text is returned.
2. The buyer opens a session with a budget or predicted word count.
3. Rubicon creates Circle / Arc authorization terms for the maximum amount the
   buyer is willing to spend.
4. The buyer signs the authorization once for the session, or once per chunk in
   fallback mode.
5. The gateway streams words one at a time while decrementing the authorized
   budget at the per-word price.
6. The buyer stops as soon as it has enough information, or the gateway stops at
   article completion or budget exhaustion.
7. Settlement uses actual words delivered, not the full authorized cap.

The product promise remains pay per word. The implementation promise is
word-level metering with session-level or chunk-level Circle / Arc
authorization.

## Authorization Modes

- `session`: preferred Circle / Arc path. The buyer authorizes up to
  `budget.maxAmountAtomic` or an equivalent predicted word cap. Rubicon streams
  against that cap and settles actual usage when the session closes.
- `chunk`: fallback path. The buyer authorizes a small batch such as 25, 50, or
  100 words. Rubicon streams within that chunk, then asks for another chunk only
  if the buyer still wants more.
- `word`: compatibility only. The existing `/payments` route can still accept a
  one-word authorization for old x402 clients, tests, and demos, but it is not
  the target Circle / Arc reading experience.

## Endpoint Index

`GET /v1/endpoints` lists the routes below. Implementations should advertise the
active authorization mode in this response and in the session response.

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

## Start A Reading Session

`POST /v1/sessions`

```json
{
  "articleId": "live-article-id-from-repository",
  "goal": "Find the resale-fee clause",
  "conversationId": "<optional, from a seller conversation>",
  "sectionId": "<optional starting section>",
  "budget": { "currency": "USDC", "maxAmountAtomic": "20000" },
  "predictedWords": 120
}
```

Opens a budgeted session. The response includes article metadata, safe section
navigation, `pricePerWordAtomic`, `maxArticlePriceAtomic`, the seller
`conversationId`, `gatewayFeeBps` (0), the session `expiresAt`, and live
counters `wordsAuthorized`, `wordsDelivered`, and `paidAtomic`.

When Circle / Arc is enabled, the response includes `authorizationRequired`.
This object describes a maximum authorization, not a one-word charge:

```json
{
  "sessionId": "session_...",
  "authorizationMode": "session",
  "meteringUnit": "word",
  "asset": "USDC",
  "network": "eip155:5042002",
  "payTo": "0x...",
  "pricePerWordAtomic": "100",
  "maxAuthorizedAtomic": "20000",
  "maxAuthorizedWords": 200,
  "settlement": "actual_usage_on_close",
  "resource": "https://gateway.example/v1/sessions/session_.../stream"
}
```

All trusted values - price, creator wallet, creator identity, article ownership,
word sequence, amount owed, settlement recipient - are loaded from persistent
storage. Buyer-supplied values are never trusted.

## Authorize And Stream

`POST /v1/sessions/:sessionId/stream`

```json
{
  "authorizationPayload": { "...": "signed Circle / Arc authorization" },
  "maxWords": 120
}
```

The gateway verifies that the authorization matches the session terms, covers at
least one more word, and cannot be replayed against another session, article,
seller wallet, network, or price. Then it streams `article.word` and
`article.usage` events. Each word decrements remaining authorized capacity by
`wordPaymentAtomic`.

The gateway must stop before releasing a word when:

- the next word would exceed `maxAuthorizedAtomic`;
- the next word would exceed the buyer's requested `maxWords`;
- the session expires, is aborted, or is already completed;
- the article section is exhausted;
- settlement risk or authorization verification fails.

The gateway never reveals or emits unpaid future words. It may inspect private
article text internally through the seller agent, but unpaid outputs remain safe
navigation only.

## Finalize Or Abort

`POST /v1/sessions/:sessionId/finalize`

Finalizes the session and settles the exact amount owed:

```json
{
  "sessionId": "session_...",
  "wordsDelivered": 73,
  "amountPaidAtomic": "7300",
  "authorizedAtomic": "20000",
  "unusedAuthorizedAtomic": "12700",
  "settlementIds": ["3c90c3cc-0d44-4b50-8888-8dd25736052a"]
}
```

`POST /v1/sessions/:sessionId/abort`

Stops the session early. The buyer may stop at any moment once it has enough
information. Abort still finalizes actual usage for words already delivered and
releases the unused authorized budget.

## Chunk Fallback

`POST /v1/sessions/:sessionId/payments`

The existing route becomes the compatibility and fallback path. A payment
request should authorize a chunk, not necessarily one word:

```json
{
  "paymentPayload": { "...": "signed chunk authorization" },
  "idempotencyKey": "<session>:<chunk-start-sequence>",
  "maxWords": 50
}
```

The gateway may then stream up to `maxWords` words or up to the authorized
amount, whichever is lower. Old clients that submit a one-word authorization
still receive one word, but SDKs should prefer session authorization and only
drop to chunk mode when Circle / Arc support, wallet policy, or risk controls
require smaller caps.

## Events

`GET /v1/sessions/:sessionId/events` - Server-Sent Events:

- `session.started`
- `seller.message`
- `authorization.accepted`
- `word.payment_accepted`
- `article.word`
- `article.usage`
- `article.completed`
- `article.error`
- `session.aborted`
- `session.closed`
- `settlement.completed`

An `article.word` event:

```json
{
  "type": "article.word",
  "sessionId": "...",
  "articleId": "...",
  "sequence": 0,
  "word": "Rubicon",
  "priceAtomic": "100",
  "totalWordsStreamed": 1,
  "totalPaidAtomic": "100",
  "remainingAuthorizedAtomic": "19900"
}
```

## Receipts

A final receipt is the canonical proof of the read. It includes:

- article id, session id, buyer wallet, seller wallet, and network;
- authorization mode and maximum authorized amount;
- exact `wordsDelivered`;
- exact `amountPaidAtomic`;
- per-word delivery records for creator accounting;
- Circle / Arc settlement ids or transaction hashes when available.

Circle Gateway settlement ids can look like UUIDs rather than EVM transaction
hashes, and `transactionHashes` may be empty. Seller dashboards must count
Rubicon backend delivery and settlement records rather than relying only on a
direct seller transfer visible in a block explorer.

## Existing-Session Policy When An Article Is Paused

A paused, archived, or deleted article cannot start a new session. An already
open session continues against the article snapshot captured when the session
started, up to its authorization, budget, or completion.
