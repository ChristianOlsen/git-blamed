import assert from "node:assert/strict";
import test from "node:test";
import { BackendError } from "./backend-errors.ts";
import { authorCommit, authorGraph } from "./commit-author-fixtures.ts";
import { initialCommitCursor } from "./commit-cursor.ts";
import type { Fetcher } from "./github-client.ts";
import { fetchPullRequestCommits } from "./pull-request-commits.ts";
import type { PullRequestCursor } from "./types.ts";

function pull(number = 1, overrides: Record<string, unknown> = {}) {
  return {
    number,
    repository_url: "https://api.github.com/repos/owner/repository",
    user: { login: "alice" },
    pull_request: {
      url: `https://api.github.com/repos/owner/repository/pulls/${number}`,
    },
    ...overrides,
  };
}

function commit(index = 1, author = "alice", message = "why is this working?") {
  return {
    sha: index.toString(16).padStart(40, "0"),
    author: {
      login: author,
      avatar_url: "https://avatars.githubusercontent.com/u/1",
    },
    committer: { login: "merge-bot" },
    commit: {
      message,
      author: { name: "Not a GitHub identity" },
      committer: { date: "2026-09-01T12:30:00Z" },
    },
  };
}

function search(items: unknown[], totalCount = items.length) {
  return { total_count: totalCount, incomplete_results: false, items };
}

function pendingCursor(overrides: Partial<PullRequestCursor> = {}) {
  return {
    page: 2,
    exhausted: true,
    pending: [{ repository: "owner/repository", number: 1 }],
    commitPage: 1,
    ...overrides,
  };
}

function mockFetcher(respond: (url: URL, options?: RequestInit) => unknown) {
  const calls: URL[] = [];
  const fetcher: Fetcher = async (input, options) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(options?.method, "GET");
    assert.equal(options?.cache, "no-store");
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal instanceof AbortSignal);
    const response = respond(url, options);
    return response instanceof Response ? response : Response.json(response);
  };
  return { calls, fetcher };
}

test("discovers authored open, closed and merged PRs without a state filter", async () => {
  const original = initialCommitCursor().pullRequests;
  const snapshot = structuredClone(original);
  const { calls, fetcher } = mockFetcher((url) => {
    if (url.pathname === "/search/issues") {
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        q: "type:pr author:alice",
        sort: "updated",
        order: "desc",
        per_page: "5",
        page: "1",
      });
      return search([
        pull(1, { state: "open", user: { login: "ALICE" } }),
        pull(2, { state: "closed" }),
        pull(3, {
          state: "closed",
          pull_request: {
            url: "https://api.github.com/repos/owner/repository/pulls/3",
            merged_at: "2026-09-01T12:30:00Z",
          },
        }),
      ]);
    }
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      per_page: "100",
      page: "1",
    });
    const number = Number(url.pathname.split("/").at(-2));
    return [commit(number)];
  });
  let cursor = original;
  for (const number of [1, 2, 3]) {
    const before = structuredClone(cursor);
    const result = await fetchPullRequestCommits(
      "alice",
      cursor,
      undefined,
      fetcher,
    );
    assert.equal(result.commits[0].id, commit(number).sha);
    assert.equal(result.commits[0].repository, "owner/repository");
    assert.equal(
      result.commits[0].url,
      `https://github.com/owner/repository/commit/${commit(number).sha}`,
    );
    assert.deepEqual(cursor, before);
    cursor = result.cursor;
    assert.equal(cursor.pending.length, 3 - number);
  }
  assert.deepEqual(cursor, {
    page: 2,
    exhausted: true,
    pending: [],
    commitPage: 1,
  });
  assert.deepEqual(
    calls.map((url) => url.pathname),
    [
      "/search/issues",
      "/repos/owner/repository/pulls/1/commits",
      "/repos/owner/repository/pulls/2/commits",
      "/repos/owner/repository/pulls/3/commits",
    ],
  );
  assert.deepEqual(original, snapshot);
});

test("PR ownership, raw authors and committers never substitute for the linked commit author", async () => {
  const { fetcher } = mockFetcher(() => [
    commit(1, "ALICE"),
    { ...commit(2, "bob"), committer: { login: "alice" } },
    { ...commit(3), author: null, committer: { login: "alice" } },
    commit(4, "alice-other"),
    commit(5, "alice", "fix: keep the useful subject\n\nMerge branch 'main'"),
    commit(6, "alice", "Merge pull request #1 from alice/topic\n\nwhy?!"),
    commit(7, "alice", "chore(deps): bump next from 1 to 2\n\nuseful details"),
    commit(8, "alice", "oops, again\r\n\r\nCo-authored-by: Bob"),
    commit(9, "alice", " \n\n"),
  ]);
  const result = await fetchPullRequestCommits(
    "alice",
    pendingCursor(),
    undefined,
    fetcher,
  );
  assert.deepEqual(
    result.commits.map(({ id, authors, message }) => ({
      id,
      author: authors[0].login,
      message,
    })),
    [
      { id: commit(1).sha, author: "alice", message: "why is this working?" },
      {
        id: commit(5).sha,
        author: "alice",
        message: "fix: keep the useful subject",
      },
      { id: commit(8).sha, author: "alice", message: "oops, again" },
    ],
  );
});

test("PR discovery accepts other or missing creators but only returns the requested commit author", async () => {
  for (const user of [
    { login: "Copilot" },
    { login: "bob" },
    null,
    undefined,
  ]) {
    const cursor = initialCommitCursor().pullRequests;
    const snapshot = structuredClone(cursor);
    const { calls, fetcher } = mockFetcher((url) => {
      if (url.pathname === "/search/issues") {
        assert.equal(url.searchParams.get("q"), "type:pr author:alice");
        return search([pull(1, { user })]);
      }
      assert.equal(url.pathname, "/repos/owner/repository/pulls/1/commits");
      return [
        commit(1, "ALICE", "finally, the thing works!"),
        commit(2, "Copilot"),
        commit(3, "bob"),
        { ...commit(4), author: null },
      ];
    });
    const result = await fetchPullRequestCommits(
      "alice",
      cursor,
      undefined,
      fetcher,
    );
    assert.deepEqual(
      result.commits.map(({ id, authors }) => ({
        id,
        author: authors[0].login,
      })),
      [{ id: commit(1).sha, author: "alice" }],
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(result.cursor, {
      page: 2,
      exhausted: true,
      pending: [],
      commitPage: 1,
    });
    assert.deepEqual(cursor, snapshot);
  }
});

test("a five-PR queue drains one commit page per batch, capped at 250 commits per PR", async () => {
  const { calls, fetcher } = mockFetcher((url) => {
    if (url.pathname === "/search/issues") {
      const start = url.searchParams.get("page") === "1" ? 1 : 6;
      return search(
        Array.from({ length: 5 }, (_, index) => pull(start + index)),
        10,
      );
    }
    assert.equal(url.searchParams.get("per_page"), "100");
    if (!url.pathname.includes("/pulls/1/")) return [];
    const page = Number(url.searchParams.get("page"));
    assert.ok(page >= 1 && page <= 3);
    return Array.from({ length: page === 3 ? 50 : 100 }, (_, index) =>
      commit((page - 1) * 100 + index),
    );
  });
  let cursor = initialCommitCursor().pullRequests;
  let total = 0;
  for (const page of [1, 2, 3]) {
    const before = structuredClone(cursor);
    const previousCalls = calls.length;
    const result = await fetchPullRequestCommits(
      "alice",
      cursor,
      undefined,
      fetcher,
    );
    assert.deepEqual(cursor, before);
    assert.equal(calls.length - previousCalls, page === 1 ? 2 : 1);
    total += result.commits.length;
    cursor = result.cursor;
    assert.equal(cursor.page, 2);
    assert.equal(cursor.exhausted, false);
    assert.equal(cursor.commitPage, page === 3 ? 1 : page + 1);
    assert.equal(cursor.pending.length, page === 3 ? 4 : 5);
    assert.equal(cursor.pending[0].number, page === 3 ? 2 : 1);
  }
  assert.equal(total, 250);
  for (const number of [2, 3, 4, 5]) {
    const previousCalls = calls.length;
    const result = await fetchPullRequestCommits(
      "alice",
      cursor,
      undefined,
      fetcher,
    );
    assert.equal(calls.length - previousCalls, 1);
    assert.equal(
      calls.at(-1)?.pathname,
      `/repos/owner/repository/pulls/${number}/commits`,
    );
    assert.equal(result.cursor.pending.length, 5 - number);
    cursor = result.cursor;
  }
  const next = await fetchPullRequestCommits(
    "alice",
    cursor,
    undefined,
    fetcher,
  );
  assert.equal(next.cursor.page, 3);
  assert.equal(next.cursor.exhausted, true);
  assert.equal(next.cursor.pending[0].number, 7);
  assert.deepEqual(
    calls
      .filter((url) => url.pathname === "/search/issues")
      .map((url) => url.searchParams.get("page")),
    ["1", "2"],
  );
});

test("the 1000-result discovery cap still drains queued PRs and never requests page 201", async () => {
  for (const totalCount of [1000, 1250]) {
    const { calls, fetcher } = mockFetcher((url) =>
      url.pathname === "/search/issues"
        ? search(
            Array.from({ length: 5 }, (_, index) => pull(996 + index)),
            totalCount,
          )
        : [],
    );
    let cursor = {
      ...initialCommitCursor().pullRequests,
      page: 200,
    };
    for (let remaining = 4; remaining >= 0; remaining--) {
      const result = await fetchPullRequestCommits(
        "alice",
        cursor,
        undefined,
        fetcher,
      );
      cursor = result.cursor;
      assert.equal(cursor.page, 201);
      assert.equal(cursor.exhausted, true);
      assert.equal(cursor.pending.length, remaining);
    }
    const skipped = await fetchPullRequestCommits(
      "alice",
      cursor,
      undefined,
      async () => assert.fail("exhausted discovery and queue must not fetch"),
    );
    assert.deepEqual(skipped, { commits: [], cursor });
    assert.equal(calls.length, 6);
    assert.equal(calls[0].searchParams.get("page"), "200");
  }
});

test("fully filtered and empty commit pages advance according to raw page length", async () => {
  const original = pendingCursor({
    pending: [
      { repository: "owner/repository", number: 1 },
      { repository: "owner/repository", number: 2 },
    ],
  });
  const { calls, fetcher } = mockFetcher((url) =>
    url.searchParams.get("page") === "1"
      ? Array.from({ length: 100 }, (_, index) => commit(index, "bob"))
      : [],
  );
  const first = await fetchPullRequestCommits(
    "alice",
    original,
    undefined,
    fetcher,
  );
  assert.deepEqual(first.commits, []);
  assert.equal(first.cursor.commitPage, 2);
  assert.deepEqual(first.cursor.pending, original.pending);
  const second = await fetchPullRequestCommits(
    "alice",
    first.cursor,
    undefined,
    fetcher,
  );
  assert.deepEqual(second.commits, []);
  assert.equal(second.cursor.commitPage, 1);
  assert.deepEqual(second.cursor.pending, [original.pending[1]]);
  assert.deepEqual(
    calls.map((url) => url.searchParams.get("page")),
    ["1", "2"],
  );
});

test("empty PR discovery exhausts discovery without a commit request", async () => {
  const { calls, fetcher } = mockFetcher(() => search([]));
  const result = await fetchPullRequestCommits(
    "alice",
    initialCommitCursor().pullRequests,
    undefined,
    fetcher,
  );
  assert.deepEqual(result, {
    commits: [],
    cursor: { page: 2, exhausted: true, pending: [], commitPage: 1 },
  });
  assert.equal(calls.length, 1);
});

test("incomplete, short and malformed PR searches fail atomically", async () => {
  const cases = [
    { body: { ...search([pull()]), incomplete_results: true }, status: 503 },
    { body: search([], 10), status: 503 },
    { body: null, status: 502 },
    { body: [], status: 502 },
    { body: { ...search([]), total_count: "0" }, status: 502 },
    { body: { ...search([]), total_count: -1 }, status: 502 },
    { body: { ...search([]), total_count: 1.5 }, status: 502 },
    { body: { ...search([]), incomplete_results: undefined }, status: 502 },
    { body: { ...search([]), items: {} }, status: 502 },
    {
      body: search(Array.from({ length: 6 }, (_, index) => pull(index + 1))),
      status: 502,
    },
  ];
  for (const { body, status } of cases) {
    const cursor = initialCommitCursor().pullRequests;
    const snapshot = structuredClone(cursor);
    const { calls, fetcher } = mockFetcher(() => body);
    await assert.rejects(
      fetchPullRequestCommits("alice", cursor, undefined, fetcher),
      (error: unknown) => {
        assert.ok(error instanceof BackendError);
        assert.equal(error.status, status);
        if (status === 503) assert.equal(error.retryAfter, 30);
        return true;
      },
    );
    assert.deepEqual(cursor, snapshot);
    assert.equal(calls.length, 1);
  }
});

test("PR marker URLs are optional and never determine the upstream commit URL", async () => {
  for (const marker of [
    {},
    { url: null },
    { url: "https://api.github.com/repos/owner/repository/issues/1" },
    { url: "https://api.github.com/repos/other/repository/pulls/1" },
    { url: "https://api.github.com/repos/owner/repository/pulls/2" },
    { url: "https://evil.example/repos/owner/repository/pulls/1" },
  ]) {
    const cursor = initialCommitCursor().pullRequests;
    const snapshot = structuredClone(cursor);
    const { calls, fetcher } = mockFetcher((url) => {
      if (url.pathname === "/search/issues") {
        return search([pull(1, { pull_request: marker })]);
      }
      assert.equal(
        url.href,
        "https://api.github.com/repos/owner/repository/pulls/1/commits?per_page=100&page=1",
      );
      return [commit()];
    });
    const result = await fetchPullRequestCommits(
      "alice",
      cursor,
      undefined,
      fetcher,
    );
    assert.equal(result.commits[0].id, commit().sha);
    assert.equal(calls.length, 2);
    assert.deepEqual(cursor, snapshot);
  }
});

test("PR records require a marker, matching GitHub repository and safe number", async () => {
  const invalid = [
    null,
    {},
    pull(0),
    pull(1.5),
    pull(Number.MAX_SAFE_INTEGER + 1),
    pull(1, { number: "1" }),
    pull(1, { repository_url: "https://evil.example/repos/owner/repository" }),
    pull(1, { repository_url: "https://api.github.com/repos/owner/../secret" }),
    pull(1, { repository_url: "https://api.github.com/repos/owner/%2e%2e" }),
    pull(1, {
      repository_url: "https://api.github.com/repos/owner/repository?token=x",
    }),
    pull(1, {
      repository_url: "https://api.github.com/repos/owner/repository/",
    }),
    pull(1, { pull_request: undefined }),
    pull(1, { pull_request: null }),
    pull(1, { pull_request: [] }),
  ];
  for (const record of invalid) {
    const cursor = initialCommitCursor().pullRequests;
    const snapshot = structuredClone(cursor);
    const { calls, fetcher } = mockFetcher(() => search([pull(), record]));
    await assert.rejects(
      fetchPullRequestCommits("alice", cursor, undefined, fetcher),
      { status: 502 },
    );
    assert.deepEqual(cursor, snapshot);
    assert.equal(
      calls.length,
      1,
      "validate the whole PR page before fetching commits",
    );
  }
});

test("malformed PR commit arrays and records do not consume the queued page", async () => {
  const invalid = [
    null,
    {},
    { items: [commit()] },
    Array.from({ length: 101 }, (_, index) => commit(index)),
    [null],
    [{ ...commit(), author: undefined }],
    [{ ...commit(), author: { login: 42 } }],
    [{ ...commit(), sha: "not-a-sha" }],
    [
      {
        ...commit(),
        author: { login: "alice", avatar_url: "https://evil.example/avatar" },
      },
    ],
    [
      {
        ...commit(),
        commit: { message: 42, committer: { date: "2026-09-01" } },
      },
    ],
    [
      {
        ...commit(),
        commit: { message: "hello", committer: { date: "not-a-date" } },
      },
    ],
  ];
  for (const body of invalid) {
    const cursor = pendingCursor();
    const snapshot = structuredClone(cursor);
    const { calls, fetcher } = mockFetcher(() => body);
    await assert.rejects(
      fetchPullRequestCommits("alice", cursor, undefined, fetcher),
      { status: 502 },
    );
    assert.deepEqual(cursor, snapshot);
    assert.equal(calls.length, 1);
  }
  const cursor = pendingCursor({ commitPage: 3 });
  const snapshot = structuredClone(cursor);
  await assert.rejects(
    fetchPullRequestCommits("alice", cursor, undefined, async () =>
      Response.json(Array.from({ length: 51 }, (_, index) => commit(index))),
    ),
    { status: 502 },
  );
  assert.deepEqual(cursor, snapshot);
});

test("a failed commit fetch after discovery can retry the same PR search and page", async () => {
  const cursor = initialCommitCursor().pullRequests;
  const snapshot = structuredClone(cursor);
  let fail = true;
  const { calls, fetcher } = mockFetcher((url) => {
    if (url.pathname === "/search/issues") return search([pull()]);
    return fail
      ? Response.json(
          { message: "secondary rate limit" },
          { status: 403, headers: { "retry-after": "25" } },
        )
      : [commit()];
  });
  await assert.rejects(
    fetchPullRequestCommits("alice", cursor, undefined, fetcher),
    { status: 429, retryAfter: 25 },
  );
  assert.deepEqual(cursor, snapshot);
  fail = false;
  const retried = await fetchPullRequestCommits(
    "alice",
    cursor,
    undefined,
    fetcher,
  );
  assert.equal(retried.commits.length, 1);
  assert.deepEqual(calls.slice(0, 2), calls.slice(2));
  assert.deepEqual(cursor, snapshot);
});

test("bot-created original PRs preserve subjects and admit humans verified only as coauthors", async () => {
  const cursor = initialCommitCursor().pullRequests;
  const snapshot = structuredClone(cursor);
  const paths: string[] = [];
  const result = await fetchPullRequestCommits(
    "alice",
    cursor,
    "token",
    async (url, options) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === "/search/issues")
        return Response.json(search([pull(1, { user: { login: "Copilot" } })]));
      if (path === "/graphql")
        return Response.json(
          authorGraph(options, ["Copilot", "Alice", "Bob", null]),
        );
      return Response.json([authorCommit(1), authorCommit(2, null)]);
    },
  );
  assert.equal(result.commits.length, 2);
  for (const card of result.commits) {
    assert.equal(card.message, "finally the thing works!");
    assert.deepEqual(
      card.authors.map(({ login }) => login),
      ["copilot", "alice", "bob"],
    );
  }
  assert.deepEqual(paths, [
    "/search/issues",
    "/repos/owner/repository/pulls/1/commits",
    "/graphql",
  ]);
  assert.deepEqual(cursor, snapshot);
  assert.deepEqual(result.cursor.pending, []);
});

test("PR coauthor lookup failures preserve discovery and pending commit pages for retry", async () => {
  for (const cursor of [initialCommitCursor().pullRequests, pendingCursor()]) {
    const snapshot = structuredClone(cursor);
    let fail = true;
    const paths: string[] = [];
    const fetcher: Fetcher = async (url, options) => {
      const parsed = new URL(String(url));
      paths.push(parsed.pathname + parsed.search);
      if (parsed.pathname === "/search/issues")
        return Response.json(search([pull()]));
      if (parsed.pathname === "/graphql") {
        return Response.json(fail ? { data: null } : authorGraph(options));
      }
      return Response.json([authorCommit()]);
    };
    await assert.rejects(
      fetchPullRequestCommits("alice", cursor, "token", fetcher),
      { status: 502 },
    );
    assert.deepEqual(cursor, snapshot);
    const calls = paths.length;
    fail = false;
    const retried = await fetchPullRequestCommits(
      "alice",
      cursor,
      "token",
      fetcher,
    );
    assert.equal(retried.commits.length, 1);
    assert.deepEqual(paths.slice(0, calls), paths.slice(calls));
    assert.deepEqual(cursor, snapshot);
  }
});
