import assert from "node:assert/strict";
import test from "node:test";
import { BackendError } from "./backend-errors.ts";
import {
  fetchViewer,
  githubGet,
  readLimitedBody,
  retryAfterSeconds,
} from "./github-client.ts";

test("only a validated viewer profile is returned", async () => {
  const token = "test-token";
  const viewer = await fetchViewer(token, async (url) => {
    assert.equal(String(url), "https://api.github.com/user");
    return Response.json({
      login: "Alice",
      avatar_url: "https://avatars.githubusercontent.com/u/1",
      email: "not-returned@example.invalid",
      extra: "private",
    });
  });
  assert.deepEqual(viewer, {
    login: "Alice",
    avatarUrl: "https://avatars.githubusercontent.com/u/1",
  });
  await assert.rejects(
    fetchViewer(token, async () =>
      Response.json({ login: "bad user", avatar_url: "http://evil.invalid" }),
    ),
    BackendError,
  );
});

test("primary and secondary rate limits surface bounded useful retry intervals", async () => {
  const now = Date.parse("2026-09-01T00:00:00Z");
  assert.equal(
    retryAfterSeconds(new Headers({ "retry-after": "20" }), now),
    20,
  );
  assert.equal(
    retryAfterSeconds(
      new Headers({ "retry-after": new Date(now + 45000).toUTCString() }),
      now,
    ),
    45,
  );
  assert.equal(
    retryAfterSeconds(
      new Headers({ "x-ratelimit-reset": String(now / 1000 + 100) }),
      now,
    ),
    100,
  );
  assert.equal(
    retryAfterSeconds(new Headers({ "retry-after": "invalid" }), now),
    60,
  );
  assert.equal(
    retryAfterSeconds(new Headers({ "retry-after": "9999999999" }), now),
    86400,
  );
  for (const [status, message] of [
    [429, "too many requests"],
    [403, "You have exceeded a secondary rate limit"],
  ] as const) {
    await assert.rejects(
      githubGet("/search/commits?q=author:alice", "token", async () =>
        Response.json(
          { message },
          { status, headers: { "retry-after": "22" } },
        ),
      ),
      { status: 429, retryAfter: 22 },
    );
  }
});

test("permission, expiration, validation and service errors are distinct", async () => {
  for (const [status, expected] of [
    [401, 401],
    [403, 403],
    [422, 422],
    [500, 502],
  ]) {
    await assert.rejects(
      githubGet("/user", "token", async () =>
        Response.json({ message: "private upstream data" }, { status }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof BackendError);
        assert.equal(error.status, expected);
        assert.doesNotMatch(error.message, /private upstream data/);
        return true;
      },
    );
  }
});

test("network failures, bad JSON, and partial SSO results are surfaced", async () => {
  await assert.rejects(
    githubGet("/user", "token", async () => {
      throw new TypeError("network");
    }),
    { status: 503, retryAfter: 15 },
  );
  await assert.rejects(
    githubGet("/user", "token", async () => {
      throw new DOMException("timeout", "TimeoutError");
    }),
    { status: 503 },
  );
  await assert.rejects(
    githubGet("/user", "token", async () => new Response("not json")),
    { status: 502 },
  );
  await assert.rejects(
    githubGet("/user", "token", async () =>
      Response.json(
        {},
        { headers: { "x-github-sso": "partial-results; organizations=1" } },
      ),
    ),
    { status: 403 },
  );
});

test("unexpected programming errors are not disguised as network failures", async () => {
  const unexpected = new Error("programming failure");
  await assert.rejects(
    githubGet("/user", "token", async () => {
      throw unexpected;
    }),
    (error: unknown) => error === unexpected,
  );
});

test("non-JSON errors still preserve authentication and rate-limit status", async () => {
  for (const [status, expected] of [
    [401, 401],
    [403, 403],
    [429, 429],
    [502, 502],
  ]) {
    await assert.rejects(
      githubGet(
        "/user",
        "token",
        async () => new Response("an upstream proxy error page", { status }),
      ),
      { status: expected },
    );
  }
});

test("body limits apply to actual bytes even without a content-length header", async () => {
  assert.equal(await readLimitedBody(new Response("hello"), 5), "hello");
  await assert.rejects(readLimitedBody(new Response("hello"), 4), {
    status: 502,
  });
  await assert.rejects(
    readLimitedBody(
      new Response("x", { headers: { "content-length": "200" } }),
      100,
    ),
    { status: 502 },
  );
  await assert.rejects(readLimitedBody(new Response("🚀🚀"), 7), {
    status: 502,
  });
});
