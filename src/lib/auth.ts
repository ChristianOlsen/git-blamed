import "server-only";
import { cookies } from "next/headers";
import {
  type AuthConfig,
  cookieName,
  openCookie,
  readAuthConfig,
  type Session,
} from "./auth-core.ts";
import { BackendError } from "./backend-errors.ts";
import type { Viewer } from "./types.ts";

export function getAuthConfig(): AuthConfig {
  const config = readAuthConfig(process.env);
  if (!config) {
    throw new BackendError(
      "GitHub sign-in is not configured. Set the server's OAuth environment variables.",
      503,
    );
  }
  return config;
}

export function isAuthConfigured(): boolean {
  try {
    return readAuthConfig(process.env) !== null;
  } catch (error) {
    if (error instanceof BackendError) return false;
    throw error;
  }
}

export async function getSession(): Promise<Session | null> {
  const config = readAuthConfig(process.env);
  if (!config) return null;
  const jar = await cookies();
  const session = await openCookie(
    config,
    "session",
    jar.get(cookieName(config, "session"))?.value,
  );
  return session && "token" in session ? session : null;
}

export async function getViewer(): Promise<Viewer | null> {
  return (await getSession())?.viewer ?? null;
}
