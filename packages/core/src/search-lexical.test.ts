import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArticleSummary } from "./protocol.js";
import { lexicalConfidence, lexicalSearch, lexicalSectionConfidence, meaningfulTerms } from "./search-lexical.js";

function article(overrides: Partial<ArticleSummary> = {}): ArticleSummary {
  return {
    articleId: "art-1",
    creatorId: "creator-1",
    creatorUsername: "creator",
    title: "Field Guide to Metered Reading",
    author: "Ada",
    state: "live",
    accessMode: "paid",
    totalWords: 100,
    pricePerWordAtomic: "1",
    maxArticlePriceAtomic: "100",
    sections: [
      { sectionId: "summary", heading: "Summary", level: 1, wordStart: 0, wordCount: 20 },
      { sectionId: "sessions", heading: "How sessions work", level: 1, wordStart: 20, wordCount: 40 },
      { sectionId: "conclusion", heading: "Conclusion", level: 1, wordStart: 60, wordCount: 40 },
    ],
    ...overrides,
  };
}

test("meaningfulTerms strips stopwords and short tokens", () => {
  assert.deepEqual(
    meaningfulTerms("explain the how and what for metered reading sessions"),
    ["metered", "reading", "sessions"],
  );
  assert.deepEqual(meaningfulTerms("the and for"), []);
  assert.deepEqual(meaningfulTerms(""), []);
});

test("lexicalConfidence returns matched/total normalized 0..1", () => {
  // "metered" and "reading" both appear in the title.
  assert.equal(lexicalConfidence(article(), "metered reading"), 1);
  // Only "metered" appears; "quantum" does not.
  const score = lexicalConfidence(article(), "metered quantum");
  assert.ok(score > 0 && score < 1);
  assert.equal(score, 0.5);
  // No terms match.
  assert.equal(lexicalConfidence(article(), "quantum chromodynamics"), 0);
  // No meaningful terms.
  assert.equal(lexicalConfidence(article(), "the and for"), 0);
});

test("lexicalSectionConfidence scores per section heading + title", () => {
  const art = article();
  const sessions = art.sections.find((s) => s.sectionId === "sessions")!;
  assert.equal(lexicalSectionConfidence(art, sessions, "sessions work"), 1);
  assert.equal(lexicalSectionConfidence(art, sessions, "sessions quantum"), 0.5);
  assert.equal(lexicalSectionConfidence(art, sessions, "quantum"), 0);
});

test("lexicalSearch ranks articles by confidence and drops zero-score results", () => {
  const matching = article();
  const unrelated = article({
    articleId: "art-2",
    title: "Quantum Chromodynamics Primer",
    sections: [{ sectionId: "intro", heading: "Introduction", level: 1, wordStart: 0, wordCount: 100 }],
  });
  const results = lexicalSearch([unrelated, matching], "metered reading", 10);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.article.articleId, "art-1");
  assert.ok(results[0]!.score > 0);
  assert.ok(results[0]!.matchedSections.length > 0);
});

test("lexicalSearch respects limit", () => {
  const a = article({ articleId: "a" });
  const b = article({ articleId: "b" });
  const results = lexicalSearch([a, b], "metered reading", 1);
  assert.equal(results.length, 1);
});

test("lexicalSearch returns empty for an unmatched query", () => {
  const results = lexicalSearch([article()], "quantum chromodynamics", 10);
  assert.equal(results.length, 0);
});
