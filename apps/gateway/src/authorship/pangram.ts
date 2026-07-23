import type { AuthorshipMetrics } from "@rubicon-caliga/core";
import { AuthorshipProviderError, type AuthorshipProvider } from "./types.js";

export const PANGRAM_API_URL = "https://text.api.pangram.com/v3";
export const PANGRAM_TIMEOUT_MS = 15_000;
export const PANGRAM_MAX_TEXT_CHARS = 75_000;

type PangramResponse = Record<string, unknown>;

export class PangramAuthorshipProvider implements AuthorshipProvider {
  readonly name = "pangram" as const;

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async analyze(input: { text: string; apiKey: string }): Promise<AuthorshipMetrics> {
    if (!input.text || input.text.length > PANGRAM_MAX_TEXT_CHARS) {
      throw new AuthorshipProviderError("unavailable");
    }
    let response: Response;
    try {
      response = await this.fetcher(PANGRAM_API_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": input.apiKey },
        body: JSON.stringify({ text: input.text, public_dashboard_link: false }),
        signal: AbortSignal.timeout(PANGRAM_TIMEOUT_MS),
      });
    } catch {
      throw new AuthorshipProviderError("unavailable");
    }
    if (!response.ok) {
      // Never read or propagate the provider body: it may echo text or links.
      throw new AuthorshipProviderError(response.status === 401 || response.status === 429 || response.status >= 500 ? "unavailable" : "error");
    }
    let raw: PangramResponse;
    try {
      raw = await response.json() as PangramResponse;
    } catch {
      throw new AuthorshipProviderError("error");
    }
    return sanitize(raw);
  }
}

function sanitize(raw: PangramResponse): AuthorshipMetrics {
  return {
    humanWritten: fraction(raw.fraction_human),
    aiGenerated: fraction(raw.fraction_ai),
    aiAssisted: fraction(raw.fraction_ai_assisted),
    humanSegments: count(raw.num_human_segments),
    aiGeneratedSegments: count(raw.num_ai_segments),
    aiAssistedSegments: count(raw.num_ai_assisted_segments),
  };
}

function fraction(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new AuthorshipProviderError("error");
  }
  return value;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AuthorshipProviderError("error");
  }
  return value;
}
