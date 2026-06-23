import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCircleCli } from "./circle.js";

test("falls back to circle-cli when circle binary is missing", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "rubicon-circle-bin-"));
  const script = join(binDir, "circle-cli");
  writeFileSync(script, "#!/bin/sh\necho circle-cli 1.1.2\n");
  chmodSync(script, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = binDir;
  try {
    assert.equal(await runCircleCli("circle", ["--version"]), "circle-cli 1.1.2\n");
  } finally {
    process.env.PATH = originalPath;
  }
});
