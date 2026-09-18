import assert from "node:assert/strict";
import test from "node:test";
import { BackendError, isSecureTokenOrigin } from "./backend-errors.ts";
import {
  assertTokenRequest,
  connectToken,
  readBearerToken,
} from "./token-auth.ts";

test("tokens connect without configuration and only return a viewer profile", async () => {
  const viewer = await connectToken(
    { token: "  github_pat_test_token  " },
    async (url, options) => {
      assert.equal(String(url), "https://api.github.com/user");
      assert.equal(options?.method, "GET");
      assert.equal(options?.cache, "no-store");
      assert.equal(
        new Headers(options?.headers).get("authorization"),
        "Bearer github_pat_test_token",
      );
      return Response.json({
        login: "test-host",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        email: "not-returned@example.invalid",
        token: "not-returned",
      });
    },
  );
  assert.deepEqual(viewer, {
    login: "test-host",
    avatarUrl: "https://avatars.githubusercontent.com/u/1",
  });
});

test("invalid token input never reaches GitHub or appears in an error", async () => {
  for (const body of [
    null,
    [],
    {},
    { token: "" },
    { token: " " },
    { token: "secret\ninjection" },
    { token: "secret invalid" },
    { token: "x".repeat(513) },
    { token: "token", extra: true },
  ]) {
    await assert.rejects(
      connectToken(body, async () =>
        assert.fail("invalid tokens must not be sent"),
      ),
      (error: unknown) => {
        assert.ok(error instanceof BackendError);
        assert.equal(error.status, 400);
        assert.doesNotMatch(error.message, /secret/);
        return true;
      },
    );
  }
});

test("rejected tokens surface a clear error without accepting a connection", async () => {
  await assert.rejects(
    connectToken({ token: "invalid-token" }, async () =>
      Response.json({ message: "private upstream details" }, { status: 401 }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof BackendError);
      assert.equal(error.status, 401);
      assert.match(error.message, /rejected this token/);
      assert.doesNotMatch(
        error.message,
        /invalid-token|private upstream details/,
      );
      return true;
    },
  );
});

test("rate limits and SSO failures remain actionable", async () => {
  await assert.rejects(
    connectToken({ token: "test-token" }, async () =>
      Response.json({}, { status: 429, headers: { "retry-after": "25" } }),
    ),
    { status: 429, retryAfter: 25 },
  );
  await assert.rejects(
    connectToken({ token: "test-token" }, async () =>
      Response.json({}, { status: 403 }),
    ),
    { status: 403 },
  );
});

test("authorization headers are optional but malformed values never fall back to another session", () => {
  assert.equal(readBearerToken(null), undefined);
  assert.equal(readBearerToken("Bearer ghp_example"), "ghp_example");
  assert.equal(
    readBearerToken("bearer github_pat_example"),
    "github_pat_example",
  );
  for (const value of [
    "",
    "Basic secret",
    "Bearer ",
    "Bearer secret token",
    `Bearer ${"x".repeat(513)}`,
  ]) {
    assert.throws(() => readBearerToken(value), BackendError);
  }
});

test("token requests require HTTPS outside localhost and reject cross-origin requests", () => {
  for (const [origin, host] of [
    ["https://party.example", "party.example"],
    ["http://localhost:3000", "localhost:3000"],
    ["http://127.0.0.1:3104", "127.0.0.1:3104"],
    ["http://[::1]:3000", "[::1]:3000"],
  ]) {
    assert.equal(isSecureTokenOrigin(origin), true);
    assert.doesNotThrow(() =>
      assertTokenRequest(new Headers({ origin, host })),
    );
  }
  for (const origin of [
    "http://party.example",
    "http://localhost.example",
    "ftp://localhost",
    "not a URL",
  ]) {
    assert.equal(isSecureTokenOrigin(origin), false);
  }
  assert.throws(
    () =>
      assertTokenRequest(
        new Headers({ origin: "http://party.example", host: "party.example" }),
      ),
    { status: 400 },
  );
  assert.throws(
    () =>
      assertTokenRequest(
        new Headers({ origin: "https://other.example", host: "party.example" }),
      ),
    { status: 403 },
  );
  assert.throws(() => assertTokenRequest(new Headers()), { status: 403 });
});
