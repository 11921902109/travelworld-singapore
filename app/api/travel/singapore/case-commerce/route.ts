import { NextRequest, NextResponse } from "next/server";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import { getSingaporeCaseCommerce } from "@/lib/travel/singapore-case-commerce";

export const dynamic = "force-dynamic";

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    // The Worker holds a short-lived server cache, but a commercial result
    // should never be cached by a visitor's browser or a shared proxy.
    headers: { "Cache-Control": "private, no-store" },
  });
}

/**
 * Fixed public-case commerce source. It has no request body: dates, traveller
 * count and allowed places are server-owned constants, so a browser cannot use
 * this endpoint to turn the demo into an arbitrary FlyAI lookup proxy.
 */
export async function GET(request: NextRequest) {
  const blocked = guardSingaporeApi(request, {
    bucket: "singapore-case-commerce",
    limit: 3,
    windowMs: 5 * 60_000,
  });
  if (blocked) return blocked;

  try {
    return noStoreJson(await getSingaporeCaseCommerce());
  } catch {
    return noStoreJson({
      error: "案例飞猪价格暂时无法查询，请稍后重试。",
    }, 503);
  }
}
