import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { EncryptJWT, jwtDecrypt } from "jose";
import {
  assertPublicOrigin,
  assertSameOrigin,
  authorizationUrl,
  cookieName,
  cookieOptions,
  matchesState,
  newOAuthState,
  openCookie,
  readAuthConfig,
  SESSION_SECONDS,
  safeReturnTo,
  sealCookie,
} from "./auth-core.ts";
import { BackendError } from "./backend-errors.ts";

const env = {
  APP_URL: "http://localhost:3000",
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
  SESSION_SECRET: "a-random-development-secret-at-least-32-characters",
};
const config = readAuthConfig(env);
assert.ok(config);
const session = {
  token: "gho_test_token",
  viewer: {
    login: "alice",
    avatarUrl: "https://avatars.githubusercontent.com/u/1",
  },
};

test("auth configuration is optional but a present configuration must be safe", () => {
  assert.equal(readAuthConfig({}), null);
  assert.equal(config.origin, "http://localhost:3000");
  assert.equal(config.secure, false);
  assert.equal(
    readAuthConfig({ ...env, APP_URL: "https://example.com/" })?.secure,
    true,
  );
  for (const url of [
    "https://example.com/path",
    "https://user:pass@example.com",
    "http://example.com",
    "https://example.com?origin=elsewhere",
    "https://example.com/#fragment",
    "not a url",
  ]) {
    assert.throws(() => readAuthConfig({ ...env, APP_URL: url }), BackendError);
  }
  assert.throws(
    () => readAuthConfig({ ...env, SESSION_SECRET: "too-short" }),
    BackendError,
  );
});

test("return URLs retain root query parameters but cannot redirect off site", () => {
  assert.equal(safeReturnTo("/?users=alice,bob"), "/?users=alice,bob");
  assert.equal(safeReturnTo("/?user=alice&user=bob"), "/?user=alice&user=bob");
  assert.equal(
    safeReturnTo("/?next=https://example.com"),
    "/?next=https://example.com",
  );
  for (const value of [
    undefined,
    "//example.com",
    "https://example.com",
    "/\\example.com",
    "/%2f%2fexample.com",
    "/api/auth/github",
    "/?q=\r\nLocation: https://example.com",
    `/?q=${"a".repeat(2048)}`,
  ]) {
    assert.equal(safeReturnTo(value), "/");
  }
});

test("POST origin validation rejects missing, foreign and cross-site origins", () => {
  assert.doesNotThrow(() =>
    assertSameOrigin(new Headers({ origin: config.origin }), config.origin),
  );
  for (const headers of [
    new Headers(),
    new Headers({ origin: "null" }),
    new Headers({ origin: "https://evil.example" }),
    new Headers({ origin: `${config.origin}/` }),
    new Headers({ origin: config.origin, "sec-fetch-site": "cross-site" }),
  ]) {
    assert.throws(() => assertSameOrigin(headers, config.origin), BackendError);
  }
});

test("public requests use the browser-facing host without requiring OAuth configuration", () => {
  for (const [origin, host] of [
    ["http://127.0.0.1:3102", "127.0.0.1:3102"],
    ["http://localhost:3000", "localhost:3000"],
    ["https://party.example", "party.example"],
  ]) {
    assert.doesNotThrow(() =>
      assertPublicOrigin(new Headers({ origin, host })),
    );
  }
  const invalidHeaders: Record<string, string>[] = [
    { host: "localhost:3000" },
    { origin: "null", host: "localhost:3000" },
    { origin: "https://other.example", host: "party.example" },
    { origin: "https://party.example", host: "party.example:3000" },
    { origin: "https://party.example/path", host: "party.example" },
    { origin: "ftp://party.example", host: "party.example" },
    {
      origin: "https://party.example",
      host: "party.example",
      "sec-fetch-site": "cross-site",
    },
    {
      origin: "https://party.example",
      host: "internal:3000",
      "x-forwarded-host": "party.example",
    },
  ];
  for (const headers of invalidHeaders) {
    assert.throws(() => assertPublicOrigin(new Headers(headers)), BackendError);
  }
});

test("OAuth authorization includes state, PKCE S256, canonical callback and scopes", () => {
  const state = newOAuthState("/?users=alice,bob");
  const second = newOAuthState("/");
  assert.notEqual(state.state, second.state);
  assert.notEqual(state.state, state.verifier);
  assert.equal(matchesState(state.state, state.state), true);
  assert.equal(matchesState(state.state, second.state), false);
  assert.equal(matchesState(state.state, "short"), false);
  assert.equal(matchesState(state.state, null), false);
  const url = new URL(authorizationUrl(config, state));
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.pathname, "/login/oauth/authorize");
  assert.equal(url.searchParams.get("state"), state.state);
  assert.equal(url.searchParams.get("scope"), "repo read:user");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    `${config.origin}/api/auth/callback`,
  );
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("code_challenge"),
    createHash("sha256").update(state.verifier).digest("base64url"),
  );
  assert.equal(url.searchParams.has("client_secret"), false);
});

test("session JWE encrypts the token and has a fixed, non-sliding 12-hour lifetime", async () => {
  const cookie = await sealCookie(config, "session", session);
  assert.equal(cookie.includes(session.token), false);
  assert.deepEqual(await openCookie(config, "session", cookie), session);
  const { payload } = await jwtDecrypt(
    cookie,
    createHash("sha256").update(config.secret).digest(),
  );
  assert.equal((payload.exp ?? 0) - (payload.iat ?? 0), SESSION_SECONDS);
  assert.equal(await openCookie(config, "oauth", cookie), null);
  assert.equal(
    await openCookie(
      { ...config, secret: "another-secret-of-at-least-32-characters" },
      "session",
      cookie,
    ),
    null,
  );
  assert.equal(
    await openCookie(
      { ...config, origin: "https://elsewhere.example" },
      "session",
      cookie,
    ),
    null,
  );
  assert.equal(await openCookie(config, "session", `${cookie}corrupt`), null);
  assert.equal(await openCookie(config, "session", undefined), null);
  assert.equal(await openCookie(config, "session", "invalid"), null);
});

test("expired and malformed encrypted session data is unauthenticated", async () => {
  const now = Math.floor(Date.now() / 1000);
  const expired = await new EncryptJWT({ data: session })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuer(config.origin)
    .setAudience("git-blamed:session")
    .setIssuedAt(now - SESSION_SECONDS - 10)
    .setExpirationTime(now - 10)
    .encrypt(createHash("sha256").update(config.secret).digest());
  assert.equal(await openCookie(config, "session", expired), null);
  const malformed = await sealCookie(config, "session", {
    ...session,
    viewer: { login: "not/a/user", avatarUrl: session.viewer.avatarUrl },
  });
  assert.equal(await openCookie(config, "session", malformed), null);
});

test("OAuth cookies are purpose-bound and reject unsafe stored return URLs", async () => {
  const state = newOAuthState("/?users=alice,bob");
  const cookie = await sealCookie(config, "oauth", state);
  assert.deepEqual(await openCookie(config, "oauth", cookie), state);
  assert.equal(await openCookie(config, "session", cookie), null);
  const unsafe = await sealCookie(config, "oauth", {
    ...state,
    returnTo: "//evil.example",
  });
  assert.equal(await openCookie(config, "oauth", unsafe), null);
});

test("cookie settings use host-bound secure cookies on HTTPS", () => {
  assert.equal(cookieName(config, "session"), "git-blamed-session");
  const secure = { ...config, secure: true };
  assert.equal(cookieName(secure, "session"), "__Host-git-blamed-session");
  assert.deepEqual(cookieOptions(secure, SESSION_SECONDS), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: SESSION_SECONDS,
  });
});
