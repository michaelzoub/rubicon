import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveSelection, SelectionError, type ReadSelection } from "./selection.js";

// article: 10 words [0..9]. sections: intro [0,3), body [3,4), tail [7,3) => [7,10)
const TOTAL = 10;
const SECTIONS = [
  { sectionId: "intro", wordStart: 0, wordCount: 3 },
  { sectionId: "body", wordStart: 3, wordCount: 4 },
  { sectionId: "tail", wordStart: 7, wordCount: 3 },
  { sectionId: "empty", wordStart: 5, wordCount: 0 },
];

test("article mode returns every word index", () => {
  assert.deepEqual(resolveSelection(TOTAL, SECTIONS, { mode: "article" }), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("single section resolves to its contiguous range", () => {
  assert.deepEqual(resolveSelection(TOTAL, SECTIONS, { mode: "sections", sectionIds: ["body"] }), [3, 4, 5, 6]);
});

test("multiple sections union in document order regardless of input order", () => {
  const out = resolveSelection(TOTAL, SECTIONS, { mode: "sections", sectionIds: ["tail", "intro"] });
  assert.deepEqual(out, [0, 1, 2, 7, 8, 9]);
});

test("overlapping / adjacent sections are de-duplicated", () => {
  // intro [0,3) + body [3,7) are adjacent and must not double-count word 3.
  const out = resolveSelection(TOTAL, SECTIONS, { mode: "sections", sectionIds: ["intro", "body"] });
  assert.deepEqual(out, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(out).size, out.length);
});

test("word range is offset + count [n, n+k)", () => {
  assert.deepEqual(resolveSelection(TOTAL, SECTIONS, { mode: "words", wordStart: 4, wordCount: 3 }), [4, 5, 6]);
});

test("word range clamps to article length", () => {
  assert.deepEqual(resolveSelection(TOTAL, SECTIONS, { mode: "words", wordStart: 8, wordCount: 100 }), [8, 9]);
});

test("unknown section throws section_not_found", () => {
  assert.throws(
    () => resolveSelection(TOTAL, SECTIONS, { mode: "sections", sectionIds: ["nope"] }),
    (e: unknown) => e instanceof SelectionError && e.code === "section_not_found",
  );
});

test("empty section list throws no_sections", () => {
  assert.throws(
    () => resolveSelection(TOTAL, SECTIONS, { mode: "sections", sectionIds: [] }),
    (e: unknown) => e instanceof SelectionError && e.code === "no_sections",
  );
});

test("negative offset or zero count throws invalid_range", () => {
  for (const bad of [{ wordStart: -1, wordCount: 3 }, { wordStart: 0, wordCount: 0 }] as const) {
    assert.throws(
      () => resolveSelection(TOTAL, SECTIONS, { mode: "words", ...bad }),
      (e: unknown) => e instanceof SelectionError && e.code === "invalid_range",
    );
  }
});

test("range beyond article end resolves to empty and throws empty_selection", () => {
  assert.throws(
    () => resolveSelection(TOTAL, SECTIONS, { mode: "words", wordStart: 50, wordCount: 3 }),
    (e: unknown) => e instanceof SelectionError && e.code === "empty_selection",
  );
});

test("a zero-word section alone resolves to empty_selection", () => {
  assert.throws(
    () => resolveSelection(TOTAL, SECTIONS, { mode: "sections", sectionIds: ["empty"] }),
    (e: unknown) => e instanceof SelectionError && e.code === "empty_selection",
  );
});

test("full-article sectionId in sections mode expands to the whole article", () => {
  const out = resolveSelection(TOTAL, SECTIONS, { mode: "sections", sectionIds: ["full-article"] });
  assert.equal(out.length, TOTAL);
});

// Type-level: ReadSelection is a discriminated union usable by callers.
test("ReadSelection discriminates on mode", () => {
  const selections: ReadSelection[] = [
    { mode: "article" },
    { mode: "sections", sectionIds: ["intro"] },
    { mode: "words", wordStart: 0, wordCount: 1 },
  ];
  assert.equal(selections.length, 3);
});
