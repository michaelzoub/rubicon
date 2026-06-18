import { test } from "node:test";
import assert from "node:assert/strict";
import {
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
