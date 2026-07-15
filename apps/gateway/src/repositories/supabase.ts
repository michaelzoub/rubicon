import { createClient } from "@supabase/supabase-js";
import type { WebSocketLikeConstructor } from "@supabase/supabase-js";
import type { ArticleAccessMode, ArticleSection, ArticleState, ArticleSummary, CreatorWallet, SellerAgentConfig } from "@rubicon-caliga/core";
import { PUBLIC_ARTICLE_STATE } from "@rubicon-caliga/core";
import { createRequire } from "node:module";
import { toCaip2Network } from "../chain.js";
import { clampSectionsToWords, tokenizeWords } from "../words.js";
import type { ArticleRecord, PublishedArticleRepository } from "./types.js";

const require = createRequire(import.meta.url);
const WebSocket = require("ws") as WebSocketLikeConstructor;

type SupabaseResult<T> = PromiseLike<{ data: T | null; error: SupabaseQueryError | null }>;

interface SupabaseQueryError {
  message: string;
  code?: string;
  hint?: string;
  details?: string;
}

interface SupabaseFromBuilder<T> {
  select(columns: string): SupabaseQueryBuilder<T>;
}

interface SupabaseQueryBuilder<T> extends SupabaseResult<T[]> {
  eq(column: string, value: unknown): SupabaseQueryBuilder<T>;
  order(column: string, options?: { ascending?: boolean; referencedTable?: string; foreignTable?: string }): SupabaseQueryBuilder<T>;
  limit(count: number): SupabaseQueryBuilder<T>;
}

export interface SupabaseReader {
  from<T = unknown>(table: string): SupabaseFromBuilder<T>;
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<{ data: T | null; error: SupabaseQueryError | null }>;
}

interface CreatorRelation {
  id: string;
  username: string;
}

interface ArticleSectionRow {
  id: string;
  article_id: string;
  section_id: string;
  heading: string;
  level: number;
  word_start: number;
  word_count: number;
  ordinal: number;
}

interface ArticleRow {
  id: string;
  creator_id: string;
  title: string;
  author: string;
  state: ArticleState;
  access_mode: ArticleAccessMode;
  price_per_word_atomic: string;
  max_article_price_atomic: string | null;
  total_words: number;
  revision: number;
  seller_agent_config: SellerAgentConfig | null;
  body?: string;
  created_at: string;
  updated_at: string;
  creator: CreatorRelation | CreatorRelation[] | null;
  sections: ArticleSectionRow[] | null;
}

interface CreatorWalletRow {
  creator_id: string;
  address: string;
  network: string;
  verified: boolean;
}

export class SupabaseRepositoryError extends Error {
  constructor(
    message: string,
    public readonly cause: SupabaseQueryError,
  ) {
    super(message);
    this.name = "SupabaseRepositoryError";
  }
}

export function createSupabaseClientFromEnv(env: NodeJS.ProcessEnv = process.env): SupabaseReader {
  const { url, key } = resolveSupabaseConfigFromEnv(env);

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      transport: WebSocket,
    },
  }) as unknown as SupabaseReader;
}

export function resolveSupabaseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): { url: string; key: string } {
  const url = env.SUPABASE_URL;
  // The gateway is a trusted server-side process and is the only holder of this
  // key, so SUPABASE_SERVICE_ROLE_KEY is accepted (and preferred when set) to
  // read articles directly, bypassing RLS. An anon/publishable key still works
  // when RLS policies grant the anon role access to live articles.
  const key =
    env.SUPABASE_SERVICE_ROLE_KEY ??
    env.SUPABASE_ANON_KEY ??
    env.SUPABASE_PUBLISHABLE_KEY ??
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const missing: string[] = [];
  if (!url) {
    missing.push("SUPABASE_URL");
  }
  if (!key) {
    missing.push("SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY / SUPABASE_PUBLISHABLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY)");
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required Supabase environment variable${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
    );
  }
  if (!url || !key) {
    throw new Error("Missing required Supabase configuration.");
  }
  return { url, key };
}

const ARTICLE_SUMMARY_SELECT = `
  id,
  creator_id,
  title,
  author,
  state,
  access_mode,
  price_per_word_atomic,
  max_article_price_atomic,
  total_words,
  revision,
  seller_agent_config,
  created_at,
  updated_at,
  creator:creators!inner(id, username),
  sections:article_sections(id, article_id, section_id, heading, level, word_start, word_count, ordinal)
`;

const ARTICLE_FULL_SELECT = `
  id,
  creator_id,
  title,
  author,
  state,
  access_mode,
  price_per_word_atomic,
  max_article_price_atomic,
  total_words,
  revision,
  seller_agent_config,
  body,
  created_at,
  updated_at,
  creator:creators!inner(id, username),
  sections:article_sections(id, article_id, section_id, heading, level, word_start, word_count, ordinal)
`;

export class SupabasePublishedArticleRepository implements PublishedArticleRepository {
  constructor(private readonly supabase: SupabaseReader) {}

  async listPublishedArticles(): Promise<ArticleSummary[]> {
    const rows = await this.fetchLiveArticleRows(ARTICLE_SUMMARY_SELECT);
    return rows.map(toArticleSummary);
  }

  async getPublishedArticle(articleId: string): Promise<ArticleRecord | null> {
    const rows = await this.fetchLiveArticleRows(ARTICLE_FULL_SELECT, articleId);
    const row = rows[0];
    return row ? toArticleRecord(row) : null;
  }

  async getArticleSections(articleId: string): Promise<ArticleSection[]> {
    const { data, error } = await this.supabase
      .from<ArticleSectionRow>("article_sections")
      .select("id, article_id, section_id, heading, level, word_start, word_count, ordinal")
      .eq("article_id", articleId)
      .order("word_start", { ascending: true });
    if (error) {
      throw new SupabaseRepositoryError("Supabase section query failed", error);
    }
    return (data ?? []).map(toSection);
  }

  async getCreatorWallet(creatorId: string): Promise<CreatorWallet | null> {
    const { data, error } = await this.supabase
      .from<CreatorWalletRow>("creator_wallets")
      .select("creator_id, address, network, verified")
      .eq("creator_id", creatorId)
      .eq("verified", true)
      .eq("network", "arc-testnet")
      .limit(1);
    if (error) {
      throw new SupabaseRepositoryError("Supabase creator wallet query failed", error);
    }
    const row = data?.[0];
    if (!row) {
      return null;
    }
    return {
      creatorId: row.creator_id,
      address: row.address as `0x${string}`,
      network: toCaip2Network(row.network),
      verified: row.verified,
    };
  }

  async getCreatorBaseWallet(creatorId: string): Promise<CreatorWallet | null> {
    const { data, error } = await this.supabase
      .from<CreatorWalletRow>("creator_wallets")
      .select("creator_id, address, network, verified")
      .eq("creator_id", creatorId)
      .eq("verified", true)
      .eq("network", "eip155:8453")
      .limit(1);
    if (error) {
      throw new SupabaseRepositoryError("Supabase creator Base wallet query failed", error);
    }
    const row = data?.[0];
    if (!row) return null;
    return {
      creatorId: row.creator_id,
      address: row.address as `0x${string}`,
      network: toCaip2Network(row.network),
      verified: row.verified,
    };
  }

  async searchSections(queryEmbedding: number[], matchCount: number): Promise<Array<{ articleId: string; sectionId: string; revision: number; similarity: number }>> {
    const { data, error } = await this.supabase.rpc<Array<{ article_id: string; section_id: string; revision: number; similarity: number }>>(
      "search_article_sections",
      { query_embedding: `[${queryEmbedding.join(",")}]`, match_count: matchCount },
    );
    if (error) {
      throw new SupabaseRepositoryError("Supabase semantic search RPC failed", error);
    }
    return (data ?? []).map((row) => ({
      articleId: row.article_id,
      sectionId: row.section_id,
      revision: row.revision,
      similarity: row.similarity,
    }));
  }

  private async fetchLiveArticleRows(select: string, articleId?: string): Promise<ArticleRow[]> {
    let query = this.supabase
      .from<ArticleRow>("articles")
      .select(select)
      .eq("state", PUBLIC_ARTICLE_STATE)
      .order("word_start", { referencedTable: "article_sections", foreignTable: "article_sections", ascending: true });
    if (articleId) {
      query = query.eq("id", articleId).limit(1);
    }
    const { data, error } = await query;
    if (error) {
      throw new SupabaseRepositoryError("Supabase article query failed", error);
    }
    return data ?? [];
  }
}

function toArticleRecord(row: ArticleRow): ArticleRecord {
  if (row.body === undefined) {
    throw new Error(`Live article ${row.id} is missing body data`);
  }
  const sections = [...(row.sections ?? []).map(toSection)].sort((a, b) => a.wordStart - b.wordStart);
  const creator = Array.isArray(row.creator) ? row.creator[0] : row.creator;
  if (!creator) {
    throw new Error(`Live article ${row.id} is missing creator data`);
  }
  // Single source of truth: the tokenized body is what the gateway slices, so
  // totalWords and section ranges are derived from it rather than the stored
  // `total_words`/section rows, which can drift. See clampSectionsToWords.
  const words = tokenizeWords(row.body);
  return {
    id: row.id,
    creatorId: row.creator_id,
    creatorUsername: creator.username,
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

function toArticleSummary(row: ArticleRow): ArticleSummary {
  const sections = [...(row.sections ?? []).map(toSection)].sort((a, b) => a.wordStart - b.wordStart);
  const creator = Array.isArray(row.creator) ? row.creator[0] : row.creator;
  if (!creator) {
    throw new Error(`Live article ${row.id} is missing creator data`);
  }
  const pricePerWordAtomic = BigInt(row.price_per_word_atomic);
  const maxPrice = row.max_article_price_atomic ? BigInt(row.max_article_price_atomic) : pricePerWordAtomic * BigInt(row.total_words);
  return {
    articleId: row.id,
    creatorId: row.creator_id,
    creatorUsername: creator.username,
    title: row.title,
    author: row.author,
    state: row.state,
    accessMode: row.access_mode,
    totalWords: row.total_words,
    pricePerWordAtomic: `${pricePerWordAtomic}`,
    maxArticlePriceAtomic: `${maxPrice}`,
    sections: sections.map((section) => ({
      sectionId: section.sectionId,
      heading: section.heading,
      level: section.level,
      wordStart: section.wordStart,
      wordCount: section.wordCount,
    })),
  };
}

function toSection(row: ArticleSectionRow): ArticleSection {
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
