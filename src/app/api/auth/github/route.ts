import type { NextRequest } from "next/server";
import { privateRedirect } from "@/lib/api-response";
import { getAuthConfig } from "@/lib/auth";
import {
  authorizationUrl,
  cookieName,
  cookieOptions,
  newOAuthState,
  OAUTH_SECONDS,
  sealCookie,
} from "@/lib/auth-core";
import { BackendError } from "@/lib/backend-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const config = getAuthConfig();
    const state = newOAuthState(request.nextUrl.searchParams.get("returnTo"));
    const response = privateRedirect(authorizationUrl(config, state));
    response.cookies.set(
      cookieName(config, "oauth"),
      await sealCookie(config, "oauth", state),
      cookieOptions(config, OAUTH_SECONDS),
    );
    return response;
  } catch (error) {
    const message =
      error instanceof BackendError
        ? error.message
        : "GitHub sign-in could not be started. Please try again.";
    return privateRedirect(`/?${new URLSearchParams({ authError: message })}`);
  }
}
