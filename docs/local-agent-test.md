# Local Agent Test Setup

Use this guide when you want another local agent project to consume the Rubicon
gateway through the local SDK package, without publishing
`@rubicon-caliga/agent-sdk` to npm.

## What This Tests

- A local Rubicon gateway reading live article metadata from Supabase.
- The local, unpublished `packages/agent-sdk` package.
- A real agent/script importing `@rubicon-caliga/agent-sdk` and calling
  `rubicon.run(...)`.
- The full seller-agent conversation, session creation, one-word payment loop,
  early stop/abort behavior, and final receipt.

## Start Rubicon Locally

From this repo:

```bash
pnpm install
pnpm --filter @rubicon-caliga/agent-sdk build
# Ensure .env or .env.local has SUPABASE_URL and the anon/publishable Supabase key.
GATEWAY_PORT=8788 pnpm dev:gateway
```

Keep that terminal running.

`8788` is used here to avoid conflicts with anything already listening on the
default `8787`. If `8787` is free, `pnpm dev:gateway` also works.

## Install The Local SDK In Another Agent Project

From the other local project:

```bash
pnpm add /Users/michaelzoubkoff/Documents/rubicon/packages/agent-sdk
```

If the other project uses npm:

```bash
npm install /Users/michaelzoubkoff/Documents/rubicon/packages/agent-sdk
```

If you edit the SDK after installing it, rebuild the SDK in the Rubicon repo and
reinstall it in the other project:

```bash
pnpm --filter @rubicon-caliga/agent-sdk build
```

## Minimal Agent Code

```ts
import Rubicon from "@rubicon-caliga/agent-sdk";

const rubicon = new Rubicon({
  baseUrl: "http://localhost:8788",
});

const receipt = await rubicon.run({
  articleId: "live-article-id-from-repository",
  goal: "Find the resale-fee clause",
  maxSpendAtomic: "20000",
  onWord: (word) => {
    process.stdout.write(`${word} `);
  },
});

console.log("\nreceipt:", receipt);
```

Expected result: words stream to stdout, then a receipt prints with fields like
`sessionId`, `articleId`, `wordsRead`, `amountPaidAtomic`, `text`, `completed`,
and `stopReason`.

## Paste This Into Another Agent

```txt
Set up a local Rubicon SDK integration test.

Context:
- The Rubicon repo is at /Users/michaelzoubkoff/Documents/rubicon.
- The gateway should run locally on http://localhost:8788.
- Do not install @rubicon-caliga/agent-sdk from npm.
- Install it from /Users/michaelzoubkoff/Documents/rubicon/packages/agent-sdk.

Steps:
1. In /Users/michaelzoubkoff/Documents/rubicon, run:
   pnpm install
   pnpm --filter @rubicon-caliga/agent-sdk build
   GATEWAY_PORT=8788 pnpm dev:gateway

2. Keep the gateway running.

3. In this agent project, install the local SDK:
   pnpm add /Users/michaelzoubkoff/Documents/rubicon/packages/agent-sdk

4. Create or update a TypeScript script that runs:

   import Rubicon from "@rubicon-caliga/agent-sdk";

   const rubicon = new Rubicon({
     baseUrl: "http://localhost:8788",
   });

   const receipt = await rubicon.run({
     articleId: "live-article-id-from-repository",
     goal: "Find the resale-fee clause",
     maxSpendAtomic: "20000",
     onWord: (word) => {
       process.stdout.write(`${word} `);
     },
   });

   console.log("\nreceipt:", receipt);

5. Run the script and confirm that words stream and a final receipt prints.
```

## Troubleshooting

If the gateway fails with `EADDRINUSE`, the selected port is already in use.
Pick another port and pass the same value to both sides:

```bash
GATEWAY_PORT=8790 pnpm dev:gateway
```

```ts
const rubicon = new Rubicon({
  baseUrl: "http://localhost:8790",
});
```

If the agent project cannot find the SDK package, reinstall it from the local
path:

```bash
pnpm add /Users/michaelzoubkoff/Documents/rubicon/packages/agent-sdk
```

If the agent project sees stale SDK types or behavior, rebuild the SDK in this
repo, then reinstall it in the agent project:

```bash
pnpm --filter @rubicon-caliga/agent-sdk build
```
