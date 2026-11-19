import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { getDb } from "@/db";
import { travelSharedTrips } from "@/db/schema";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import { createSharedTripSnapshot } from "@/lib/travel/shared-trip";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 180_000;
const SHARE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const ShareRequest = z.object({
  trip: z.unknown(),
  includeAccommodation: z.boolean().optional(),
  preview: z.boolean().optional(),
});

function errorResponse(message: string, status: number, code: string) {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const previewRequest = request.nextUrl.searchParams.get("preview") === "1";
  const blocked = guardSingaporeApi(request, {
    bucket: previewRequest ? "travel-share-preview" : "travel-share",
    limit: previewRequest ? 30 : 8,
    windowMs: 60 * 60_000,
    maxBodyBytes: MAX_BODY_BYTES,
  });
  if (blocked) return blocked;

  let body: z.infer<typeof ShareRequest>;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return errorResponse("行程内容过长，暂时无法分享。", 413, "SHARE_TOO_LARGE");
    }
    body = ShareRequest.parse(JSON.parse(raw));
  } catch {
    return errorResponse("分享请求格式不正确。", 400, "INVALID_SHARE_INPUT");
  }

  try {
    const createdAt = new Date();
    const snapshot = createSharedTripSnapshot(body.trip, createdAt.toISOString(), body.includeAccommodation === true);
    const headers = { "Cache-Control": "private, no-store" };
    if (previewRequest || body.preview) return NextResponse.json({ snapshot }, { headers });

    const id = crypto.randomUUID().replace(/-/g, "");
    const expiresAt = new Date(createdAt.getTime() + SHARE_LIFETIME_MS).toISOString();

    await getDb().insert(travelSharedTrips).values({
      id,
      snapshotJson: JSON.stringify(snapshot),
      createdAt: createdAt.toISOString(),
      expiresAt,
    });

    return NextResponse.json(
      { url: new URL(`/travel/shared/${id}`, request.url).toString(), expiresAt, snapshot },
      { headers },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return errorResponse("当前行程数据不完整，无法生成分享链接。", 422, "INVALID_TRIP_SNAPSHOT");
    }
    console.error("Could not save travel share", { errorName: error instanceof Error ? error.name : "unknown" });
    return errorResponse("暂时无法保存分享链接，请稍后重试。", 503, "SHARE_UNAVAILABLE");
  }
}
