import {
  BackendError,
  isAvatarUrl,
  isRecord,
  isUsername,
} from "./backend-errors.ts";
import { type Fetcher, githubGet } from "./github-client.ts";
import type { CommitBatch, CommitCard, CommitRequest } from "./types.ts";

const PER_PAGE = 100;
const MAX_PAGE = 10;

export function validateCommitRequest(value: unknown): CommitRequest {
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
  const cursors: CommitRequest["cursors"] = {};
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

function parseCommit(value: unknown, username: string): CommitCard | null {
  if (!isRecord(value)) {
    throw new BackendError("GitHub returned an invalid commit record.", 502);
  }
  // Search can match unlinked historical identities. Only GitHub's linked author counts.
  if (value.author === null) return null;
  if (!isRecord(value.author) || typeof value.author.login !== "string") {
    throw new BackendError("GitHub returned an invalid commit author.", 502);
  }
  if (value.author.login.toLowerCase() !== username) return null;
  if (
    !isUsername(value.author.login) ||
    !isAvatarUrl(value.author.avatar_url) ||
    typeof value.sha !== "string" ||
    !/^[a-f\d]{40}$/i.test(value.sha) ||
    !isRecord(value.repository) ||
    typeof value.repository.full_name !== "string" ||
    value.repository.full_name.length > 200 ||
    !/^[a-z\d](?:[a-z\d-]*[a-z\d])?\/(?!\.{1,2}$)[a-z\d_.-]+$/i.test(
      value.repository.full_name,
    ) ||
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
  const repository = value.repository.full_name;
  const sha = value.sha.toLowerCase();
  return {
    id: sha,
    message,
    author: value.author.login.toLowerCase(),
    avatarUrl: value.author.avatar_url,
    url: `https://github.com/${repository}/commit/${sha}`,
    repository,
    committedAt: value.commit.committer.date,
  };
}

export async function searchCommitBatch(
  input: unknown,
  token?: string,
  fetcher: Fetcher = fetch,
  random: () => number = Math.random,
): Promise<CommitBatch> {
  const request = validateCommitRequest(input);
  if (request.requireAuth && !token) {
    throw new BackendError(
      "Connect a GitHub token to continue with private repository access.",
      401,
    );
  }
  // Keep a public game's search scope stable if the host signs in in another tab.
  const searchToken = request.requireAuth === false ? undefined : token;
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
      if (
        !isRecord(data) ||
        typeof data.total_count !== "number" ||
        !Number.isSafeInteger(data.total_count) ||
        data.total_count < 0 ||
        typeof data.incomplete_results !== "boolean" ||
        !Array.isArray(data.items) ||
        data.items.length > PER_PAGE
      ) {
        throw new BackendError(
          "GitHub returned an invalid search response.",
          502,
        );
      }
      if (data.incomplete_results) {
        throw new BackendError(
          "GitHub returned an incomplete search. Retry this batch; no pages were skipped.",
          503,
          30,
        );
      }
      const expectedItems = Math.min(
        PER_PAGE,
        Math.max(0, data.total_count - (cursor.page - 1) * PER_PAGE),
      );
      if (data.items.length < expectedItems) {
        throw new BackendError(
          "GitHub returned fewer results than its search count promised. Retry this batch; no pages were skipped.",
          503,
          30,
        );
      }
      const commits: CommitCard[] = [];
      for (const item of data.items) {
        const commit = parseCommit(item, username);
        if (commit) commits.push(commit);
      }
      const warnings: string[] = [];
      if (data.total_count === 0 && cursor.page === 1) {
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
          exhausted:
            cursor.page === MAX_PAGE ||
            data.items.length < PER_PAGE ||
            cursor.page * PER_PAGE >= data.total_count,
        },
        commits,
        warnings,
      };
    }),
  );
  const commits = new Map<string, CommitCard>();
  const cursors: CommitBatch["cursors"] = {};
  const warnings = new Set<string>();
  for (const result of results) {
    cursors[result.username] = result.cursor;
    for (const commit of result.commits) {
      const duplicate = commits.get(commit.id);
      if (duplicate && duplicate.author !== commit.author) {
        throw new BackendError(
          "GitHub returned conflicting author information. Retry the batch; no pages were skipped.",
          502,
        );
      }
      if (!duplicate) commits.set(commit.id, commit);
    }
    for (const warning of result.warnings) warnings.add(warning);
  }
  return {
    commits: rankCommits([...commits.values()], random),
    cursors,
    warnings: [...warnings],
    exhausted: Object.values(cursors).every((cursor) => cursor.exhausted),
  };
}
