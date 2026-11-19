import { NextRequest, NextResponse } from "next/server";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import { initializeTravelVisitSession } from "@/lib/travel/bailian";
import { readTravelVisitToken } from "@/lib/travel/visit-session";

export const dynamic = "force-dynamic";

/** A tab may initialize once before the first planning message. */
export async function POST(request: NextRequest) {
  const blocked = guardSingaporeApi(request, {
    bucket: "singapore-visit-init",
    limit: 10,
    windowMs: 60_000,
  });
  if (blocked) return blocked;
  const visitToken = readTravelVisitToken(request);
  if (!visitToken) {
    return NextResponse.json({ error: "缺少本次访问标识。" }, {
      status: 400,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  const ready = await initializeTravelVisitSession(visitToken);
  return NextResponse.json({ ready }, {
    status: ready ? 200 : 503,
    headers: { "Cache-Control": "private, no-store" },
  });
}
