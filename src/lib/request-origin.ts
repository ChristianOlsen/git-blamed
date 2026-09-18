import { BackendError } from "./backend-errors.ts";

export function assertSameOrigin(headers: Pick<Headers, "get">): void {
  const origin = headers.get("origin");
  const url = origin && URL.canParse(origin) ? new URL(origin) : null;
  // Next.js can normalize request URLs to an internal host behind a proxy.
  if (
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    origin !== url.origin ||
    url.host !== headers.get("host")?.toLowerCase() ||
    headers.get("sec-fetch-site") === "cross-site"
  ) {
    throw new BackendError(
      "This request must come from the app's own origin.",
      403,
    );
  }
}
