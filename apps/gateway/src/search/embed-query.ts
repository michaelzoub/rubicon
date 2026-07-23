/**
 * Query embedding helper for semantic search. Uses OpenRouter's OpenAI-compatible
 * embeddings API. When the key is unset (demo /
 * in-memory mode), returns null so the search service falls back to lexical
 * scoring without ever blocking the request.
 *
 * The embedding model is pinned to text-embedding-3-small (1536 dimensions) to
 * match the pgvector column. See docs/embeddings-contract.md.
 */

const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const CACHE_CAP = 200;

/** Returns a function that embeds a query string into a 1536-dim vector, or null when OpenRouter is not configured. */
export function createQueryEmbedder(env: NodeJS.ProcessEnv = process.env): ((q: string) => Promise<number[] | null>) | null {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  // In-process LRU-ish cache: cap at CACHE_CAP entries, evict oldest on overflow.
  const cache = new Map<string, number[]>();

  return async (query: string): Promise<number[] | null> => {
    const cached = cache.get(query);
    if (cached) return cached;

    let embedding: number[];
    try {
      const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "HTTP-Referer": env.OPENROUTER_SITE_URL ?? "https://rubicon.caliga.ai",
          "X-Title": env.OPENROUTER_APP_NAME ?? "Rubicon",
        },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: query }),
      });
      if (!response.ok) {
        console.error(`[gateway] query embedding failed: ${response.status} ${await response.text()}`);
        return null;
      }
      const body = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
      embedding = body.data?.[0]?.embedding ?? [];
    } catch (error) {
      console.error("[gateway] query embedding request failed", error);
      return null;
    }

    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      console.error(`[gateway] query embedding returned ${embedding.length} dims, expected ${EMBEDDING_DIMENSIONS}`);
      return null;
    }

    if (cache.size >= CACHE_CAP) {
      // Evict the oldest entry (Map preserves insertion order).
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(query, embedding);
    return embedding;
  };
}
