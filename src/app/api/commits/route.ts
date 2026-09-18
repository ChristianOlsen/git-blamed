import { type NextRequest, NextResponse } from "next/server";
import {
  errorResponse,
  PRIVATE_HEADERS,
  readJsonBody,
} from "@/lib/api-response";
import { fetchCommitBatch } from "@/lib/github";
import { assertSameOrigin } from "@/lib/request-origin";
import { assertTokenRequest, readBearerToken } from "@/lib/token-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  try {
    const token = readBearerToken(request.headers.get("authorization"));
    if (token) {
      assertTokenRequest(request.headers);
    } else {
      assertSameOrigin(request.headers);
    }
    const body = await readJsonBody(request);
    const batch = await fetchCommitBatch(body, token);
    return NextResponse.json(batch, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}
