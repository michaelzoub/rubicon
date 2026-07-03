import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CircleCliGatewaySigner,
  parseCircleGatewayBackingEOA,
  parseCircleCliSignature,
  parseCircleCliWalletAddress,
} from "./circle-cli-gateway-payment.js";

test("parses quiet Circle CLI signatures", () => {
  assert.equal(parseCircleCliSignature("0xabc123\n"), "0xabc123");
});

test("parses JSON Circle CLI signatures", () => {
  assert.equal(
    parseCircleCliSignature(JSON.stringify({ data: { signature: "0xdef456" } })),
    "0xdef456",
  );
});

test("rejects non-signature Circle CLI output", () => {
  assert.throws(() => parseCircleCliSignature("signed"), /did not return a hex EIP-712 signature/);
});

test("parses a sole wallet address from Circle CLI list output", () => {
  assert.equal(
    parseCircleCliWalletAddress(
      JSON.stringify({
        data: {
          wallets: [
            {
              address: "0x1111111111111111111111111111111111111111",
            },
          ],
        },
      }),
    ),
    "0x1111111111111111111111111111111111111111",
  );
});

test("parses backing EOA from Circle Gateway balance output", () => {
  assert.equal(
    parseCircleGatewayBackingEOA(
      JSON.stringify({
        data: {
          backingEOA: "0x2222222222222222222222222222222222222222",
        },
      }),
    ),
    "0x2222222222222222222222222222222222222222",
  );
});

test("separates Circle CLI Agent Wallet address from x402 backing EOA", async () => {
  const calls: string[][] = [];
  const signer = new CircleCliGatewaySigner({
    agentWalletAddress: "0x1111111111111111111111111111111111111111",
    chain: "ARC-TESTNET",
    command: "circle",
    runner: async (_command, args) => {
      calls.push(args);
      assert.deepEqual(args, [
        "gateway",
        "balance",
        "--address",
        "0x1111111111111111111111111111111111111111",
        "--chain",
        "ARC-TESTNET",
        "--output",
        "json",
      ]);
      return JSON.stringify({
        data: {
          backingEOA: "0x2222222222222222222222222222222222222222",
        },
      });
    },
  });

  await signer.ensureAddress();

  assert.equal(signer.agentWalletAddress, "0x1111111111111111111111111111111111111111");
  assert.equal(signer.address, "0x2222222222222222222222222222222222222222");
  assert.equal(calls.length, 1);
});

test("discovers sole Agent Wallet and then its Gateway backing EOA", async () => {
  const calls: string[][] = [];
  const signer = new CircleCliGatewaySigner({
    chain: "ARC-TESTNET",
    command: "circle",
    runner: async (_command, args) => {
      calls.push(args);
      if (args[0] === "wallet") {
        return JSON.stringify({
          data: {
            wallets: [{ address: "0x1111111111111111111111111111111111111111" }],
          },
        });
      }
      return JSON.stringify({
        data: {
          backingEOA: "0x2222222222222222222222222222222222222222",
        },
      });
    },
  });

  await signer.ensureAddress();

  assert.equal(signer.agentWalletAddress, "0x1111111111111111111111111111111111111111");
  assert.equal(signer.address, "0x2222222222222222222222222222222222222222");
  assert.deepEqual(calls, [
    ["wallet", "list", "--chain", "ARC-TESTNET", "--type", "agent", "--output", "json"],
    [
      "gateway",
      "balance",
      "--address",
      "0x1111111111111111111111111111111111111111",
      "--chain",
      "ARC-TESTNET",
      "--output",
      "json",
    ],
  ]);
});

test("typed data message.from uses backing EOA while CLI signs with Agent Wallet", async () => {
  let signedPayload: Record<string, unknown> | undefined;
  const signer = new CircleCliGatewaySigner({
    agentWalletAddress: "0x1111111111111111111111111111111111111111",
    buyerWalletAddress: "0x2222222222222222222222222222222222222222",
    chain: "ARC-TESTNET",
    command: "circle",
    runner: async (_command, args) => {
      const addressFlag = args.indexOf("--address");
      assert.equal(args[addressFlag + 1], "0x1111111111111111111111111111111111111111");
      signedPayload = JSON.parse(args[3] ?? "{}") as Record<string, unknown>;
      return "0xabc123";
    },
  });
  await signer.ensureAddress();
  assert.equal(signer.address, "0x2222222222222222222222222222222222222222");

  await signer.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 5042002 },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: signer.address,
      to: "0x3333333333333333333333333333333333333333",
      value: 1n,
    },
  });

  assert.equal(
    (signedPayload?.message as Record<string, unknown>).from,
    "0x2222222222222222222222222222222222222222",
  );
});

test("requires explicit wallet address when multiple Agent Wallets are present", () => {
  assert.throws(
    () =>
      parseCircleCliWalletAddress(
        JSON.stringify({
          data: [
            { address: "0x1111111111111111111111111111111111111111" },
            { address: "0x2222222222222222222222222222222222222222" },
          ],
        }),
      ),
    /Multiple Circle Agent Wallets found/,
  );
});

test("buildCircleInvocation routes bare commands through cmd.exe on win32 only", async () => {
  const { buildCircleInvocation } = await import("./circle-cli-gateway-payment.js");
  const win = buildCircleInvocation("circle", ["wallet", "list"], "win32");
  assert.equal(win.file, "cmd.exe");
  assert.deepEqual(win.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(win.options.windowsVerbatimArguments, true);

  const posix = buildCircleInvocation("circle", ["wallet", "list"], "linux");
  assert.deepEqual({ file: posix.file, args: posix.args }, { file: "circle", args: ["wallet", "list"] });
});
