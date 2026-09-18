import { NextResponse } from "next/server";
import { BackendError } from "./backend-errors.ts";
import { readLimitedBody } from "./github-client.ts";

export const PRIVATE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export function errorResponse(error: unknown): NextResponse {
  const known = error instanceof BackendError;
  const status = known ? error.status : 500;
  const message = known
    ? error.message
    : "The server could not complete this request. Please try again.";
  const retryAfter = known ? error.retryAfter : undefined;
  return NextResponse.json(
    { error: message, ...(retryAfter ? { retryAfter } : {}) },
    {
      status,
      headers: {
        ...PRIVATE_HEADERS,
        ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
      },
    },
  );
}

export async function readCommitBody(request: Request): Promise<unknown> {
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase() !== "application/json"
  ) {
    throw new BackendError("Send commit requests as application/json.", 415);
  }
  let text: string;
  try {
    text = await readLimitedBody(request, 8192);
  } catch (error) {
    if (error instanceof BackendError) {
      throw new BackendError("The commit request is too large.", 413);
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BackendError("The commit request must contain valid JSON.", 400);
  }
}

export function privateRedirect(location: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { ...PRIVATE_HEADERS, Location: location },
  });
}
