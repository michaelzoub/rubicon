import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCircleInvocation,
  circleAuthStatus,
  circleCommandDiagnostics,
  circleGatewayBalance,
  circleGuidance,
  circleLoginComplete,
  circleLoginInit,
  classifyCircleError,
  redactCircleArgs,
  redactSecrets,
  runCircleCli,
} from "./circle.js";

const BUYER_WALLET = "0xb161c2306a4f58ca41c4c0b10544d953c8af26b7";
const BACKING_EOA = "0x92cb35294b2e8df793039a49bc94a476350477ed";

// Exact Circle CLI 0.0.6 `gateway balance --output json` shape observed on Arc
// Testnet for the funded buyer wallet. The balance decimal has full six-digit
// precision while the aggregate `total` is trimmed.
function arcGatewayBalanceOutput(overrides: { total?: string; balance?: string; address?: string } = {}): string {
  return JSON.stringify({
    data: {
      message: `Gateway balance: ${overrides.total ?? "1.1382"} USDC`,
      address: overrides.address ?? BUYER_WALLET,
      backingEOA: BACKING_EOA,
      total: overrides.total ?? "1.1382",
      token: "USDC",
      balances: [{ network: "Arc Testnet", domain: 26, balance: overrides.balance ?? "1.138200" }],
    },
  });
}

test("circleGatewayBalance recognizes a funded Arc Testnet balance as atomic units", async () => {
  const runner = async () => arcGatewayBalanceOutput();
  const info = await circleGatewayBalance({ runner, chain: "ARC-TESTNET", address: BUYER_WALLET });
  assert.equal(info.balanceAtomic, "1138200");
  assert.equal(info.backingEOA, BACKING_EOA);
  assert.equal(info.reportedAddress, BUYER_WALLET);
});

test("circleGatewayBalance converts the trimmed aggregate total when balances are absent", async () => {
  const runner = async () => JSON.stringify({ data: { total: "1.1382", backingEOA: BACKING_EOA, address: BUYER_WALLET } });
  const info = await circleGatewayBalance({ runner, chain: "ARC-TESTNET", address: BUYER_WALLET });
  assert.equal(info.balanceAtomic, "1138200");
});

test("circleGatewayBalance reports zero for an empty Gateway balance", async () => {
  const runner = async () => arcGatewayBalanceOutput({ total: "0", balance: "0.000000" });
  const info = await circleGatewayBalance({ runner, chain: "ARC-TESTNET", address: BUYER_WALLET });
  assert.equal(info.balanceAtomic, "0");
  assert.equal(info.backingEOA, BACKING_EOA);
});

test("circleGatewayBalance tolerates malformed/missing balance fields", async () => {
  const cases = ["{}", JSON.stringify({ data: {} }), JSON.stringify({ data: { total: "not-a-number" } }), "garbage-not-json"];
  for (const output of cases) {
    const info = await circleGatewayBalance({ runner: async () => output, chain: "ARC-TESTNET", address: BUYER_WALLET });
    assert.equal(info.balanceAtomic, "0");
  }
});

test("circleGatewayBalance keeps the backing EOA distinct from the queried wallet address", async () => {
  const runner = async () => arcGatewayBalanceOutput();
  const info = await circleGatewayBalance({ runner, chain: "ARC-TESTNET", address: BUYER_WALLET });
  assert.notEqual(info.reportedAddress?.toLowerCase(), info.backingEOA?.toLowerCase());
  assert.equal(info.reportedAddress, BUYER_WALLET);
  assert.equal(info.backingEOA, BACKING_EOA);
});

test("circleGatewayBalance surfaces a different-profile depositor address for mismatch detection", async () => {
  const otherAddress = "0x00000000000000000000000000000000000000ff";
  const runner = async () => arcGatewayBalanceOutput({ address: otherAddress });
  const info = await circleGatewayBalance({ runner, chain: "ARC-TESTNET", address: BUYER_WALLET });
  assert.equal(info.reportedAddress, otherAddress);
});

test("circleGatewayBalance selects the requested chain out of multiple funded domains", async () => {
  const runner = async () =>
    JSON.stringify({
      data: {
        total: "3.500000",
        address: BUYER_WALLET,
        backingEOA: BACKING_EOA,
        balances: [
          { network: "Base Sepolia", domain: 6, balance: "2.361800" },
          { network: "Arc Testnet", domain: 26, balance: "1.138200" },
        ],
      },
    });
  const info = await circleGatewayBalance({ runner, chain: "ARC-TESTNET", address: BUYER_WALLET });
  assert.equal(info.balanceAtomic, "1138200");
});

test("circleGatewayBalance decimal-to-atomic truncates beyond six fraction digits", async () => {
  const runner = async () => arcGatewayBalanceOutput({ balance: "0.1234567" });
  const info = await circleGatewayBalance({ runner, chain: "ARC-TESTNET", address: BUYER_WALLET });
  assert.equal(info.balanceAtomic, "123456");
});

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
