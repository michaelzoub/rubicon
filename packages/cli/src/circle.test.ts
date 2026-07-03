import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCircleInvocation,
  circleAuthStatus,
  circleCommandDiagnostics,
  circleGuidance,
  circleLoginComplete,
  circleLoginInit,
  classifyCircleError,
  redactCircleArgs,
  redactSecrets,
  runCircleCli,
} from "./circle.js";

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

test("falls back to npx when neither circle nor circle-cli is on PATH", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "rubicon-circle-npx-"));
  const script = join(binDir, "npx");
  writeFileSync(script, "#!/bin/sh\necho \"npx $@\"\n");
  chmodSync(script, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = binDir;
  try {
    assert.equal(
      await runCircleCli("circle", ["--version"]),
      "npx -y --package @circle-fin/cli circle --version\n",
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("npx fallback is disabled with RUBICON_NO_NPX_FALLBACK=1", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "rubicon-circle-nonpx-"));
  const script = join(binDir, "npx");
  writeFileSync(script, "#!/bin/sh\necho unreachable\n");
  chmodSync(script, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = binDir;
  process.env.RUBICON_NO_NPX_FALLBACK = "1";
  try {
    await assert.rejects(
      () => runCircleCli("circle", ["--version"]),
      (error) => circleGuidance(error)?.code === "missing_cli",
    );
  } finally {
    process.env.PATH = originalPath;
    delete process.env.RUBICON_NO_NPX_FALLBACK;
  }
});

test("buildCircleInvocation routes bare commands through cmd.exe on win32", () => {
  const invocation = buildCircleInvocation("circle", ["wallet", "sign", 'typed-data {"a":"b"}'], "win32");
  assert.equal(invocation.file, "cmd.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(invocation.args[3]!, /^"circle \^"wallet\^" \^"sign\^" /);
  assert.equal(invocation.options.windowsVerbatimArguments, true);

  const posix = buildCircleInvocation("circle", ["--version"], "linux");
  assert.deepEqual({ file: posix.file, args: posix.args }, { file: "circle", args: ["--version"] });

  const explicitPath = buildCircleInvocation("C:\\tools\\circle.cmd", ["--version"], "win32");
  assert.equal(explicitPath.file, "C:\\tools\\circle.cmd");
});

test("circleAuthStatus adds --testnet only for testnet sessions", async () => {
  const calls: string[][] = [];
  const runner = async (_command: string, args: string[]) => {
    calls.push(args);
    return "{}";
  };

  await circleAuthStatus({ runner, testnet: true });
  await circleAuthStatus({ runner });

  assert.deepEqual(calls[0], ["wallet", "status", "--type", "agent", "--testnet", "--output", "json"]);
  assert.deepEqual(calls[1], ["wallet", "status", "--type", "agent", "--output", "json"]);
});

test("runCircleCli preserves exit code, stdout, and stderr diagnostics", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "rubicon-circle-diag-"));
  const script = join(binDir, "circle");
  writeFileSync(script, "#!/bin/sh\necho out-line\necho err-line >&2\nexit 7\n");
  chmodSync(script, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = binDir;
  try {
    await assert.rejects(
      () => runCircleCli("circle", ["wallet", "status"]),
      (error) => {
        const diagnostics = circleCommandDiagnostics(error);
        assert.ok(diagnostics);
        assert.equal(diagnostics.command, "circle");
        assert.deepEqual(diagnostics.args, ["wallet", "status"]);
        assert.equal(diagnostics.exitCode, 7);
        assert.match(diagnostics.stdout, /out-line/);
        assert.match(diagnostics.stderr, /err-line/);
        return true;
      },
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("classifyCircleError redacts OTPs and secrets from diagnostics and message", () => {
  const error = Object.assign(new Error("circle command exited 2"), {
    code: 2,
    stdout: '{"otp":"123456"}',
    stderr: "upstream 503; apiKey=sk-live-abc",
    circleInvocation: { command: "circle", args: ["wallet", "login", "--otp", "123456", "--request", "req_1"] },
  });
  const classified = classifyCircleError(error);
  const diagnostics = circleCommandDiagnostics(classified);
  assert.ok(diagnostics);
  assert.equal(diagnostics.command, "circle");
  assert.deepEqual(diagnostics.args, ["wallet", "login", "--otp", "[REDACTED]", "--request", "req_1"]);
  assert.equal(diagnostics.exitCode, 2);
  assert.ok(!diagnostics.stdout.includes("123456"));
  assert.ok(!diagnostics.stderr.includes("sk-live-abc"));
  assert.ok(!classified.message.includes("123456"));
  assert.ok(!classified.message.includes("sk-live-abc"));
});

test("redaction helpers scrub secret flags and key-value secrets", () => {
  assert.deepEqual(redactCircleArgs(["--otp", "000111", "--otp=222333", "--chain", "ARC-TESTNET"]), [
    "--otp",
    "[REDACTED]",
    "--otp=[REDACTED]",
    "--chain",
    "ARC-TESTNET",
  ]);
  const text = redactSecrets('authorization: Bearer abc.def token="xyz" balance=12');
  assert.ok(!text.includes("abc.def"));
  assert.ok(!text.includes("xyz"));
  assert.ok(text.includes("balance=12"));
});

test("classifies Circle terms acceptance errors", () => {
  const error = classifyCircleError(new Error("You must accept the Circle Developer Terms before using this command"));
  assert.equal(circleGuidance(error)?.code, "terms_not_accepted");
  assert.match(circleGuidance(error)?.guidance ?? "", /circle terms accept/);
});

test("not_logged_in guidance points to rubicon login", () => {
  const error = classifyCircleError(new Error("unauthorized: please login"));
  assert.equal(circleGuidance(error)?.code, "not_logged_in");
  assert.match(circleGuidance(error)?.guidance ?? "", /rubicon login <email>/);
});

test("circleLoginInit and circleLoginComplete build Circle 0.0.6-compatible commands", async () => {
  const calls: string[][] = [];
  const runner = async (_command: string, args: string[]) => {
    calls.push(args);
    return JSON.stringify({ data: { requestId: "req_123" } });
  };

  const init = await circleLoginInit({ email: "buyer@example.com", testnet: true, runner });
  assert.equal(init.requestId, "req_123");
  assert.deepEqual(calls[0], ["wallet", "login", "buyer@example.com", "--type", "agent", "--testnet", "--init"]);

  await circleLoginComplete({ requestId: "req_123", otp: "000000", testnet: true, runner });
  assert.deepEqual(calls[1], ["wallet", "login", "--type", "agent", "--testnet", "--request", "req_123", "--otp", "000000"]);

  await circleLoginComplete({ requestId: "req_123", otp: "000000", testnet: false, runner });
  assert.deepEqual(calls[2], ["wallet", "login", "--type", "agent", "--request", "req_123", "--otp", "000000"]);
});
