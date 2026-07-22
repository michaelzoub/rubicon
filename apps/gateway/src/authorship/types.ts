import type { AuthorshipMetrics, AuthorshipProviderName } from "@rubicon-caliga/core";

export interface AuthorshipProvider {
  readonly name: AuthorshipProviderName;
  analyze(input: { text: string; apiKey: string }): Promise<AuthorshipMetrics>;
}

export class AuthorshipProviderError extends Error {
  constructor(readonly kind: "unavailable" | "error") {
    super(`authorship_provider_${kind}`);
    this.name = "AuthorshipProviderError";
  }
}
