import { PangramAuthorshipProvider } from "./pangram.js";
import type { AuthorshipProvider } from "./types.js";

/** Fixed allowlist. Provider URLs are code-owned and never accepted from buyers. */
export function createAuthorshipProviderRegistry(fetcher: typeof fetch = fetch): ReadonlyMap<string, AuthorshipProvider> {
  const pangram = new PangramAuthorshipProvider(fetcher);
  return new Map([[pangram.name, pangram]]);
}
