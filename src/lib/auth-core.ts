import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EncryptJWT, errors, jwtDecrypt } from "jose";
import {
  BackendError,
  isAvatarUrl,
  isRecord,
  isUsername,
} from "./backend-errors.ts";
import type { Viewer } from "./types.ts";

export const SESSION_SECONDS = 12 * 60 * 60;
export const OAUTH_SECONDS = 10 * 60;

export type AuthConfig = {
  origin: string;
  clientId: string;
  clientSecret: string;
  secret: string;
  secure: boolean;
};

export type Session = {
  token: string;
  viewer: Viewer;
};

export type OAuthState = {
  state: string;
  verifier: string;
  returnTo: string;
};

export function readAuthConfig(
  env: Record<string, string | undefined>,
): AuthConfig | null {
  const {
    APP_URL: appUrl,
    GITHUB_CLIENT_ID: clientId,
    GITHUB_CLIENT_SECRET: clientSecret,
    SESSION_SECRET: secret,
  } = env;
  if (!appUrl || !clientId || !clientSecret || !secret) return null;
  if (
    secret.length < 32 ||
    clientId.length > 256 ||
    clientSecret.length > 1024 ||
    /[\r\n]/.test(clientId + clientSecret)
  ) {
    throw new BackendError("GitHub sign-in is not configured correctly.", 503);
  }
  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    throw new BackendError("APP_URL must be a canonical app origin.", 503);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new BackendError(
      "APP_URL must be an HTTPS origin (HTTP is allowed on localhost).",
      503,
    );
  }
  return {
    origin: url.origin,
    clientId,
    clientSecret,
    secret,
    secure: url.protocol === "https:",
  };
}

export function safeReturnTo(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !/^\/(?:\?|$)/.test(value) ||
    /[\\\p{Cc}]/u.test(value)
  ) {
    return "/";
  }
  const url = new URL(value, "https://app.invalid");
  return url.origin === "https://app.invalid" && url.pathname === "/"
    ? `${url.pathname}${url.search}`
    : "/";
}

export function assertSameOrigin(
  headers: Pick<Headers, "get">,
  origin: string,
): void {
  if (
    headers.get("origin") !== origin ||
    headers.get("sec-fetch-site") === "cross-site"
  ) {
    throw new BackendError(
      "This request must come from the app's configured origin.",
      403,
    );
  }
}

export function assertPublicOrigin(headers: Pick<Headers, "get">): void {
  const origin = headers.get("origin");
  const url = origin && URL.canParse(origin) ? new URL(origin) : null;
  // Next.js can normalize request URLs to an internal host behind a proxy.
  if (
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    origin !== url.origin ||
    url.host !== headers.get("host")?.toLowerCase() ||
    headers.get("sec-fetch-site") === "cross-site"
  ) {
    throw new BackendError(
      "This request must come from the app's own origin.",
      403,
    );
  }
}

export function newOAuthState(returnTo: unknown): OAuthState {
  return {
    state: randomBytes(32).toString("base64url"),
    verifier: randomBytes(32).toString("base64url"),
    returnTo: safeReturnTo(returnTo),
  };
}

export function matchesState(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string" || !/^[\w-]{43}$/.test(actual)) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authorizationUrl(
  config: AuthConfig,
  state: OAuthState,
): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `${config.origin}/api/auth/callback`,
    scope: "repo read:user",
    state: state.state,
    code_challenge: createHash("sha256")
      .update(state.verifier)
      .digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

function key(config: AuthConfig): Uint8Array {
  return createHash("sha256").update(config.secret).digest();
}

export async function sealCookie(
  config: AuthConfig,
  kind: "session" | "oauth",
  data: Session | OAuthState,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encrypted = await new EncryptJWT({ data })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuer(config.origin)
    .setAudience(`git-blamed:${kind}`)
    .setIssuedAt(now)
    .setExpirationTime(
      now + (kind === "session" ? SESSION_SECONDS : OAUTH_SECONDS),
    )
    .encrypt(key(config));
  if (encrypted.length > 3800) {
    throw new BackendError(
      "GitHub sign-in data was too large to save securely. Please try again.",
      502,
    );
  }
  return encrypted;
}

export async function openCookie(
  config: AuthConfig,
  kind: "session" | "oauth",
  value: string | undefined,
): Promise<Session | OAuthState | null> {
  if (!value || value.length > 4096) return null;
  let data: unknown;
  try {
    const { payload } = await jwtDecrypt(value, key(config), {
      issuer: config.origin,
      audience: `git-blamed:${kind}`,
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
      requiredClaims: ["iat", "exp"],
      maxTokenAge: kind === "session" ? SESSION_SECONDS : OAUTH_SECONDS,
    });
    data = payload.data;
  } catch (error) {
    if (
      error instanceof errors.JWTExpired ||
      error instanceof errors.JWTClaimValidationFailed ||
      error instanceof errors.JWEDecryptionFailed ||
      error instanceof errors.JWEInvalid ||
      error instanceof errors.JWTInvalid ||
      error instanceof errors.JOSEAlgNotAllowed
    ) {
      return null;
    }
    throw error;
  }
  if (!isRecord(data)) return null;
  if (kind === "session") {
    if (
      typeof data.token !== "string" ||
      !/^[\w-]{1,512}$/.test(data.token) ||
      !isRecord(data.viewer) ||
      !isUsername(data.viewer.login) ||
      !isAvatarUrl(data.viewer.avatarUrl)
    ) {
      return null;
    }
    return {
      token: data.token,
      viewer: {
        login: data.viewer.login,
        avatarUrl: data.viewer.avatarUrl,
      },
    };
  }
  if (
    typeof data.state !== "string" ||
    !/^[\w-]{43}$/.test(data.state) ||
    typeof data.verifier !== "string" ||
    !/^[\w-]{43}$/.test(data.verifier) ||
    typeof data.returnTo !== "string" ||
    data.returnTo !== safeReturnTo(data.returnTo)
  ) {
    return null;
  }
  return {
    state: data.state,
    verifier: data.verifier,
    returnTo: data.returnTo,
  };
}

export function cookieName(
  config: AuthConfig,
  kind: "session" | "oauth",
): string {
  return `${config.secure ? "__Host-" : ""}git-blamed-${kind}`;
}

export function cookieOptions(config: AuthConfig, maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.secure,
    path: "/",
    maxAge,
  };
}
