import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import type {
  ArticleSection,
  ArticleState,
  ArticleSummary,
  CreatorWallet,
  EarningsSummary,
  PaymentActivity,
  SellerAgentConfig,
  SellerAgentMessageRecord,
  SessionRecord,
  WordDeliveryRecord,
} from "@rubicon-caliga/core";
import { PUBLIC_ARTICLE_STATE } from "@rubicon-caliga/core";
import { toCaip2Network } from "../chain.js";
import { tokenizeWords } from "../words.js";
import { summarizeArticle } from "./in-memory.js";
import type {
  ArticleRecord,
  LedgerRepository,
  PublishedArticleRepository,
  RecordWordDeliveryInput,
  RecordWordDeliveryResult,
} from "./types.js";

export function createPgPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}

/** Run all SQL migration files in apps/gateway/migrations in lexical order. */
export async function runMigrations(pool: Pool): Promise<void> {
  const dir = fileURLToPath(new URL("../../migrations/", import.meta.url));
  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  );
  for (const file of files) {
    const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
    if (applied.rowCount > 0) {
      continue;
    }
    const sql = await readFile(`${dir}${file}`, "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

interface ArticleRow {
  id: string;
  creator_id: string;
  creator_username: string;
  title: string;
  author: string;
  state: ArticleState;
  price_per_word_atomic: string;
  max_article_price_atomic: string | null;
  total_words: number;
  revision: number;
  seller_agent_config: SellerAgentConfig | null;
  body: string;
  created_at: string;
  updated_at: string;
}

interface SectionRow {
  section_id: string;
  heading: string;
  level: number;
  word_start: number;
  word_count: number;
  ordinal: number;
  article_id: string;
  id: string;
}

function toArticleRecord(row: ArticleRow, sections: ArticleSection[]): ArticleRecord {
  return {
    id: row.id,
    creatorId: row.creator_id,
    creatorUsername: row.creator_username,
    title: row.title,
    author: row.author,
    state: row.state,
    pricePerWordAtomic: BigInt(row.price_per_word_atomic),
    maxArticlePriceAtomic: row.max_article_price_atomic ? BigInt(row.max_article_price_atomic) : undefined,
    totalWords: row.total_words,
    revision: row.revision,
    sellerAgentConfig: row.seller_agent_config ?? undefined,
    body: row.body,
    words: tokenizeWords(row.body),
    sections,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSection(row: SectionRow): ArticleSection {
  return {
    id: row.id,
    articleId: row.article_id,
    sectionId: row.section_id,
    heading: row.heading,
    level: row.level,
    wordStart: row.word_start,
    wordCount: row.word_count,
    ordinal: row.ordinal,
  };
}

const ARTICLE_SELECT = `
  SELECT a.id, a.creator_id, c.username AS creator_username, a.title, a.author, a.state,
         a.price_per_word_atomic, a.max_article_price_atomic, a.total_words, a.revision,
         a.seller_agent_config, a.body, a.created_at, a.updated_at
  FROM articles a
  JOIN creators c ON c.id = a.creator_id
`;

export class PostgresPublishedArticleRepository implements PublishedArticleRepository {
  constructor(private readonly pool: Pool) {}

  async listPublishedArticles(): Promise<ArticleSummary[]> {
    const articles = await this.pool.query<ArticleRow>(`${ARTICLE_SELECT} WHERE a.state = $1`, [
      PUBLIC_ARTICLE_STATE,
    ]);
    const summaries: ArticleSummary[] = [];
    for (const row of articles.rows) {
      const sections = await this.getArticleSections(row.id);
      summaries.push(summarizeArticle(toArticleRecord(row, sections)));
    }
    return summaries;
  }

  async getPublishedArticle(articleId: string): Promise<ArticleRecord | null> {
    const result = await this.pool.query<ArticleRow>(`${ARTICLE_SELECT} WHERE a.id = $1 AND a.state = $2`, [
      articleId,
      PUBLIC_ARTICLE_STATE,
    ]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return toArticleRecord(row, await this.getArticleSections(articleId));
  }

  async getArticleAnyState(articleId: string): Promise<ArticleRecord | null> {
    const result = await this.pool.query<ArticleRow>(`${ARTICLE_SELECT} WHERE a.id = $1`, [articleId]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return toArticleRecord(row, await this.getArticleSections(articleId));
  }

  async getArticleSections(articleId: string): Promise<ArticleSection[]> {
    const result = await this.pool.query<SectionRow>(
      "SELECT id, article_id, section_id, heading, level, word_start, word_count, ordinal FROM article_sections WHERE article_id = $1 ORDER BY ordinal",
      [articleId],
    );
    return result.rows.map(toSection);
  }

  async getCreatorWallet(creatorId: string): Promise<CreatorWallet | null> {
    const result = await this.pool.query<{
      creator_id: string;
      address: string;
      network: string;
      verified: boolean;
    }>("SELECT creator_id, address, network, verified FROM creator_wallets WHERE creator_id = $1", [creatorId]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      creatorId: row.creator_id,
      address: row.address as `0x${string}`,
      // rubicon-marketing persists the human slug ("arc-testnet"); the x402
      // settlement path needs canonical CAIP-2 ("eip155:5042002").
      network: toCaip2Network(row.network),
      verified: row.verified,
    };
  }
}

export class PostgresLedgerRepository implements LedgerRepository {
  constructor(private readonly pool: Pool) {}

  async createSession(session: SessionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO stream_sessions
         (id, article_id, creator_id, conversation_id, state, goal, section_id,
          price_per_word_atomic, gateway_fee_bps, seller_wallet, budget_atomic,
          words_paid, words_delivered, paid_atomic, metadata, created_at, updated_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        session.id,
        session.articleId,
        session.creatorId,
        session.conversationId ?? null,
        session.state,
        session.goal ?? null,
        session.sectionId ?? null,
        `${session.pricePerWordAtomic}`,
        session.gatewayFeeBps,
        session.sellerWallet,
        session.budget.maxAmountAtomic,
        session.wordsPaid,
        session.wordsDelivered,
        `${session.paidAtomic}`,
        JSON.stringify(session.metadata),
        session.createdAt.toISOString(),
        session.updatedAt.toISOString(),
        session.expiresAt.toISOString(),
      ],
    );
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const result = await this.pool.query<{
      id: string;
      article_id: string;
      creator_id: string;
      conversation_id: string | null;
      state: SessionRecord["state"];
      goal: string | null;
      section_id: string | null;
      price_per_word_atomic: string;
      gateway_fee_bps: number;
      seller_wallet: string;
      budget_atomic: string;
      words_paid: number;
      words_delivered: number;
      paid_atomic: string;
      metadata: Record<string, unknown>;
      created_at: string;
      updated_at: string;
      expires_at: string;
    }>("SELECT * FROM stream_sessions WHERE id = $1", [sessionId]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      articleId: row.article_id,
      creatorId: row.creator_id,
      conversationId: row.conversation_id ?? undefined,
      goal: row.goal ?? undefined,
      sectionId: row.section_id ?? undefined,
      budget: { currency: "USDC", maxAmountAtomic: row.budget_atomic as `${bigint}` },
      pricePerWordAtomic: BigInt(row.price_per_word_atomic),
      gatewayFeeBps: row.gateway_fee_bps,
      sellerWallet: row.seller_wallet as `0x${string}`,
      metadata: row.metadata ?? {},
      state: row.state,
      wordsPaid: row.words_paid,
      wordsDelivered: row.words_delivered,
      paidAtomic: BigInt(row.paid_atomic),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      expiresAt: new Date(row.expires_at),
    };
  }

  async saveSession(session: SessionRecord): Promise<void> {
    await this.pool.query(
      `UPDATE stream_sessions SET state=$2, words_paid=$3, words_delivered=$4, paid_atomic=$5,
         conversation_id=$6, metadata=$7, updated_at=$8 WHERE id=$1`,
      [
        session.id,
        session.state,
        session.wordsPaid,
        session.wordsDelivered,
        `${session.paidAtomic}`,
        session.conversationId ?? null,
        JSON.stringify(session.metadata),
        new Date().toISOString(),
      ],
    );
  }

  async createConversation(input: {
    id: string;
    articleId: string;
    creatorId: string;
    goal?: string;
  }): Promise<void> {
    await this.pool.query(
      "INSERT INTO seller_agent_conversations (id, article_id, creator_id, goal) VALUES ($1,$2,$3,$4)",
      [input.id, input.articleId, input.creatorId, input.goal ?? null],
    );
  }

  async getConversation(
    conversationId: string,
  ): Promise<{ id: string; articleId: string; creatorId: string; goal?: string } | null> {
    const result = await this.pool.query<{
      id: string;
      article_id: string;
      creator_id: string;
      goal: string | null;
    }>("SELECT id, article_id, creator_id, goal FROM seller_agent_conversations WHERE id = $1", [conversationId]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return { id: row.id, articleId: row.article_id, creatorId: row.creator_id, goal: row.goal ?? undefined };
  }

  async appendMessage(message: SellerAgentMessageRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO seller_agent_messages
         (id, conversation_id, article_id, session_id, role, content, recommended_section_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        message.id,
        message.conversationId,
        message.articleId,
        message.sessionId ?? null,
        message.role,
        message.content,
        null,
        message.createdAt,
      ],
    );
  }

  async listMessages(conversationId: string): Promise<SellerAgentMessageRecord[]> {
    const result = await this.pool.query<{
      id: string;
      conversation_id: string;
      article_id: string;
      session_id: string | null;
      role: "buyer" | "seller";
      content: string;
      created_at: string;
    }>(
      "SELECT * FROM seller_agent_messages WHERE conversation_id = $1 ORDER BY created_at",
      [conversationId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      articleId: row.article_id,
      sessionId: row.session_id ?? undefined,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  async getDeliveryByIdempotencyKey(key: string): Promise<RecordWordDeliveryResult | null> {
    const result = await this.pool.query<{
      session_id: string;
      article_id: string;
      creator_id: string;
      sequence: number;
      word: string;
      price_atomic: string;
      creator_amount_atomic: string;
      rubicon_fee_atomic: string;
      network: string | null;
      pay_to: `0x${string}` | null;
      transaction_hash: string | null;
      transaction_hashes: string[] | null;
      payment_id: string;
      transfer_id: string | null;
      created_at: string;
    }>(
      `SELECT d.session_id, d.article_id, d.sequence, d.word, d.price_atomic, d.payment_id, d.created_at,
              p.creator_id, p.creator_amount_atomic, p.rubicon_fee_atomic, p.network, p.pay_to,
              p.transaction_hash, p.transaction_hashes, p.transfer_id
       FROM word_deliveries d JOIN word_payments p ON p.payment_id = d.payment_id
       WHERE d.idempotency_key = $1`,
      [key],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      duplicate: true,
      delivery: {
        sessionId: row.session_id,
        articleId: row.article_id,
        sequence: row.sequence,
        word: row.word,
        priceAtomic: row.price_atomic as `${bigint}`,
        paymentId: row.payment_id,
        createdAt: row.created_at,
      },
      payment: {
        paymentId: row.payment_id,
        sessionId: row.session_id,
        articleId: row.article_id,
        sequence: row.sequence,
        amountAtomic: row.price_atomic as `${bigint}`,
        creatorAmountAtomic: row.creator_amount_atomic as `${bigint}`,
        rubiconFeeAtomic: row.rubicon_fee_atomic as `${bigint}`,
        network: row.network ?? undefined,
        payTo: row.pay_to ?? undefined,
        transactionHash: row.transaction_hash ?? row.transfer_id ?? undefined,
        transactionHashes: row.transaction_hashes ?? (row.transaction_hash || row.transfer_id ? [row.transaction_hash ?? row.transfer_id!] : undefined),
        transferId: row.transfer_id ?? undefined,
        createdAt: row.created_at,
      },
    };
  }

  async recordWordDelivery(input: RecordWordDeliveryInput): Promise<RecordWordDeliveryResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO word_payments
           (id, payment_id, session_id, article_id, creator_id, sequence, amount_atomic,
            creator_amount_atomic, rubicon_fee_atomic, network, pay_to, transaction_hash,
            transaction_hashes, transfer_id, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING payment_id`,
        [
          crypto.randomUUID(),
          input.paymentId,
          input.sessionId,
          input.articleId,
          input.creatorId,
          input.sequence,
          `${input.priceAtomic}`,
          `${input.creatorAmountAtomic}`,
          `${input.rubiconFeeAtomic}`,
          input.network ?? null,
          input.payTo ?? null,
          input.transactionHash ?? input.transferId ?? null,
          input.transactionHashes ? JSON.stringify(input.transactionHashes) : null,
          input.transferId ?? null,
          input.idempotencyKey,
        ],
      );
      if (inserted.rowCount === 0) {
        await client.query("ROLLBACK");
        const existing = await this.getDeliveryByIdempotencyKey(input.idempotencyKey);
        if (existing) {
          return existing;
        }
        throw new Error("word_delivery_conflict");
      }
      await client.query(
        `INSERT INTO word_deliveries (id, session_id, article_id, sequence, word, price_atomic, payment_id, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          crypto.randomUUID(),
          input.sessionId,
          input.articleId,
          input.sequence,
          input.word,
          `${input.priceAtomic}`,
          input.paymentId,
          input.idempotencyKey,
        ],
      );
      await client.query(
        `INSERT INTO settlement_receipts
           (id, payment_id, network, pay_to, transaction_hash, transaction_hashes, transfer_id,
            amount_atomic, creator_amount_atomic, rubicon_fee_atomic)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          crypto.randomUUID(),
          input.paymentId,
          input.network ?? null,
          input.payTo ?? null,
          input.transactionHash ?? input.transferId ?? null,
          input.transactionHashes ? JSON.stringify(input.transactionHashes) : null,
          input.transferId ?? null,
          `${input.priceAtomic}`,
          `${input.creatorAmountAtomic}`,
          `${input.rubiconFeeAtomic}`,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const createdAt = new Date().toISOString();
    return {
      duplicate: false,
      delivery: {
        sessionId: input.sessionId,
        articleId: input.articleId,
        sequence: input.sequence,
        word: input.word,
        priceAtomic: `${input.priceAtomic}`,
        paymentId: input.paymentId,
        createdAt,
      },
      payment: {
        paymentId: input.paymentId,
        sessionId: input.sessionId,
        articleId: input.articleId,
        sequence: input.sequence,
        amountAtomic: `${input.priceAtomic}`,
        creatorAmountAtomic: `${input.creatorAmountAtomic}`,
        rubiconFeeAtomic: `${input.rubiconFeeAtomic}`,
        network: input.network,
        payTo: input.payTo,
        transactionHash: input.transactionHash ?? input.transferId,
        transactionHashes: input.transactionHashes ?? (input.transactionHash || input.transferId ? [input.transactionHash ?? input.transferId!] : undefined),
        transferId: input.transferId,
        createdAt,
      },
    };
  }

  async listDeliveries(sessionId: string): Promise<WordDeliveryRecord[]> {
    const result = await this.pool.query<{
      session_id: string;
      article_id: string;
      sequence: number;
      word: string;
      price_atomic: string;
      payment_id: string;
      created_at: string;
    }>("SELECT * FROM word_deliveries WHERE session_id = $1 ORDER BY sequence", [sessionId]);
    return result.rows.map((row) => ({
      sessionId: row.session_id,
      articleId: row.article_id,
      sequence: row.sequence,
      word: row.word,
      priceAtomic: row.price_atomic as `${bigint}`,
      paymentId: row.payment_id,
      createdAt: row.created_at,
    }));
  }

  async listPayments(sessionId: string): Promise<PaymentActivity[]> {
    const result = await this.pool.query<{
      payment_id: string;
      session_id: string;
      article_id: string;
      sequence: number;
      amount_atomic: string;
      creator_amount_atomic: string;
      rubicon_fee_atomic: string;
      network: string | null;
      pay_to: `0x${string}` | null;
      transaction_hash: string | null;
      transaction_hashes: string[] | null;
      transfer_id: string | null;
      created_at: string;
    }>("SELECT * FROM word_payments WHERE session_id = $1 ORDER BY sequence", [sessionId]);
    return result.rows.map((row) => ({
      paymentId: row.payment_id,
      sessionId: row.session_id,
      articleId: row.article_id,
      sequence: row.sequence,
      amountAtomic: row.amount_atomic as `${bigint}`,
      creatorAmountAtomic: row.creator_amount_atomic as `${bigint}`,
      rubiconFeeAtomic: row.rubicon_fee_atomic as `${bigint}`,
      network: row.network ?? undefined,
      payTo: row.pay_to ?? undefined,
      transactionHash: row.transaction_hash ?? row.transfer_id ?? undefined,
      transactionHashes: row.transaction_hashes ?? (row.transaction_hash || row.transfer_id ? [row.transaction_hash ?? row.transfer_id!] : undefined),
      transferId: row.transfer_id ?? undefined,
      createdAt: row.created_at,
    }));
  }

  async earningsForArticle(articleId: string): Promise<EarningsSummary> {
    const result = await this.pool.query<{
      creator_id: string;
      words: string;
      creator_amount: string | null;
      rubicon_fee: string | null;
    }>(
      `SELECT MIN(creator_id) AS creator_id, COUNT(*)::text AS words,
              COALESCE(SUM(creator_amount_atomic::numeric),0)::text AS creator_amount,
              COALESCE(SUM(rubicon_fee_atomic::numeric),0)::text AS rubicon_fee
       FROM word_payments WHERE article_id = $1`,
      [articleId],
    );
    const row = result.rows[0];
    return {
      creatorId: row?.creator_id ?? "",
      articleId,
      wordsDelivered: Number(row?.words ?? "0"),
      creatorAmountAtomic: (row?.creator_amount ?? "0") as `${bigint}`,
      rubiconFeeAtomic: (row?.rubicon_fee ?? "0") as `${bigint}`,
    };
  }

  async earningsForCreator(creatorId: string): Promise<EarningsSummary> {
    const result = await this.pool.query<{
      words: string;
      creator_amount: string | null;
      rubicon_fee: string | null;
    }>(
      `SELECT COUNT(*)::text AS words,
              COALESCE(SUM(creator_amount_atomic::numeric),0)::text AS creator_amount,
              COALESCE(SUM(rubicon_fee_atomic::numeric),0)::text AS rubicon_fee
       FROM word_payments WHERE creator_id = $1`,
      [creatorId],
    );
    const row = result.rows[0];
    return {
      creatorId,
      wordsDelivered: Number(row?.words ?? "0"),
      creatorAmountAtomic: (row?.creator_amount ?? "0") as `${bigint}`,
      rubiconFeeAtomic: (row?.rubicon_fee ?? "0") as `${bigint}`,
    };
  }
}
