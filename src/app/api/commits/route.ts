import { type NextRequest, NextResponse } from "next/server";
import {
  errorResponse,
  PRIVATE_HEADERS,
  readCommitBody,
} from "@/lib/api-response";
import { getSession } from "@/lib/auth";
import {
  assertPublicOrigin,
  assertSameOrigin,
  readAuthConfig,
} from "@/lib/auth-core";
import { fetchCommitBatch } from "@/lib/github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  try {
    const config = readAuthConfig(process.env);
    if (config) assertSameOrigin(request.headers, config.origin);
    else assertPublicOrigin(request.headers);
    const session = await getSession();
    const body = await readCommitBody(request);
    const batch = await fetchCommitBatch(body, session?.token);
    return NextResponse.json(batch, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}
