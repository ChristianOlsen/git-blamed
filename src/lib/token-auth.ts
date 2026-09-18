import {
  BackendError,
  isRecord,
  isSecureTokenOrigin,
} from "./backend-errors.ts";
import { type Fetcher, fetchViewer } from "./github-client.ts";
import { assertSameOrigin } from "./request-origin.ts";
import type { Viewer } from "./types.ts";

function parseToken(value: unknown): string {
  if (typeof value !== "string" || !/^[\w-]{1,512}$/.test(value.trim())) {
    throw new BackendError("Enter a valid GitHub access token.", 400);
  }
  return value.trim();
}

export function readBearerToken(value: string | null): string | undefined {
  if (value === null) return undefined;
  const match = /^Bearer ([\w-]{1,512})$/i.exec(value);
  if (!match) {
    throw new BackendError("Invalid GitHub token authorization header.", 400);
  }
  return match[1];
}

export function assertTokenRequest(headers: Pick<Headers, "get">): void {
  assertSameOrigin(headers);
  const origin = headers.get("origin");
  if (!origin || !isSecureTokenOrigin(origin)) {
    throw new BackendError(
      "Use HTTPS to connect GitHub outside localhost.",
      400,
    );
  }
}

export function readLocalToken(
  headers: Pick<Headers, "get">,
  environment: {
    NODE_ENV?: string;
    VERCEL?: string;
    GITHUB_TOKEN?: string;
  },
): string | undefined {
  const host = headers.get("host");
  if (
    environment.NODE_ENV !== "development" ||
    environment.VERCEL ||
    !host ||
    /[/\\@?#\s]/.test(host) ||
    !isSecureTokenOrigin(`http://${host}`)
  ) {
    return undefined;
  }
  return environment.GITHUB_TOKEN?.trim() || undefined;
}

export function resolveCommitToken(
  headers: Pick<Headers, "get">,
  body: unknown,
  localToken?: string,
): string | undefined {
  const supplied = readBearerToken(headers.get("authorization"));
  if (supplied) return supplied;
  if (isRecord(body) && body.requireAuth === true && localToken) {
    return parseToken(localToken);
  }
  return undefined;
}

export async function connectToken(
  body: unknown,
  fetcher: Fetcher = fetch,
): Promise<Viewer> {
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "token")) {
    throw new BackendError("Provide a GitHub access token.", 400);
  }
  const token = parseToken(body.token);
  try {
    return await fetchViewer(token, fetcher);
  } catch (error) {
    if (error instanceof BackendError && error.status === 401) {
      throw new BackendError(
        "GitHub rejected this token. Check that it is valid and has not expired.",
        401,
      );
    }
    throw error;
  }
}
