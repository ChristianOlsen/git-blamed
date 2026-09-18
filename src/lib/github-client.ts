import {
  BackendError,
  isAvatarUrl,
  isRecord,
  isRepositoryName,
  isUsername,
} from "./backend-errors.ts";
import type { Viewer } from "./types.ts";

export type Fetcher = typeof fetch;
const API_VERSION = "2022-11-28";
const TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export async function readLimitedBody(
  response: Pick<Response, "body" | "headers">,
  maxBytes: number,
): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (length > maxBytes) {
    await response.body?.cancel();
    throw new BackendError("The response was larger than expected.", 502);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new BackendError("The response was larger than expected.", 502);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export function retryAfterSeconds(headers: Headers, now = Date.now()): number {
  const retry = headers.get("retry-after");
  if (retry) {
    const seconds = Number(retry);
    const duration = Number.isFinite(seconds)
      ? seconds
      : (Date.parse(retry) - now) / 1000;
    if (Number.isFinite(duration) && duration > 0) {
      return Math.min(86400, Math.max(1, Math.ceil(duration)));
    }
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset * 1000 > now) {
    return Math.min(86400, Math.max(1, Math.ceil(reset - now / 1000)));
  }
  return 60;
}

async function requestJson(
  url: URL | string,
  options: RequestInit,
  fetcher: Fetcher,
): Promise<{ data: unknown; headers: Headers }> {
  let response: Response;
  let text: string;
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    signal.throwIfAborted();
    response = await fetcher(url, {
      ...options,
      cache: "no-store",
      redirect: "error",
      signal,
    });
    text = await readLimitedBody(response, MAX_RESPONSE_BYTES);
    signal.throwIfAborted();
  } catch (error) {
    if (error instanceof BackendError) throw error;
    if (
      error instanceof TypeError ||
      (error instanceof Error &&
        ["AbortError", "TimeoutError"].includes(error.name))
    ) {
      throw new BackendError(
        "GitHub could not be reached in time. Try again; no pages were skipped.",
        503,
        15,
      );
    }
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    if (response.status >= 500) {
      throw new BackendError(
        "GitHub is temporarily unavailable. Try again; no pages were skipped.",
        502,
        30,
      );
    }
    if (response.ok) {
      throw new BackendError("GitHub returned an unreadable response.", 502);
    }
  }
  if (!response.ok) {
    const message =
      isRecord(data) && typeof data.message === "string" ? data.message : "";
    if (
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          response.headers.has("retry-after") ||
          /(?:secondary )?rate limit|abuse detection/i.test(message)))
    ) {
      throw new BackendError(
        "GitHub's API rate limit was reached. Wait before retrying; no pages were skipped.",
        429,
        retryAfterSeconds(response.headers),
      );
    }
    if (response.status === 401) {
      throw new BackendError(
        "Your GitHub token expired or was revoked. Reconnect GitHub.",
        401,
      );
    }
    if (response.status === 403) {
      throw new BackendError(
        "GitHub denied access. Check repository permissions, organization approval, and SSO authorization.",
        403,
      );
    }
    if (response.status === 422) {
      throw new BackendError(
        "GitHub could not search these usernames. Check that the accounts exist and are visible to the host.",
        422,
      );
    }
    throw new BackendError(
      "GitHub could not complete the request. Try again; no pages were skipped.",
      502,
      30,
    );
  }
  if (response.headers.get("x-github-sso")?.includes("partial-results")) {
    throw new BackendError(
      "GitHub returned only partial organization results. Authorize your token for organization SSO, then retry.",
      403,
    );
  }
  return { data, headers: response.headers };
}

export async function githubGet(
  path: string,
  token?: string,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("GitHub API paths must be absolute paths.");
  }
  const response = await requestJson(
    `https://api.github.com${path}`,
    {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "git-blamed",
      },
    },
    fetcher,
  );
  return response.data;
}

export const COMMIT_AUTHOR_QUERY_SIZE = 50;

export type CommitAuthorTarget = {
  repository: string;
  sha: string;
  after?: string;
};

export async function githubCommitAuthors(
  targets: CommitAuthorTarget[],
  token: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!token) {
    throw new BackendError("Connect GitHub to verify commit co-authors.", 401);
  }
  if (
    !Array.isArray(targets) ||
    targets.length < 1 ||
    targets.length > COMMIT_AUTHOR_QUERY_SIZE ||
    targets.some(
      (target) =>
        !isRecord(target) ||
        !isRepositoryName(target.repository) ||
        typeof target.sha !== "string" ||
        !/^[a-f\d]{40}$/i.test(target.sha) ||
        (target.after !== undefined &&
          (typeof target.after !== "string" ||
            !target.after.length ||
            target.after.length > 1024 ||
            /\p{Cc}/u.test(target.after))),
    )
  ) {
    throw new BackendError("Invalid commit author lookup.", 502);
  }
  const variables: Record<string, string | null> = {};
  const declarations: string[] = [];
  const fields = targets.map((target, index) => {
    const [owner, name] = target.repository.split("/");
    variables[`owner${index}`] = owner;
    variables[`name${index}`] = name;
    variables[`oid${index}`] = target.sha;
    variables[`after${index}`] = target.after ?? null;
    declarations.push(
      `$owner${index}:String!,$name${index}:String!,$oid${index}:GitObjectID!,$after${index}:String`,
    );
    return `c${index}:repository(owner:$owner${index},name:$name${index}){
      nameWithOwner
      object(oid:$oid${index}){... on Commit{
        oid
        authors(first:100,after:$after${index}){
          nodes{user{login avatarUrl}}
          pageInfo{hasNextPage endCursor}
        }
      }}
    }`;
  });
  const { data, headers } = await requestJson(
    "https://api.github.com/graphql",
    {
      method: "POST",
      signal,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "git-blamed",
      },
      body: JSON.stringify({
        query: `query CommitAuthors(${declarations.join(",")}){${fields.join("\n")}}`,
        variables,
      }),
    },
    fetcher,
  );
  if (!isRecord(data)) {
    throw new BackendError("GitHub returned invalid commit author data.", 502);
  }
  if (data.errors !== undefined) {
    if (!Array.isArray(data.errors) || !data.errors.length) {
      throw new BackendError(
        "GitHub returned invalid commit author data.",
        502,
      );
    }
    const errors = data.errors.filter(isRecord);
    if (
      errors.some(
        (error) =>
          error.type === "RATE_LIMITED" ||
          (isRecord(error.extensions) &&
            error.extensions.code === "RATE_LIMITED") ||
          (typeof error.message === "string" &&
            /rate limit|abuse detection/i.test(error.message)),
      )
    ) {
      throw new BackendError(
        "GitHub's API rate limit was reached. Wait before retrying; no pages were skipped.",
        429,
        retryAfterSeconds(headers),
      );
    }
    if (
      errors.some(
        (error) =>
          ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"].includes(
            String(error.type),
          ) ||
          (isRecord(error.extensions) &&
            ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"].includes(
              String(error.extensions.code),
            )),
      )
    ) {
      throw new BackendError(
        "GitHub denied commit author access. Check repository permissions (Contents: read may be needed), organization approval, and SSO authorization.",
        403,
      );
    }
    throw new BackendError(
      "GitHub could not verify all commit authors. Retry the batch; no pages were skipped.",
      502,
    );
  }
  if (!isRecord(data.data)) {
    throw new BackendError(
      "GitHub returned incomplete commit author data. Check repository permissions (Contents: read may be needed) and SSO authorization; no pages were skipped.",
      502,
    );
  }
  return data.data;
}

export async function fetchViewer(
  token: string,
  fetcher: Fetcher = fetch,
): Promise<Viewer> {
  const data = await githubGet("/user", token, fetcher);
  if (
    !isRecord(data) ||
    !isUsername(data.login) ||
    !isAvatarUrl(data.avatar_url)
  ) {
    throw new BackendError("GitHub returned an invalid user profile.", 502);
  }
  return { login: data.login, avatarUrl: data.avatar_url };
}
