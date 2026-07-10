import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../server.js";
import { InMemoryLedgerRepository, InMemoryPublishedArticleRepository } from "../repositories/in-memory.js";
import { resolveBaseX402Config } from "../chain-base.js";
import {
  buildBaseChallenge,
  CdpBaseVerifier,
  publicIconUrl,
  resolveBaseX402Verifier,
  UnconfiguredBaseVerifier,
  type BaseAccept,
  type BaseX402Verifier,
} from "./x402-base.js";

const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function paidArticleRepo(network = "eip155:8453", verified = true, pricePerWordAtomic = 3n) {
  return new InMemoryPublishedArticleRepository({
    articles: [
      {
        id: "art-1",
        creatorId: "creator-a",
        creatorUsername: "alice",
        title: "Paid Article",
        author: "Alice",
        state: "live",
        pricePerWordAtomic,
        body: "one two three four five",
      },
    ],
    wallets: [
      { creatorId: "creator-a", address: "0x00000000000000000000000000000000000000aa", network, verified },
    ],
  });
}

function gatewayWith(verifier?: BaseX402Verifier, repo = paidArticleRepo()) {
  return createGateway({
    articleRepository: repo,
    ledger: new InMemoryLedgerRepository(),
    sessionTtlMs: 60_000,
    gatewayBaseUrl: "http://test",
    baseX402Verifier: verifier,
    logger: false,
  });
}

test("resolveBaseX402Config defaults to Base mainnet USDC and an enforced 10-USDC discovery ceiling", () => {
  const cfg = resolveBaseX402Config({} as NodeJS.ProcessEnv);
  assert.equal(cfg.network, "eip155:8453");
  assert.equal(cfg.chainId, 8453);
  assert.equal(cfg.mainnet, true);
  assert.equal(cfg.usdc.toLowerCase(), BASE_MAINNET_USDC.toLowerCase());
  assert.equal(cfg.maxArticlePriceAtomic, 10_000_000n);
});

test("resolveBaseX402Config honours Base Sepolia override", () => {
  const cfg = resolveBaseX402Config({ BASE_X402_NETWORK: "eip155:84532" } as unknown as NodeJS.ProcessEnv);
  assert.equal(cfg.chainId, 84532);
  assert.equal(cfg.mainnet, false);
  assert.equal(cfg.usdc.toLowerCase(), "0x036CbD53842c5426634e7929541eC2318f3dCF7e".toLowerCase());
});

test("buildBaseChallenge emits a checker-compliant x402 v2 challenge", () => {
  const cfg = resolveBaseX402Config({} as NodeJS.ProcessEnv);
  const c = buildBaseChallenge({
    config: cfg,
    resource: "http://test/v1/x402/articles/art-1",
    priceAtomic: 15n,
    articleId: "art-1",
    title: "Paid Article",
    totalWords: 5,
    payTo: "0x00000000000000000000000000000000000000aa",
  });
  assert.equal(c.x402Version, 2);
  assert.equal(c.resource.url, "http://test/v1/x402/articles/art-1");
  const a = c.accepts[0]!;
  assert.equal(a.scheme, "exact");
  assert.equal(a.network, "eip155:8453");
  assert.equal(a.asset, cfg.usdc);
  assert.equal(a.payTo, "0x00000000000000000000000000000000000000aa");
  assert.equal(a.amount, "15");
  assert.equal(a.maxAmountRequired, "15");
  assert.ok(a.maxTimeoutSeconds > 0);
  // bazaar schema block the AgentCash discovery checker requires:
  assert.ok(c.extensions.bazaar.schema.properties.input.properties.body);
  assert.ok(c.extensions.bazaar.schema.properties.output.properties.example);
});

test("AgentCash marketplace metadata only exposes a public image source", () => {
  const resource = "https://gateway.rubicon.example/v1/x402/articles/art-1";
  const iconUrl = publicIconUrl(resource);
  assert.equal(iconUrl, "https://gateway.rubicon.example/w_logo.svg");
  assert.equal(publicIconUrl("http://localhost:8787/v1/x402/articles/art-1"), undefined);
  const challenge = buildBaseChallenge({
    config: resolveBaseX402Config({} as NodeJS.ProcessEnv),
    resource,
    priceAtomic: 15n,
    articleId: "art-1",
    title: "Paid Article",
    totalWords: 5,
    payTo: "0x00000000000000000000000000000000000000aa",
    iconUrl,
  });
  assert.equal(challenge.resource.iconUrl, iconUrl);
  assert.ok(!JSON.stringify(challenge.resource).includes("[Image #1]"));
});

test("UnconfiguredBaseVerifier never accepts a payment", async () => {
  const result = await new UnconfiguredBaseVerifier().verify();
  assert.equal(result.verified, false);
});

test("POST /v1/x402/articles/:id — unpaid request returns the Base 402 challenge", async () => {
  const app = gatewayWith();
  const res = await app.inject({ method: "POST", url: "/v1/x402/articles/art-1", payload: {} });
  assert.equal(res.statusCode, 402);
  const body = res.json() as { x402Version: number; accepts: Array<{ network: string; amount: string; payTo: string }> };
  assert.equal(body.x402Version, 2);
  const encodedChallenge = res.headers["payment-required"];
  assert.ok(encodedChallenge, "unpaid x402 response includes PAYMENT-REQUIRED");
  assert.deepEqual(JSON.parse(Buffer.from(String(encodedChallenge), "base64").toString("utf8")), body);
  assert.equal(body.accepts[0]!.network, "eip155:8453");
  // 5 words * 3 atomic/word = 15 atomic USDC.
  assert.equal(body.accepts[0]!.amount, "15");
  await app.close();
});

test("placeholder id probe still returns a representative challenge (not 404)", async () => {
  const app = gatewayWith();
  const res = await app.inject({ method: "POST", url: "/v1/x402/articles/%7BarticleId%7D", payload: {} });
  assert.equal(res.statusCode, 402);
  assert.equal((res.json() as { x402Version: number }).x402Version, 2);
  await app.close();
});

test("concrete unknown id returns 404 (not a probe)", async () => {
  const app = gatewayWith();
  const res = await app.inject({ method: "POST", url: "/v1/x402/articles/does-not-exist", payload: {} });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("unverifiable payment never releases content", async () => {
  const app = gatewayWith(); // default = refusing verifier
  const res = await app.inject({
    method: "POST",
    url: "/v1/x402/articles/art-1",
    headers: { "x-payment": "bogus" },
    payload: {},
  });
  assert.equal(res.statusCode, 402);
  await app.close();
});

test("challenge payTo routes to the creator wallet (funds go direct, no gateway payout)", async () => {
  const app = gatewayWith();
  const res = await app.inject({ method: "POST", url: "/v1/x402/articles/art-1", payload: {} });
  const body = res.json() as { accepts: Array<{ payTo: string }> };
  // creator-a's verified wallet, not the default gateway/Privy wallet.
  assert.equal(body.accepts[0]!.payTo, "0x00000000000000000000000000000000000000aa");
  await app.close();
});

test("AgentCash Base lane refuses a creator wallet registered on another network", async () => {
  let calls = 0;
  const verifier: BaseX402Verifier = {
    async verify() {
      calls += 1;
      return { verified: true, transaction: "0xshould-not-settle" };
    },
  };
  const app = gatewayWith(verifier, paidArticleRepo("eip155:5042002"));
  const res = await app.inject({ method: "POST", url: "/v1/x402/articles/art-1", payload: {} });
  assert.equal(res.statusCode, 409);
  assert.equal((res.json() as { error: string }).error, "creator_base_wallet_not_configured");
  assert.equal(calls, 0, "payment verification must not run without a verified Base writer wallet");
  const doc = (await app.inject({ method: "GET", url: "/openapi.json" })).json() as any;
  assert.ok(!doc.paths["/v1/x402/articles/{articleId}"], "unpayable writer must not be listed on x402scan");
  await app.close();
});

test("AgentCash Base lane refuses articles over the advertised OpenAPI maximum", async () => {
  // Five words at 3 USDC/word exceeds the 10-USDC default ceiling.
  const app = gatewayWith(undefined, paidArticleRepo("eip155:8453", true, 3_000_000n));
  const res = await app.inject({ method: "POST", url: "/v1/x402/articles/art-1", payload: {} });
  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.json(), { error: "article_price_exceeds_x402_limit", maxAmountAtomic: "10000000" });
  const doc = (await app.inject({ method: "GET", url: "/openapi.json" })).json() as any;
  assert.ok(!doc.paths["/v1/x402/articles/{articleId}"], "an over-limit resource must not be advertised");
  await app.close();
});

test("resolveBaseX402Config rejects a malformed price ceiling", () => {
  assert.throws(
    () => resolveBaseX402Config({ BASE_X402_MAX_ARTICLE_PRICE_ATOMIC: "1.5" } as unknown as NodeJS.ProcessEnv),
    /BASE_X402_MAX_ARTICLE_PRICE_ATOMIC/,
  );
});

test("resolveBaseX402Verifier gates on CDP creds", () => {
  assert.ok(resolveBaseX402Verifier("eip155:8453", {} as NodeJS.ProcessEnv) instanceof UnconfiguredBaseVerifier);
  const configured = resolveBaseX402Verifier("eip155:8453", {
    CDP_API_KEY_ID: "id",
    CDP_API_KEY_SECRET: "secret",
  } as unknown as NodeJS.ProcessEnv);
  assert.ok(configured instanceof CdpBaseVerifier);
});

const SAMPLE_ACCEPT: BaseAccept = {
  scheme: "exact",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x00000000000000000000000000000000000000aa",
  amount: "15",
  maxAmountRequired: "15",
  maxTimeoutSeconds: 300,
  resource: "http://test/v1/x402/articles/art-1",
  description: "x",
  mimeType: "application/json",
  extra: { name: "USDC", version: "2" },
};

test("CdpBaseVerifier verifies then settles, reporting the tx", async () => {
  // Inject a fake resource server so we exercise the verify→settle flow without CDP.
  const fakeServer = {
    async initialize() {},
    async verifyPayment() {
      return { isValid: true, payer: "0xpayer" };
    },
    async settlePayment() {
      return { success: true, payer: "0xpayer", transaction: "0xtx" };
    },
  };
  // decodePaymentSignatureHeader must not throw on the header; a base64 JSON payload works.
  const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted: SAMPLE_ACCEPT, payload: {} })).toString("base64");
  const verifier = new CdpBaseVerifier("eip155:8453", async () => fakeServer as never);
  const result = await verifier.verify({ paymentHeader: header, accept: SAMPLE_ACCEPT });
  assert.deepEqual(result, { verified: true, payer: "0xpayer", transaction: "0xtx" });
});

test("CdpBaseVerifier refuses when settlement fails (no content released)", async () => {
  const fakeServer = {
    async initialize() {},
    async verifyPayment() {
      return { isValid: true };
    },
    async settlePayment() {
      return { success: false, errorReason: "insufficient_funds", transaction: "" };
    },
  };
  const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted: SAMPLE_ACCEPT, payload: {} })).toString("base64");
  const verifier = new CdpBaseVerifier("eip155:8453", async () => fakeServer as never);
  const result = await verifier.verify({ paymentHeader: header, accept: SAMPLE_ACCEPT });
  assert.deepEqual(result, { verified: false, reason: "insufficient_funds" });
});

test("CdpBaseVerifier turns a facilitator throw into a clean refusal (no 500)", async () => {
  const fakeServer = {
    async initialize() {},
    async verifyPayment(): Promise<never> {
      throw new Error("Facilitator verify failed (400): invalid");
    },
    async settlePayment() {
      return { success: true, transaction: "0x" };
    },
  };
  const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted: SAMPLE_ACCEPT, payload: {} })).toString("base64");
  const verifier = new CdpBaseVerifier("eip155:8453", async () => fakeServer as never);
  const result = await verifier.verify({ paymentHeader: header, accept: SAMPLE_ACCEPT });
  assert.equal(result.verified, false);
  assert.match((result as { reason: string }).reason, /payment_verification_error/);
});

test("verified payment returns the full article body", async () => {
  const stub: BaseX402Verifier = {
    async verify() {
      return { verified: true, payer: "0xabc", transaction: "0xdeadbeef" };
    },
  };
  const app = gatewayWith(stub);
  const res = await app.inject({
    method: "POST",
    url: "/v1/x402/articles/art-1",
    headers: { "x-payment": "valid" },
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { articleId: string; body: string; totalWords: number };
  assert.equal(body.articleId, "art-1");
  assert.equal(body.totalWords, 5);
  assert.equal(body.body, "one two three four five");
  assert.equal(res.headers["payment-response"], JSON.stringify({ transaction: "0xdeadbeef", payer: "0xabc" }));
  await app.close();
});
