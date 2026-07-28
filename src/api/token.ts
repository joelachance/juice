import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const TOKEN_ISSUER = "juice";
export const TOKEN_AUDIENCE = "juice-api";
export const USER_TOKEN_TTL_SECONDS = 12 * 60 * 60;
export const MACHINE_TOKEN_MAX_TTL_SECONDS = 90 * 24 * 60 * 60;

export type TokenAction = "read" | "write";

export type TokenScope = {
  project: string;
  env: string;
  actions: TokenAction[];
};

export type AuthPrincipal = {
  /** Who acted. Stays a login identity ("github:123") so the audit log names a person. */
  sub: string;
  /** Whose data. The account the token may address; never taken from the request. */
  acc: string;
  login?: string;
  iat: number;
  exp: number;
  jti: string;
  iss: typeof TOKEN_ISSUER;
  aud: typeof TOKEN_AUDIENCE;
  scope?: TokenScope;
};

export type SignTokenOptions = {
  ttlSeconds?: number;
  now?: number;
  jti?: string;
};

export function signToken(
  principal: Pick<AuthPrincipal, "sub" | "acc" | "login" | "scope">,
  secret: string,
  options: SignTokenOptions = {}
): string {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ttlSeconds = options.ttlSeconds ?? USER_TOKEN_TTL_SECONDS;
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload: AuthPrincipal = {
    ...principal,
    sub: principal.sub.trim(),
    iat: now,
    exp: now + ttlSeconds,
    jti: options.jti ?? randomUUID(),
    iss: TOKEN_ISSUER,
    aud: TOKEN_AUDIENCE
  };
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = hmac(`${header}.${encodedPayload}`, secret);
  return `${header}.${encodedPayload}.${signature}`;
}

export function verifyToken(token: string, secret: string, now = Math.floor(Date.now() / 1000)): AuthPrincipal | undefined {
  const [encodedHeader, encodedPayload, signature, extra] = token.split(".");
  if (!encodedHeader || !encodedPayload || !signature || extra !== undefined) return undefined;
  const expected = hmac(`${encodedHeader}.${encodedPayload}`, secret);
  if (!safeEqual(signature, expected)) return undefined;

  try {
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as { alg?: unknown; typ?: unknown };
    if (header.alg !== "HS256" || header.typ !== "JWT") return undefined;
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<AuthPrincipal>;
    if (!isValidPrincipal(payload, now)) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

function isValidPrincipal(payload: Partial<AuthPrincipal>, now: number): payload is AuthPrincipal {
  if (payload.iss !== TOKEN_ISSUER || payload.aud !== TOKEN_AUDIENCE) return false;
  if (typeof payload.sub !== "string" || payload.sub.trim() === "") return false;
  if (typeof payload.jti !== "string" || payload.jti.trim() === "") return false;
  if (typeof payload.iat !== "number" || !Number.isInteger(payload.iat)) return false;
  if (typeof payload.exp !== "number" || !Number.isInteger(payload.exp)) return false;
  if (payload.iat > now + 60) return false;
  if (payload.exp <= now || payload.exp <= payload.iat) return false;
  if (payload.scope !== undefined && !isValidScope(payload.scope)) return false;
  return true;
}

function isValidScope(scope: TokenScope): boolean {
  if (typeof scope !== "object" || scope === null) return false;
  if (typeof scope.project !== "string" || scope.project.trim() === "") return false;
  if (typeof scope.env !== "string" || scope.env.trim() === "") return false;
  if (!Array.isArray(scope.actions) || scope.actions.length === 0) return false;
  return scope.actions.every((action) => action === "read" || action === "write");
}

function hmac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
