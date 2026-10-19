import { NextResponse } from "next/server";
import { getGoogleMapsBrowserKey } from "@/lib/travel/google-maps";

export const dynamic = "force-dynamic";

export async function GET() {
  const browserKey = getGoogleMapsBrowserKey();
  if (!browserKey) {
    return NextResponse.json({ error: "地图服务暂未配置。" }, { status: 503 });
  }

  return NextResponse.json(
    { provider: "google", browserKey },
    { headers: { "Cache-Control": "private, max-age=300" } },
  );
}
