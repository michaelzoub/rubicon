import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import type {
  ArticleSection,
  ArticleAccessMode,
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
import { hashBuyerAgentIdentity } from "../analytics/identity.js";
import { clampSectionsToWords, tokenizeWords } from "../words.js";
import { summarizeArticle } from "./in-memory.js";
import type {
  ArticleRecord,
  LedgerRepository,
  PublishedArticleRepository,
  RecordWordDeliveryResult,
  RecordBundleResult,
  RecordFreeBundleInput,
  RecordPaidBundleInput,
  RecordedBundle,
  RecordSettlementRangeInput,
  SettlementEvidenceInput,
} from "./types.js";

interface PgPoolConfig {
  connectionString: string;
  ssl?: { rejectUnauthorized: boolean };
}

export function createPgPool(databaseUrl: string): Pool {
  return new Pool(resolvePgPoolConfig(databaseUrl));
}

export function describeDatabaseUrl(databaseUrl: string): string {
  const parsed = parseDatabaseUrl(databaseUrl);
  if (!parsed) {
    return "invalid DATABASE_URL";
  }
  const database = parsed.pathname.replace(/^\//, "") || "(default)";
  const sslMode = parsed.searchParams.get("sslmode") ?? "(unspecified)";
  const username = parsed.username || "(unspecified)";
  return `host=${parsed.hostname} port=${parsed.port || "(default)"} database=${database} user=${username} sslmode=${sslMode}`;
}

export function resolvePgPoolConfig(databaseUrl: string): PgPoolConfig {
  const config: PgPoolConfig = { connectionString: databaseUrl };
  const parsed = parseDatabaseUrl(databaseUrl);
  if (!parsed) {
    return config;
  }

  const sslMode = parsed.searchParams.get("sslmode");
  if (isSupabasePoolerHost(parsed.hostname) && sslMode !== "disable") {
    config.ssl = { rejectUnauthorized: false };
  }
  if (sslMode === "no-verify") {
    config.ssl = { rejectUnauthorized: false };
  }
  return config;
}

export function assertRailwayCompatibleDatabaseUrl(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isRailwayRuntime(env)) {
    return;
  }

  const parsed = parseDatabaseUrl(databaseUrl);
  if (!parsed) {
    throw new Error("DATABASE_URL must be a full PostgreSQL connection URL, for example postgresql://user:password@host:5432/postgres.");
  }

  if (parsed.hostname === "base") {
    throw new Error(
      "DATABASE_URL resolves to host `base`, which is a placeholder/default. Set the persistent Railway service variable to the Supabase pooler URL.",
    );
  }

  if (/^db\.[^.]+\.supabase\.co$/i.test(parsed.hostname)) {
    throw new Error(
      [
        "DATABASE_URL points at Supabase's direct Postgres host, which is IPv6-only and often unreachable from Railway.",
        "Use the Supabase connection pooler URL instead, for example:",
        "postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=no-verify",
      ].join(" "),
    );
  }
}

function isRailwayRuntime(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID);
}

function isSupabasePoolerHost(hostname: string): boolean {
  return /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/i.test(hostname);
}

function parseDatabaseUrl(databaseUrl: string): URL | null {
  try {
    return new URL(databaseUrl);
  } catch {
    return null;
  }
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
  access_mode: ArticleAccessMode;
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
  // Single source of truth: the tokenized body is what the gateway slices, so
  // totalWords and section ranges are derived from it rather than the stored
  // `total_words`/section rows, which can drift. See clampSectionsToWords.
  const words = tokenizeWords(row.body);
  return {
    id: row.id,
    creatorId: row.creator_id,
    creatorUsername: row.creator_username,
    title: row.title,
    author: row.author,
    state: row.state,
    accessMode: row.access_mode,
    pricePerWordAtomic: BigInt(row.price_per_word_atomic),
    maxArticlePriceAtomic: row.max_article_price_atomic ? BigInt(row.max_article_price_atomic) : undefined,
    totalWords: words.length,
    revision: row.revision,
    sellerAgentConfig: row.seller_agent_config ?? undefined,
    body: row.body,
    words,
    sections: clampSectionsToWords(words, sections),
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
  SELECT a.id, a.creator_id, c.username AS creator_username, a.title, a.author, a.state, a.access_mode,
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
    }>("SELECT creator_id, address, network, verified FROM creator_wallets WHERE creator_id = $1 AND network = 'arc-testnet'", [creatorId]);
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

  async getCreatorBaseWallet(creatorId: string): Promise<CreatorWallet | null> {
    const result = await this.pool.query<{
      creator_id: string;
      address: string;
      network: string;
      verified: boolean;
    }>("SELECT creator_id, address, network, verified FROM creator_wallets WHERE creator_id = $1 AND network = 'eip155:8453' AND verified = true", [creatorId]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      creatorId: row.creator_id,
      address: row.address as `0x${string}`,
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
         (id, article_id, creator_id, conversation_id, state, access_mode, goal, section_id,
          price_per_word_atomic, gateway_fee_bps, seller_wallet, budget_atomic,
          words_paid, words_delivered, paid_atomic, payment_required, metadata, created_at, updated_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        session.id,
        session.articleId,
        session.creatorId,
        session.conversationId ?? null,
        session.state,
        session.accessMode,
        session.goal ?? null,
        session.sectionId ?? null,
        `${session.pricePerWordAtomic}`,
        session.gatewayFeeBps,
        session.sellerWallet,
        session.budget.maxAmountAtomic,
        session.wordsPaid,
        session.wordsDelivered,
        `${session.paidAtomic}`,
        session.paymentRequired === undefined ? null : JSON.stringify(session.paymentRequired),
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
      access_mode: SessionRecord["accessMode"];
      goal: string | null;
      section_id: string | null;
      price_per_word_atomic: string;
      gateway_fee_bps: number;
      seller_wallet: string | null;
      budget_atomic: string;
      words_paid: number;
      words_delivered: number;
      paid_atomic: string;
      payment_required: unknown | null;
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
      accessMode: row.access_mode,
      conversationId: row.conversation_id ?? undefined,
      goal: row.goal ?? undefined,
      sectionId: row.section_id ?? undefined,
      budget: { currency: "USDC", maxAmountAtomic: row.budget_atomic as `${bigint}` },
      pricePerWordAtomic: BigInt(row.price_per_word_atomic),
      gatewayFeeBps: row.gateway_fee_bps,
      sellerWallet: (row.seller_wallet ?? undefined) as `0x${string}` | undefined,
      metadata: row.metadata ?? {},
      state: row.state,
      wordsPaid: row.words_paid,
      wordsDelivered: row.words_delivered,
      paidAtomic: BigInt(row.paid_atomic),
      paymentRequired: row.payment_required ?? undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      expiresAt: new Date(row.expires_at),
    };
  }

  async saveSession(session: SessionRecord): Promise<void> {
    await this.pool.query(
      `UPDATE stream_sessions SET state=$2, words_paid=$3, words_delivered=$4, paid_atomic=$5,
         conversation_id=$6, metadata=$7, payment_required=$8, updated_at=$9 WHERE id=$1`,
      [
        session.id,
        session.state,
        session.wordsPaid,
        session.wordsDelivered,
        `${session.paidAtomic}`,
        session.conversationId ?? null,
        JSON.stringify(session.metadata),
        session.paymentRequired === undefined ? null : JSON.stringify(session.paymentRequired),
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

  async getBundleByIdempotencyKey(key: string): Promise<RecordBundleResult | null> {
    return this.loadBundleByIdempotencyKey(this.pool, key, true);
  }

  async recordPaidBundle(input: RecordPaidBundleInput): Promise<RecordBundleResult> {
    return this.recordBundle(input);
  }

  async recordFreeBundle(input: RecordFreeBundleInput): Promise<RecordBundleResult> {
    return this.recordBundle(input);
  }

  private async recordBundle(input: RecordPaidBundleInput | RecordFreeBundleInput): Promise<RecordBundleResult> {
    validateBundleInput(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const duplicate = await this.loadBundleByIdempotencyKey(client, input.idempotencyKey, true);
      if (duplicate) {
        await client.query("COMMIT");
        return duplicate;
      }

      const sessionResult = await client.query<{
        words_delivered: number;
        words_paid: number;
        paid_atomic: string;
      }>(
        "SELECT words_delivered, words_paid, paid_atomic FROM stream_sessions WHERE id = $1 FOR UPDATE",
        [input.sessionId],
      );
      const session = sessionResult.rows[0];
      if (!session) throw new Error("session_not_found");
      if (session.words_delivered !== input.startSequence) throw new Error("bundle_session_conflict");

      const wordsCount = input.words.length;
      const endSequence = input.startSequence + wordsCount - 1;
      const grossAmountAtomic = input.accessMode === "paid" ? input.grossAmountAtomic : 0n;
      const creatorAmountAtomic = input.accessMode === "paid" ? input.creatorAmountAtomic : 0n;
      const rubiconFeeAtomic = input.accessMode === "paid" ? input.rubiconFeeAtomic : 0n;
      const paymentStatus = input.accessMode === "free"
        ? "free"
        : input.settlement && hasSettlementEvidence(input.settlement)
          ? input.settlement.status
          : "authorized";
      const now = new Date().toISOString();

      await client.query(
        `INSERT INTO read_bundles
           (id, bundle_id, idempotency_key, session_id, creator_id, article_id, access_mode,
            section_id, bundle_sequence, start_sequence, end_sequence, words_count,
            price_per_word_atomic, gross_amount_atomic, creator_amount_atomic, rubicon_fee_atomic,
            payment_id, authorization_reference, buyer_wallet_address, network, pay_to,
            payment_status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$23)`,
        [
          randomUUID(), input.bundleId, input.idempotencyKey, input.sessionId, input.creatorId,
          input.articleId, input.accessMode, input.sectionId ?? null, input.bundleSequence,
          input.startSequence, endSequence, wordsCount, `${input.pricePerWordAtomic}`,
          `${grossAmountAtomic}`, `${creatorAmountAtomic}`, `${rubiconFeeAtomic}`,
          input.accessMode === "paid" ? input.paymentId : null,
          input.accessMode === "paid" ? input.authorizationReference : null,
          input.accessMode === "paid" ? input.buyerWalletAddress ?? null : null,
          input.accessMode === "paid" ? input.network ?? null : null,
          input.accessMode === "paid" ? input.payTo ?? null : null,
          paymentStatus,
          now,
        ],
      );

      if (input.accessMode === "paid") {
        await client.query(
          `INSERT INTO word_payments
             (id, payment_id, session_id, article_id, creator_id, sequence, amount_atomic,
              creator_amount_atomic, rubicon_fee_atomic, network, pay_to, transaction_hash,
              transaction_hashes, settlement_id, settlement_ids, buyer_wallet_address,
              transfer_id, idempotency_key, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [
            randomUUID(), input.paymentId, input.sessionId, input.articleId, input.creatorId,
            input.startSequence, `${grossAmountAtomic}`, `${creatorAmountAtomic}`, `${rubiconFeeAtomic}`,
            input.network ?? null, input.payTo ?? null,
            input.settlement?.transactionHash ?? null,
            input.settlement?.transactionHashes ? JSON.stringify(input.settlement.transactionHashes) : null,
            input.settlement?.settlementId ?? null,
            input.settlement?.settlementIds ?? null,
            input.buyerWalletAddress ?? null,
            input.settlement?.transferId ?? null,
            input.idempotencyKey,
            now,
          ],
        );
      }

      await client.query(
        `INSERT INTO word_deliveries
           (id, session_id, article_id, sequence, word, price_atomic, payment_id, idempotency_key, bundle_id, created_at)
         SELECT ids.id, $1, $2, seq.sequence, words.word, $3, $4, keys.idempotency_key, $5, $6
         FROM unnest($7::text[]) WITH ORDINALITY AS ids(id, ord)
         JOIN unnest($8::integer[]) WITH ORDINALITY AS seq(sequence, ord) USING (ord)
         JOIN unnest($9::text[]) WITH ORDINALITY AS words(word, ord) USING (ord)
         JOIN unnest($10::text[]) WITH ORDINALITY AS keys(idempotency_key, ord) USING (ord)`,
        [
          input.sessionId,
          input.articleId,
          `${input.pricePerWordAtomic}`,
          input.accessMode === "paid" ? input.paymentId : null,
          input.bundleId,
          now,
          input.words.map(() => randomUUID()),
          input.words.map((word) => word.sequence),
          input.words.map((word) => word.word),
          input.words.map((word) => input.words.length === 1 ? input.idempotencyKey : `${input.idempotencyKey}:${word.sequence}`),
        ],
      );

      const counters = await client.query<{
        words_delivered: number;
        words_paid: number;
        paid_atomic: string;
      }>(
        `UPDATE stream_sessions
         SET words_delivered = words_delivered + $2,
             words_paid = words_paid + $3,
             paid_atomic = (paid_atomic::numeric + $4::numeric)::text,
             metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{bundleSequence}', to_jsonb($5::integer), true),
             updated_at = $6
         WHERE id = $1
         RETURNING words_delivered, words_paid, paid_atomic`,
        [input.sessionId, wordsCount, input.accessMode === "paid" ? wordsCount : 0, `${grossAmountAtomic}`, input.bundleSequence + 1, now],
      );

      const bundle = recordedBundleFromInput(input, paymentStatus, now);
      await insertOutboxEvent(client, readBundleCommittedEvent(bundle));
      if (input.accessMode === "paid" && input.settlement && hasSettlementEvidence(input.settlement)) {
        await this.insertSettlement(client, input.settlement);
      }
      await client.query("COMMIT");
      const updated = counters.rows[0];
      return {
        duplicate: false,
        bundle,
        wordsDelivered: updated?.words_delivered ?? input.startSequence + wordsCount,
        wordsPaid: updated?.words_paid ?? (input.accessMode === "paid" ? session.words_paid + wordsCount : session.words_paid),
        paidAtomic: (updated?.paid_atomic ?? `${BigInt(session.paid_atomic) + grossAmountAtomic}`) as `${bigint}`,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) {
        const existing = await this.getBundleByIdempotencyKey(input.idempotencyKey);
        if (existing) return existing;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async recordSettlementRange(input: RecordSettlementRangeInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const bundles = await client.query<{ bundle_id: string }>(
        `SELECT bundle_id FROM read_bundles
         WHERE session_id = $1 AND start_sequence >= $2 AND end_sequence <= $3
         ORDER BY start_sequence FOR UPDATE`,
        [input.sessionId, input.startSequence, input.endSequence],
      );
      if (bundles.rows.length === 0) throw new Error("settlement_bundle_not_found");
      if (!hasSettlementEvidence(input)) {
        if (input.status === "failed") {
          await client.query(
            "UPDATE read_bundles SET payment_status = 'failed', updated_at = now() WHERE bundle_id = ANY($1::text[])",
            [bundles.rows.map((row) => row.bundle_id)],
          );
        }
        await client.query("COMMIT");
        return;
      }
      await this.insertSettlement(client, { ...input, bundleIds: bundles.rows.map((row) => row.bundle_id) });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertSettlement(client: PoolClient, input: SettlementEvidenceInput): Promise<void> {
    const providerReference = settlementProviderReference(input);
    if (!providerReference || input.bundleIds.length === 0) return;
    const amount = await client.query<{
      gross: string;
      creator: string;
      fee: string;
      creator_id: string;
      article_id: string;
      session_id: string;
    }>(
      `SELECT COALESCE(SUM(gross_amount_atomic),0)::text AS gross,
              COALESCE(SUM(creator_amount_atomic),0)::text AS creator,
              COALESCE(SUM(rubicon_fee_atomic),0)::text AS fee,
              MIN(creator_id) AS creator_id, MIN(article_id) AS article_id, MIN(session_id) AS session_id
       FROM read_bundles WHERE bundle_id = ANY($1::text[])`,
      [input.bundleIds],
    );
    const totals = amount.rows[0];
    if (!totals) return;
    const settlementRecordId = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO settlements
         (id, provider, provider_reference, idempotency_key, status, network, pay_to,
          buyer_wallet_address, transaction_hash, transaction_hashes, settlement_id,
          settlement_ids, transfer_id, gross_amount_atomic, creator_amount_atomic,
          rubicon_fee_atomic, initiated_at, confirmed_at, failed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [
        settlementRecordId, input.provider, providerReference, input.idempotencyKey, input.status,
        input.network ?? null, input.payTo ?? null, input.buyerWalletAddress ?? null,
        input.transactionHash ?? null, input.transactionHashes ?? null,
        input.settlementId ?? null, input.settlementIds ?? null, input.transferId ?? null,
        totals.gross, totals.creator, totals.fee,
        input.initiatedAt ?? new Date().toISOString(), input.confirmedAt ?? null, input.failedAt ?? null,
      ],
    );
    if (inserted.rowCount === 0) return;
    await client.query(
      `INSERT INTO settlement_bundle_links
         (settlement_record_id, bundle_id, allocated_gross_amount_atomic,
          allocated_creator_amount_atomic, allocated_fee_atomic)
       SELECT $1, bundle_id, gross_amount_atomic, creator_amount_atomic, rubicon_fee_atomic
       FROM read_bundles WHERE bundle_id = ANY($2::text[])
       ON CONFLICT DO NOTHING`,
      [settlementRecordId, input.bundleIds],
    );
    await client.query(
      "UPDATE read_bundles SET payment_status = $2, updated_at = now() WHERE bundle_id = ANY($1::text[])",
      [input.bundleIds, input.status],
    );
    await insertOutboxEvent(client, {
      eventId: `settlement:${input.idempotencyKey}:v1`,
      eventVersion: 1,
      eventType: "settlement_changed",
      occurredAt: new Date().toISOString(),
      settlementRecordId,
      bundleIds: input.bundleIds,
      creatorId: totals.creator_id,
      articleId: totals.article_id,
      sessionId: totals.session_id,
      providerReference,
      status: input.status,
      settledCreatorAmountAtomicDelta: input.status === "completed" ? totals.creator : "0",
    });
  }

  private async loadBundleByIdempotencyKey(
    queryable: Pick<Pool, "query"> | Pick<PoolClient, "query">,
    key: string,
    duplicate: boolean,
  ): Promise<RecordBundleResult | null> {
    const result = await queryable.query<BundleRow>(
      "SELECT * FROM read_bundles WHERE idempotency_key = $1",
      [key],
    );
    const row = result.rows[0];
    if (!row) return null;
    const words = await queryable.query<{ sequence: number; word: string }>(
      "SELECT sequence, word FROM word_deliveries WHERE bundle_id = $1 ORDER BY sequence",
      [row.bundle_id],
    );
    const counters = await queryable.query<{ words_delivered: number; words_paid: number; paid_atomic: string }>(
      "SELECT words_delivered, words_paid, paid_atomic FROM stream_sessions WHERE id = $1",
      [row.session_id],
    );
    return {
      duplicate,
      bundle: recordedBundleFromRow(row, words.rows),
      wordsDelivered: counters.rows[0]?.words_delivered ?? row.end_sequence + 1,
      wordsPaid: counters.rows[0]?.words_paid ?? (row.access_mode === "paid" ? row.words_count : 0),
      paidAtomic: (counters.rows[0]?.paid_atomic ?? row.gross_amount_atomic) as `${bigint}`,
    };
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
      settlement_id: string | null;
      settlement_ids: string[] | null;
      buyer_wallet_address: `0x${string}` | null;
      payment_id: string | null;
      transfer_id: string | null;
      created_at: string;
    }>(
      `SELECT d.session_id, d.article_id, d.sequence, d.word, d.price_atomic, d.payment_id, d.created_at,
              p.creator_id, p.creator_amount_atomic, p.rubicon_fee_atomic, p.network, p.pay_to,
              p.transaction_hash, p.transaction_hashes, p.settlement_id, p.settlement_ids,
              p.buyer_wallet_address, p.transfer_id
       FROM word_deliveries d LEFT JOIN word_payments p ON p.payment_id = d.payment_id
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
        paymentId: row.payment_id ?? undefined,
        createdAt: row.created_at,
      },
      payment: row.payment_id ? {
        paymentId: row.payment_id,
        sessionId: row.session_id,
        articleId: row.article_id,
        sequence: row.sequence,
        amountAtomic: row.price_atomic as `${bigint}`,
        creatorAmountAtomic: row.creator_amount_atomic as `${bigint}`,
        rubiconFeeAtomic: row.rubicon_fee_atomic as `${bigint}`,
        network: row.network ?? undefined,
        payTo: row.pay_to ?? undefined,
        transactionHash: row.transaction_hash ?? undefined,
        transactionHashes: row.transaction_hashes ?? (row.transaction_hash ? [row.transaction_hash] : undefined),
        settlementId: row.settlement_id ?? row.transfer_id ?? row.transaction_hash ?? undefined,
        settlementIds: row.settlement_ids ?? (row.settlement_id || row.transfer_id || row.transaction_hash ? [row.settlement_id ?? row.transfer_id ?? row.transaction_hash!] : undefined),
        buyerWalletAddress: row.buyer_wallet_address ?? undefined,
        transferId: row.transfer_id ?? undefined,
        createdAt: row.created_at,
      } : undefined,
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
      settlement_id: string | null;
      settlement_ids: string[] | null;
      buyer_wallet_address: `0x${string}` | null;
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
      transactionHash: row.transaction_hash ?? undefined,
      transactionHashes: row.transaction_hashes ?? (row.transaction_hash ? [row.transaction_hash] : undefined),
      settlementId: row.settlement_id ?? row.transfer_id ?? row.transaction_hash ?? undefined,
      settlementIds: row.settlement_ids ?? (row.settlement_id || row.transfer_id || row.transaction_hash ? [row.settlement_id ?? row.transfer_id ?? row.transaction_hash!] : undefined),
      buyerWalletAddress: row.buyer_wallet_address ?? undefined,
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
      `SELECT MIN(creator_id) AS creator_id, COALESCE(SUM(words_count),0)::text AS words,
              COALESCE(SUM(creator_amount_atomic::numeric),0)::text AS creator_amount,
              COALESCE(SUM(rubicon_fee_atomic::numeric),0)::text AS rubicon_fee
       FROM read_bundles WHERE article_id = $1 AND access_mode = 'paid'`,
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
      `SELECT COALESCE(SUM(words_count),0)::text AS words,
              COALESCE(SUM(creator_amount_atomic::numeric),0)::text AS creator_amount,
              COALESCE(SUM(rubicon_fee_atomic::numeric),0)::text AS rubicon_fee
       FROM read_bundles WHERE creator_id = $1 AND access_mode = 'paid'`,
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

interface BundleRow {
  bundle_id: string;
  idempotency_key: string;
  session_id: string;
  creator_id: string;
  article_id: string;
  access_mode: "paid" | "free";
  section_id: string | null;
  bundle_sequence: number;
  start_sequence: number;
  end_sequence: number;
  words_count: number;
  price_per_word_atomic: string;
  gross_amount_atomic: string;
  creator_amount_atomic: string;
  rubicon_fee_atomic: string;
  payment_id: string | null;
  authorization_reference: string | null;
  buyer_wallet_address: `0x${string}` | null;
  network: string | null;
  pay_to: `0x${string}` | null;
  payment_status: RecordedBundle["paymentStatus"];
  created_at: string;
  updated_at: string;
}

function validateBundleInput(input: RecordPaidBundleInput | RecordFreeBundleInput): void {
  if (input.words.length < 1) throw new Error("empty_bundle");
  if (input.words.some((word, offset) => word.sequence !== input.startSequence + offset)) {
    throw new Error("invalid_bundle_range");
  }
  const gross = input.accessMode === "paid" ? input.grossAmountAtomic : 0n;
  if (gross !== input.pricePerWordAtomic * BigInt(input.words.length)) {
    throw new Error("bundle_amount_mismatch");
  }
  if (input.accessMode === "paid" && (!input.paymentId || !input.authorizationReference)) {
    throw new Error("paid_bundle_missing_authorization");
  }
}

function recordedBundleFromInput(
  input: RecordPaidBundleInput | RecordFreeBundleInput,
  paymentStatus: RecordedBundle["paymentStatus"],
  now: string,
): RecordedBundle {
  const wordsCount = input.words.length;
  return {
    bundleId: input.bundleId,
    idempotencyKey: input.idempotencyKey,
    sessionId: input.sessionId,
    creatorId: input.creatorId,
    articleId: input.articleId,
    accessMode: input.accessMode,
    sectionId: input.sectionId,
    bundleSequence: input.bundleSequence,
    startSequence: input.startSequence,
    endSequence: input.startSequence + wordsCount - 1,
    wordsCount,
    pricePerWordAtomic: `${input.pricePerWordAtomic}`,
    grossAmountAtomic: `${input.accessMode === "paid" ? input.grossAmountAtomic : 0n}`,
    creatorAmountAtomic: `${input.accessMode === "paid" ? input.creatorAmountAtomic : 0n}`,
    rubiconFeeAtomic: `${input.accessMode === "paid" ? input.rubiconFeeAtomic : 0n}`,
    paymentId: input.accessMode === "paid" ? input.paymentId : undefined,
    authorizationReference: input.accessMode === "paid" ? input.authorizationReference : undefined,
    buyerWalletAddress: input.accessMode === "paid" ? input.buyerWalletAddress : undefined,
    network: input.accessMode === "paid" ? input.network : undefined,
    payTo: input.accessMode === "paid" ? input.payTo : undefined,
    paymentStatus,
    words: input.words.map((word) => ({ ...word })),
    createdAt: now,
    updatedAt: now,
  };
}

function recordedBundleFromRow(row: BundleRow, words: Array<{ sequence: number; word: string }>): RecordedBundle {
  return {
    bundleId: row.bundle_id,
    idempotencyKey: row.idempotency_key,
    sessionId: row.session_id,
    creatorId: row.creator_id,
    articleId: row.article_id,
    accessMode: row.access_mode,
    sectionId: row.section_id ?? undefined,
    bundleSequence: row.bundle_sequence,
    startSequence: row.start_sequence,
    endSequence: row.end_sequence,
    wordsCount: row.words_count,
    pricePerWordAtomic: row.price_per_word_atomic as `${bigint}`,
    grossAmountAtomic: row.gross_amount_atomic as `${bigint}`,
    creatorAmountAtomic: row.creator_amount_atomic as `${bigint}`,
    rubiconFeeAtomic: row.rubicon_fee_atomic as `${bigint}`,
    paymentId: row.payment_id ?? undefined,
    authorizationReference: row.authorization_reference ?? undefined,
    buyerWalletAddress: row.buyer_wallet_address ?? undefined,
    network: row.network ?? undefined,
    payTo: row.pay_to ?? undefined,
    paymentStatus: row.payment_status,
    words,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readBundleCommittedEvent(bundle: RecordedBundle): Record<string, unknown> {
  return {
    eventId: `read_bundle:${bundle.bundleId}:v1`,
    eventVersion: 1,
    eventType: "read_bundle_committed",
    occurredAt: bundle.createdAt,
    bundleId: bundle.bundleId,
    creatorId: bundle.creatorId,
    articleId: bundle.articleId,
    sessionId: bundle.sessionId,
    accessMode: bundle.accessMode,
    sectionId: bundle.sectionId,
    startSequence: bundle.startSequence,
    endSequence: bundle.endSequence,
    wordsCount: bundle.wordsCount,
    grossAmountAtomic: bundle.grossAmountAtomic,
    creatorAmountAtomic: bundle.creatorAmountAtomic,
    rubiconFeeAtomic: bundle.rubiconFeeAtomic,
    buyerAgentHash: hashBuyerAgentIdentity(bundle.buyerWalletAddress),
  };
}

async function insertOutboxEvent(client: PoolClient, event: Record<string, unknown>): Promise<void> {
  const eventId = String(event.eventId);
  const eventType = String(event.eventType);
  const eventVersion = Number(event.eventVersion);
  const occurredAt = String(event.occurredAt);
  const aggregateKey = eventType === "read_bundle_committed"
    ? String(event.bundleId)
    : String(event.settlementRecordId);
  await client.query(
    `INSERT INTO analytics_outbox
       (id, event_id, event_type, event_version, aggregate_key, payload, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (event_id) DO NOTHING`,
    [randomUUID(), eventId, eventType, eventVersion, aggregateKey, JSON.stringify(event), occurredAt],
  );
}

function hasSettlementEvidence(input: SettlementEvidenceInput | RecordSettlementRangeInput): boolean {
  return Boolean(
    input.transferId
    || input.settlementId
    || input.settlementIds?.length
    || input.transactionHash
    || input.transactionHashes?.length
  );
}

function settlementProviderReference(input: SettlementEvidenceInput | RecordSettlementRangeInput): string | undefined {
  return input.transferId
    ?? input.settlementId
    ?? input.settlementIds?.[0]
    ?? input.transactionHash
    ?? input.transactionHashes?.[0];
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
