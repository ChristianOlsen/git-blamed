import { isAvatarUrl, isRecord, isUsername } from "./backend-errors.ts";
import type { CommitCard, Viewer } from "./types.ts";

function isCommitAuthor(value: unknown): value is Viewer {
  return (
    isRecord(value) && isUsername(value.login) && isAvatarUrl(value.avatarUrl)
  );
}

export function isCommitCard(value: unknown): value is CommitCard {
  return (
    isRecord(value) &&
    ["id", "message", "url", "repository", "committedAt"].every(
      (key) => typeof value[key] === "string",
    ) &&
    Array.isArray(value.authors) &&
    value.authors.length > 0 &&
    value.authors.every(isCommitAuthor) &&
    new Set(value.authors.map(({ login }) => login.toLowerCase())).size ===
      value.authors.length
  );
}
