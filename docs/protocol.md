# Streaming Protocol

## Start Session

`POST /v1/sessions`

```json
{
  "providerId": "mock-compute",
  "input": { "prompt": "summarize this dataset" },
  "budget": { "maxAmountAtomic": "50000", "currency": "USDC" },
  "metadata": { "agent": "demo" }
}
```

Returns a session, quote, and heartbeat interval. The quote is denominated in USDC atomic units where `1 USDC = 1_000_000`.
When Circle/x402 is enabled, the response also includes `paymentRequired`, the x402 terms the agent signs for each heartbeat.

## Payment Heartbeat

`POST /v1/sessions/:sessionId/heartbeats`

```json
{
  "paymentPayload": {
    "x402Version": 2,
    "accepted": {},
    "payload": {}
  }
}
```

The agent SDK can create this payload from the session's `paymentRequired` object using Circle's batch x402 client.

## Stream Events

`GET /v1/sessions/:sessionId/events`

Server-sent events:

- `session.started`
- `session.heartbeat_accepted`
- `provider.output`
- `provider.usage`
- `provider.completed`
- `provider.error`
- `session.aborted`
- `session.closed`
