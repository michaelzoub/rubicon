import { EventSource } from "eventsource";
import type {
  ArticleSummary,
  Budget,
  GatewayEvent,
  SendConversationMessageResponse,
  StartConversationResponse,
  StartSessionRequest,
  StartSessionResponse,
  StreamPaymentRequest,
  StreamPaymentResponse,
} from "@rubicon-caliga/core";
import { StaticPaymentEngine, type AgentPaymentEngine } from "./payment-engine.js";

export interface RubiconClientOptions {
  baseUrl?: string;
  paymentEngine?: AgentPaymentEngine;
  /** Optional auth header value for the public agent API, e.g. "Bearer <token>". */
  authorization?: string;
  fetch?: typeof fetch;
}

export interface RepositoryResponse {
  repository: "articles";
  articles: ArticleSummary[];
}

export interface NavigationResponse {
  article: ArticleSummary;
  navigation: StartSessionResponse["navigation"];
}

export interface ReadReceipt {
  sessionId: string;
  articleId: string;
  conversationId: string;
  wordsRead: number;
  amountPaidAtomic: `${bigint}`;
  transactionHashes: string[];
  text: string;
  completed: boolean;
  stopReason: "article_completed" | "stop_condition" | "budget_reached" | "max_words" | "aborted";
}

export type RubiconReadEvent =
  | { type: "session.started"; session: StartSessionResponse }
  | { type: "seller.message"; content: string; recommendedSectionId?: string }
  | {
      type: "article.word";
      sequence: number;
      word: string;
      priceAtomic: `${bigint}`;
      wordsRead: number;
      amountPaidAtomic: `${bigint}`;
      transactionHash?: string;
      transactionHashes?: string[];
      text: string;
    }
  | { type: "article.usage"; wordsPaid: number; wordsDelivered: number; paidAtomic: `${bigint}` }
  | { type: "article.completed"; receipt: ReadReceipt }
  | { type: "article.error"; message: string };

export interface ReadOptions {
  articleId: string;
  goal?: string;
  sectionId?: string;
  conversationId?: string;
  /** Hard spend ceiling in atomic USDC. Equivalent to budget.maxAmountAtomic. */
  maxSpendAtomic?: `${bigint}`;
  budget?: Budget;
  maxWords?: number;
  /** Return true to stop reading once enough information has been collected. */
  stopWhen?: (state: {
    text: string;
    wordsRead: number;
    amountPaid: bigint;
  }) => boolean | Promise<boolean>;
  metadata?: Record<string, unknown>;
}

export interface RunOptions extends ReadOptions {
  onEvent?: (event: RubiconReadEvent) => void | Promise<void>;
  onWord?: (word: string, state: { text: string; wordsRead: number; amountPaidAtomic: `${bigint}` }) => void | Promise<void>;
}

/**
 * High-level buyer-agent client for Rubicon. `read()` runs the entire
 * pay -> word -> usage loop one word at a time until a stop condition is met,
 * so application developers never send a payment for every word themselves.
 */
export class RubiconClient {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly paymentEngine: AgentPaymentEngine;

  constructor(private readonly options: RubiconClientOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? "http://localhost:8787";
    this.paymentEngine = options.paymentEngine ?? new StaticPaymentEngine();
  }

  async getRepository(): Promise<RepositoryResponse> {
    return this.readJson(await this.fetcher(`${this.baseUrl}/v1/repository`, { headers: this.headers() }));
  }

  async getNavigation(articleId: string, goal?: string): Promise<NavigationResponse> {
    const url = new URL(`${this.baseUrl}/v1/articles/${articleId}/navigation`);
    if (goal) {
      url.searchParams.set("goal", goal);
    }
    return this.readJson(await this.fetcher(url.toString(), { headers: this.headers() }));
  }

  async startConversation(input: {
    articleId: string;
    goal?: string;
    message?: string;
  }): Promise<StartConversationResponse> {
    return this.readJson(
      await this.fetcher(`${this.baseUrl}/v1/seller-agent/conversations`, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify(input),
      }),
    );
  }

  async sendConversationMessage(
    conversationId: string,
    message: string,
  ): Promise<SendConversationMessageResponse> {
    return this.readJson(
      await this.fetcher(
        `${this.baseUrl}/v1/seller-agent/conversations/${conversationId}/messages`,
        {
          method: "POST",
          headers: this.headers({ "content-type": "application/json" }),
          body: JSON.stringify({ message }),
        },
      ),
    );
  }

  async startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    return this.readJson(
      await this.fetcher(`${this.baseUrl}/v1/sessions`, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify(request),
      }),
    );
  }

  async payForWord(sessionId: string, payment: StreamPaymentRequest): Promise<StreamPaymentResponse> {
    const response = await this.fetcher(`${this.baseUrl}/v1/sessions/${sessionId}/payments`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(payment),
    });
    if (!response.ok) {
      throw new Error(`Word payment rejected: ${response.status} ${await response.text()}`);
    }
    return response.json() as Promise<StreamPaymentResponse>;
  }

  async abort(sessionId: string, reason = "agent_cancelled"): Promise<void> {
    await this.fetcher(`${this.baseUrl}/v1/sessions/${sessionId}/abort`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ reason }),
    });
  }

  /** Subscribe to raw word-level server-sent events for observation/logging. */
  streamEvents(sessionId: string, onEvent: (event: GatewayEvent) => void): () => void {
    const headers = this.headers();
    const source = new EventSource(`${this.baseUrl}/v1/sessions/${sessionId}/events`, {
      fetch: (input, init) =>
        this.fetcher(input, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers).entries()),
            ...headers,
          },
        }),
    });
    source.onmessage = (message) => onEvent(JSON.parse(message.data) as GatewayEvent);
    source.onerror = () => source.close();
    return () => source.close();
  }

  /**
   * Simplest path for agents: run the whole paid read and return the receipt.
   * Use callbacks only when the caller wants live progress.
   */
  async run(options: RunOptions): Promise<ReadReceipt> {
    let receipt: ReadReceipt | undefined;
    for await (const event of this.read(options)) {
      await options.onEvent?.(event);
      if (event.type === "article.word") {
        await options.onWord?.(event.word, {
          text: event.text,
          wordsRead: event.wordsRead,
          amountPaidAtomic: event.amountPaidAtomic,
        });
      }
      if (event.type === "article.completed") {
        receipt = event.receipt;
      }
    }
    if (!receipt) {
      throw new Error("Rubicon read finished without a receipt");
    }
    return receipt;
  }

  /**
   * Read an article one paid word at a time. Yields seller messages, paid words,
   * running usage, and a final completion event carrying the receipt.
   */
  async *read(options: ReadOptions): AsyncGenerator<RubiconReadEvent, ReadReceipt> {
    const budget: Budget =
      options.budget ??
      (options.maxSpendAtomic
        ? { currency: "USDC", maxAmountAtomic: options.maxSpendAtomic }
        : (() => {
            throw new Error("read() requires maxSpendAtomic or budget");
          })());
    const budgetAtomic = BigInt(budget.maxAmountAtomic);

    // Let the seller agent recommend a starting section if the buyer has a goal
    // and did not pick one explicitly.
    let conversationId = options.conversationId;
    let sectionId = options.sectionId;
    if (options.goal && !conversationId) {
      const conversation = await this.startConversation({
        articleId: options.articleId,
        goal: options.goal,
        message: options.goal,
      });
      conversationId = conversation.conversationId;
      const seller = conversation.messages.find((message) => message.role === "seller");
      if (seller) {
        yield {
          type: "seller.message",
          content: seller.content,
          recommendedSectionId: seller.recommendedSectionId,
        };
        sectionId = sectionId ?? seller.recommendedSectionId;
      }
    }

    const session = await this.startSession({
      articleId: options.articleId,
      goal: options.goal,
      conversationId,
      sectionId,
      budget,
      metadata: options.metadata,
    });
    yield { type: "session.started", session };

    const wordPaymentAtomic = BigInt(session.wordPaymentAtomic);
    let text = "";
    let wordsRead = 0;
    let amountPaid = 0n;
    const transactionHashes: string[] = [];
    let stopReason: ReadReceipt["stopReason"] = "article_completed";
    let completed = false;

    const makeReceipt = (): ReadReceipt => ({
      sessionId: session.sessionId,
      articleId: session.article.articleId,
      conversationId: session.conversationId,
      wordsRead,
      amountPaidAtomic: `${amountPaid}`,
      transactionHashes: [...transactionHashes],
      text,
      completed,
      stopReason,
    });

    while (true) {
      if (options.maxWords !== undefined && wordsRead >= options.maxWords) {
        stopReason = "max_words";
        break;
      }
      if (amountPaid + wordPaymentAtomic > budgetAtomic) {
        stopReason = "budget_reached";
        break;
      }
      if (await options.stopWhen?.({ text, wordsRead, amountPaid })) {
        stopReason = "stop_condition";
        break;
      }

      const payment = await this.paymentEngine.createWordPayment(session);
      // Idempotency key ties this payment to the specific next word; safe retries.
      const idempotencyKey = `${session.sessionId}:${wordsRead}`;
      let result: StreamPaymentResponse;
      try {
        result = await this.payForWord(session.sessionId, { ...payment, idempotencyKey });
      } catch (error) {
        yield { type: "article.error", message: error instanceof Error ? error.message : String(error) };
        stopReason = "aborted";
        break;
      }

      if (result.completed && result.word === "") {
        // Article exhausted with no further word to deliver.
        completed = true;
        stopReason = "article_completed";
        const receipt = makeReceipt();
        yield { type: "article.completed", receipt };
        return receipt;
      }

      wordsRead = result.wordsDelivered;
      amountPaid = BigInt(result.paidAtomic);
      transactionHashes.push(...(result.transactionHashes ?? (result.transactionHash ? [result.transactionHash] : [])));
      text = text ? `${text} ${result.word}` : result.word;

      yield {
        type: "article.word",
        sequence: result.sequence,
        word: result.word,
        priceAtomic: result.priceAtomic,
        wordsRead,
        amountPaidAtomic: `${amountPaid}`,
        transactionHash: result.transactionHash,
        transactionHashes: result.transactionHashes,
        text,
      };
      yield {
        type: "article.usage",
        wordsPaid: result.wordsPaid,
        wordsDelivered: result.wordsDelivered,
        paidAtomic: result.paidAtomic,
      };

      if (result.completed) {
        completed = true;
        stopReason = "article_completed";
        const receipt = makeReceipt();
        yield { type: "article.completed", receipt };
        return receipt;
      }
    }

    // Stopped early by the buyer: abort the session so no further words are owed.
    await this.abort(session.sessionId, stopReason).catch(() => {});
    const receipt = makeReceipt();
    yield { type: "article.completed", receipt };
    return receipt;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.options.authorization) {
      headers.authorization = this.options.authorization;
    }
    return headers;
  }

  private async readJson<T>(response: Response): Promise<T> {
    if (!response.ok) {
      throw new Error(`Gateway request failed: ${response.status} ${await response.text()}`);
    }
    return response.json() as Promise<T>;
  }
}

/** Backwards-compatible alias. */
export const AgentClient = RubiconClient;
