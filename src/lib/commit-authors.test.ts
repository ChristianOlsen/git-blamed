import assert from "node:assert/strict";
import test from "node:test";
import { BackendError } from "./backend-errors.ts";
import {
  authorCommit,
  authorGraph,
  avatarUrl,
} from "./commit-author-fixtures.ts";
import {
  createCommitAuthorResolver,
  hasCoauthorTrailer,
} from "./commit-authors.ts";
import { deduplicateCommits, parseCommit } from "./commit-search.ts";
import type { Fetcher } from "./github-client.ts";

test("trailers only trigger verification and never infer usernames or email identities", async () => {
  for (const trailer of [
    "Co-authored-by: Alice <alice@example.invalid>",
    "co-AUTHORED-by : Arbitrary text",
    "\tCo-authored-by:\t",
  ]) {
    assert.ok(
      hasCoauthorTrailer({ commit: { message: `subject\r\n\r\n${trailer}` } }),
    );
  }
  for (const message of ["ordinary subject", "mention Co-authored-by: Alice"]) {
    assert.equal(hasCoauthorTrailer({ commit: { message } }), false);
  }
  const resolve = createCommitAuthorResolver("token", async (_url, options) =>
    Response.json(authorGraph(options, ["Copilot", null])),
  );
  assert.deepEqual(await resolve([authorCommit()]), [
    [{ login: "copilot", avatarUrl }],
  ]);
});

test("verified linked authors include primary and all coauthors, ignoring unlinked actors", async () => {
  const resolve = createCommitAuthorResolver("token", async (_url, options) =>
    Response.json(
      authorGraph(options, ["COPILOT", "Alice", null, "Bob", "ALICE"]),
    ),
  );
  const [authors] = await resolve([authorCommit()]);
  assert.deepEqual(authors, [
    { login: "copilot", avatarUrl },
    { login: "alice", avatarUrl },
    { login: "bob", avatarUrl },
  ]);
  for (const username of ["alice", "bob", "copilot"]) {
    const card = parseCommit(authorCommit(), username, undefined, authors);
    assert.ok(card);
    assert.deepEqual(card.authors, authors);
    assert.equal(card.message, "finally the thing works!");
  }
  assert.equal(
    parseCommit(authorCommit(), "unlinked", undefined, authors),
    null,
  );
});

test("null primary permits verified coauthors; missing linked primary is a conflict", async () => {
  const resolve = createCommitAuthorResolver("token", async (_url, options) =>
    Response.json(authorGraph(options, [null, "Alice"])),
  );
  assert.deepEqual(await resolve([authorCommit(1, null)]), [
    [{ login: "alice", avatarUrl }],
  ]);
  await assert.rejects(resolve([authorCommit(1, "Copilot")]), { status: 502 });
});

test("no-token and ordinary commits remain REST-primary-only without GraphQL", async () => {
  const unavailable: Fetcher = async () =>
    assert.fail("must not query GraphQL");
  const noToken = createCommitAuthorResolver(undefined, unavailable);
  assert.deepEqual(
    await noToken([
      authorCommit(1),
      authorCommit(2, null),
      authorCommit(3, "Alice"),
    ]),
    [[{ login: "copilot", avatarUrl }], [], [{ login: "alice", avatarUrl }]],
  );
  const ordinary = {
    ...authorCommit(),
    commit: { ...authorCommit().commit, message: "ordinary subject" },
  };
  assert.deepEqual(
    await createCommitAuthorResolver("token", unavailable)([ordinary]),
    [[{ login: "copilot", avatarUrl }]],
  );
});

test("linked bot accounts are retained without making unlinked actors eligible", async () => {
  const resolve = createCommitAuthorResolver("token", async (_url, options) =>
    Response.json(authorGraph(options, ["helper[bot]", "Alice", null])),
  );
  const [authors] = await resolve([authorCommit(1, "helper[bot]")]);
  assert.deepEqual(authors, [
    { login: "helper[bot]", avatarUrl },
    { login: "alice", avatarUrl },
  ]);
});

test("a hundred commits batch into two parallel queries and cache by repository plus SHA", async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const resolve = createCommitAuthorResolver("token", async (_url, options) => {
    calls++;
    maxActive = Math.max(maxActive, ++active);
    await new Promise((done) => setImmediate(done));
    active--;
    return Response.json(authorGraph(options));
  });
  const items = Array.from({ length: 100 }, (_, index) => authorCommit(index));
  const [first, second] = await Promise.all([resolve(items), resolve(items)]);
  assert.equal(calls, 2);
  assert.equal(maxActive, 2);
  assert.deepEqual(first, second);
  assert.equal(first.length, 100);
  await resolve([authorCommit(0, "Copilot", "fork/repository")]);
  assert.equal(calls, 3);
});

test("author pagination collects every page before matching a later-page participant", async () => {
  const afters: unknown[] = [];
  const resolve = createCommitAuthorResolver("token", async (_url, options) => {
    const { variables } = JSON.parse(String(options?.body));
    afters.push(variables.after0);
    return Response.json(
      variables.after0 === null
        ? authorGraph(options, ["Copilot", null], {
            hasNextPage: true,
            endCursor: "next-page",
          })
        : authorGraph(options, ["ALICE", "Bob"]),
    );
  });
  const [authors] = await resolve([authorCommit()]);
  assert.deepEqual(afters, [null, "next-page"]);
  assert.ok(parseCommit(authorCommit(), "alice", undefined, authors));
  assert.deepEqual(
    authors.map(({ login }) => login),
    ["copilot", "alice", "bob"],
  );
});

test("pagination safety caps and repeated cursors fail instead of truncating authors", async () => {
  for (const repeat of [false, true]) {
    let calls = 0;
    const resolve = createCommitAuthorResolver("token", async (_url, options) =>
      Response.json(
        authorGraph(options, ["Copilot"], {
          hasNextPage: true,
          endCursor: repeat ? "same-cursor" : `cursor-${++calls}`,
        }),
      ),
    );
    await assert.rejects(resolve([authorCommit()]), { status: 502 });
    if (!repeat) assert.equal(calls, 3);
  }
});

test("concurrency and total lookup budget are bounded", async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const resolve = createCommitAuthorResolver("token", async (_url, options) => {
    calls++;
    maxActive = Math.max(maxActive, ++active);
    await new Promise((done) => setImmediate(done));
    active--;
    return Response.json(authorGraph(options));
  });
  await assert.rejects(
    resolve(Array.from({ length: 2450 }, (_, index) => authorCommit(index))),
    { status: 502 },
  );
  assert.equal(calls, 48);
  assert.equal(maxActive, 8);
});

test("one 50-second batch deadline aborts in-flight queries and prevents queued requests", async (context) => {
  const deadline = new AbortController();
  const timeouts: number[] = [];
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    timeouts.push(milliseconds);
    return milliseconds === 50_000
      ? deadline.signal
      : new AbortController().signal;
  });
  let calls = 0;
  const resolve = createCommitAuthorResolver("token", async (_url, options) => {
    calls++;
    const signal = options?.signal;
    assert.ok(signal);
    if (calls === 8) {
      setImmediate(() =>
        deadline.abort(new DOMException("stage expired", "TimeoutError")),
      );
    }
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  await assert.rejects(
    resolve(Array.from({ length: 500 }, (_, index) => authorCommit(index))),
    {
      status: 503,
      retryAfter: 15,
      message: /co-author verification timed out.*no pages were skipped/,
    },
  );
  assert.equal(calls, 8);
  assert.equal(timeouts.filter((timeout) => timeout === 50_000).length, 1);
  assert.ok(timeouts.every((timeout) => [12_000, 50_000].includes(timeout)));
});

test("author pagination cannot reset the shared lookup deadline", async (context) => {
  const deadline = new AbortController();
  let stageTimers = 0;
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    if (milliseconds === 50_000) {
      stageTimers++;
      return deadline.signal;
    }
    return new AbortController().signal;
  });
  let calls = 0;
  const resolve = createCommitAuthorResolver("token", async (_url, options) => {
    if (++calls === 2) {
      deadline.abort(new DOMException("stage expired", "TimeoutError"));
    }
    return Response.json(
      authorGraph(options, calls === 1 ? ["Copilot"] : ["Alice"], {
        hasNextPage: calls === 1,
        endCursor: calls === 1 ? "next-page" : null,
      }),
    );
  });
  await assert.rejects(resolve([authorCommit()]), {
    status: 503,
    retryAfter: 15,
  });
  assert.equal(calls, 2);
  assert.equal(stageTimers, 1);
  await assert.rejects(resolve([authorCommit(2)]), { status: 503 });
  assert.equal(calls, 2);
});

test("batch deadline starts at resolver creation, before the first lookup", async (context) => {
  const deadline = new AbortController();
  let stageTimers = 0;
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, 50_000);
    stageTimers++;
    return deadline.signal;
  });
  const resolve = createCommitAuthorResolver("token", async () =>
    assert.fail("a deadline expired during REST wait must not start GraphQL"),
  );
  assert.equal(stageTimers, 1);
  deadline.abort(new DOMException("batch expired", "TimeoutError"));
  await assert.rejects(resolve([authorCommit()]), {
    status: 503,
    retryAfter: 15,
    message: /co-author verification timed out.*no pages were skipped/,
  });
  assert.equal(stageTimers, 1);
});

test("upstream repository and SHA are validated before any GraphQL request", async () => {
  for (const patch of [
    { sha: "bad } mutation {" },
    { repository: { full_name: "owner/repo?token=x" } },
    { repository: { full_name: "owner/../private" } },
  ]) {
    await assert.rejects(
      createCommitAuthorResolver("token", async () =>
        assert.fail("invalid variables must not be sent"),
      )([{ ...authorCommit(), ...patch }]),
      { status: 502 },
    );
  }
});

test("malformed, partial, mismatched and invalid linked author responses fail closed", async () => {
  const mutations: ((value: ReturnType<typeof authorGraph>) => void)[] = [
    (value) => {
      delete value.data.c0;
    },
    (value) => {
      value.data.c0.nameWithOwner = "other/repository";
    },
    (value) => {
      value.data.c0.object.oid = "f".repeat(40);
    },
    (value) => {
      value.data.c0.object.authors.nodes = [];
    },
    (value) => {
      value.data.c0.object.authors.nodes[0].user = {
        login: "bad user",
        avatarUrl,
      };
    },
    (value) => {
      value.data.c0.object.authors.nodes[0].user = {
        login: "Alice",
        avatarUrl: "https://evil.example/avatar",
      };
    },
    (value) => {
      value.data.c0.object.authors.pageInfo = {
        hasNextPage: true,
        endCursor: null,
      };
    },
    (value) => {
      value.data.c0.object.authors.pageInfo = {
        hasNextPage: true,
        endCursor: "bad\ncursor",
      };
    },
  ];
  for (const mutate of mutations) {
    const resolve = createCommitAuthorResolver(
      "token",
      async (_url, options) => {
        const value = authorGraph(options);
        mutate(value);
        return Response.json(value);
      },
    );
    await assert.rejects(resolve([authorCommit()]), BackendError);
  }
  for (const record of [null, {}, { ...authorCommit(), author: undefined }]) {
    await assert.rejects(createCommitAuthorResolver()([record]), {
      status: 502,
    });
  }
});

test("same-SHA complete shared author sets deduplicate, conflicting sets fail", () => {
  const shared = ["alice", "bob"].map((login) => ({ login, avatarUrl }));
  const alice = parseCommit(authorCommit(), "alice", undefined, shared);
  const bob = parseCommit(
    authorCommit(),
    "bob",
    "fork/repository",
    [...shared].reverse(),
  );
  assert.ok(alice && bob);
  assert.deepEqual(deduplicateCommits([alice, bob]), [alice]);
  assert.deepEqual(alice.authors, shared);
  const conflict = { ...bob, authors: [{ login: "bob", avatarUrl }] };
  assert.throws(() => deduplicateCommits([alice, conflict]), { status: 502 });
});
