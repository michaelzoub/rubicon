import Fastify, { type FastifyInstance } from "fastify";
import {
  canSpend,
  createSession,
  quotePerInterval,
  recordPayment,
  type GatewayEvent,
  type MeteringUnit,
  type PaymentHeartbeatRequest,
  type PaymentVerification,
  type SessionRecord,
  type StartSessionRequest,
  type StartSessionResponse,
} from "@rubicon-caliga/core";
import { InMemoryEventBus } from "./stores/event-bus.js";
import { InMemorySessionStore } from "./stores/session-store.js";

export interface ProviderConfig {
  id: string;
  baseUrl: string;
  sharedSecret: string;
  unitPriceAtomic: bigint;
  unitsPerInterval: number;
  meteringUnit: MeteringUnit;
}

export interface GatewayOptions {
  providers: Record<string, ProviderConfig>;
  heartbeatIntervalMs: number;
  sessionTtlMs: number;
  gatewayFeeBps: number;
  gatewayBaseUrl?: string;
  paymentVerifier?: PaymentVerifier;
}

export interface PaymentVerifier {
  verify(session: SessionRecord, heartbeat: PaymentHeartbeatRequest): Promise<PaymentVerification>;
  createPaymentRequired?(input: {
    session: SessionRecord;
    provider: ProviderConfig;
    amountAtomic: `${bigint}`;
    gatewayBaseUrl: string;
  }): Promise<unknown>;
}

class DevelopmentPaymentVerifier implements PaymentVerifier {
  async verify(session: SessionRecord, heartbeat: PaymentHeartbeatRequest): Promise<PaymentVerification> {
    const payload = heartbeat.paymentPayload as { amountAtomic?: string } | undefined;
    return {
      accepted: true,
      amountAtomic: (payload?.amountAtomic ?? "0") as `${bigint}`,
      transferId: `dev_${session.id}_${Date.now()}`,
    };
  }

  async createPaymentRequired(input: { amountAtomic: `${bigint}` }): Promise<unknown> {
    return {
      x402Version: 2,
      resource: { url: "development://heartbeat" },
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

export function createGateway(options: GatewayOptions): FastifyInstance {
  const app = Fastify({ logger: true });
  const sessions = new InMemorySessionStore();
  const events = new InMemoryEventBus();
  const paymentVerifier = options.paymentVerifier ?? new DevelopmentPaymentVerifier();

  app.get("/health", async () => ({ ok: true }));

  app.post<{ Body: StartSessionRequest }>("/v1/sessions", async (request, reply) => {
    const provider = options.providers[request.body.providerId];
    if (!provider) {
      return reply.code(404).send({ error: "provider_not_found" });
    }

    const session = createSession({
      providerId: request.body.providerId,
      payload: request.body.input,
      budget: request.body.budget,
      metadata: request.body.metadata,
      ttlMs: options.sessionTtlMs,
    });
    sessions.set(session);

    const quote = quotePerInterval({
      unitPriceAtomic: provider.unitPriceAtomic,
      unitsPerInterval: provider.unitsPerInterval,
      intervalMs: options.heartbeatIntervalMs,
      meteringUnit: provider.meteringUnit,
      gatewayFeeBps: options.gatewayFeeBps,
    });
    const heartbeatChargeAtomic = quote.chargePerIntervalAtomic;

    session.metadata.heartbeatChargeAtomic = heartbeatChargeAtomic;
    session.metadata.gatewayBaseUrl = options.gatewayBaseUrl ?? `http://localhost:${process.env.GATEWAY_PORT ?? 8787}`;
    session.metadata.providerSnapshot = {
      id: provider.id,
      baseUrl: provider.baseUrl,
      sharedSecret: provider.sharedSecret,
      unitPriceAtomic: `${provider.unitPriceAtomic}`,
      unitsPerInterval: provider.unitsPerInterval,
      meteringUnit: provider.meteringUnit,
    };
    sessions.set(session);

    const paymentRequired = await paymentVerifier.createPaymentRequired?.({
      session,
      provider,
      amountAtomic: heartbeatChargeAtomic,
      gatewayBaseUrl: session.metadata.gatewayBaseUrl as string,
    });

    events.publish({
      type: "session.started",
      sessionId: session.id,
      state: session.state,
      quote,
    });

    const response: StartSessionResponse = {
      sessionId: session.id,
      state: session.state,
      quote,
      paymentRequired,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      expiresAt: session.expiresAt.toISOString(),
    };

    return reply.code(201).send(response);
  });

  app.post<{ Params: { sessionId: string }; Body: PaymentHeartbeatRequest }>(
    "/v1/sessions/:sessionId/heartbeats",
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

      const provider = options.providers[session.providerId];
      if (!provider) {
        return reply.code(404).send({ error: "provider_not_found" });
      }

      const charge = BigInt(verification.amountAtomic);
      if (!canSpend(session, charge)) {
        await closeSession(session, "budget_exhausted");
        return reply.code(402).send({ error: "budget_exhausted" });
      }

      recordPayment(session, verification.amountAtomic);
      sessions.set(session);
      events.publish({
        type: "session.heartbeat_accepted",
        sessionId: session.id,
        paidAtomic: `${session.paidAtomic}`,
        transferId: verification.transferId,
      });

      if (session.paidAtomic === charge) {
        await startProviderJob(provider, session);
      }

      return reply.send({ accepted: true, paidAtomic: `${session.paidAtomic}` });
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

  app.post<{ Params: { providerId: string; sessionId: string }; Body: GatewayEvent }>(
    "/v1/providers/:providerId/sessions/:sessionId/events",
    async (request, reply) => {
      const provider = options.providers[request.params.providerId];
      if (!provider || request.headers.authorization !== `Bearer ${provider.sharedSecret}`) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      const session = sessions.get(request.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      if (request.body.type === "provider.usage") {
        session.spentAtomic += BigInt(request.body.usage.totalCostAtomic);
        sessions.set(session);
      }

      if (request.body.type === "provider.completed") {
        session.state = "completed";
        sessions.set(session);
        events.publish(request.body);
        events.publish({ type: "session.closed", sessionId: session.id, reason: "provider_completed" });
        return reply.send({ accepted: true });
      }

      events.publish(request.body);
      return reply.send({ accepted: true });
    },
  );

  async function closeSession(session: SessionRecord, reason: string): Promise<void> {
    session.state = reason === "budget_exhausted" ? "expired" : "aborted";
    sessions.set(session);
    events.publish({ type: "session.aborted", sessionId: session.id, reason });
    const provider = options.providers[session.providerId];
    if (provider) {
      await fetch(`${provider.baseUrl}/v1/jobs/${session.id}/abort`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${provider.sharedSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason }),
      }).catch(() => undefined);
    }
  }

  return app;
}

async function startProviderJob(provider: ProviderConfig, session: SessionRecord): Promise<void> {
  await fetch(`${provider.baseUrl}/v1/jobs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${provider.sharedSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sessionId: session.id,
      input: session.input,
      metadata: session.metadata,
    }),
  });
}
