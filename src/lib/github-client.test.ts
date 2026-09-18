import assert from "node:assert/strict";
import test from "node:test";
import { BackendError } from "./backend-errors.ts";
import { authorGraph } from "./commit-author-fixtures.ts";
import {
  fetchViewer,
  githubCommitAuthors,
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

const authorTargets = [{ repository: "owner/repository", sha: "a".repeat(40) }];

test("commit author lookup only sends its known read query to the fixed GraphQL endpoint", async () => {
  await githubCommitAuthors(
    authorTargets,
    "test-token",
    async (url, options) => {
      assert.equal(String(url), "https://api.github.com/graphql");
      assert.equal(options?.method, "POST");
      assert.equal(options.cache, "no-store");
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      const headers = new Headers(options.headers);
      assert.equal(headers.get("authorization"), "Bearer test-token");
      assert.equal(headers.get("content-type"), "application/json");
      const body = JSON.parse(String(options.body));
      assert.match(body.query, /^query CommitAuthors\(/);
      assert.doesNotMatch(body.query, /\bmutation\b|owner\/repository/);
      assert.match(body.query, /authors\(first:100,after:\$after0\)/);
      assert.deepEqual(body.variables, {
        owner0: "owner",
        name0: "repository",
        oid0: "a".repeat(40),
        after0: null,
      });
      return Response.json(authorGraph(options));
    },
  );
});

test("GraphQL observes a shared stage abort before fetching and during response reading", async () => {
  const expired = new AbortController();
  expired.abort(new DOMException("stage expired", "TimeoutError"));
  await assert.rejects(
    githubCommitAuthors(
      authorTargets,
      "token",
      async () =>
        assert.fail("an expired lookup stage must not send a request"),
      expired.signal,
    ),
    { status: 503, retryAfter: 15 },
  );
  const deadline = new AbortController();
  await assert.rejects(
    githubCommitAuthors(
      authorTargets,
      "token",
      async (_url, options) => {
        assert.ok(options?.signal);
        deadline.abort(new DOMException("stage expired", "TimeoutError"));
        assert.equal(options.signal.aborted, true);
        return Response.json(authorGraph(options));
      },
      deadline.signal,
    ),
    { status: 503 },
  );
});

test("invalid GraphQL targets, cursors and missing tokens cannot send a request", async () => {
  for (const targets of [
    [],
    Array.from({ length: 51 }, () => authorTargets[0]),
    [{ ...authorTargets[0], repository: "owner/../../private" }],
    [{ ...authorTargets[0], sha: "mutation {}" }],
    [{ ...authorTargets[0], after: "x".repeat(1025) }],
    [{ ...authorTargets[0], after: "" }],
    [{ ...authorTargets[0], after: "bad\ncursor" }],
  ]) {
    await assert.rejects(
      githubCommitAuthors(targets, "token", async () =>
        assert.fail("invalid lookup must never fetch"),
      ),
      { status: 502 },
    );
  }
  await assert.rejects(
    githubCommitAuthors(authorTargets, "", async () =>
      assert.fail("GraphQL requires a token"),
    ),
    { status: 401 },
  );
});

test("GraphQL HTTP 200 errors fail closed with sanitized rate and access guidance", async () => {
  for (const [error, status] of [
    [{ type: "RATE_LIMITED", message: "private details" }, 429],
    [{ extensions: { code: "RATE_LIMITED" } }, 429],
    [{ message: "secondary rate limit: private details" }, 429],
    [{ type: "FORBIDDEN", message: "private details" }, 403],
    [{ type: "NOT_FOUND", message: "private details" }, 403],
    [{ extensions: { code: "FORBIDDEN" } }, 403],
    [{ message: "private details" }, 502],
  ] as const) {
    await assert.rejects(
      githubCommitAuthors(authorTargets, "token", async (_url, options) =>
        Response.json(
          { ...authorGraph(options), errors: [error] },
          { headers: { "retry-after": "27" } },
        ),
      ),
      (error: unknown) => {
        assert.ok(error instanceof BackendError);
        assert.equal(error.status, status);
        assert.doesNotMatch(error.message, /private details/);
        if (status === 429) assert.equal(error.retryAfter, 27);
        if (status === 403) assert.match(error.message, /Contents: read/);
        return true;
      },
    );
  }
  for (const body of [
    null,
    {},
    { data: null },
    { data: {}, errors: {} },
    { data: {}, errors: [] },
  ]) {
    await assert.rejects(
      githubCommitAuthors(authorTargets, "token", async () =>
        Response.json(body),
      ),
      { status: 502 },
    );
  }
});

test("GraphQL reuses HTTP, SSO, response-size, JSON and network safeguards", async () => {
  for (const [status, expected] of [
    [401, 401],
    [403, 403],
    [429, 429],
    [500, 502],
  ]) {
    await assert.rejects(
      githubCommitAuthors(authorTargets, "token", async () =>
        Response.json({ message: "private details" }, { status }),
      ),
      { status: expected },
    );
  }
  for (const response of [
    new Response("not JSON"),
    Response.json(
      {},
      { headers: { "content-length": String(4 * 1024 * 1024 + 1) } },
    ),
  ]) {
    await assert.rejects(
      githubCommitAuthors(authorTargets, "token", async () => response),
      { status: 502 },
    );
  }
  await assert.rejects(
    githubCommitAuthors(authorTargets, "token", async () =>
      Response.json({}, { headers: { "x-github-sso": "partial-results" } }),
    ),
    { status: 403 },
  );
  await assert.rejects(
    githubCommitAuthors(authorTargets, "token", async () => {
      throw new DOMException("timeout", "TimeoutError");
    }),
    { status: 503 },
  );
});
