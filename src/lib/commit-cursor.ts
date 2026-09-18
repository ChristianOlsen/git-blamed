import { isRecord, isRepositoryName } from "./backend-errors.ts";
import {
  COMMITS_PER_PAGE,
  PULL_REQUEST_COMMIT_LIMIT,
  PULL_REQUESTS_PER_PAGE,
  SEARCH_RESULT_LIMIT,
} from "./search-page.ts";
import type { CommitCursor, SearchCursor } from "./types.ts";

export function initialCommitCursor(exhausted = false): CommitCursor {
  return {
    search: { page: 1, exhausted },
    pullRequests: { page: 1, exhausted, pending: [], commitPage: 1 },
    exhausted,
  };
}

function isSearchCursor(
  value: unknown,
  perPage: number,
): value is SearchCursor & Record<string, unknown> {
  const maxPage = SEARCH_RESULT_LIMIT / perPage;
  return (
    isRecord(value) &&
    typeof value.page === "number" &&
    Number.isInteger(value.page) &&
    value.page >= 1 &&
    value.page <= maxPage + 1 &&
    typeof value.exhausted === "boolean" &&
    (value.exhausted || value.page <= maxPage)
  );
}

export function isCommitCursor(value: unknown): value is CommitCursor {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["search", "pullRequests", "exhausted"].includes(key),
    ) ||
    !isSearchCursor(value.search, COMMITS_PER_PAGE) ||
    Object.keys(value.search).some(
      (key) => !["page", "exhausted"].includes(key),
    ) ||
    !isRecord(value.pullRequests)
  ) {
    return false;
  }
  const pulls = value.pullRequests;
  return (
    isSearchCursor(pulls, PULL_REQUESTS_PER_PAGE) &&
    Object.keys(pulls).every((key) =>
      ["page", "exhausted", "pending", "commitPage"].includes(key),
    ) &&
    Array.isArray(pulls.pending) &&
    pulls.pending.length <= PULL_REQUESTS_PER_PAGE &&
    pulls.pending.every(
      (pull) =>
        isRecord(pull) &&
        Object.keys(pull).every((key) =>
          ["repository", "number"].includes(key),
        ) &&
        isRepositoryName(pull.repository) &&
        typeof pull.number === "number" &&
        Number.isSafeInteger(pull.number) &&
        pull.number > 0,
    ) &&
    typeof pulls.commitPage === "number" &&
    Number.isInteger(pulls.commitPage) &&
    pulls.commitPage >= 1 &&
    pulls.commitPage <=
      Math.ceil(PULL_REQUEST_COMMIT_LIMIT / COMMITS_PER_PAGE) &&
    (pulls.pending.length > 0 || pulls.commitPage === 1) &&
    value.exhausted ===
      (value.search.exhausted && pulls.exhausted && pulls.pending.length === 0)
  );
}
