import assert from "node:assert/strict";

export const avatarUrl = "https://avatars.githubusercontent.com/u/1";

export function authorCommit(
  index = 1,
  primary: string | null = "Copilot",
  repository = "owner/repository",
) {
  return {
    sha: index.toString(16).padStart(40, "0"),
    author: primary === null ? null : { login: primary, avatar_url: avatarUrl },
    repository: { full_name: repository },
    commit: {
      message:
        "finally the thing works!\n\nCo-authored-by: Untrusted Name <not-an-account@example.invalid>",
      author: {
        name: "Untrusted Name",
        email: "not-an-account@example.invalid",
      },
      committer: { date: "2026-09-01T12:30:00Z" },
    },
  };
}

export function authorGraph(
  options?: RequestInit,
  logins: (string | null)[] = ["Copilot", "Alice", "Bob"],
  pageInfo = { hasNextPage: false, endCursor: null as string | null },
) {
  assert.equal(typeof options?.body, "string");
  const { variables } = JSON.parse(String(options?.body));
  const count = Object.keys(variables).filter((key) =>
    key.startsWith("oid"),
  ).length;
  return {
    data: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `c${index}`,
        {
          nameWithOwner: `${variables[`owner${index}`]}/${variables[`name${index}`]}`,
          object: {
            oid: variables[`oid${index}`],
            authors: {
              nodes: logins.map((login) => ({
                user: login === null ? null : { login, avatarUrl },
              })),
              pageInfo,
            },
          },
        },
      ]),
    ),
  };
}
