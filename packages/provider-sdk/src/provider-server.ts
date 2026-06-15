import Fastify, { type FastifyInstance } from "fastify";
import type { GatewayEvent, ProviderJobRequest, UsageReport } from "@rubicon-caliga/core";

export interface ProviderContext {
  emitOutput(chunk: unknown): Promise<void>;
  reportUsage(usage: UsageReport): Promise<void>;
  complete(result: unknown): Promise<void>;
  fail(message: string): Promise<void>;
  signal: AbortSignal;
}

export type ProviderJobHandler = (job: ProviderJobRequest, context: ProviderContext) => Promise<void>;

export interface ProviderServerOptions {
  providerId: string;
  sharedSecret: string;
  gatewayBaseUrl: string;
  handler: ProviderJobHandler;
}

export class ProviderServer {
  readonly app: FastifyInstance;
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly options: ProviderServerOptions) {
    this.app = Fastify({ logger: true });
    this.routes();
  }

  async listen(port: number, host = "0.0.0.0"): Promise<void> {
    await this.app.listen({ port, host });
  }

  private routes(): void {
    this.app.post<{ Body: ProviderJobRequest }>("/v1/jobs", async (request, reply) => {
      if (!this.isAuthorized(request.headers.authorization)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const job = request.body;
      const controller = new AbortController();
      this.controllers.set(job.sessionId, controller);

      void this.options.handler(job, this.context(job.sessionId, controller.signal))
        .catch((error: unknown) => this.emit(job.sessionId, {
          type: "provider.error",
          sessionId: job.sessionId,
          message: error instanceof Error ? error.message : "unknown provider error",
        }))
        .finally(() => this.controllers.delete(job.sessionId));

      return reply.code(202).send({ accepted: true });
    });

    this.app.post<{ Params: { sessionId: string }; Body: { reason?: string } }>(
      "/v1/jobs/:sessionId/abort",
      async (request, reply) => {
        if (!this.isAuthorized(request.headers.authorization)) {
          return reply.code(401).send({ error: "unauthorized" });
        }
        this.controllers.get(request.params.sessionId)?.abort(request.body.reason ?? "gateway_abort");
        return reply.send({ aborted: true });
      },
    );
  }

  private context(sessionId: string, signal: AbortSignal): ProviderContext {
    return {
      signal,
      emitOutput: (chunk) => this.emit(sessionId, { type: "provider.output", sessionId, chunk }),
      reportUsage: (usage) => this.emit(sessionId, { type: "provider.usage", sessionId, usage }),
      complete: (result) => this.emit(sessionId, { type: "provider.completed", sessionId, result }),
      fail: (message) => this.emit(sessionId, { type: "provider.error", sessionId, message }),
    };
  }

  private async emit(sessionId: string, event: GatewayEvent): Promise<void> {
    await fetch(`${this.options.gatewayBaseUrl}/v1/providers/${this.options.providerId}/sessions/${sessionId}/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.sharedSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
    });
  }

  private isAuthorized(authorization: string | undefined): boolean {
    return authorization === `Bearer ${this.options.sharedSecret}`;
  }
}
