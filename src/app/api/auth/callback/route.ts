import type { NextRequest } from "next/server";
import { privateRedirect } from "@/lib/api-response";
import { getAuthConfig } from "@/lib/auth";
import {
  type AuthConfig,
  cookieName,
  cookieOptions,
  matchesState,
  openCookie,
  SESSION_SECONDS,
  sealCookie,
} from "@/lib/auth-core";
import { BackendError } from "@/lib/backend-errors";
import { exchangeOAuthCode, fetchViewer } from "@/lib/github-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let config: AuthConfig | undefined;
  try {
    config = getAuthConfig();
    const state = await openCookie(
      config,
      "oauth",
      request.cookies.get(cookieName(config, "oauth"))?.value,
    );
    const params = request.nextUrl.searchParams;
    if (
      !state ||
      !("state" in state) ||
      params.getAll("state").length !== 1 ||
      !matchesState(state.state, params.get("state"))
    ) {
      throw new BackendError(
        "GitHub sign-in expired or could not be verified. Start sign-in again in this browser.",
        401,
      );
    }
    if (params.has("error")) {
      throw new BackendError(
        params.get("error") === "access_denied"
          ? "GitHub sign-in was cancelled. You can try again or play with public commits."
          : "GitHub could not authorize this sign-in. Please try again.",
        401,
      );
    }
    const code = params.get("code");
    if (
      params.getAll("code").length !== 1 ||
      !code ||
      !/^[\w-]{1,512}$/.test(code)
    ) {
      throw new BackendError(
        "GitHub did not return a valid sign-in code.",
        401,
      );
    }
    const token = await exchangeOAuthCode(config, code, state.verifier);
    const viewer = await fetchViewer(token);
    const response = privateRedirect(
      new URL(state.returnTo, config.origin).href,
    );
    response.cookies.set(
      cookieName(config, "session"),
      await sealCookie(config, "session", { token, viewer }),
      cookieOptions(config, SESSION_SECONDS),
    );
    response.cookies.set(
      cookieName(config, "oauth"),
      "",
      cookieOptions(config, 0),
    );
    return response;
  } catch (error) {
    const message =
      error instanceof BackendError
        ? error.message
        : "GitHub sign-in could not be completed. Please try again.";
    const location = `/?${new URLSearchParams({ authError: message })}`;
    const response = privateRedirect(
      config ? new URL(location, config.origin).href : location,
    );
    if (config) {
      response.cookies.set(
        cookieName(config, "oauth"),
        "",
        cookieOptions(config, 0),
      );
    }
    return response;
  }
}
