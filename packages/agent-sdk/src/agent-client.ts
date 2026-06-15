import { EventSource } from "eventsource";
import type {
  GatewayEvent,
  PaymentHeartbeatRequest,
  StartSessionRequest,
  StartSessionResponse,
} from "@rubicon-caliga/core";
import type { AgentPaymentEngine } from "./payment-engine.js";

export interface AgentClientOptions {
  baseUrl: string;
  paymentEngine: AgentPaymentEngine;
  fetch?: typeof fetch;
}

export class AgentClient {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: AgentClientOptions) {
    this.fetcher = options.fetch ?? fetch;
  }

  async startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    const response = await this.fetcher(`${this.options.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    return this.readJson(response);
  }

  async sendHeartbeat(session: StartSessionResponse): Promise<void> {
    const heartbeat = await this.options.paymentEngine.createHeartbeat(session);
    await this.sendRawHeartbeat(session.sessionId, heartbeat);
  }

  async sendRawHeartbeat(sessionId: string, heartbeat: PaymentHeartbeatRequest): Promise<void> {
    const response = await this.fetcher(`${this.options.baseUrl}/v1/sessions/${sessionId}/heartbeats`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(heartbeat),
    });
    if (!response.ok) {
      throw new Error(`Heartbeat rejected: ${response.status} ${await response.text()}`);
    }
  }

  async abort(sessionId: string, reason = "agent_cancelled"): Promise<void> {
    await this.fetcher(`${this.options.baseUrl}/v1/sessions/${sessionId}/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    });
  }

  stream(sessionId: string, onEvent: (event: GatewayEvent) => void): () => void {
    const source = new EventSource(`${this.options.baseUrl}/v1/sessions/${sessionId}/events`);
    source.onmessage = (message) => onEvent(JSON.parse(message.data) as GatewayEvent);
    source.onerror = () => source.close();
    return () => source.close();
  }

  private async readJson<T>(response: Response): Promise<T> {
    if (!response.ok) {
      throw new Error(`Gateway request failed: ${response.status} ${await response.text()}`);
    }
    return response.json() as Promise<T>;
  }
}
