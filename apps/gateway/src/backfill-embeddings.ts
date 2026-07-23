import { createClient } from "@supabase/supabase-js";
import { loadGatewayEnvironment } from "./config.js";
import { createHash } from "node:crypto";
import {
  createSupabaseClientFromEnv,
  resolveSupabaseConfigFromEnv,
  SupabasePublishedArticleRepository,
} from "./repositories/supabase.js";

/**
 * Populate `article_section_embeddings` for every live article. This is the
 * write side of the semantic-search contract in docs/embeddings-contract.md,
 * which rubicon-marketing is nominally responsible for but which was never
 * implemented — so the table sits empty and /v1/search always falls back to
 * lexical scoring. Run this to backfill (and re-run any time to refresh):
 *
 *   pnpm --filter @rubicon-caliga/gateway backfill:embeddings
 *   pnpm --filter @rubicon-caliga/gateway backfill:embeddings -- --dry-run
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (RLS grants anon SELECT only,
 * so writes need the service role), and OPENROUTER_API_KEY.
 *
 * Idempotent: each section's embedded input is hashed (sha256) into
 * `content_hash`; unchanged sections skip the OpenRouter call entirely. Sections
 * that no longer exist on a live article have their embedding rows deleted so
 * stale hits never surface.
 */

const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
/** OpenRouter accepts array input; keep batches modest to stay within token limits. */
const EMBED_BATCH_SIZE = 64;

const DRY_RUN = process.argv.includes("--dry-run");

interface SectionWork {
  sectionId: string;
  contentHash: string;
  input: string;
}

/** sha256 of the exact text that gets embedded, per the contract. */
function hashInput(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Raised when OpenRouter rejects an input for exceeding the 8192-token limit. */
class InputTooLongError extends Error {}

/** One raw call to the embeddings API for a batch of strings, in order. */
async function callEmbeddings(apiKey: string, inputs: string[]): Promise<number[][]> {
  const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "https://rubicon.caliga.ai",
      "X-Title": process.env.OPENROUTER_APP_NAME ?? "Rubicon",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: inputs }),
  });
  if (!response.ok) {
    const text = await response.text();
    if (response.status === 400 && /maximum input length/i.test(text)) {
      throw new InputTooLongError(text);
    }
    throw new Error(`OpenRouter embeddings failed: ${response.status} ${text}`);
  }
  const body = (await response.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
  const data = body.data ?? [];
  if (data.length !== inputs.length) {
    throw new Error(`OpenRouter returned ${data.length} embeddings for ${inputs.length} inputs`);
  }
  // Reorder defensively by `index` — the API returns in-order, but do not assume.
  const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return ordered.map((row) => {
    const embedding = row.embedding ?? [];
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Embedding has ${embedding.length} dims, expected ${EMBEDDING_DIMENSIONS}`);
    }
    return embedding;
  });
}

/**
 * Embed a single oversized input by halving its characters until it fits under
 * the 8192-token limit. Token density varies wildly (CJK/code can be >1
 * token/char), so we probe by retrying rather than guessing a fixed cap.
 */
async function embedTruncated(apiKey: string, input: string): Promise<number[]> {
  let text = input;
  while (text.length > 0) {
    try {
      const [embedding] = await callEmbeddings(apiKey, [text]);
      return embedding!;
    } catch (error) {
      if (!(error instanceof InputTooLongError)) throw error;
      text = text.slice(0, Math.floor(text.length / 2));
    }
  }
  throw new Error("Unable to embed input even after truncation to empty.");
}

/**
 * Embed a batch, returning vectors in order. On a length rejection, recursively
 * split the batch to isolate the oversized input, then truncate just that one —
 * so one long section never fails the whole run or penalizes its neighbours.
 */
async function embedBatch(apiKey: string, inputs: string[]): Promise<number[][]> {
  try {
    return await callEmbeddings(apiKey, inputs);
  } catch (error) {
    if (!(error instanceof InputTooLongError)) throw error;
    if (inputs.length === 1) {
      return [await embedTruncated(apiKey, inputs[0]!)];
    }
    const mid = Math.floor(inputs.length / 2);
    const left = await embedBatch(apiKey, inputs.slice(0, mid));
    const right = await embedBatch(apiKey, inputs.slice(mid));
    return [...left, ...right];
  }
}

/** pgvector literal: "[v1,v2,...]". PostgREST accepts this string for a vector column. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

async function main(): Promise<void> {
  const { env } = loadGatewayEnvironment();
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set — cannot compute embeddings.");
  }

  const { url } = resolveSupabaseConfigFromEnv(env);
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set — writes to article_section_embeddings require the service role (anon has SELECT only).",
    );
  }

  // Reads reuse the exact same repository the gateway serves from, so word
  // slicing and section clamping are identical to what search compares against.
  const repo = new SupabasePublishedArticleRepository(createSupabaseClientFromEnv(env));
  // Writes use a full client (the read-only SupabaseReader type has no upsert).
  const db = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const summaries = await repo.listPublishedArticles();
  console.log(`[backfill] ${summaries.length} live article(s)${DRY_RUN ? " (dry run)" : ""}`);

  let embedded = 0;
  let skipped = 0;
  let deleted = 0;

  for (const summary of summaries) {
    const record = await repo.getPublishedArticle(summary.articleId);
    if (!record) {
      console.warn(`[backfill] ${summary.articleId}: no full record, skipping`);
      continue;
    }

    // Existing hashes so unchanged sections skip the OpenRouter call.
    const { data: existingRows, error: existingError } = await db
      .from("article_section_embeddings")
      .select("section_id, content_hash")
      .eq("article_id", record.id);
    if (existingError) {
      throw new Error(`Failed to read existing embeddings for ${record.id}: ${existingError.message}`);
    }
    const existingHashes = new Map<string, string>(
      (existingRows ?? []).map((row) => [row.section_id as string, row.content_hash as string]),
    );

    const currentSectionIds = new Set(record.sections.map((section) => section.sectionId));
    const pending: SectionWork[] = [];

    for (const section of record.sections) {
      const bodyText = record.words
        .slice(section.wordStart, section.wordStart + section.wordCount)
        .join(" ");
      const input = `${record.title}\n${section.heading}\n${bodyText}`;
      const contentHash = hashInput(input);
      if (existingHashes.get(section.sectionId) === contentHash) {
        skipped += 1;
        continue;
      }
      pending.push({ sectionId: section.sectionId, contentHash, input });
    }

    // Embed changed sections in batches and upsert.
    for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
      const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
      if (DRY_RUN) {
        embedded += batch.length;
        continue;
      }
      const vectors = await embedBatch(apiKey, batch.map((work) => work.input));
      const rows = batch.map((work, index) => ({
        article_id: record.id,
        section_id: work.sectionId,
        revision: record.revision,
        embedding: toVectorLiteral(vectors[index]!),
        content_hash: work.contentHash,
        model: EMBEDDING_MODEL,
        updated_at: new Date().toISOString(),
      }));
      const { error: upsertError } = await db
        .from("article_section_embeddings")
        .upsert(rows, { onConflict: "article_id,section_id" });
      if (upsertError) {
        throw new Error(`Upsert failed for ${record.id}: ${upsertError.message}`);
      }
      embedded += rows.length;
    }

    // Delete embedding rows for sections that no longer exist on the live article.
    const staleSectionIds = [...existingHashes.keys()].filter((id) => !currentSectionIds.has(id));
    if (staleSectionIds.length > 0 && !DRY_RUN) {
      const { error: deleteError } = await db
        .from("article_section_embeddings")
        .delete()
        .eq("article_id", record.id)
        .in("section_id", staleSectionIds);
      if (deleteError) {
        throw new Error(`Stale delete failed for ${record.id}: ${deleteError.message}`);
      }
    }
    deleted += staleSectionIds.length;

    console.log(
      `[backfill] ${record.id} rev${record.revision}: ${pending.length} embedded, ${record.sections.length - pending.length} unchanged, ${staleSectionIds.length} stale`,
    );
  }

  console.log(
    `[backfill] done — ${embedded} section(s) embedded, ${skipped} unchanged, ${deleted} stale removed${DRY_RUN ? " (dry run, no writes)" : ""}`,
  );
}

main().catch((error) => {
  console.error("[backfill] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
