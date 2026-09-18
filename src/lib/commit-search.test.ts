import assert from "node:assert/strict";
import test from "node:test";
import { BackendError } from "./backend-errors.ts";
import {
  isCommitNoise,
  rankCommits,
  scoreMessage,
  searchCommitBatch,
  validateCommitRequest,
} from "./commit-search.ts";
import type { Fetcher } from "./github-client.ts";

function item(
  index = 1,
  author = "alice",
  message = "why does this work now?",
) {
  return {
    sha: index.toString(16).padStart(40, "0"),
    author: {
      login: author,
      avatar_url: "https://avatars.githubusercontent.com/u/1",
    },
    committer: { login: "someone-else" },
    commit: {
      message,
      author: { name: "Untrusted raw git author" },
      committer: { date: "2026-09-01T12:30:00Z" },
    },
    repository: { full_name: "owner/repository" },
  };
}

function searchResponse(items: unknown[], totalCount = items.length) {
  return Response.json({
    total_count: totalCount,
    incomplete_results: false,
    items,
  });
}

const request = { usernames: ["alice"], cursors: {} };

test("request validation normalizes usernames and rejects unbounded or injected searches", () => {
  assert.deepEqual(
    validateCommitRequest({ usernames: [" Alice ", "BOB"], cursors: {} }),
    {
      usernames: ["alice", "bob"],
      cursors: {},
    },
  );
  for (const value of [
    null,
    {},
    { usernames: [], cursors: {} },
    { usernames: Array.from({ length: 9 }, (_, i) => `user${i}`), cursors: {} },
    { usernames: ["alice", "ALICE"], cursors: {} },
    { usernames: ["alice repo:secret/project"], cursors: {} },
    { usernames: ["a--b"], cursors: {} },
    { usernames: ["a".repeat(40)], cursors: {} },
    { usernames: ["alice"], cursors: { bob: { page: 1, exhausted: false } } },
    { usernames: ["alice"], cursors: {}, requireAuth: "false" },
    { usernames: ["alice"], cursors: {}, requireAuth: null },
    {
      usernames: ["alice"],
      cursors: { alice: { page: 11, exhausted: false } },
    },
    {
      usernames: ["alice"],
      cursors: { alice: { page: 1.5, exhausted: false } },
    },
    { usernames: ["alice"], cursors: { alice: { page: 0, exhausted: false } } },
    {
      usernames: ["alice"],
      cursors: { alice: { page: 1, exhausted: "false" } },
    },
    {
      usernames: ["alice"],
      cursors: { alice: { page: 1, exhausted: false, q: "all" } },
    },
  ]) {
    assert.throws(() => validateCommitRequest(value), BackendError);
  }
});

test("invalid input causes no upstream requests", async () => {
  let calls = 0;
  await assert.rejects(
    searchCommitBatch(
      { usernames: ["alice OR author:bob"], cursors: {} },
      "token",
      async () => {
        calls++;
        return searchResponse([]);
      },
    ),
    { status: 400 },
  );
  assert.equal(calls, 0);
});

test("valid usernames that match object properties still begin at page one", async () => {
  const result = await searchCommitBatch(
    { usernames: ["constructor"], cursors: {} },
    "token",
    async (url) => {
      const query = new URL(String(url)).searchParams;
      assert.equal(query.get("q"), "author:constructor");
      assert.equal(query.get("page"), "1");
      return searchResponse([item(1, "constructor")]);
    },
  );
  assert.equal(result.commits[0].author, "constructor");
  assert.deepEqual(result.cursors.constructor, { page: 2, exhausted: true });
});

test("queries only requested authors with bounded GETs, timeout and no-store", async () => {
  const fetcher: Fetcher = async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(url.pathname, "/search/commits");
    assert.equal(url.searchParams.get("q"), "author:alice");
    assert.equal(url.searchParams.get("sort"), "committer-date");
    assert.equal(url.searchParams.get("order"), "desc");
    assert.equal(url.searchParams.get("per_page"), "100");
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(options?.method, "GET");
    assert.equal(options?.cache, "no-store");
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal instanceof AbortSignal);
    assert.equal(
      new Headers(options?.headers).get("authorization"),
      "Bearer test-token",
    );
    return searchResponse([item()]);
  };
  const result = await searchCommitBatch(request, "test-token", fetcher);
  assert.equal(result.commits.length, 1);
  assert.equal(result.commits[0].author, "alice");
  assert.equal(
    result.commits[0].url,
    `https://github.com/owner/repository/commit/${item().sha}`,
  );
  assert.deepEqual(result.cursors, { alice: { page: 2, exhausted: true } });
  assert.equal(result.exhausted, true);
});

test("unsigned searches fetch public commits without an Authorization header", async () => {
  const result = await searchCommitBatch(
    request,
    undefined,
    async (url, options) => {
      assert.equal(new Headers(options?.headers).has("authorization"), false);
      assert.equal(new URL(String(url)).searchParams.get("q"), "author:alice");
      return searchResponse([item()]);
    },
  );
  assert.equal(result.commits[0].author, "alice");
  assert.deepEqual(result.cursors.alice, { page: 2, exhausted: true });
});

test("public games stay public even if a session becomes available between pages", async () => {
  const result = await searchCommitBatch(
    {
      ...request,
      requireAuth: false,
      cursors: { alice: { page: 2, exhausted: false } },
    },
    "available-session-token",
    async (url, options) => {
      assert.equal(new Headers(options?.headers).has("authorization"), false);
      assert.equal(new URL(String(url)).searchParams.get("page"), "2");
      return searchResponse([item()], 101);
    },
  );
  assert.equal(result.commits.length, 1);
  assert.equal(result.exhausted, true);
});

test("private games require a token rather than silently switching to public search", async () => {
  await assert.rejects(
    searchCommitBatch({ ...request, requireAuth: true }, undefined, async () =>
      assert.fail("an expired private session must not make a public search"),
    ),
    { status: 401 },
  );
  const result = await searchCommitBatch(
    { ...request, requireAuth: true },
    "session-token",
    async (_url, options) => {
      assert.equal(new Headers(options?.headers).has("authorization"), true);
      return searchResponse([item()]);
    },
  );
  assert.equal(result.commits.length, 1);
});

test("anonymous rate limits preserve the retry interval and the current page", async () => {
  const input = { ...request, requireAuth: false };
  await assert.rejects(
    searchCommitBatch(input, undefined, async () =>
      Response.json(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "retry-after": "30" },
        },
      ),
    ),
    { status: 429, retryAfter: 30 },
  );
  assert.deepEqual(input.cursors, {});
});

test("public empty-search guidance does not assume a signed-in host", async () => {
  const result = await searchCommitBatch(request, undefined, async () =>
    searchResponse([]),
  );
  assert.match(result.warnings[0], /no indexed public commits/);
  assert.match(result.warnings[0], /optional token connection/);
});

test("linked author, not committer or raw git author, decides attribution", async () => {
  const result = await searchCommitBatch(request, "token", async () =>
    searchResponse([
      item(1, "ALICE"),
      { ...item(2, "bob"), committer: { login: "alice" } },
      { ...item(3), author: null, committer: { login: "alice" } },
      item(4, "alice-other"),
    ]),
  );
  assert.deepEqual(
    result.commits.map((commit) => commit.author),
    ["alice"],
  );
  assert.equal(result.commits[0].id, item(1).sha);
});

test("fork duplicates are deduplicated by SHA and obvious noise is removed", async () => {
  const result = await searchCommitBatch(request, "token", async () =>
    searchResponse([
      item(1),
      { ...item(1), repository: { full_name: "forker/fork" } },
      item(2, "alice", "Merge pull request #123 from alice/branch"),
      item(3, "alice", "chore(deps): bump next from 1 to 2"),
      item(4, "alice", "fix"),
    ]),
  );
  assert.equal(result.commits.length, 2);
  assert.ok(result.commits.some((commit) => commit.message === "fix"));
  assert.equal(result.commits[0].message, item().commit.message);
});

test("only the subject is shown, keeping explanatory bodies and author trailers hidden", async () => {
  const result = await searchCommitBatch(request, "token", async () =>
    searchResponse([
      item(
        1,
        "alice",
        "oops, again\r\n\r\nAlice fixed the backend.\r\nCo-authored-by: Bob <bob@example.com>",
      ),
    ]),
  );
  assert.equal(result.commits[0].message, "oops, again");
});

test("empty filtered pages still advance until actual search exhaustion", async () => {
  const input = {
    usernames: ["alice"],
    cursors: { alice: { page: 3, exhausted: false } },
  };
  const snapshot = structuredClone(input);
  const result = await searchCommitBatch(input, "token", async (url) => {
    assert.equal(new URL(String(url)).searchParams.get("page"), "3");
    return searchResponse(
      Array.from({ length: 100 }, (_, i) =>
        item(i, "alice", "Merge branch 'main'"),
      ),
      450,
    );
  });
  assert.deepEqual(result.commits, []);
  assert.deepEqual(result.cursors, { alice: { page: 4, exhausted: false } });
  assert.equal(result.exhausted, false);
  assert.deepEqual(input, snapshot);
});

test("searches above the 1000-result cap advance without a warning", async () => {
  const result = await searchCommitBatch(request, "token", async () =>
    searchResponse(
      Array.from({ length: 100 }, (_, i) => item(i)),
      1250,
    ),
  );
  assert.deepEqual(result.cursors, { alice: { page: 2, exhausted: false } });
  assert.equal(result.exhausted, false);
  assert.deepEqual(result.warnings, []);
});

test("the 1000-result boundary stops pagination without a warning", async () => {
  for (const totalCount of [1000, 1250]) {
    const result = await searchCommitBatch(
      {
        usernames: ["alice"],
        cursors: { alice: { page: 10, exhausted: false } },
      },
      "token",
      async () =>
        searchResponse(
          Array.from({ length: 100 }, (_, i) => item(i)),
          totalCount,
        ),
    );
    assert.deepEqual(result.cursors, { alice: { page: 11, exhausted: true } });
    assert.equal(result.exhausted, true);
    assert.deepEqual(result.warnings, []);
    const skipped = await searchCommitBatch(
      { usernames: ["alice"], cursors: result.cursors },
      "token",
      async () => assert.fail("exhausted cursors must not issue a request"),
    );
    assert.deepEqual(skipped.commits, []);
    assert.equal(skipped.exhausted, true);
  }
});

test("all users need to be exhausted; usernames cannot leak across searches", async () => {
  const result = await searchCommitBatch(
    {
      usernames: ["alice", "bob"],
      cursors: { alice: { page: 2, exhausted: true } },
    },
    "token",
    async (url) => {
      assert.equal(new URL(String(url)).searchParams.get("q"), "author:bob");
      return searchResponse(
        Array.from({ length: 100 }, (_, i) => item(i, "bob")),
        250,
      );
    },
  );
  assert.equal(result.exhausted, false);
  assert.ok(result.commits.every((commit) => commit.author === "bob"));
  assert.deepEqual(result.cursors.alice, { page: 2, exhausted: true });
});

test("an upstream failure fails the entire batch without mutating cursors", async () => {
  const input = { usernames: ["alice", "bob"], cursors: {} };
  await assert.rejects(
    searchCommitBatch(input, "token", async (url) =>
      new URL(String(url)).searchParams.get("q") === "author:alice"
        ? searchResponse([item()])
        : Response.json(
            { message: "API rate limit exceeded: private details" },
            {
              status: 403,
              headers: { "x-ratelimit-remaining": "0", "retry-after": "25" },
            },
          ),
    ),
    (error: unknown) => {
      assert.ok(error instanceof BackendError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfter, 25);
      assert.doesNotMatch(error.message, /private details/);
      return true;
    },
  );
  assert.deepEqual(input.cursors, {});
});

test("incomplete and malformed upstream results fail instead of skipping pages", async () => {
  for (const body of [
    { total_count: 100, incomplete_results: true, items: [item()] },
    { total_count: "100", incomplete_results: false, items: [] },
    { total_count: 100, incomplete_results: false, items: [null] },
    {
      total_count: 100,
      incomplete_results: false,
      items: [{ ...item(), sha: "no" }],
    },
    {
      total_count: 100,
      incomplete_results: false,
      items: [{ ...item(), author: undefined }],
    },
    {
      total_count: 1,
      incomplete_results: false,
      items: [
        {
          ...item(),
          author: { login: "alice", avatar_url: "https://evil.example/a" },
        },
      ],
    },
  ]) {
    await assert.rejects(
      searchCommitBatch(request, "token", async () => Response.json(body)),
      BackendError,
    );
  }
});

test("messages are bounded, ordinary commits retained, and ranking favors funny subjects", async () => {
  assert.equal(isCommitNoise("Bump lodash from 1.0 to 2.0"), true);
  assert.equal(isCommitNoise("finally fixed the dependency disaster"), false);
  assert.ok(scoreMessage("why does this work now?!") > scoreMessage("fix"));
  const result = await searchCommitBatch(request, "token", async () =>
    searchResponse([
      item(1, "alice", `\u0000${"a".repeat(2000)}`),
      item(2, "alice", "why does this work now?!"),
      item(3, "alice", "fix"),
    ]),
  );
  assert.equal(
    result.commits.find((commit) => commit.id === item(1).sha)?.message.length,
    1000,
  );
  assert.equal(rankCommits(result.commits, () => 0)[0].id, item(2).sha);
});

test("an empty search exposes visibility and indexing caveats", async () => {
  const result = await searchCommitBatch(request, "token", async () =>
    searchResponse([]),
  );
  assert.equal(result.exhausted, true);
  assert.match(result.warnings[0], /no indexed commits visible to the host/);
});

test("a short page contradicting the search count fails instead of claiming exhaustion", async () => {
  await assert.rejects(
    searchCommitBatch(request, "token", async () => searchResponse([], 200)),
    { status: 503, retryAfter: 30 },
  );
});
