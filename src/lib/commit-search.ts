import {
  BackendError,
  isRecord,
  isRepositoryName,
  isUsername,
} from "./backend-errors.ts";
import {
  type CommitAuthorResolver,
  createCommitAuthorResolver,
  primaryCommitAuthors,
} from "./commit-authors.ts";
import { type Fetcher, githubGet } from "./github-client.ts";
import {
  COMMITS_PER_PAGE,
  parseSearchPage,
  SEARCH_RESULT_LIMIT,
} from "./search-page.ts";
import type {
  CommitCard,
  IndexedCommitBatch,
  IndexedCommitRequest,
  Viewer,
} from "./types.ts";

const PER_PAGE = COMMITS_PER_PAGE;
const MAX_PAGE = SEARCH_RESULT_LIMIT / PER_PAGE;

export function validateCommitRequest(value: unknown): IndexedCommitRequest {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["usernames", "cursors", "requireAuth"].includes(key),
    ) ||
    !Array.isArray(value.usernames) ||
    value.usernames.length < 1 ||
    value.usernames.length > 8 ||
    !isRecord(value.cursors) ||
    (value.requireAuth !== undefined && typeof value.requireAuth !== "boolean")
  ) {
    throw new BackendError(
      "Provide 1–8 GitHub usernames and a cursors object.",
      400,
    );
  }
  const usernames = value.usernames.map((name: unknown) => {
    if (typeof name !== "string" || !isUsername(name.trim())) {
      throw new BackendError("One of the GitHub usernames is invalid.", 400);
    }
    return name.trim().toLowerCase();
  });
  if (new Set(usernames).size !== usernames.length) {
    throw new BackendError("GitHub usernames must be unique.", 400);
  }
  const cursors: IndexedCommitRequest["cursors"] = {};
  for (const [username, cursor] of Object.entries(value.cursors)) {
    if (
      !usernames.includes(username) ||
      !isRecord(cursor) ||
      Object.keys(cursor).some((key) => !["page", "exhausted"].includes(key)) ||
      typeof cursor.page !== "number" ||
      !Number.isInteger(cursor.page) ||
      cursor.page < 1 ||
      cursor.page > MAX_PAGE + 1 ||
      typeof cursor.exhausted !== "boolean" ||
      (!cursor.exhausted && cursor.page > MAX_PAGE)
    ) {
      throw new BackendError(
        "Invalid commit cursor. Restart the game to start a fresh search.",
        400,
      );
    }
    cursors[username] = {
      page: cursor.page,
      exhausted: cursor.exhausted,
    };
  }
  return {
    usernames,
    cursors,
    ...(value.requireAuth === undefined
      ? {}
      : { requireAuth: value.requireAuth }),
  };
}

export function isCommitNoise(message: string): boolean {
  return (
    /^merge (?:pull request|branch|remote-tracking branch|tag)\b/i.test(
      message,
    ) ||
    /^(?:(?:build|chore|ci)(?:\([^)]*\))?!?:\s*)?(?:bump|update|upgrade) (?:dependencies|devdependencies|lockfile)\b/i.test(
      message,
    ) ||
    /^(?:(?:build|chore|ci)(?:\([^)]*\))?!?:\s*)?bump .+ from \S+ to \S+/i.test(
      message,
    ) ||
    /^(?:build|chore|ci)\(deps(?:-dev)?\):/i.test(message)
  );
}

export function scoreMessage(message: string): number {
  const subject = message.split("\n", 1)[0];
  let score = subject.length >= 12 && subject.length <= 120 ? 3 : 0;
  if (subject.length <= 5) score -= 2;
  if (message.length > 300) score -= 2;
  if (
    /\b(?:oops|woops|whoops|wtf|why|please|finally|actually|somehow|apparently|magic|sorry|again|yolo|lol|hell|damn|fuck|shit|nope|never|sleep|coffee|hack)\b/i.test(
      subject,
    )
  ) {
    score += 4;
  }
  if (/[!?]|\p{Extended_Pictographic}/u.test(subject)) score += 1;
  if (/^(?:fix|feat|refactor|docs|test|chore)(?:\([^)]*\))?:/i.test(subject)) {
    score -= 1;
  }
  return score;
}

export function rankCommits(
  commits: CommitCard[],
  random: () => number = Math.random,
): CommitCard[] {
  const decorated = commits.map((commit) => ({
    commit,
    score: scoreMessage(commit.message) + random() * 3,
  }));
  decorated.sort((a, b) => b.score - a.score);
  return decorated.map(({ commit }) => commit);
}

export function parseCommit(
  value: unknown,
  username: string,
  repositoryName?: string,
  verifiedAuthors?: Viewer[],
): CommitCard | null {
  if (!isRecord(value)) {
    throw new BackendError("GitHub returned an invalid commit record.", 502);
  }
  const authors = verifiedAuthors ?? primaryCommitAuthors(value);
  if (!authors.some((author) => author.login === username)) return null;
  const repository =
    repositoryName ??
    (isRecord(value.repository) ? value.repository.full_name : undefined);
  if (
    typeof value.sha !== "string" ||
    !/^[a-f\d]{40}$/i.test(value.sha) ||
    !isRepositoryName(repository) ||
    !isRecord(value.commit) ||
    typeof value.commit.message !== "string" ||
    !isRecord(value.commit.committer) ||
    typeof value.commit.committer.date !== "string" ||
    value.commit.committer.date.length > 40 ||
    !Number.isFinite(Date.parse(value.commit.committer.date))
  ) {
    throw new BackendError("GitHub returned an invalid commit record.", 502);
  }
  const message = value.commit.message
    .trim()
    .split(/\r?\n/, 1)[0]
    .replace(/\p{Cc}/gu, (char) => ("\n\r\t".includes(char) ? char : ""))
    .trim()
    .slice(0, 1000);
  if (!message || isCommitNoise(message)) return null;
  const sha = value.sha.toLowerCase();
  return {
    id: sha,
    message,
    authors,
    url: `https://github.com/${repository}/commit/${sha}`,
    repository,
    committedAt: value.commit.committer.date,
  };
}

export function deduplicateCommits(commits: CommitCard[]): CommitCard[] {
  const unique = new Map<string, CommitCard>();
  for (const commit of commits) {
    const duplicate = unique.get(commit.id);
    if (
      duplicate &&
      (duplicate.authors.length !== commit.authors.length ||
        duplicate.authors.some(
          (author) =>
            !commit.authors.some((other) => other.login === author.login),
        ))
    ) {
      throw new BackendError(
        "GitHub returned conflicting author information. Retry the batch; no pages were skipped.",
        502,
      );
    }
    if (!duplicate) unique.set(commit.id, commit);
  }
  return [...unique.values()];
}

export async function searchCommitBatch(
  input: unknown,
  token?: string,
  fetcher: Fetcher = fetch,
  random: () => number = Math.random,
  options: {
    warnOnEmpty?: boolean;
    resolveAuthors?: CommitAuthorResolver;
  } = {},
): Promise<IndexedCommitBatch> {
  const request = validateCommitRequest(input);
  if (request.requireAuth && !token) {
    throw new BackendError(
      "Connect a GitHub token to continue with private repository access.",
      401,
    );
  }
  // Keep a public game's search scope stable if the host signs in in another tab.
  const searchToken = request.requireAuth === false ? undefined : token;
  const resolveAuthors = searchToken
    ? (options.resolveAuthors ??
      createCommitAuthorResolver(searchToken, fetcher))
    : createCommitAuthorResolver(undefined, fetcher);
  const results = await Promise.all(
    request.usernames.map(async (username) => {
      const cursor = Object.hasOwn(request.cursors, username)
        ? request.cursors[username]
        : { page: 1, exhausted: false };
      if (cursor.exhausted) {
        return { username, cursor, commits: [] as CommitCard[], warnings: [] };
      }
      const query = new URLSearchParams({
        q: `author:${username}`,
        sort: "committer-date",
        order: "desc",
        per_page: String(PER_PAGE),
        page: String(cursor.page),
      });
      const data = await githubGet(
        `/search/commits?${query}`,
        searchToken,
        fetcher,
      );
      const page = parseSearchPage(data, cursor.page, PER_PAGE);
      const authors = await resolveAuthors(page.items);
      const commits: CommitCard[] = [];
      for (const [index, item] of page.items.entries()) {
        const commit = parseCommit(item, username, undefined, authors[index]);
        if (commit) commits.push(commit);
      }
      const warnings: string[] = [];
      if (
        options.warnOnEmpty !== false &&
        page.totalCount === 0 &&
        cursor.page === 1
      ) {
        warnings.push(
          searchToken
            ? `@${username}: no indexed commits visible to the host were found. Private repository access, SSO, and GitHub indexing can affect results.`
            : `@${username}: no indexed public commits were found. Check the username and GitHub indexing; private repositories require an optional token connection.`,
        );
      }
      return {
        username,
        cursor: {
          page: cursor.page + 1,
          exhausted: page.exhausted,
        },
        commits,
        warnings,
      };
    }),
  );
  const cursors: IndexedCommitBatch["cursors"] = {};
  const warnings = new Set<string>();
  for (const result of results) {
    cursors[result.username] = result.cursor;
    for (const warning of result.warnings) warnings.add(warning);
  }
  return {
    commits: rankCommits(
      deduplicateCommits(results.flatMap((result) => result.commits)),
      random,
    ),
    cursors,
    warnings: [...warnings],
    exhausted: Object.values(cursors).every((cursor) => cursor.exhausted),
  };
}
