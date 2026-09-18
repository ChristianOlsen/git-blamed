import { type NextRequest, NextResponse } from "next/server";
import {
  errorResponse,
  PRIVATE_HEADERS,
  readJsonBody,
} from "@/lib/api-response";
import { assertTokenRequest, connectToken } from "@/lib/token-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertTokenRequest(request.headers);
    const viewer = await connectToken(await readJsonBody(request));
    return NextResponse.json(viewer, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}
