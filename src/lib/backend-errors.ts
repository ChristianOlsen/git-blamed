export class BackendError extends Error {
  readonly status: number;
  readonly retryAfter?: number;

  constructor(message: string, status = 500, retryAfter?: number) {
    super(message);
    this.name = "BackendError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUsername(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 39 &&
    /^[a-z\d](?:[a-z\d]|-(?=[a-z\d]))*$/i.test(value)
  );
}

export function isRepositoryName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 200 &&
    /^[a-z\d](?:[a-z\d-]*[a-z\d])?\/(?!\.{1,2}$)[a-z\d_.-]+$/i.test(value)
  );
}

export function isAvatarUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "avatars.githubusercontent.com" &&
      !url.port &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function isSecureTokenOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  );
}
