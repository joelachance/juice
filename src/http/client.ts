type Json = Record<string, unknown>;

export async function requestJson<T>(url: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);

  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) as Json : {};
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export function apiBase(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.JUICE_API_URL || "https://api.juice.run").replace(/\/+$/, "");
  const parsed = new URL(base);
  if (parsed.protocol === "https:") return base;
  if (parsed.protocol === "http:" && (isLocalhost(parsed.hostname) || env.JUICE_ALLOW_INSECURE === "1")) return base;
  throw new Error("JUICE_API_URL must use https unless it points at localhost or JUICE_ALLOW_INSECURE=1 is set");
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
