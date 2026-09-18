import assert from "node:assert/strict";
import test from "node:test";
import { BackendError } from "./backend-errors.ts";
import { authorCommit, authorGraph } from "./commit-author-fixtures.ts";
import {
  isCommitNoise,
  RANKING_JITTER,
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
  assert.equal(result.commits[0].authors[0].login, "constructor");
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
  assert.equal(result.commits[0].authors[0].login, "alice");
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
  assert.equal(result.commits[0].authors[0].login, "alice");
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
    result.commits.map((commit) => commit.authors[0].login),
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
  const result = await searchCommitBatch(request, undefined, async () =>
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
  assert.ok(
    result.commits.every((commit) => commit.authors[0].login === "bob"),
  );
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

test("indexed bot-primary and null-primary commits admit verified coauthors and return every linked author", async () => {
  const calls: string[] = [];
  const result = await searchCommitBatch(
    request,
    "token",
    async (url, options) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      return path === "/graphql"
        ? Response.json(authorGraph(options, ["Copilot", "Alice", "Bob", null]))
        : searchResponse([authorCommit(1), authorCommit(2, null)]);
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
  assert.deepEqual(calls, ["/search/commits", "/graphql"]);
});

test("public indexed games never enrich trailers, even with an available token", async () => {
  for (const token of [undefined, "session-token"]) {
    const result = await searchCommitBatch(
      { ...request, requireAuth: false },
      token,
      async (url, options) => {
        assert.equal(new URL(String(url)).pathname, "/search/commits");
        assert.equal(new Headers(options?.headers).has("authorization"), false);
        return searchResponse([authorCommit(1), authorCommit(2, "Alice")]);
      },
    );
    assert.equal(result.commits.length, 1);
    assert.equal(result.commits[0].id, authorCommit(2).sha);
    assert.deepEqual(
      result.commits[0].authors.map(({ login }) => login),
      ["alice"],
    );
  }
});

test("indexed author verification failure does not consume or mutate a page and retries it", async () => {
  const input = {
    ...request,
    cursors: { alice: { page: 2, exhausted: false } },
  };
  const snapshot = structuredClone(input);
  let fail = true;
  const paths: string[] = [];
  const fetcher: Fetcher = async (url, options) => {
    const parsed = new URL(String(url));
    paths.push(parsed.pathname + parsed.search);
    if (parsed.pathname === "/search/commits") {
      return searchResponse([authorCommit()], 101);
    }
    return Response.json(
      fail
        ? { data: null, errors: [{ type: "FORBIDDEN" }] }
        : authorGraph(options),
    );
  };
  await assert.rejects(searchCommitBatch(input, "token", fetcher), {
    status: 403,
  });
  assert.deepEqual(input, snapshot);
  fail = false;
  const result = await searchCommitBatch(input, "token", fetcher);
  assert.deepEqual(result.cursors.alice, { page: 3, exhausted: true });
  assert.deepEqual(paths.slice(0, 2), paths.slice(2));
  assert.deepEqual(input, snapshot);
});

const FUNNY = [
  "sorry, my fault, I broke prod again",
  "don't ask me why this works, it just does",
  "why does this work now?!",
  'Revert "Revert "Add caching""',
  "fix the fix that fixed the fix",
  "ok WHO thought nested ternaries were a good idea",
  "temporary hack, will remove before friday (lie)",
  "attempt 7 at making the tests pass",
];

const ORDINARY = [
  "Add retry logic to the payment webhook handler",
  "Refactor the invoice renderer to share layout code",
  "feat(auth): add SSO login for enterprise tenants",
];

const MACHINE_WRITTEN = [
  "PROJ-1421",
  "v2.14.0",
  "Update README.md",
  "wip",
  "fix",
  "cleanup",
  "typo",
  "a1b2c3d4 rebase onto 9f8e7d6",
];

test("scoring puts confessional subjects above ordinary work above machine output", () => {
  const worstFunny = Math.min(...FUNNY.map(scoreMessage));
  const bestOrdinary = Math.max(...ORDINARY.map(scoreMessage));
  const bestMachine = Math.max(...MACHINE_WRITTEN.map(scoreMessage));
  assert.ok(
    worstFunny > bestOrdinary,
    `funny floor ${worstFunny} must beat ordinary ceiling ${bestOrdinary}`,
  );
  assert.ok(
    bestOrdinary > bestMachine,
    `ordinary ceiling ${bestOrdinary} must beat machine ceiling ${bestMachine}`,
  );
  for (const message of MACHINE_WRITTEN) {
    assert.ok(scoreMessage(message) < 0, `${message} should score below zero`);
  }
});

test("repeated signals accumulate instead of collapsing into one bucket", () => {
  assert.ok(
    scoreMessage("why oh why did the cache stop working") >
      scoreMessage("why did the cache stop working"),
  );
  assert.ok(
    scoreMessage("sorry, this is a stupid hack, please forgive me") >
      scoreMessage("sorry, this is a hack"),
  );
});

test("jitter reshuffles near ties but never lifts a machine subject over a good one", () => {
  const gap =
    scoreMessage("sorry, my fault, I broke prod again") -
    scoreMessage("Update README.md");
  assert.ok(gap > RANKING_JITTER, `gap ${gap} must exceed ${RANKING_JITTER}`);
  const neighbours = ORDINARY.map(scoreMessage);
  assert.ok(Math.max(...neighbours) - Math.min(...neighbours) < RANKING_JITTER);
});

test("technical acronyms read as vocabulary, not as shouting", () => {
  const withAcronyms = scoreMessage("Fix HTTP retries in the JSON parser");
  const without = scoreMessage("Fix the retries in the parser");
  assert.ok(
    Math.abs(withAcronyms - without) < 1,
    `${withAcronyms} and ${without} should be close`,
  );
  assert.ok(scoreMessage("FINALLY got the build green") > withAcronyms + 2);
  assert.ok(
    scoreMessage("FINALLY got the build green") >
      scoreMessage("FIX THE WHOLE BUILD ALREADY"),
  );
});

test("a confessing body helps a little and a changelog body hurts", () => {
  const subject = "Move the retry helper into its own module";
  const plain = scoreMessage(subject);
  const confessing = scoreMessage(
    `${subject}\n\nI have no idea why this fixes it, sorry.`,
  );
  const changelog = scoreMessage(
    `${subject}\n\n${"- updated a dependency\n".repeat(60)}`,
  );
  assert.ok(confessing > plain);
  assert.ok(
    confessing - plain <= 1.5,
    `body bonus ${confessing - plain} must stay small`,
  );
  assert.ok(changelog < plain);
});

test("ranking is a stable, pure ordering of the funniest commits first", () => {
  const card = (message: string) => ({
    id: message,
    authors: [{ login: "alice", avatarUrl: "" }],
    message,
    url: "",
    repository: "owner/repository",
    committedAt: "2026-09-01T12:30:00Z",
  });
  const commits = [
    ...MACHINE_WRITTEN.map(card),
    ...ORDINARY.map(card),
    ...FUNNY.map(card),
  ];
  const snapshot = structuredClone(commits);
  const ranked = rankCommits(commits, () => 0);
  assert.deepEqual(commits, snapshot);
  assert.deepEqual(
    ranked
      .slice(0, FUNNY.length)
      .map(({ id }) => id)
      .sort(),
    [...FUNNY].sort(),
  );
  assert.deepEqual(
    ranked
      .slice(-MACHINE_WRITTEN.length)
      .map(({ id }) => id)
      .sort(),
    [...MACHINE_WRITTEN].sort(),
  );
  assert.deepEqual(
    rankCommits(commits, () => 0),
    ranked,
  );
});
