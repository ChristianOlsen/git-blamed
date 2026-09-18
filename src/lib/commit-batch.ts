import { BackendError, isRecord } from "./backend-errors.ts";
import { createCommitAuthorResolver } from "./commit-authors.ts";
import { initialCommitCursor, isCommitCursor } from "./commit-cursor.ts";
import {
  deduplicateCommits,
  rankCommits,
  searchCommitBatch,
  validateCommitRequest,
} from "./commit-search.ts";
import type { Fetcher } from "./github-client.ts";
import { fetchPullRequestCommits } from "./pull-request-commits.ts";
import type { CommitBatch, CommitCard, CommitRequest } from "./types.ts";

export function validateBatchRequest(input: unknown): CommitRequest {
  if (!isRecord(input) || !isRecord(input.cursors)) {
    throw new BackendError(
      "Provide GitHub usernames and a cursors object.",
      400,
    );
  }
  const cursors: CommitRequest["cursors"] = Object.fromEntries(
    Object.entries(input.cursors).map(([username, cursor]) => {
      if (!isCommitCursor(cursor)) {
        throw new BackendError(
          "Invalid commit cursor. Restart the game to start a fresh search.",
          400,
        );
      }
      return [username, structuredClone(cursor)];
    }),
  );
  const request = validateCommitRequest({
    ...input,
    cursors: Object.fromEntries(
      Object.entries(cursors).map(([username, cursor]) => [
        username,
        cursor.search,
      ]),
    ),
  });
  return { ...request, cursors };
}

export async function fetchCommitBatch(
  input: unknown,
  token?: string,
  fetcher: Fetcher = fetch,
  random: () => number = Math.random,
): Promise<CommitBatch> {
  const request = validateBatchRequest(input);
  if (request.requireAuth && !token) {
    throw new BackendError(
      "Connect a GitHub token to continue with private repository access.",
      401,
    );
  }
  const searchToken = request.requireAuth === false ? undefined : token;
  const resolveAuthors = createCommitAuthorResolver(searchToken, fetcher);
  const results = await Promise.all(
    request.usernames.map(async (username) => {
      const cursor = Object.hasOwn(request.cursors, username)
        ? request.cursors[username]
        : initialCommitCursor();
      if (cursor.exhausted) {
        return { username, cursor, commits: [] as CommitCard[], warnings: [] };
      }
      // Reserve the search quota for PR discovery when its queue is empty.
      // Otherwise, mix an indexed page with the next page of original commits.
      const discoveringPulls =
        !cursor.pullRequests.exhausted && !cursor.pullRequests.pending.length;
      const [pulls, indexed] = await Promise.all([
        fetchPullRequestCommits(
          username,
          cursor.pullRequests,
          searchToken,
          fetcher,
          resolveAuthors,
        ),
        discoveringPulls || cursor.search.exhausted
          ? undefined
          : searchCommitBatch(
              {
                usernames: [username],
                cursors: { [username]: cursor.search },
                requireAuth: request.requireAuth,
              },
              searchToken,
              fetcher,
              random,
              { warnOnEmpty: false, resolveAuthors },
            ),
      ]);
      const search = indexed?.cursors[username] ?? cursor.search;
      return {
        username,
        cursor: {
          search,
          pullRequests: pulls.cursor,
          exhausted:
            search.exhausted &&
            pulls.cursor.exhausted &&
            !pulls.cursor.pending.length,
        },
        commits: [...pulls.commits, ...(indexed?.commits ?? [])],
        warnings: indexed?.warnings ?? [],
      };
    }),
  );
  const cursors = Object.fromEntries(
    results.map((result) => [result.username, result.cursor]),
  );
  return {
    commits: rankCommits(
      deduplicateCommits(results.flatMap((result) => result.commits)),
      random,
    ),
    cursors,
    warnings: [...new Set(results.flatMap((result) => result.warnings))],
    exhausted: Object.values(cursors).every((cursor) => cursor.exhausted),
  };
}
