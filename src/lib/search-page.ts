import { BackendError, isRecord } from "./backend-errors.ts";

export const SEARCH_RESULT_LIMIT = 1000;
export const COMMITS_PER_PAGE = 100;
export const PULL_REQUESTS_PER_PAGE = 5;
export const PULL_REQUEST_COMMIT_LIMIT = 250;

export function parseSearchPage(
  data: unknown,
  page: number,
  perPage: number,
): { items: unknown[]; totalCount: number; exhausted: boolean } {
  if (
    !isRecord(data) ||
    typeof data.total_count !== "number" ||
    !Number.isSafeInteger(data.total_count) ||
    data.total_count < 0 ||
    typeof data.incomplete_results !== "boolean" ||
    !Array.isArray(data.items) ||
    data.items.length > perPage
  ) {
    throw new BackendError("GitHub returned an invalid search response.", 502);
  }
  if (data.incomplete_results) {
    throw new BackendError(
      "GitHub returned an incomplete search. Retry this batch; no pages were skipped.",
      503,
      30,
    );
  }
  const expectedItems = Math.min(
    perPage,
    Math.max(0, data.total_count - (page - 1) * perPage),
  );
  if (data.items.length < expectedItems) {
    throw new BackendError(
      "GitHub returned fewer results than its search count promised. Retry this batch; no pages were skipped.",
      503,
      30,
    );
  }
  return {
    items: data.items,
    totalCount: data.total_count,
    exhausted:
      page * perPage >= SEARCH_RESULT_LIMIT ||
      data.items.length < perPage ||
      page * perPage >= data.total_count,
  };
}
