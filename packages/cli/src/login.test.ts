import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./args.js";
import { CliError } from "./errors.js";
import { runLogin } from "./login.js";

function runnerFor(calls: string[][]) {
  return async (_command: string, args: string[]) => {
    calls.push(args);
    return JSON.stringify({ data: { requestId: "req_123" } });
  };
}

test("login init defaults to testnet for the default chain and returns the next command", async () => {
  const calls: string[][] = [];
  const result = await runLogin(
    { parsed: parseArgs(["login", "buyer@example.com", "--json"]), config: {} },
    { circleRunner: runnerFor(calls) },
  );

  assert.deepEqual(calls[0], ["wallet", "login", "buyer@example.com", "--type", "agent", "--testnet", "--init"]);
  assert.equal(result.step, "otp_sent");
  assert.equal(result.testnet, true);
  assert.equal(result.requestId, "req_123");
  assert.equal(result.next, "rubicon login --request req_123 --otp <code> --testnet --json");
});

test("login init omits --testnet for mainnet chains", async () => {
  const calls: string[][] = [];
  const result = await runLogin(
    { parsed: parseArgs(["login", "buyer@example.com", "--mainnet"]), config: { circleChain: "ETH" } },
    { circleRunner: runnerFor(calls) },
  );

  assert.equal(result.testnet, false);
  assert.deepEqual(calls[0], ["wallet", "login", "buyer@example.com", "--type", "agent", "--init"]);
});

test("login completion sends request id and OTP without persisting them", async () => {
  const calls: string[][] = [];
  const result = await runLogin(
    { parsed: parseArgs(["login", "--request", "req_123", "--otp", "424242", "--testnet"]), config: {} },
    { circleRunner: runnerFor(calls) },
  );

  assert.equal(result.step, "complete");
  assert.deepEqual(calls[0], ["wallet", "login", "--type", "agent", "--testnet", "--request", "req_123", "--otp", "424242"]);
});

test("login rejects a lone --otp or missing email", async () => {
  await assert.rejects(
    () => runLogin({ parsed: parseArgs(["login", "--otp", "424242"]), config: {} }, { circleRunner: runnerFor([]) }),
    (error) => error instanceof CliError && error.code === "MISSING_OTP",
  );
  await assert.rejects(
    () => runLogin({ parsed: parseArgs(["login"]), config: {} }, { circleRunner: runnerFor([]) }),
    (error) => error instanceof CliError && error.code === "MISSING_EMAIL",
  );
});
