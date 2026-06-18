import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeTypedData, toEip712Payload } from "./circle-agent-wallet.js";

// The x402 schemes hand the signer viem-style typed data with no EIP712Domain
// entry; Circle's API needs the complete document. These pin the bridging.

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
  ],
};

const EIP3009_TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
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

test("serializes bigint authorization fields (exact fallback) as decimal strings", () => {
  // The `exact` scheme hands the signer bigint value/validAfter/validBefore;
  // plain JSON.stringify would throw, so they must be coerced to strings.
  const payload = toEip712Payload({
    domain: { name: "USD Coin", chainId: 5042002 },
    types: EIP3009_TRANSFER_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: "0x1",
      to: "0x2",
      value: 5n,
      validAfter: 0n,
      validBefore: 1893456000n,
      nonce: "0xabc",
    },
  });

  const json = serializeTypedData(payload);
  const parsed = JSON.parse(json);
  assert.equal(parsed.message.value, "5");
  assert.equal(parsed.message.validAfter, "0");
  assert.equal(parsed.message.validBefore, "1893456000");
});

test("removes message fields that are not declared by the primary type", () => {
  const payload = toEip712Payload({
    domain: { name: "USD Coin", chainId: 5042002 },
    types: TRANSFER_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: "0x1",
      to: "0x2",
      value: "5",
      validAfter: "0",
      validBefore: "1893456000",
      nonce: "0xabc",
      authorization: { unexpected: true },
    },
  });

  assert.deepEqual(payload.message, { from: "0x1", to: "0x2", value: "5" });
});
