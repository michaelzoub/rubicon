import assert from "node:assert/strict";
import { test } from "node:test";
import { CircleWalletSigner, type CircleWalletsClient } from "./payment-engine.js";

function mockClient(overrides: Partial<CircleWalletsClient> = {}): {
  client: CircleWalletsClient;
  signCalls: Array<{ walletId: string; data: string }>;
} {
  const signCalls: Array<{ walletId: string; data: string }> = [];
  const client: CircleWalletsClient = {
    async getWallet({ id }) {
      assert.equal(id, "wallet-1");
      return { data: { wallet: { address: "0x00000000000000000000000000000000000000aa" } } };
    },
    async signTypedData(input) {
      signCalls.push({ walletId: input.walletId, data: input.data });
      return { data: { signature: "0xsig" } };
    },
    ...overrides,
  };
  return { client, signCalls };
}

test("ensureReady resolves the wallet address from the Circle client", async () => {
  const { client } = mockClient();
  const signer = new CircleWalletSigner({ client, walletId: "wallet-1" });
  await signer.ensureReady();
  assert.equal(signer.address, "0x00000000000000000000000000000000000000aa");
});

test("an explicit address skips the getWallet lookup", async () => {
  let lookups = 0;
  const { client } = mockClient({
    async getWallet() {
      lookups += 1;
      return { data: { wallet: { address: "0xshould-not-be-used" } } };
    },
  });
  const signer = new CircleWalletSigner({
    client,
    walletId: "wallet-1",
    address: "0x00000000000000000000000000000000000000bb",
  });
  await signer.ensureReady();
  assert.equal(lookups, 0);
  assert.equal(signer.address, "0x00000000000000000000000000000000000000bb");
});

test("signTypedData forwards an EIP-712 document with a derived EIP712Domain and serialized bigints", async () => {
  const { client, signCalls } = mockClient();
  const signer = new CircleWalletSigner({ client, walletId: "wallet-1" });
  await signer.ensureReady();

  const signature = await signer.signTypedData({
    domain: { name: "USDC", version: "2", chainId: 5042002, verifyingContract: "0xabc" },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "value", type: "uint256" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: { from: "0xfrom", value: 1n },
  });

  assert.equal(signature, "0xsig");
  assert.equal(signCalls.length, 1);
  const call = signCalls[0]!;
  assert.equal(call.walletId, "wallet-1");

  const sent = JSON.parse(call.data);
  // EIP712Domain is reconstructed from the domain fields that were present.
  assert.deepEqual(sent.types.EIP712Domain, [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ]);
  // The caller's own types are preserved alongside it.
  assert.ok(sent.types.TransferWithAuthorization);
  // bigint message fields are serialized as decimal strings (valid JSON / EIP-712).
  assert.equal(sent.message.value, "1");
});

test("signTypedData before ensureReady throws a clear error (credentials path)", async () => {
  // With the credentials path the client is only built during ensureReady, so
  // signing beforehand must fail loudly rather than silently no-op.
  const signer = new CircleWalletSigner({
    apiKey: "test",
    entitySecret: "test",
    walletId: "wallet-1",
  });
  await assert.rejects(
    () =>
      signer.signTypedData({
        domain: {},
        types: {},
        primaryType: "X",
        message: {},
      }),
    /ensureReady/,
  );
});

test("a missing signature surfaces an error", async () => {
  const { client } = mockClient({
    async signTypedData() {
      return { data: {} };
    },
  });
  const signer = new CircleWalletSigner({ client, walletId: "wallet-1" });
  await signer.ensureReady();
  await assert.rejects(
    () =>
      signer.signTypedData({ domain: {}, types: {}, primaryType: "X", message: {} }),
    /no signature/,
  );
});
