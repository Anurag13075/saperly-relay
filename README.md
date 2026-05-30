# saperly-replay

Replay failed (or any) Saperly webhook deliveries to any URL.

Saperly delivers each webhook **once with no automatic retries**. When your handler is down during a call spike, those events are gone — unless you replay them from the delivery log.

## Usage

```bash
# Install deps (once)
npm install -g ts-node typescript
npm install node-fetch   # only needed for Node < 18

# Replay all failed deliveries to your local server
npx ts-node saperly-replay.ts \
  --api-key sk_live_... \
  --to http://localhost:3000/webhook

# Replay for a specific line only
npx ts-node saperly-replay.ts \
  --api-key sk_live_... \
  --to https://yourapp.com/webhook \
  --line line_abc123

# See what would be replayed without sending
npx ts-node saperly-replay.ts \
  --api-key sk_live_... \
  --to http://localhost:3000/webhook \
  --dry-run

# Re-sign payloads so verifyWebhook() in your handler still passes
npx ts-node saperly-replay.ts \
  --api-key sk_live_... \
  --to http://localhost:3000/webhook \
  --secret <your-line-signing-secret>

# Replay delivered events too (e.g. to seed a new environment)
npx ts-node saperly-replay.ts \
  --api-key sk_live_... \
  --to https://staging.yourapp.com/webhook \
  --status all \
  --limit 500
```

## Options

| Flag | Default | Description |
|---|---|---|
| `--api-key` | `SAPERLY_API_KEY` env | Your Saperly API key |
| `--to` | *(required)* | Target URL to POST replayed webhooks to |
| `--status` | `failed` | `failed` \| `delivered` \| `all` |
| `--line` | *(all lines)* | Filter to one line ID |
| `--limit` | `100` | Max deliveries to fetch |
| `--concurrency` | `3` | Parallel replay workers |
| `--secret` | *(none)* | Line signing secret — re-signs payloads so `verifyWebhook()` passes |
| `--dry-run` | `false` | Print deliveries without sending |
| `--verbose` | `false` | Print request/response bodies |

## How it works

1. Calls `GET /api/v1/webhooks/deliveries` with offset pagination (100/page)
2. For each delivery, re-POSTs the **original payload** to your `--to` URL
3. Adds `x-saperly-replay: true` so your handler can detect replays
4. Preserves the original `x-saperly-delivery-id` as `x-saperly-original-delivery-id` — use this for idempotency checks in your handler
5. If `--secret` is passed, re-signs with a fresh timestamp + delivery ID using the same HMAC-SHA256 algorithm as `@saperly/sdk`'s `verifyWebhook()`
6. Retries once on 5xx or network errors. Never retries 4xx (permanent failures)
7. Exits with code `1` if any delivery is still failing after retries

## Idempotency in your handler

Saperly docs note that network-level duplicates are possible even for successful deliveries. Your handler should already be idempotent. During replay, use `x-saperly-original-delivery-id` as your idempotency key:

```typescript
import { verifyWebhook } from "@saperly/sdk";

app.post("/webhook", async (req, res) => {
  // Detect replays
  const isReplay = req.headers["x-saperly-replay"] === "true";
  const idempotencyKey =
    req.headers["x-saperly-original-delivery-id"] ??
    req.headers["x-saperly-delivery-id"];

  // Deduplicate
  if (await alreadyProcessed(idempotencyKey)) {
    return res.status(200).json({ ok: true, skipped: true });
  }

  // Verify signature (pass --secret to saperly-replay to keep this working)
  const result = verifyWebhook(rawBody, secret, req.headers);
  if (!result.valid) return res.status(401).end();

  // Handle event...
});
```

## No dependencies

Zero runtime deps beyond Node 18+ built-ins (`node:crypto`, `node:util`).  
Node 18 ships native `fetch` — no polyfill needed.

## Refs

- [Webhook Mode guide](https://docs.saperly.com/guides/webhook-mode)
- [Errors and Testing](https://docs.saperly.com/reference/errors-and-testing)
- [GET /api/v1/webhooks/deliveries](https://docs.saperly.com/api-reference/webhooks/list-deliveries)
- [`@saperly/sdk` verifyWebhook](https://github.com/Saperly/saperly-node)
