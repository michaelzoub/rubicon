import { test } from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "./args.js";
import { parseSelectionFlags, explicitSelectionModeCount } from "./read-selection.js";
import { CliError } from "./errors.js";

function flagsFor(argv: string[]) {
  return parseSelectionFlags(parseArgs(["read", "article_1", ...argv]));
}

test("no selection flags returns all-undefined / whole=false", () => {
  const f = flagsFor([]);
  assert.deepEqual(f, { sectionIds: undefined, wordStart: undefined, wordCount: undefined, whole: false });
  assert.equal(explicitSelectionModeCount(f), 0);
});

test("--whole sets whole=true", () => {
  const f = flagsFor(["--whole"]);
  assert.equal(f.whole, true);
  assert.equal(explicitSelectionModeCount(f), 1);
});

test("--sections splits and trims into an id list", () => {
  const f = flagsFor(["--sections", "summary, how-sessions-work ,conclusion"]);
  assert.deepEqual(f.sectionIds, ["summary", "how-sessions-work", "conclusion"]);
  assert.equal(explicitSelectionModeCount(f), 1);
});

test("--words parses <start>:<count>", () => {
  const f = flagsFor(["--words", "40:29"]);
  assert.equal(f.wordStart, 40);
  assert.equal(f.wordCount, 29);
  assert.equal(explicitSelectionModeCount(f), 1);
});

test("--words rejects non start:count formats", () => {
  for (const bad of ["40", "40-68", "a:b", "40:", ":5", "40:0"]) {
    assert.throws(
      () => flagsFor(["--words", bad]),
      (e: unknown) => e instanceof CliError && e.code === "INVALID_WORDS",
      `expected ${bad} to be rejected`,
    );
  }
});

test("empty --sections value is rejected", () => {
  assert.throws(
    () => flagsFor(["--sections", " , "]),
    (e: unknown) => e instanceof CliError && e.code === "INVALID_SECTIONS",
  );
});

test("combining modes is detectable via explicitSelectionModeCount", () => {
  const f = flagsFor(["--whole", "--words", "0:5"]);
  assert.equal(explicitSelectionModeCount(f), 2);
});
