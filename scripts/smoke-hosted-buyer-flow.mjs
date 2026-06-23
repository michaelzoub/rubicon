#!/usr/bin/env node
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const cliVersion = process.env.RUBICON_SMOKE_CLI_VERSION ?? "0.1.6";
const goal = process.env.RUBICON_SMOKE_GOAL ?? "find and summarize the first available article";
const maxUsdc = process.env.RUBICON_SMOKE_MAX_USDC ?? "0.01";
const command = [
  "pnpm",
  "dlx",
  `@rubicon-caliga/cli@${cliVersion}`,
  "buy",
  "--first",
  "--goal",
  goal,
  "--max-usdc",
  maxUsdc,
  "--json",
];

const cwd = await mkdtemp(join(tmpdir(), "rubicon-hosted-smoke-cwd-"));
const home = await mkdtemp(join(tmpdir(), "rubicon-hosted-smoke-home-"));
const env = { ...process.env, HOME: home };

const first = await run(command, { cwd, env });
let final = first;
if (isNotLoggedIn(first)) {
  final = await recoverLoginThenRetry({ cwd, env });
}

const parsed = parseJson(final.stdout);
if (final.code !== 0 || parsed?.success === false) {
  blocker("BUY_BLOCKED", parsed?.error?.message ?? final.stderr || final.stdout || `exit ${final.code}`);
}

const result = parsed?.result;
const amountPaidAtomic = BigInt(String(result?.amountPaidAtomic ?? "-1"));
const capAtomic = parseUsdcToAtomic(maxUsdc);
const receipts = Array.isArray(result?.receipts) ? result.receipts : [];
const firstReceipt = receipts[0] ?? {};
const missing = [
  ["articleId", result?.articleId],
  ["sessionId", firstReceipt.sessionId],
  ["receiptIds", Array.isArray(result?.receiptIds) && result.receiptIds.length > 0],
  ["paymentIds", Array.isArray(firstReceipt.paymentIds)],
  ["settlementIds", Array.isArray(firstReceipt.settlementIds)],
  ["amountPaidAtomic", result?.amountPaidAtomic],
].filter(([, value]) => !value);

if (amountPaidAtomic < 0n || amountPaidAtomic > capAtomic) {
  blocker("CAP_EXCEEDED", `spent ${amountPaidAtomic} atomic USDC with cap ${capAtomic}`);
}
if (missing.length > 0) {
  blocker("MISSING_RECEIPT_FIELDS", `missing ${missing.map(([name]) => name).join(", ")}`);
}

console.log(JSON.stringify({
  success: true,
  cwd,
  home,
  command: command.join(" "),
  amountPaidAtomic: String(amountPaidAtomic),
  maxUsdc,
  articleId: result.articleId,
  receiptIds: result.receiptIds,
  sessionId: firstReceipt.sessionId,
  paymentIds: firstReceipt.paymentIds,
  settlementIds: firstReceipt.settlementIds,
  transactionHashes: firstReceipt.transactionHashes ?? [],
}, null, 2));

async function recoverLoginThenRetry({ cwd, env }) {
  const email = process.env.CIRCLE_AGENT_EMAIL;
  if (!email) {
    blocker("NOT_LOGGED_IN", "Set CIRCLE_AGENT_EMAIL to allow this smoke test to start Circle agent-wallet OTP login, then rerun.");
  }
  const init = await run(["circle", "wallet", "login", email, "--type", "agent", "--init"], { cwd, env });
  if (init.code !== 0) blocker("LOGIN_INIT_FAILED", init.stderr || init.stdout || `exit ${init.code}`);
  const requestId = parseRequestId(init.stdout);
  if (!requestId) blocker("LOGIN_REQUEST_ID_MISSING", init.stdout || init.stderr);

  const rl = createInterface({ input, output });
  const otp = (await rl.question("Circle OTP: ")).trim();
  rl.close();
  if (!otp) blocker("OTP_MISSING", "Circle OTP was not provided.");

  const complete = await run(["circle", "wallet", "login", "--type", "agent", "--request", requestId, "--otp", otp], { cwd, env });
  if (complete.code !== 0) blocker("LOGIN_COMPLETE_FAILED", complete.stderr || complete.stdout || `exit ${complete.code}`);
  return run(command, { cwd, env });
}

function isNotLoggedIn(result) {
  const parsed = parseJson(result.stdout);
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return parsed?.error?.code === "NOT_LOGGED_IN" || text.includes("not_logged_in") || text.includes("not logged in");
}

function parseRequestId(text) {
  const parsed = parseJson(text);
  const candidates = [
    parsed?.data?.requestId,
    parsed?.requestId,
    parsed?.data?.id,
    parsed?.id,
    text.match(/request(?:\s*id)?[:=\s]+([A-Za-z0-9_-]+)/i)?.[1],
  ];
  return candidates.find((value) => typeof value === "string" && value.length > 0);
}

function parseJson(text) {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}

function parseUsdcToAtomic(value) {
  const [whole = "0", fraction = ""] = String(value).split(".");
  return BigInt(whole) * 1_000_000n + BigInt(`${fraction}000000`.slice(0, 6));
}

function blocker(code, message) {
  console.error(JSON.stringify({ success: false, blocker: { code, message }, command: command.join(" "), cwd, home }, null, 2));
  process.exit(1);
}

function run(args, options) {
  return new Promise((resolve) => {
    const child = spawn(args[0], args.slice(1), { ...options, env: options.env ?? process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: String(error) }));
  });
}
