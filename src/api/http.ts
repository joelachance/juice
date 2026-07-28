/**
 * Request and response plumbing shared by every route.
 *
 * `readJson` caps the body: an unbounded read is a free denial of service on
 * an endpoint that has not authenticated the caller yet.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/** Caps an unauthenticated read so a body cannot be a free denial of service. */
const MAX_JSON_BYTES = 64 * 1024;

export async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_JSON_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "Malformed JSON");
  }
}

export function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  if (status === 204) {
    res.end();
    return;
  }
  res.end(`${JSON.stringify(body)}\n`);
}

export function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return firstForwarded?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}

export class TokenBucketLimiter {
  readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(readonly limit: number, readonly windowMs: number) {}

  allow(key: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (bucket.count >= this.limit) return false;
    bucket.count += 1;
    return true;
  }
}


export class HttpError extends Error {
  constructor(readonly status: number, readonly publicMessage: string) {
    super(publicMessage);
  }
}
