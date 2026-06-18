import { test } from "node:test";
import assert from "node:assert/strict";
import { toEip712Payload } from "./circle-agent-wallet.js";

// The x402 schemes hand the signer viem-style typed data with no EIP712Domain
// entry; Circle's API needs the complete document. These pin the bridging.

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
  ],
};

test("injects EIP712Domain derived from the domain fields present", () => {
  const payload = toEip712Payload({
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: 5042002,
      verifyingContract: "0xabc",
    },
    types: TRANSFER_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { from: "0x1", to: "0x2", value: "5" },
  });

  assert.deepEqual(payload.types.EIP712Domain, [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ]);
  // Original typed-data entries are preserved alongside the injected domain.
  assert.deepEqual(payload.types.TransferWithAuthorization, TRANSFER_TYPES.TransferWithAuthorization);
  assert.equal(payload.primaryType, "TransferWithAuthorization");
});

test("only includes domain fields that are actually present", () => {
  const payload = toEip712Payload({
    domain: { name: "Test", chainId: 1337 },
    types: TRANSFER_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {},
  });

  assert.deepEqual(payload.types.EIP712Domain, [
    { name: "name", type: "string" },
    { name: "chainId", type: "uint256" },
  ]);
});

test("does not overwrite an EIP712Domain the caller already supplied", () => {
  const provided = [{ name: "name", type: "string" }];
  const payload = toEip712Payload({
    domain: { name: "Test", chainId: 1337 },
    types: { ...TRANSFER_TYPES, EIP712Domain: provided },
    primaryType: "TransferWithAuthorization",
    message: {},
  });

  assert.deepEqual(payload.types.EIP712Domain, provided);
});
