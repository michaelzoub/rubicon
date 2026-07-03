import { booleanFlag, stringFlag, type ParsedArgs } from "./args.js";
import { circleLoginComplete, circleLoginInit, type CircleRunner } from "./circle.js";
import type { RubiconCliConfig } from "./config.js";
import { CliError } from "./errors.js";

export interface LoginDeps {
  circleRunner?: CircleRunner;
  circleCommand?: string;
}

export async function runLogin(input: { parsed: ParsedArgs; config: RubiconCliConfig }, deps: LoginDeps = {}): Promise<Record<string, unknown>> {
  const email = input.parsed.positionals[1];
  const requestId = stringFlag(input.parsed.flags, "request");
  const otp = stringFlag(input.parsed.flags, "otp");
  const testnet = resolveTestnet(input.parsed, input.config);

  if (requestId || otp) {
    if (!requestId || !otp) {
      throw new CliError("MISSING_OTP", "rubicon login completion requires both --request and --otp.");
    }
    const result = await circleLoginComplete({
      requestId,
      otp,
      testnet,
      command: deps.circleCommand,
      runner: deps.circleRunner,
    });
    return { success: true, step: "complete", testnet, result };
  }

  if (!email) {
    throw new CliError("MISSING_EMAIL", "rubicon login requires an email, or --request and --otp to complete a pending login.");
  }
  const init = await circleLoginInit({
    email,
    testnet,
    command: deps.circleCommand,
    runner: deps.circleRunner,
  });
  return {
    success: true,
    step: "otp_sent",
    email,
    testnet,
    requestId: init.requestId,
    next: `rubicon login --request ${init.requestId ?? "<request-id>"} --otp <code>${testnet ? " --testnet" : ""} --json`,
    result: init.raw,
  };
}

function resolveTestnet(parsed: ParsedArgs, config: RubiconCliConfig): boolean {
  if (booleanFlag(parsed.flags, "mainnet")) return false;
  const flag = parsed.flags["testnet"];
  if (flag !== undefined) return flag !== "false";
  const chain = process.env.CIRCLE_CLI_CHAIN ?? config.circleChain ?? "ARC-TESTNET";
  return /testnet/i.test(chain);
}
