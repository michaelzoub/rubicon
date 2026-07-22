import { test } from "node:test";
import assert from "node:assert/strict";
import { PangramAuthorshipProvider, PANGRAM_API_URL } from "./pangram.js";
import { AuthorshipProviderError } from "./types.js";

test("Pangram adapter sends only the fixed endpoint/key/text and strictly sanitizes output", async () => {
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), PANGRAM_API_URL);
    assert.equal(new Headers(init?.headers).get("x-api-key"), "secret-key");
    assert.deepEqual(JSON.parse(String(init?.body)), { text: "private body", public_dashboard_link: false });
    return new Response(JSON.stringify({
      text: "private body", dashboard_link: "https://forbidden", windows: [{ text: "private" }],
      fraction_human: 0.7, fraction_ai: 0.2, fraction_ai_assisted: 0.1,
      num_human_segments: 7, num_ai_segments: 2, num_ai_assisted_segments: 1,
    }), { status: 200 });
  }) as typeof fetch;
  const result = await new PangramAuthorshipProvider(fetcher).analyze({ text: "private body", apiKey: "secret-key" });
  assert.deepEqual(result, {
    humanWritten: 0.7, aiGenerated: 0.2, aiAssisted: 0.1,
    humanSegments: 7, aiGeneratedSegments: 2, aiAssistedSegments: 1,
  });
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes("forbidden"), false);
});

test("Pangram adapter never exposes an invalid raw response", async () => {
  const provider = new PangramAuthorshipProvider((async () => new Response(
    JSON.stringify({ text: "private excerpt", fraction_human: "bad" }), { status: 200 },
  )) as unknown as typeof fetch);
  await assert.rejects(provider.analyze({ text: "body", apiKey: "key" }), (error) =>
    error instanceof AuthorshipProviderError && error.message === "authorship_provider_error");
});
