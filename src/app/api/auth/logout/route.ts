import type { NextRequest } from "next/server";
import { errorResponse, privateRedirect } from "@/lib/api-response";
import { getAuthConfig } from "@/lib/auth";
import { assertSameOrigin, cookieName, cookieOptions } from "@/lib/auth-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const config = getAuthConfig();
    assertSameOrigin(request.headers, config.origin);
    const response = privateRedirect("/");
    for (const kind of ["session", "oauth"] as const) {
      response.cookies.set(
        cookieName(config, kind),
        "",
        cookieOptions(config, 0),
      );
    }
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
