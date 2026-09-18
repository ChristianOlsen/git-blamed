import { type NextRequest, NextResponse } from "next/server";
import {
  errorResponse,
  PRIVATE_HEADERS,
  readJsonBody,
} from "@/lib/api-response";
import { fetchCommitBatch } from "@/lib/github";
import { getLocalGitHubToken } from "@/lib/local-token";
import { assertSameOrigin } from "@/lib/request-origin";
import { assertTokenRequest, resolveCommitToken } from "@/lib/token-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request.headers);
    const body = await readJsonBody(request);
    const token = resolveCommitToken(
      request.headers,
      body,
      getLocalGitHubToken(request.headers),
    );
    if (token) {
      assertTokenRequest(request.headers);
    }
    const batch = await fetchCommitBatch(body, token);
    return NextResponse.json(batch, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}
