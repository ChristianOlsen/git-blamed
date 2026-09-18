import assert from "node:assert/strict";
import test from "node:test";
import {
  appendUniqueCommits,
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
    author: "alice",
    avatarUrl: "",
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
