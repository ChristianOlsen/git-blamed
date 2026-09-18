import "server-only";

import { readLocalToken } from "./token-auth.ts";

export function getLocalGitHubToken(
  headers: Pick<Headers, "get">,
): string | undefined {
  return readLocalToken(headers, {
    NODE_ENV: process.env.NODE_ENV,
    VERCEL: process.env.VERCEL,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  });
}
