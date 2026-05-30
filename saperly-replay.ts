#!/usr/bin/env npx ts-node
/**
 * saperly-replay.ts
 *
 * Replay failed (or all) Saperly webhook deliveries to any URL.
 *
 * Saperly delivers each webhook ONCE with no automatic retries.
 * When your handler is down during a call spike, those events are gone —
 * unless you replay them from the delivery log.
 *
 * Usage:
 *   npx ts-node saperly-replay.ts --api-key sk_live_... --to http://localhost:3000/webhook
 *
 * Options:
 *   --api-key   <key>    Saperly API key (or set SAPERLY_API_KEY env var)
 *   --to        <url>    Target URL to replay webhooks to (required)
 *   --status    <s>      Filter by delivery status: failed|delivered|all (default: failed)
 *   --line      <id>     Only replay deliveries for a specific line ID
 *   --limit     <n>      Max deliveries to fetch (default: 100)
 *   --concurrency <n>    Parallel replays (default: 3)
 *   --dry-run            Print what would be replayed, without sending
 *   --verbose            Print full request/response bodies
 *
 * Docs:
 *   https://docs.saperly.com/guides/webhook-mode
 *   https://docs.saperly.com/reference/errors-and-testing
 */

import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

// ─── ANSI colours (no deps) ──────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  indigo: "\x1b[34m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

const ok = (s: string) => `${c.green}✓${c.reset}  ${s}`;
const fail = (s: string) => `${c.red}✗${c.reset}  ${s}`;
const warn = (s: string) => `${c.yellow}⚠${c.reset}  ${s}`;
const info = (s: string) => `${c.gray}→${c.reset}  ${s}`;
const dim = (s: string) => `${c.dim}${s}${c.reset}`;
const bold = (s: string) => `${c.bold}${s}${c.reset}`;

// ─── Types matching Saperly API exactly ─────────────────────────────────────
// Ref: https://docs.saperly.com/reference/api-overview

type DeliveryStatus = "delivered" | "failed" | "pending";
type WebhookEventType =
  | "call_started"
  | "call_ended"
  | "message"
  | "sms_received"
  | "call_incoming"
  | "call_outgoing";

interface WebhookDelivery {
  id: string;
  line_id: string;
  event: WebhookEventType;
  webhook_url: string;
  payload: Record<string, unknown>; // raw event body Saperly sent
  request_headers: Record<string, string>; // includes x-saperly-* signature headers
  response_status?: number;
  response_body?: string;
  response_latency_ms?: number;
  status: DeliveryStatus;
  attempted_at: string; // ISO 8601
  delivered_at?: string;
}

interface DeliveriesResponse {
  data: WebhookDelivery[];
  total: number;
  limit: number;
  offset: number;
}

interface SaperlyErrorBody {
  error: {
    code: string; // branch on this, not message
    message: string;
    details?: Array<{ field: string; message: string }>;
  };
}

// ─── Saperly error codes we care about ──────────────────────────────────────
// Ref: https://docs.saperly.com/reference/errors-and-testing#error-codes

const FRIENDLY_ERRORS: Record<string, string> = {
  invalid_api_key: "Your API key is invalid or revoked. Check SAPERLY_API_KEY.",
  unauthorized: "No auth header found. Pass --api-key or set SAPERLY_API_KEY.",
  forbidden: "You don't have permission to read webhook deliveries.",
  not_found: "Resource not found — check your --line ID if you passed one.",
  rate_limited:
    "Rate limited by Saperly. Slow down and retry. (Read endpoints: 60/hr)",
  internal_error: "Saperly returned a 500. Try again in a moment.",
};

// ─── Saperly API client ──────────────────────────────────────────────────────

const SAPERLY_BASE = "https://saperly.com/api/v1";

class SaperlyApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "SaperlyApiError";
  }
}

async function saperlyFetch<T>(
  apiKey: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${SAPERLY_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "saperly-replay/1.0.0",
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }

  if (!res.ok) {
    const err = json as SaperlyErrorBody;
    const code = err?.error?.code ?? "unknown_error";
    const msg =
      FRIENDLY_ERRORS[code] ??
      err?.error?.message ??
      `HTTP ${res.status} from Saperly`;
    throw new SaperlyApiError(code, msg, res.status);
  }

  return json as T;
}

// ─── Fetch deliveries (offset pagination) ───────────────────────────────────
// GET /api/v1/webhooks/deliveries
// Uses offset-based pagination per the API overview.

async function fetchDeliveries(
  apiKey: string,
  opts: {
    status?: "failed" | "delivered" | "all";
    lineId?: string;
    limit: number;
  }
): Promise<WebhookDelivery[]> {
  const all: WebhookDelivery[] = [];
  const pageSize = Math.min(opts.limit, 100);
  let offset = 0;

  while (all.length < opts.limit) {
    const qs = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
    });
    // Saperly filter: "all" means don't pass status param
    if (opts.status && opts.status !== "all") {
      qs.set("status", opts.status);
    }
    if (opts.lineId) {
      qs.set("line_id", opts.lineId);
    }

    const page = await saperlyFetch<DeliveriesResponse>(
      apiKey,
      `/webhooks/deliveries?${qs}`
    );

    all.push(...page.data);

    // Stop if we've fetched everything
    if (page.data.length < pageSize || all.length >= page.total) break;
    offset += pageSize;
  }

  return all.slice(0, opts.limit);
}

// ─── Signature re-stamping ───────────────────────────────────────────────────
// When replaying, we can't re-sign with the original line secret (we don't
// have it). Instead we:
//   1. Strip the original x-saperly-signature / x-saperly-delivery-id / x-saperly-timestamp
//   2. Add x-saperly-replay: true so your handler can detect replays
//   3. Keep the original x-saperly-delivery-id in x-saperly-original-delivery-id
//      so you can deduplicate against your own idempotency store.
//
// If you pass --secret, we re-sign with that secret so your handler's
// verifyWebhook() call still passes.

function buildReplayHeaders(
  original: Record<string, string>,
  payload: string,
  secret?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "saperly-replay/1.0.0",
  };

  // Preserve original Saperly headers that don't affect signature
  const preserve = [
    "x-saperly-line-id",
    "x-saperly-event",
    "x-saperly-call-id",
  ];
  for (const h of preserve) {
    if (original[h]) headers[h] = original[h];
  }

  // Tag as replay + preserve original delivery ID for idempotency
  headers["x-saperly-replay"] = "true";
  if (original["x-saperly-delivery-id"]) {
    headers["x-saperly-original-delivery-id"] =
      original["x-saperly-delivery-id"];
  }

  // Re-sign if secret provided (matches @saperly/sdk verifyWebhook algorithm)
  // Algorithm: HMAC-SHA256( key=secret, data="${timestamp}.${deliveryId}.${rawBody}" )
  // Ref: https://docs.saperly.com/guides/webhook-mode#signature-verification
  const newDeliveryId = randomUUID();
  const newTimestamp = String(Math.floor(Date.now() / 1000));

  headers["x-saperly-delivery-id"] = newDeliveryId;
  headers["x-saperly-timestamp"] = newTimestamp;

  if (secret) {
    const sigPayload = `${newTimestamp}.${newDeliveryId}.${payload}`;
    const hex = createHmac("sha256", secret)
      .update(sigPayload, "utf8")
      .digest("hex");
    headers["x-saperly-signature"] = `v1=${hex}`;
  }

  return headers;
}

// ─── Replay a single delivery ────────────────────────────────────────────────

interface ReplayResult {
  delivery: WebhookDelivery;
  attempt: number;
  responseStatus?: number;
  responseBody?: string;
  latencyMs: number;
  success: boolean;
  error?: string;
}

async function replayOne(
  delivery: WebhookDelivery,
  targetUrl: string,
  opts: { secret?: string; verbose: boolean; attempt?: number }
): Promise<ReplayResult> {
  const payload = JSON.stringify(delivery.payload);
  const headers = buildReplayHeaders(
    delivery.request_headers ?? {},
    payload,
    opts.secret
  );

  const start = Date.now();
  const attempt = opts.attempt ?? 1;

  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.timeout(10_000), // 10s — matches Saperly's message event budget
    });

    const latencyMs = Date.now() - start;
    const responseBody = await res.text().catch(() => "");
    const success = res.status >= 200 && res.status < 300;

    if (opts.verbose) {
      console.log(
        dim(
          `     req  ${JSON.stringify(delivery.payload, null, 2).slice(0, 300)}`
        )
      );
      console.log(
        dim(`     res  ${res.status} ${responseBody.slice(0, 200)}`)
      );
    }

    return {
      delivery,
      attempt,
      responseStatus: res.status,
      responseBody,
      latencyMs,
      success,
    };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    const isTimeout =
      err?.name === "TimeoutError" || err?.name === "AbortError";
    return {
      delivery,
      attempt,
      latencyMs,
      success: false,
      error: isTimeout ? "timeout after 10s" : (err?.message ?? "unknown"),
    };
  }
}

// ─── Concurrency pool ────────────────────────────────────────────────────────

async function pool<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  onDone: (result: T, index: number) => void
): Promise<T[]> {
  const results: T[] = [];
  let i = 0;

  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      const result = await tasks[idx]();
      results[idx] = result;
      onDone(result, idx);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const { values } = parseArgs({
    options: {
      "api-key": { type: "string" },
      to: { type: "string" },
      status: { type: "string", default: "failed" },
      line: { type: "string" },
      limit: { type: "string", default: "100" },
      concurrency: { type: "string", default: "3" },
      secret: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
${bold("saperly-replay")}  —  Replay failed Saperly webhook deliveries

${bold("Usage")}
  npx ts-node saperly-replay.ts --api-key sk_live_... --to http://localhost:3000/webhook

${bold("Options")}
  --api-key   <key>    Saperly API key (or set SAPERLY_API_KEY env var)
  --to        <url>    Target URL to replay webhooks to  ${c.red}(required)${c.reset}
  --status    <s>      failed | delivered | all  (default: failed)
  --line      <id>     Only replay deliveries for one line
  --limit     <n>      Max deliveries to fetch (default: 100)
  --concurrency <n>    Parallel replays (default: 3)
  --secret    <s>      Line signing secret — re-signs replayed payloads so
                       verifyWebhook() in your handler still passes
  --dry-run            Print deliveries without sending
  --verbose            Print request/response bodies

${bold("Docs")}
  https://docs.saperly.com/guides/webhook-mode
    `);
    process.exit(0);
  }

  const apiKey =
    (values["api-key"] as string | undefined) ??
    process.env.SAPERLY_API_KEY ??
    "";
  const targetUrl = values.to as string | undefined;
  const status = (values.status as string) as "failed" | "delivered" | "all";
  const lineId = values.line as string | undefined;
  const limit = parseInt(values.limit as string, 10);
  const concurrency = parseInt(values.concurrency as string, 10);
  const secret = values.secret as string | undefined;
  const dryRun = values["dry-run"] as boolean;
  const verbose = values.verbose as boolean;

  // ── Validate ──────────────────────────────────────────────────────────────

  const errors: string[] = [];
  if (!apiKey) errors.push("--api-key or SAPERLY_API_KEY is required");
  if (!targetUrl && !dryRun) errors.push("--to <url> is required");
  if (!["failed", "delivered", "all"].includes(status))
    errors.push('--status must be failed | delivered | all');
  if (isNaN(limit) || limit < 1) errors.push("--limit must be a positive integer");
  if (isNaN(concurrency) || concurrency < 1)
    errors.push("--concurrency must be a positive integer");

  if (errors.length) {
    for (const e of errors) console.error(fail(e));
    process.exit(1);
  }

  // ── Banner ────────────────────────────────────────────────────────────────

  console.log(`
${c.indigo}${c.bold}  saperly-replay${c.reset}
${c.gray}  ──────────────────────────────────────────────${c.reset}
`);

  // ── Fetch deliveries ──────────────────────────────────────────────────────

  process.stdout.write(
    info(
      `Fetching ${status === "all" ? "" : status + " "}deliveries from Saperly...`
    ) + " "
  );

  let deliveries: WebhookDelivery[];
  try {
    deliveries = await fetchDeliveries(apiKey, { status, lineId, limit });
  } catch (err) {
    process.stdout.write("\n");
    if (err instanceof SaperlyApiError) {
      console.error(fail(`${err.message}  ${dim("[" + err.code + "]")}`));
    } else {
      console.error(fail(String(err)));
    }
    process.exit(1);
  }

  console.log(`${c.green}${deliveries.length} found${c.reset}`);
  console.log();

  if (deliveries.length === 0) {
    console.log(ok(`No ${status === "all" ? "" : status + " "}deliveries found. Nothing to replay.`));
    process.exit(0);
  }

  // ── Dry run ───────────────────────────────────────────────────────────────

  if (dryRun) {
    console.log(warn("Dry run — not sending. Deliveries that would be replayed:\n"));
    for (const d of deliveries) {
      const age = formatAge(d.attempted_at);
      const prevStatus =
        d.status === "failed"
          ? `${c.red}failed${c.reset}`
          : `${c.green}delivered${c.reset}`;
      console.log(
        `  ${c.gray}${d.id.slice(0, 8)}${c.reset}  ${c.cyan}${padEnd(d.event, 16)}${c.reset}  line:${d.line_id.slice(0, 8)}  ${prevStatus}  ${dim(age)}`
      );
      if (verbose) {
        console.log(
          dim("           " + JSON.stringify(d.payload).slice(0, 120))
        );
      }
    }
    console.log();
    console.log(
      dim(
        `  ${deliveries.length} deliveries. Re-run without --dry-run to replay them.`
      )
    );
    process.exit(0);
  }

  // ── Replay ────────────────────────────────────────────────────────────────

  console.log(
    info(
      `Replaying to ${c.cyan}${targetUrl}${c.reset}  (concurrency: ${concurrency}${secret ? ", re-signing ✓" : ""})\n`
    )
  );

  const padN = String(deliveries.length).length;
  let completed = 0;
  const failed_ids: string[] = [];
  const MAX_RETRIES = 2;

  // Build task list with retry logic
  const tasks = deliveries.map((delivery, i) => async (): Promise<ReplayResult> => {
    let result = await replayOne(delivery, targetUrl!, { secret, verbose });

    // Retry once on 5xx or network errors (not on 4xx — those are permanent)
    let attempt = 1;
    while (
      !result.success &&
      attempt < MAX_RETRIES &&
      (result.error != null ||
        (result.responseStatus != null && result.responseStatus >= 500))
    ) {
      attempt++;
      await sleep(500 * attempt); // backoff
      result = await replayOne(delivery, targetUrl!, {
        secret,
        verbose,
        attempt,
      });
    }

    return result;
  });

  await pool(tasks, concurrency, (result, i) => {
    completed++;
    const n = String(completed).padStart(padN);
    const total = deliveries.length;
    const d = result.delivery;
    const age = formatAge(d.attempted_at);

    const statusPart = result.success
      ? `${c.green}${result.responseStatus} OK${c.reset}`
      : result.error
      ? `${c.red}${result.error}${c.reset}`
      : `${c.red}${result.responseStatus} ERROR${c.reset}`;

    const retryNote =
      result.attempt > 1 ? dim(` (retry ${result.attempt - 1})`) : "";
    const latency = result.latencyMs
      ? dim(` ${result.latencyMs}ms`)
      : "";

    console.log(
      `  [${n}/${total}]  ${c.cyan}${padEnd(d.event, 16)}${c.reset}  ${c.gray}${d.id.slice(0, 8)}${c.reset}  →  ${statusPart}${latency}${retryNote}`
    );

    if (!result.success) {
      failed_ids.push(d.id);
    }
  });

  // ── Summary ───────────────────────────────────────────────────────────────

  const successCount = deliveries.length - failed_ids.length;

  console.log(`
${c.gray}  ──────────────────────────────────────────────${c.reset}`);

  if (failed_ids.length === 0) {
    console.log(
      ok(
        `${bold(String(successCount))}/${deliveries.length} replayed successfully.`
      )
    );
  } else {
    console.log(
      ok(`${c.green}${bold(String(successCount))}${c.reset}/${deliveries.length} replayed successfully.`)
    );
    console.log(
      fail(
        `${c.red}${bold(String(failed_ids.length))}${c.reset}/${deliveries.length} still failing after ${MAX_RETRIES} attempts.`
      )
    );
    console.log();
    console.log(
      dim("  Inspect failures at: https://saperly.com/dashboard/webhooks")
    );
    console.log(
      dim(
        "  Or via API: GET https://saperly.com/api/v1/webhooks/deliveries?status=failed"
      )
    );
  }

  console.log();
  process.exit(failed_ids.length > 0 ? 1 : 0);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function padEnd(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function formatAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(fail(err?.message ?? String(err)));
  process.exit(1);
});
