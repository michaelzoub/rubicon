import { EventSource } from "eventsource";
import type {
  ArticleNavigation,
  ArticleSummary,
  GatewayEvent,
  StartSessionRequest,
  StartSessionResponse,
  StreamPaymentRequest,
} from "@rubicon-caliga/core";
import type { AgentPaymentEngine } from "./payment-engine.js";

export interface AgentClientOptions {
  baseUrl: string;
  paymentEngine: AgentPaymentEngine;
  sellerAgentApiKey?: string;
  fetch?: typeof fetch;
}

export interface NavigationResponse {
  article: ArticleSummary;
  navigation: ArticleNavigation;
}

export interface SellerAgentNavigationResponse {
  article: ArticleSummary;
  sellerAgent: {
    role: "neutral_article_navigator";
    selectedSectionIds: string[];
    hints: string[];
    constraints: string[];
    withholds: string[];
  };
}

export interface StreamStopOptions {
  maxWords?: number;
  maxPayments?: number;
  maxSpendAtomic?: `${bigint}`;
  hasEnoughInformation?: (input: {
    event: GatewayEvent;
    wordsStreamed: number;
    paymentsSent: number;
    paidAtomic: bigint;
  }) => boolean;
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

  async startArticleStream(request: StartSessionRequest): Promise<StartSessionResponse> {
    return this.startSession(request);
  }

  async getArticleNavigation(articleId: string): Promise<NavigationResponse> {
    const response = await this.fetcher(`${this.options.baseUrl}/v1/articles/${articleId}/navigation`);
    return this.readJson(response);
  }

  async askSellerAgentNavigation(request: {
    articleId: string;
    buyerGoal?: string;
    candidateSectionIds?: string[];
    maxSpendAtomic?: `${bigint}`;
  }): Promise<SellerAgentNavigationResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.sellerAgentApiKey) {
      headers.authorization = `Bearer ${this.options.sellerAgentApiKey}`;
    }
    const response = await this.fetcher(`${this.options.baseUrl}/v1/seller-agent/navigation`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    return this.readJson(response);
  }

  async sendPayment(session: StartSessionResponse): Promise<void> {
    const payment = await this.options.paymentEngine.createPayment(session);
    await this.sendRawPayment(session.sessionId, payment);
  }

  async sendRawPayment(sessionId: string, payment: StreamPaymentRequest): Promise<void> {
    const response = await this.fetcher(`${this.options.baseUrl}/v1/sessions/${sessionId}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payment),
    });
    if (!response.ok) {
      throw new Error(`Payment rejected: ${response.status} ${await response.text()}`);
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

  streamWithStopConditions(
    session: StartSessionResponse,
    options: StreamStopOptions,
    onEvent: (event: GatewayEvent) => void,
  ): () => void {
    let wordsStreamed = 0;
    let paymentsSent = 0;
    let paidAtomic = 0n;
    let paymentInFlight = false;
    let closed = false;

    const stop = this.stream(session.sessionId, (event) => {
      onEvent(event);
      if (event.type === "session.payment_accepted") {
        paidAtomic = BigInt(event.paidAtomic);
      }
      if (event.type === "article.usage") {
        wordsStreamed = event.wordsStreamed;
      }
      if (event.type === "session.closed" || event.type === "session.aborted") {
        closed = true;
        stop();
        return;
      }
      if (
        shouldStop({
          event,
          wordsStreamed,
          paymentsSent,
          paidAtomic,
          options,
        })
      ) {
        closed = true;
        void this.abort(session.sessionId, "buyer_stop_condition_met").finally(stop);
        return;
      }
      if (event.type === "article.usage") {
        void payNext();
      }
    });

    const payNext = async (): Promise<void> => {
      if (closed || paymentInFlight) {
        return;
      }
      paymentInFlight = true;
      paymentsSent += 1;
      try {
        await this.sendPayment(session);
      } finally {
        paymentInFlight = false;
      }
    };

    void payNext();
    return () => {
      closed = true;
      stop();
    };
  }

  private async readJson<T>(response: Response): Promise<T> {
    if (!response.ok) {
      throw new Error(`Gateway request failed: ${response.status} ${await response.text()}`);
    }
    return response.json() as Promise<T>;
  }
}

function shouldStop(input: {
  event: GatewayEvent;
  wordsStreamed: number;
  paymentsSent: number;
  paidAtomic: bigint;
  options: StreamStopOptions;
}): boolean {
  if (input.options.maxWords !== undefined && input.wordsStreamed >= input.options.maxWords) {
    return true;
  }
  if (input.options.maxPayments !== undefined && input.paymentsSent >= input.options.maxPayments) {
    return true;
  }
  if (input.options.maxSpendAtomic !== undefined && input.paidAtomic >= BigInt(input.options.maxSpendAtomic)) {
    return true;
  }
  return input.options.hasEnoughInformation?.({
    event: input.event,
    wordsStreamed: input.wordsStreamed,
    paymentsSent: input.paymentsSent,
    paidAtomic: input.paidAtomic,
  }) === true;
}
