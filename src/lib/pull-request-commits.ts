import { BackendError, isRecord, isRepositoryName } from "./backend-errors.ts";
import {
  type CommitAuthorResolver,
  createCommitAuthorResolver,
} from "./commit-authors.ts";
import { parseCommit } from "./commit-search.ts";
import { type Fetcher, githubGet } from "./github-client.ts";
import {
  COMMITS_PER_PAGE,
  PULL_REQUEST_COMMIT_LIMIT,
  PULL_REQUESTS_PER_PAGE,
  parseSearchPage,
} from "./search-page.ts";
import type {
  CommitCard,
  PullRequestCursor,
  PullRequestReference,
} from "./types.ts";

function parsePullRequest(value: unknown): PullRequestReference {
  // Author searches can match bot-created PRs; check authors on commits instead.
  if (
    !isRecord(value) ||
    typeof value.repository_url !== "string" ||
    !value.repository_url.startsWith("https://api.github.com/repos/") ||
    typeof value.number !== "number" ||
    !Number.isSafeInteger(value.number) ||
    value.number < 1 ||
    !isRecord(value.pull_request)
  ) {
    throw new BackendError("GitHub returned an invalid pull request.", 502);
  }
  const repository = value.repository_url.slice(
    "https://api.github.com/repos/".length,
  );
  if (!isRepositoryName(repository)) {
    throw new BackendError("GitHub returned an invalid pull request.", 502);
  }
  return { repository, number: value.number };
}

export async function fetchPullRequestCommits(
  username: string,
  cursor: PullRequestCursor,
  token?: string,
  fetcher: Fetcher = fetch,
  resolveAuthors: CommitAuthorResolver = createCommitAuthorResolver(
    token,
    fetcher,
  ),
): Promise<{ commits: CommitCard[]; cursor: PullRequestCursor }> {
  let next = { ...cursor, pending: [...cursor.pending] };
  if (!next.pending.length && !next.exhausted) {
    const query = new URLSearchParams({
      q: `type:pr author:${username}`,
      sort: "updated",
      order: "desc",
      per_page: String(PULL_REQUESTS_PER_PAGE),
      page: String(next.page),
    });
    const data = await githubGet(`/search/issues?${query}`, token, fetcher);
    const page = parseSearchPage(data, next.page, PULL_REQUESTS_PER_PAGE);
    next = {
      page: next.page + 1,
      exhausted: page.exhausted,
      pending: page.items.map(parsePullRequest),
      commitPage: 1,
    };
  }
  const pull = next.pending[0];
  if (!pull) return { commits: [], cursor: next };

  const data = await githubGet(
    `/repos/${pull.repository}/pulls/${pull.number}/commits?per_page=${COMMITS_PER_PAGE}&page=${next.commitPage}`,
    token,
    fetcher,
  );
  const remaining =
    PULL_REQUEST_COMMIT_LIMIT - (next.commitPage - 1) * COMMITS_PER_PAGE;
  if (
    !Array.isArray(data) ||
    data.length > Math.min(COMMITS_PER_PAGE, remaining)
  ) {
    throw new BackendError(
      "GitHub returned an invalid pull request commit response.",
      502,
    );
  }
  const commits: CommitCard[] = [];
  const authors = await resolveAuthors(data, pull.repository);
  for (const [index, item] of data.entries()) {
    const commit = parseCommit(item, username, pull.repository, authors[index]);
    if (commit) commits.push(commit);
  }
  if (data.length < COMMITS_PER_PAGE || remaining <= COMMITS_PER_PAGE) {
    next.pending.shift();
    next.commitPage = 1;
  } else {
    next.commitPage++;
  }
  return { commits, cursor: next };
}
