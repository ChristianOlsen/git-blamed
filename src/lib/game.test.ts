import assert from "node:assert/strict";
import test from "node:test";
import { initialCommitCursor } from "./commit-cursor.ts";
import {
  appendUniqueCommits,
  type CommitPool,
  chooseNextRound,
  matchingCommitAuthors,
  navigationDirection,
  normalizePlayers,
  partyUrl,
  playersFromInput,
  playersFromParams,
  validatePlayers,
} from "./game.ts";
import type { CommitCard } from "./types.ts";

test("URL players accept comma-separated and repeated usernames", () => {
  assert.deepEqual(
    playersFromParams({
      users: " Alice, @BOB,alice",
      user: ["carol", "bob"],
      name: ["Al", "B"],
    }),
    [{ username: "alice" }, { username: "bob" }, { username: "carol" }],
  );
  assert.deepEqual(
    playersFromParams({ users: ["alice,bob", "carol", "alice"] }),
    [{ username: "alice" }, { username: "bob" }, { username: "carol" }],
  );
});

test("username input accepts commas and new lines without hiding duplicates or invalid names", () => {
  assert.deepEqual(playersFromInput(" Alice,\n@Bob\r\ncarol, ,"), [
    { username: "alice" },
    { username: "bob" },
    { username: "carol" },
  ]);
  assert.deepEqual(playersFromInput(""), []);
  assert.match(
    validatePlayers(playersFromInput("alice,ALICE")) ?? "",
    /more than once/,
  );
  assert.match(
    validatePlayers(playersFromInput("alice,bad name")) ?? "",
    /valid GitHub username/,
  );
});

test("invalid and oversized URL lineups aren't silently hidden", () => {
  const players = playersFromParams({ users: "alice,bad/name" });
  assert.match(validatePlayers(players) ?? "", /valid GitHub username/);
  const many = playersFromParams({
    users: Array.from({ length: 9 }, (_, index) => `user${index}`).join(","),
  });
  assert.match(validatePlayers(many) ?? "", /up to 8/);
});

test("lineup validation normalizes, disallows duplicate and invalid names", () => {
  const player = (username: string) => ({ username });
  assert.equal(validatePlayers([player("@Alice"), player("bob-2")]), null);
  assert.match(
    validatePlayers([player("@Alice"), player("ALICE")]) ?? "",
    /more than once/,
  );
  for (const invalid of [
    "",
    "-alice",
    "alice-",
    "al--ice",
    "a b",
    "x".repeat(40),
  ]) {
    assert.notEqual(validatePlayers([player(invalid), player("bob")]), null);
  }
  assert.notEqual(validatePlayers([player("alice")]), null);
});

test("party URLs round-trip the full username list without display names", () => {
  const players = [
    { username: "@Alice" },
    { username: "BOB" },
    { username: "carol" },
  ];
  assert.equal(partyUrl(players), "/?users=alice,bob,carol");
  const url = new URL(partyUrl(players), "http://localhost");
  const decoded = playersFromParams({
    users: url.searchParams.get("users") ?? "",
    name: ["Not Alice", "Not Bob"],
  });
  assert.deepEqual(decoded, normalizePlayers(players));
  assert.deepEqual([...url.searchParams.keys()], ["users"]);
});

test("invalid URL input cannot add extra query parameters when shared", () => {
  const url = new URL(
    partyUrl([{ username: "alice&admin=true" }]),
    "http://localhost",
  );
  assert.equal(url.searchParams.get("users"), "alice&admin=true");
  assert.equal(url.searchParams.has("admin"), false);
});

test("keyboard navigation supports both axes and avoids repeat or input hijacking", () => {
  for (const key of ["Enter", " ", "ArrowRight", "ArrowDown"]) {
    assert.equal(navigationDirection(key, false, false), 1);
  }
  for (const key of ["ArrowLeft", "ArrowUp"]) {
    assert.equal(navigationDirection(key, false, false), -1);
  }
  assert.equal(navigationDirection("Escape", false, false), 0);
  assert.equal(navigationDirection("Enter", true, false), 0);
  assert.equal(navigationDirection(" ", false, true), 0);
  assert.equal(navigationDirection("ArrowLeft", false, false, true), 0);
});

test("paging deduplicates commits and messages while preserving back history", () => {
  const card = (id: string, message: string): CommitCard => ({
    id,
    message,
    authors: [{ login: "alice", avatarUrl: "" }],
    url: "",
    repository: "",
    committedAt: "",
  });
  const original = [card("a", "Oops")];
  assert.deepEqual(
    appendUniqueCommits(original, [
      card("a", "Oops"),
      card("b", " oops "),
      card("c", "Oh no"),
      card("c", "Oh no"),
    ]),
    [card("a", "Oops"), card("c", "Oh no")],
  );
  assert.equal(original.length, 1);
});

function candidate(
  id: string,
  author: string,
  message = `Commit ${id}`,
): CommitCard {
  return {
    id,
    authors: [{ login: author, avatarUrl: "" }],
    message,
    url: "",
    repository: "",
    committedAt: "",
  };
}

function commitPool(candidates: CommitCard[]): CommitPool {
  return {
    players: [{ username: "alice" }, { username: "bob" }],
    commits: [],
    candidates,
    cursors: {
      alice: initialCommitCursor(true),
      bob: initialCommitCursor(true),
    },
  };
}

test("participants have equal probability despite a 100-to-1 commit imbalance", () => {
  const pool = commitPool([
    ...Array.from({ length: 100 }, (_, index) =>
      candidate(`a${index}`, "alice"),
    ),
    candidate("b", "bob", "boring"),
  ]);
  const original = structuredClone(pool);
  const counts = new Map<string, number>();
  let draws = 0;
  for (let index = 0; index < 1000; index++) {
    const round = chooseNextRound(pool, () => {
      draws++;
      return index / 1000;
    });
    assert.equal(round.kind, "commit");
    if (round.kind !== "commit") throw new Error("Expected a commit");
    const author = round.commit.authors[0].login;
    counts.set(author, (counts.get(author) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(counts), { alice: 500, bob: 500 });
  assert.equal(draws, 1000);
  assert.deepEqual(pool, original);
});

test("random participant repeats are allowed without repeating commits or changing history", () => {
  const pool = commitPool([
    candidate("a1", "alice"),
    candidate("a2", "alice"),
    candidate("b1", "bob"),
  ]);
  const first = chooseNextRound(pool, () => 0);
  assert.equal(first.kind, "commit");
  if (first.kind !== "commit") throw new Error("Expected a commit");
  const afterFirst = {
    ...pool,
    commits: [first.commit],
    candidates: first.candidates,
  };
  const original = structuredClone(afterFirst);
  const second = chooseNextRound(afterFirst, () => 0);
  assert.equal(second.kind, "commit");
  if (second.kind !== "commit") throw new Error("Expected a commit");
  assert.equal(first.commit.id, "a1");
  assert.equal(second.commit.id, "a2");
  assert.deepEqual(second.commit.authors, first.commit.authors);
  assert.deepEqual(afterFirst, original);
  const third = chooseNextRound({
    ...afterFirst,
    commits: [...afterFirst.commits, second.commit],
    candidates: second.candidates,
  });
  assert.equal(third.kind, "commit");
  if (third.kind !== "commit") throw new Error("Expected a commit");
  assert.equal(third.commit.id, "b1");
  assert.deepEqual(
    chooseNextRound({
      ...afterFirst,
      commits: [...afterFirst.commits, second.commit, third.commit],
      candidates: third.candidates,
    }),
    { kind: "finished", usernames: ["alice", "bob"] },
  );
});

test("depleted participants refill before any random draw; buffered authors need no new pages", () => {
  const pool = commitPool([candidate("a1", "alice")]);
  pool.cursors.bob = initialCommitCursor();
  assert.deepEqual(
    chooseNextRound(pool, () => {
      throw new Error(
        "Do not choose an author before everyone has a candidate",
      );
    }),
    { kind: "fetch", usernames: ["bob"] },
  );
  assert.deepEqual(
    chooseNextRound({
      ...pool,
      candidates: [...pool.candidates, candidate("duplicate", "bob", "seen")],
      commits: [candidate("played", "alice", " SEEN ")],
    }),
    { kind: "fetch", usernames: ["bob"] },
  );
  const refilled = chooseNextRound(
    {
      ...pool,
      candidates: [...pool.candidates, candidate("b1", "bob")],
      cursors: { ...pool.cursors, bob: initialCommitCursor(true) },
    },
    () => 0.75,
  );
  assert.equal(refilled.kind, "commit");
  if (refilled.kind !== "commit") throw new Error("Expected a commit");
  assert.equal(refilled.commit.authors[0].login, "bob");
});

test("pending original PR commits keep a player searchable after indexed search ends", () => {
  const pool = commitPool([candidate("b1", "bob")]);
  pool.cursors.alice = {
    search: { page: 11, exhausted: true },
    pullRequests: {
      page: 2,
      exhausted: true,
      pending: [{ repository: "owner/repository", number: 412 }],
      commitPage: 2,
    },
    exhausted: false,
  };
  assert.deepEqual(chooseNextRound(pool), {
    kind: "fetch",
    usernames: ["alice"],
  });
});

test("the game keeps going while anyone has commits left and only ends when everyone runs out", () => {
  const pool = commitPool([candidate("a1", "alice")]);
  pool.cursors.alice = initialCommitCursor();
  const round = chooseNextRound(pool, () => 0);
  assert.equal(round.kind, "commit");
  if (round.kind !== "commit") throw new Error("Expected a commit");
  assert.equal(round.commit.id, "a1");
  assert.deepEqual(chooseNextRound({ ...pool, candidates: [] }), {
    kind: "fetch",
    usernames: ["alice"],
  });
  assert.deepEqual(chooseNextRound(commitPool([])), {
    kind: "finished",
    usernames: ["alice", "bob"],
  });
});

test("an exhausted player never takes a turn once their queue is empty", () => {
  const pool = commitPool([candidate("a1", "alice"), candidate("a2", "alice")]);
  const authors = new Set<string>();
  for (let index = 0; index < 100; index++) {
    const round = chooseNextRound(pool, () => index / 100);
    assert.equal(round.kind, "commit");
    if (round.kind !== "commit") throw new Error("Expected a commit");
    authors.add(round.commit.authors[0].login);
  }
  assert.deepEqual([...authors], ["alice"]);
});

test("shared unseen messages remain eligible for either author, then are removed globally", () => {
  const pool = commitPool([
    candidate("a1", "alice", "same subject"),
    candidate("a2", "alice"),
    candidate("b1", "bob", " SAME SUBJECT "),
  ]);
  for (const [random, author] of [
    [0, "alice"],
    [0.75, "bob"],
  ] as const) {
    const round = chooseNextRound(pool, () => random);
    assert.equal(round.kind, "commit");
    if (round.kind !== "commit") throw new Error("Expected a commit");
    assert.equal(round.commit.authors[0].login, author);
    assert.deepEqual(round.candidates, [candidate("a2", "alice")]);
  }
});

test("ranking stays within the selected author and used SHAs or messages never return", () => {
  const pool = commitPool([
    candidate("used", "bob", "changed subject"),
    candidate("copy", "bob", " SHOWN "),
    candidate("a1", "alice", "funny ranked subject"),
    candidate("b1", "bob", "first ranked bob subject"),
    candidate("b2", "bob", "First Ranked Bob Subject"),
    candidate("b3", "bob"),
  ]);
  pool.commits = [candidate("used", "alice", "shown")];
  const round = chooseNextRound(pool, () => 0.5);
  assert.equal(round.kind, "commit");
  if (round.kind !== "commit") throw new Error("Expected a commit");
  assert.equal(round.commit.id, "b1");
  assert.deepEqual(
    round.candidates.map((commit) => commit.id),
    ["a1", "b3"],
  );
});

test("new pools fetch all participants and reject a missing lineup", () => {
  assert.deepEqual(chooseNextRound({ ...commitPool([]), cursors: {} }), {
    kind: "fetch",
    usernames: ["alice", "bob"],
  });
  assert.throws(
    () => chooseNextRound({ ...commitPool([]), players: [] }),
    /needs participants/,
  );
});

test("a shared commit is eligible for every matching player even if their searches are exhausted", () => {
  const shared: CommitCard = {
    ...candidate("shared", "copilot"),
    authors: ["copilot", "alice", "bob"].map((login) => ({
      login,
      avatarUrl: "",
    })),
  };
  const pool = commitPool([
    shared,
    candidate("a1", "alice"),
    candidate("b1", "bob"),
  ]);
  const snapshot = structuredClone(pool);
  for (const random of [0, 0.75]) {
    const round = chooseNextRound(pool, () => random);
    assert.equal(round.kind, "commit");
    if (round.kind !== "commit") throw new Error("Expected a shared commit");
    assert.equal(round.commit.id, "shared");
    assert.deepEqual(
      matchingCommitAuthors(round.commit, pool.players).map(
        ({ login }) => login,
      ),
      ["alice", "bob"],
    );
    assert.deepEqual(
      round.candidates.map(({ id }) => id),
      ["a1", "b1"],
    );
    assert.deepEqual(pool, snapshot);
  }
});

test("shared candidates stay deduplicated across player queues and cannot repeat once shown", () => {
  const shared: CommitCard = {
    ...candidate("shared", "alice"),
    authors: [
      { login: "alice", avatarUrl: "" },
      { login: "bob", avatarUrl: "" },
    ],
  };
  const pool = commitPool([
    candidate("a1", "alice"),
    candidate("b1", "bob"),
    shared,
    structuredClone(shared),
  ]);
  const first = chooseNextRound(pool, () => 0);
  if (first.kind !== "commit") throw new Error("Expected a commit");
  assert.equal(first.commit.id, "a1");
  assert.equal(first.candidates.filter(({ id }) => id === "shared").length, 1);
  const second = chooseNextRound(
    {
      ...pool,
      commits: [first.commit],
      candidates: first.candidates,
    },
    () => 0,
  );
  if (second.kind !== "commit") throw new Error("Expected a shared commit");
  assert.equal(second.commit.id, "shared");
  const third = chooseNextRound({
    ...pool,
    commits: [first.commit, second.commit],
    candidates: [...second.candidates, shared],
  });
  assert.equal(third.kind, "commit");
  if (third.kind !== "commit") throw new Error("Expected bob's last commit");
  assert.equal(third.commit.id, "b1");
  assert.deepEqual(
    chooseNextRound({
      ...pool,
      commits: [first.commit, second.commit, third.commit],
      candidates: third.candidates,
    }),
    { kind: "finished", usernames: ["alice", "bob"] },
  );
});

test("reveals include all matching authors in lineup order without outside accounts", () => {
  const commit: CommitCard = {
    ...candidate("shared", "copilot"),
    authors: [
      { login: "copilot", avatarUrl: "bot-avatar" },
      { login: "BOB", avatarUrl: "bob-avatar" },
      { login: "alice", avatarUrl: "alice-avatar" },
      { login: "charlie", avatarUrl: "charlie-avatar" },
    ],
  };
  assert.deepEqual(
    matchingCommitAuthors(commit, [
      { username: "alice" },
      { username: "bob" },
      { username: "dana" },
    ]),
    [
      { login: "alice", avatarUrl: "alice-avatar" },
      { login: "BOB", avatarUrl: "bob-avatar" },
    ],
  );
});
