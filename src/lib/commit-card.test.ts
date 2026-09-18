import assert from "node:assert/strict";
import test from "node:test";
import { isCommitCard } from "./commit-card.ts";

const author = {
  login: "alice",
  avatarUrl: "https://avatars.githubusercontent.com/u/1",
};
const card = {
  id: "a".repeat(40),
  message: "finally, a working commit",
  authors: [author],
  url: `https://github.com/owner/repository/commit/${"a".repeat(40)}`,
  repository: "owner/repository",
  committedAt: "2026-09-01T12:30:00Z",
};

test("commit responses accept one or multiple linked authors", () => {
  assert.equal(isCommitCard(card), true);
  assert.equal(
    isCommitCard({
      ...card,
      authors: [author, { ...author, login: "bob" }],
    }),
    true,
  );
});

test("commit responses reject missing, invalid or duplicate authors", () => {
  for (const authors of [
    undefined,
    null,
    [],
    [null],
    [{ login: "alice" }],
    [{ ...author, login: "bad user" }],
    [{ ...author, avatarUrl: "https://example.com/avatar" }],
    [author, { ...author, login: "ALICE" }],
  ]) {
    assert.equal(isCommitCard({ ...card, authors }), false);
  }
  assert.equal(
    isCommitCard({
      ...card,
      authors: undefined,
      author: "alice",
      avatarUrl: "",
    }),
    false,
  );
  assert.equal(isCommitCard({ ...card, message: null }), false);
  assert.equal(isCommitCard(null), false);
});
