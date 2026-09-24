import assert from "node:assert/strict";
import test from "node:test";
import { authorCommit, authorGraph } from "./commit-author-fixtures.ts";
import { fetchCommitBatch, validateBatchRequest } from "./commit-batch.ts";
import { initialCommitCursor, isCommitCursor } from "./commit-cursor.ts";
import type { Fetcher } from "./github-client.ts";
import type { CommitCursor, CommitRequest } from "./types.ts";

function commit(index = 1, author = "alice", message = "why is this working?") {
  return {
    sha: index.toString(16).padStart(40, "0"),
    author: {
      login: author,
      avatar_url: "https://avatars.githubusercontent.com/u/1",
    },
    commit: {
      message,
      committer: { date: "2026-09-01T12:30:00Z" },
    },
    repository: { full_name: "owner/repository" },
  };
}

function pull(number = 1, author = "alice") {
  return {
    number,
    repository_url: "https://api.github.com/repos/owner/repository",
    pull_request: {
      url: `https://api.github.com/repos/owner/repository/pulls/${number}`,
    },
    user: { login: author },
  };
}

function search(items: unknown[], totalCount = items.length) {
  return { total_count: totalCount, incomplete_results: false, items };
}

function queuedCursor(numbers = [1]): CommitCursor {
  return {
    ...initialCommitCursor(),
    pullRequests: {
      page: 2,
      exhausted: true,
      pending: numbers.map((number) => ({
        repository: "owner/repository",
        number,
      })),
      commitPage: 1,
    },
  };
}

function mockFetcher(respond: (url: URL, options?: RequestInit) => unknown) {
  const calls: URL[] = [];
  const fetcher: Fetcher = async (input, options) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(url.origin, "https://api.github.com");
    const response = respond(url, options);
    return response instanceof Response ? response : Response.json(response);
  };
  return { calls, fetcher };
}

test("original PR subjects are recovered before squash-indexed commits, then ranked and deduplicated together", async () => {
  const input = { usernames: [" Alice "], cursors: {} };
  const snapshot = structuredClone(input);
  const { calls, fetcher } = mockFetcher((url) => {
    if (url.pathname === "/search/issues") {
      assert.equal(url.searchParams.get("q"), "type:pr author:alice");
      return search([pull(1, "Copilot"), pull(2)]);
    }
    if (url.pathname === "/search/commits") {
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        q: "author:alice",
        sort: "committer-date",
        order: "desc",
        per_page: "100",
        page: "1",
      });
      return search([
        commit(3, "alice", "feat: implement the payment workflow (#42)"),
        { ...commit(2), repository: { full_name: "fork/repository" } },
        commit(4, "alice", "fix"),
      ]);
    }
    if (url.pathname.endsWith("/pulls/1/commits")) {
      return [
        commit(
          1,
          "alice",
          "please work, I need sleep!\n\nInternal explanation",
        ),
      ];
    }
    assert.equal(url.pathname, "/repos/owner/repository/pulls/2/commits");
    return [commit(2, "alice", "why is this working?")];
  });
  const first = await fetchCommitBatch(input, undefined, fetcher, () => 0);
  assert.deepEqual(
    first.commits.map((entry) => entry.message),
    ["please work, I need sleep!"],
  );
  assert.deepEqual(first.cursors.alice.search, { page: 1, exhausted: false });
  assert.equal(first.exhausted, false);
  assert.equal(
    calls.filter((url) => url.pathname.startsWith("/search/")).length,
    1,
  );
  assert.deepEqual(input, snapshot);

  const nextInput = {
    usernames: ["alice"],
    cursors: JSON.parse(JSON.stringify(first.cursors)),
  };
  assert.ok(isCommitCursor(nextInput.cursors.alice));
  const nextSnapshot = structuredClone(nextInput);
  const second = await fetchCommitBatch(nextInput, undefined, fetcher, () => 0);
  assert.deepEqual(
    second.commits.map((entry) => entry.id),
    [2, 3, 4].map((index) => commit(index).sha),
  );
  assert.equal(second.commits[0].repository, "owner/repository");
  assert.equal(
    second.commits[1].message,
    "feat: implement the payment workflow (#42)",
  );
  assert.equal(second.exhausted, true);
  assert.ok(isCommitCursor(second.cursors.alice));
  assert.deepEqual(nextInput, nextSnapshot);
});

test("zero indexed commits never stop a PR-only player's pending pages or queue", async () => {
  const cursor = queuedCursor([1, 2]);
  const { calls, fetcher } = mockFetcher((url) => {
    if (url.pathname === "/search/commits") return search([]);
    assert.notEqual(url.pathname, "/search/issues");
    if (url.pathname.endsWith("/pulls/2/commits")) return [commit(102)];
    return url.searchParams.get("page") === "1"
      ? Array.from({ length: 100 }, (_, index) => commit(index))
      : [commit(101)];
  });
  let cursors = { alice: cursor };
  for (const [index, expectedCount] of [100, 1, 1].entries()) {
    const input = { usernames: ["alice"], cursors };
    const snapshot = structuredClone(input);
    const result = await fetchCommitBatch(input, undefined, fetcher, () => 0);
    assert.equal(result.commits.length, expectedCount);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.exhausted, index === 2);
    assert.equal(result.cursors.alice.search.exhausted, true);
    assert.ok(isCommitCursor(result.cursors.alice));
    assert.deepEqual(input, snapshot);
    cursors = { alice: result.cursors.alice };
  }
  assert.equal(
    calls.filter((url) => url.pathname === "/search/commits").length,
    1,
  );
  assert.deepEqual(
    calls
      .filter((url) => !url.pathname.startsWith("/search/"))
      .map((url) => url.searchParams.get("page")),
    ["1", "2", "1"],
  );
});

test("each player makes at most one search request per batch, reserving discovery until its queue drains", async () => {
  let cursors: CommitRequest["cursors"] = {};
  const { calls, fetcher } = mockFetcher((url) => {
    if (url.pathname === "/search/issues") {
      const author = url.searchParams.get("q")?.split("author:")[1];
      assert.ok(author === "alice" || author === "bob");
      if (url.searchParams.get("page") === "2") return search([], 5);
      return search(
        Array.from({ length: 5 }, (_, index) => pull(index + 1, author)),
        6,
      );
    }
    if (url.pathname === "/search/commits") {
      const author = url.searchParams.get("q")?.slice("author:".length);
      return search(
        Array.from({ length: 100 }, (_, index) =>
          commit(index + (author === "bob" ? 1000 : 0), author),
        ),
        1000,
      );
    }
    return [];
  });
  for (let batch = 0; batch < 6; batch++) {
    const start = calls.length;
    const result = await fetchCommitBatch(
      { usernames: ["alice", "bob"], cursors },
      undefined,
      fetcher,
      () => 0,
    );
    const searches = calls
      .slice(start)
      .filter((url) => url.pathname.startsWith("/search/"));
    assert.equal(searches.length, 2);
    for (const author of ["alice", "bob"]) {
      assert.equal(
        searches.filter((url) =>
          url.searchParams.get("q")?.endsWith(`author:${author}`),
        ).length,
        1,
      );
    }
    assert.ok(
      searches.every(
        (url) =>
          url.pathname ===
          (batch === 0 || batch === 5 ? "/search/issues" : "/search/commits"),
      ),
    );
    assert.equal(result.exhausted, false);
    cursors = result.cursors;
  }
});

test("exhaustion requires indexed search and PR discovery plus an empty pending queue", async () => {
  const cases: { cursor: CommitCursor; path: string; exhausted: boolean }[] = [
    { cursor: initialCommitCursor(), path: "/search/issues", exhausted: false },
    {
      cursor: {
        ...initialCommitCursor(),
        search: { page: 2, exhausted: true },
      },
      path: "/search/issues",
      exhausted: true,
    },
    {
      cursor: {
        ...initialCommitCursor(),
        pullRequests: { page: 2, exhausted: true, pending: [], commitPage: 1 },
      },
      path: "/search/commits",
      exhausted: true,
    },
  ];
  for (const { cursor, path, exhausted } of cases) {
    const { calls, fetcher } = mockFetcher((url) => {
      assert.equal(url.pathname, path);
      return search([]);
    });
    const result = await fetchCommitBatch(
      { usernames: ["alice"], cursors: { alice: cursor } },
      undefined,
      fetcher,
    );
    assert.equal(result.exhausted, exhausted);
    assert.equal(result.cursors.alice.exhausted, exhausted);
    assert.equal(calls.length, 1);
  }
  const cursor = initialCommitCursor(true);
  const result = await fetchCommitBatch(
    { usernames: ["alice", "bob"], cursors: { alice: cursor, bob: cursor } },
    undefined,
    async () => assert.fail("fully exhausted players must make no requests"),
  );
  assert.deepEqual(result.commits, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.exhausted, true);
});

test("public pinning and private authentication apply equally to discovery and both commit sources", async () => {
  for (const scenario of [
    { requireAuth: false, token: "new-session-token", authorization: null },
    { requireAuth: undefined, token: undefined, authorization: null },
    {
      requireAuth: undefined,
      token: "session-token",
      authorization: "Bearer session-token",
    },
    {
      requireAuth: true,
      token: "session-token",
      authorization: "Bearer session-token",
    },
  ]) {
    const { calls, fetcher } = mockFetcher((url, options) => {
      assert.equal(
        new Headers(options?.headers).get("authorization"),
        scenario.authorization,
      );
      if (url.pathname === "/search/issues") return search([pull(1), pull(2)]);
      if (url.pathname === "/search/commits") return search([commit()]);
      return [commit()];
    });
    const input = {
      usernames: ["alice"],
      cursors: {},
      requireAuth: scenario.requireAuth,
    };
    const first = await fetchCommitBatch(input, scenario.token, fetcher);
    await fetchCommitBatch(
      { ...input, cursors: first.cursors },
      scenario.token,
      fetcher,
    );
    assert.deepEqual(
      new Set(calls.map((url) => url.pathname)),
      new Set([
        "/search/issues",
        "/search/commits",
        "/repos/owner/repository/pulls/1/commits",
        "/repos/owner/repository/pulls/2/commits",
      ]),
    );
  }
  for (const cursor of [
    initialCommitCursor(),
    queuedCursor(),
    initialCommitCursor(true),
  ]) {
    const input = {
      usernames: ["alice"],
      cursors: { alice: cursor },
      requireAuth: true,
    };
    const snapshot = structuredClone(input);
    await assert.rejects(
      fetchCommitBatch(input, undefined, async () =>
        assert.fail("private games cannot fall back to public requests"),
      ),
      { status: 401 },
    );
    assert.deepEqual(input, snapshot);
  }
});

test("cursor validation round-trips without aliasing and handles object-property usernames", async () => {
  const cursor = queuedCursor();
  cursor.pullRequests.commitPage = 3;
  const input = {
    usernames: [" Alice ", "CONSTRUCTOR"],
    cursors: { alice: JSON.parse(JSON.stringify(cursor)) },
  };
  const validated = validateBatchRequest(input);
  assert.deepEqual(validated.usernames, ["alice", "constructor"]);
  assert.ok(isCommitCursor(validated.cursors.alice));
  validated.cursors.alice.pullRequests.pending[0].number = 2;
  assert.equal(input.cursors.alice.pullRequests.pending[0].number, 1);
  const result = await fetchCommitBatch(
    { usernames: ["constructor"], cursors: {} },
    undefined,
    async (input) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get("q"), "type:pr author:constructor");
      assert.equal(url.searchParams.get("page"), "1");
      return Response.json(search([]));
    },
  );
  assert.ok(Object.hasOwn(result.cursors, "constructor"));
  assert.ok(isCommitCursor(result.cursors.constructor));
});

test("forged cursors are rejected by the shared UI guard and batch API before any upstream request", async () => {
  const cursor = initialCommitCursor();
  const queued = queuedCursor();
  const invalid: unknown[] = [
    null,
    [],
    { page: 1, exhausted: false },
    { ...cursor, extra: true },
    { ...cursor, exhausted: true },
    { ...initialCommitCursor(true), exhausted: false },
    { ...queued, search: { page: 2, exhausted: true }, exhausted: true },
  ];
  for (const page of [0, -1, 1.5, 12, NaN, Infinity, "1"]) {
    invalid.push({ ...cursor, search: { page, exhausted: false } });
  }
  invalid.push({ ...cursor, search: { page: 11, exhausted: false } });
  for (const page of [0, -1, 1.5, 202, NaN, Infinity, "1"]) {
    invalid.push({ ...cursor, pullRequests: { ...cursor.pullRequests, page } });
  }
  invalid.push({
    ...cursor,
    pullRequests: { ...cursor.pullRequests, page: 201 },
  });
  for (const searchCursor of [
    null,
    {},
    { page: 1, exhausted: "false" },
    { page: 1, exhausted: false, q: "author:bob" },
  ]) {
    invalid.push({ ...cursor, search: searchCursor });
  }
  for (const patch of [
    { pending: null },
    {
      pending: Array.from({ length: 6 }, () => ({
        repository: "owner/repository",
        number: 1,
      })),
    },
    { commitPage: 0 },
    { commitPage: 1.5 },
    { commitPage: 4 },
    { commitPage: "1" },
    { exhausted: "false" },
    { url: "https://evil.example" },
  ]) {
    invalid.push({
      ...queued,
      pullRequests: { ...queued.pullRequests, ...patch },
    });
  }
  invalid.push({
    ...cursor,
    pullRequests: { ...cursor.pullRequests, commitPage: 2 },
  });
  for (const repository of [
    "https://api.github.com/repos/owner/repository",
    "https://evil.example/repository",
    "owner/../secret",
    "owner/.",
    "owner/..",
    "owner/%2e%2e",
    "owner/repository?per_page=1000",
    "owner/repository#fragment",
    "owner\\repository",
    "//owner/repository",
    "owner/repository/commits",
  ]) {
    invalid.push({
      ...queued,
      pullRequests: {
        ...queued.pullRequests,
        pending: [{ repository, number: 1 }],
      },
    });
  }
  for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    invalid.push({
      ...queued,
      pullRequests: {
        ...queued.pullRequests,
        pending: [{ repository: "owner/repository", number }],
      },
    });
  }
  invalid.push({
    ...queued,
    pullRequests: {
      ...queued.pullRequests,
      pending: [
        {
          repository: "owner/repository",
          number: 1,
          url: "https://evil.example",
        },
      ],
    },
  });
  for (const forged of invalid) {
    assert.equal(isCommitCursor(forged), false, JSON.stringify(forged));
    await assert.rejects(
      fetchCommitBatch(
        { usernames: ["alice"], cursors: { alice: forged } },
        undefined,
        async () => assert.fail("invalid cursor must not reach GitHub"),
      ),
      { status: 400 },
    );
  }
  const capped = {
    search: { page: 11, exhausted: true },
    pullRequests: { page: 201, exhausted: true, pending: [], commitPage: 1 },
    exhausted: true,
  };
  assert.ok(isCommitCursor(capped));
  assert.deepEqual(
    validateBatchRequest({ usernames: ["alice"], cursors: { alice: capped } })
      .cursors.alice,
    capped,
  );
});

test("invalid players, unexpected cursor owners and unknown request keys fail before fetching", async () => {
  const invalid = [
    null,
    {},
    { usernames: [], cursors: {} },
    {
      usernames: Array.from({ length: 9 }, (_, index) => `user${index}`),
      cursors: {},
    },
    { usernames: ["alice", "ALICE"], cursors: {} },
    { usernames: ["alice OR author:bob"], cursors: {} },
    { usernames: ["alice/repository"], cursors: {} },
    { usernames: ["a--b"], cursors: {} },
    { usernames: ["a".repeat(40)], cursors: {} },
    { usernames: [null], cursors: {} },
    { usernames: ["alice"], cursors: null },
    { usernames: ["alice"], cursors: { bob: initialCommitCursor() } },
    {
      usernames: ["alice"],
      cursors: JSON.parse(
        `{"__proto__":${JSON.stringify(initialCommitCursor())}}`,
      ),
    },
    { usernames: ["alice"], cursors: {}, requireAuth: "false" },
    { usernames: ["alice"], cursors: {}, q: "type:pr" },
  ];
  for (const input of invalid) {
    await assert.rejects(
      fetchCommitBatch(input, undefined, async () =>
        assert.fail("invalid player must not reach GitHub"),
      ),
      { status: 400 },
    );
  }
});

test("eight players with maximum legal PR queues fit the request body limit", () => {
  const usernames = Array.from(
    { length: 8 },
    (_, index) => `${"a".repeat(38)}${index}`,
  );
  const cursor: CommitCursor = {
    search: { page: 11, exhausted: true },
    pullRequests: {
      page: 201,
      exhausted: true,
      pending: Array.from({ length: 5 }, () => ({
        repository: `owner/${"r".repeat(194)}`,
        number: Number.MAX_SAFE_INTEGER,
      })),
      commitPage: 3,
    },
    exhausted: false,
  };
  const input = {
    usernames,
    cursors: Object.fromEntries(
      usernames.map((username) => [username, cursor]),
    ),
    requireAuth: false,
  };
  assert.ok(isCommitCursor(cursor));
  assert.deepEqual(validateBatchRequest(input), input);
  assert.ok(Buffer.byteLength(JSON.stringify(input), "utf8") <= 16_384);
});

test("conflicting authors for the same SHA across PR and indexed sources fail the whole batch", async () => {
  const input = {
    usernames: ["alice", "bob"],
    cursors: {
      alice: { ...queuedCursor(), search: { page: 2, exhausted: true } },
      bob: {
        ...initialCommitCursor(),
        pullRequests: { page: 2, exhausted: true, pending: [], commitPage: 1 },
      },
    },
  };
  const snapshot = structuredClone(input);
  const { calls, fetcher } = mockFetcher((url) => {
    if (url.pathname === "/search/commits") {
      assert.equal(url.searchParams.get("q"), "author:bob");
      return search([commit(1, "bob")]);
    }
    return [commit(1, "alice")];
  });
  await assert.rejects(fetchCommitBatch(input, undefined, fetcher), {
    status: 502,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(input, snapshot);
});

test("failure of either source rolls back the whole batch even after another player succeeds", async () => {
  for (const failingSource of ["pulls", "indexed"]) {
    const input = {
      usernames: ["alice", "bob"],
      cursors: { alice: queuedCursor([1]), bob: queuedCursor([2]) },
    };
    const snapshot = structuredClone(input);
    const completed: string[] = [];
    let releaseFailure: () => void = () => assert.fail("missing failure gate");
    const otherPlayerFinished = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const fetcher: Fetcher = async (input) => {
      const url = new URL(String(input));
      const indexed = url.pathname === "/search/commits";
      const author = indexed
        ? url.searchParams.get("q")?.slice("author:".length)
        : url.pathname.includes("/pulls/1/")
          ? "alice"
          : "bob";
      if (author === "bob" && indexed === (failingSource === "indexed")) {
        await otherPlayerFinished;
        return Response.json(
          { message: "rate limited" },
          {
            status: 429,
            headers: { "retry-after": "15" },
          },
        );
      }
      completed.push(`${author}:${indexed ? "indexed" : "pulls"}`);
      if (
        completed.includes("alice:indexed") &&
        completed.includes("alice:pulls")
      )
        releaseFailure();
      return Response.json(
        indexed
          ? search([commit(author === "alice" ? 1 : 2, author)])
          : [commit(author === "alice" ? 1 : 2, author)],
      );
    };
    await assert.rejects(fetchCommitBatch(input, undefined, fetcher), {
      status: 429,
      retryAfter: 15,
    });
    assert.ok(completed.includes("alice:indexed"));
    assert.ok(completed.includes("alice:pulls"));
    assert.deepEqual(input, snapshot);
  }
});

test("shared verified authors deduplicate across sources and users without losing either participant", async () => {
  const input = {
    usernames: ["alice", "bob"],
    cursors: { alice: queuedCursor([1]), bob: queuedCursor([2]) },
    requireAuth: true,
  };
  const snapshot = structuredClone(input);
  let graphCalls = 0;
  const result = await fetchCommitBatch(
    input,
    "token",
    async (url, options) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/graphql") {
        graphCalls++;
        return Response.json(authorGraph(options));
      }
      if (parsed.pathname === "/search/commits") {
        return Response.json(search([authorCommit(1, "Alice")]));
      }
      return Response.json([authorCommit(1)]);
    },
  );
  assert.equal(graphCalls, 1);
  assert.equal(result.commits.length, 1);
  assert.deepEqual(
    result.commits[0].authors.map(({ login }) => login),
    ["copilot", "alice", "bob"],
  );
  assert.equal(result.exhausted, true);
  assert.deepEqual(input, snapshot);
});

test("PR-only coauthor results never carry the indexed source's empty-search warning", async () => {
  const result = await fetchCommitBatch(
    { usernames: ["alice"], cursors: { alice: queuedCursor() } },
    "token",
    async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === "/graphql") return Response.json(authorGraph(options));
      if (path === "/search/commits") return Response.json(search([]));
      return Response.json([authorCommit()]);
    },
  );
  assert.equal(result.commits.length, 1);
  assert.deepEqual(result.warnings, []);
});

test("composite public scope never verifies trailers or leaks a newly available token", async () => {
  for (const token of [undefined, "new-session-token"]) {
    const paths: string[] = [];
    const fetcher: Fetcher = async (url, options) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      assert.notEqual(path, "/graphql");
      assert.equal(new Headers(options?.headers).has("authorization"), false);
      if (path === "/search/issues")
        return Response.json(search([pull(1), pull(2)]));
      if (path === "/search/commits")
        return Response.json(
          search([authorCommit(1), authorCommit(2, "Alice")]),
        );
      return Response.json([authorCommit(1), authorCommit(2, "Alice")]);
    };
    const input = { usernames: ["alice"], cursors: {}, requireAuth: false };
    const first = await fetchCommitBatch(input, token, fetcher);
    const second = await fetchCommitBatch(
      { ...input, cursors: first.cursors },
      token,
      fetcher,
    );
    for (const result of [first, second]) {
      assert.equal(result.commits.length, 1);
      assert.deepEqual(
        result.commits[0].authors.map(({ login }) => login),
        ["alice"],
      );
    }
    assert.ok(paths.includes("/search/issues"));
    assert.ok(paths.includes("/search/commits"));
  }
});

test("the shared 50-second author deadline includes REST wait without consuming cursors", async (context) => {
  const input = {
    usernames: ["alice"],
    cursors: { alice: queuedCursor() },
  };
  const snapshot = structuredClone(input);
  const deadline = new AbortController();
  let stageTimers = 0;
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    if (milliseconds === 50_000) {
      stageTimers++;
      return deadline.signal;
    }
    assert.equal(milliseconds, 12_000);
    return new AbortController().signal;
  });
  await assert.rejects(
    fetchCommitBatch(input, "token", async (url) => {
      assert.equal(
        stageTimers,
        1,
        "batch deadline starts before REST dispatch",
      );
      const path = new URL(String(url)).pathname;
      assert.notEqual(path, "/graphql");
      deadline.abort(
        new DOMException("batch expired during REST", "TimeoutError"),
      );
      return Response.json(
        path === "/search/commits"
          ? search([authorCommit()])
          : [authorCommit()],
      );
    }),
    { status: 503, retryAfter: 15 },
  );
  assert.equal(stageTimers, 1);
  assert.deepEqual(input, snapshot);
});

test("coauthor failure aborts the whole composite batch without consuming any source cursor", async () => {
  const input = {
    usernames: ["alice", "bob"],
    cursors: { alice: queuedCursor([1]), bob: queuedCursor([2]) },
  };
  const snapshot = structuredClone(input);
  const paths: string[] = [];
  const result = fetchCommitBatch(input, "token", async (url) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path === "/graphql") {
      return Response.json(
        { data: null, errors: [{ type: "RATE_LIMITED" }] },
        {
          headers: { "retry-after": "23" },
        },
      );
    }
    if (path === "/search/commits")
      return Response.json(search([authorCommit()]));
    return Response.json([authorCommit()]);
  });
  await assert.rejects(result, { status: 429, retryAfter: 23 });
  assert.deepEqual(input, snapshot);
  assert.equal(paths.filter((path) => path === "/graphql").length, 1);
});

test("the AI switch decides whether a judge runs at all", async () => {
  const { fetcher } = mockFetcher((url) => {
    if (url.pathname === "/search/issues") return search([pull(1)]);
    if (url.pathname === "/search/commits") return search([]);
    if (url.pathname.endsWith("/pulls/1/commits")) {
      return [
        commit(1, "alice", "fix the config path"),
        commit(2, "alice", "sorry, my fault, I broke prod again"),
      ];
    }
    return assert.fail(`unexpected request to ${url.pathname}`);
  });
  const base = { usernames: ["alice"], cursors: {} };
  // A judge that inverts the incoming order, so its effect is unmistakable.
  let calls = 0;
  const judge = async (subjects: string[]) => {
    calls++;
    return subjects.map((_, index) => index);
  };

  const off = await fetchCommitBatch(
    { ...base, useAi: false },
    undefined,
    fetcher,
    () => 0,
    judge,
  );
  assert.equal(calls, 0, "the switch off must not reach the model");
  assert.equal(off.commits.length, 2);

  const on = await fetchCommitBatch(
    { ...base, useAi: true },
    undefined,
    fetcher,
    () => 0,
    judge,
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    on.commits.map(({ id }) => id),
    [...off.commits].reverse().map(({ id }) => id),
  );
  assert.deepEqual(on.warnings, []);
});

test("a non-boolean AI switch is rejected before any request", () => {
  assert.throws(
    () =>
      validateBatchRequest({
        usernames: ["alice"],
        cursors: {},
        useAi: "yes",
      }),
    /AI ranking switch/,
  );
});
