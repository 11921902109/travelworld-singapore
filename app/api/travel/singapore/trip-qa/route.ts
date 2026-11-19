import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import { askBailianAgent } from "@/lib/travel/bailian";
import { readTravelVisitToken } from "@/lib/travel/visit-session";
import type { DemoTrip } from "@/lib/travel/types";

export const dynamic = "force-dynamic";

const Request = z.object({ question: z.string().trim().min(2).max(500), dayId: z.string().regex(/^day-[1-7]$/), trip: z.unknown() });

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function isTrip(value: unknown): value is DemoTrip {
  if (!value || typeof value !== "object") return false;
  const trip = value as Partial<DemoTrip>;
  return trip.source === "live" && Array.isArray(trip.days) && trip.days.length >= 1 && trip.days.length <= 7;
}

export async function POST(request: NextRequest) {
  const blocked = guardSingaporeApi(request, { bucket: "trip-qa", limit: 8, windowMs: 5 * 60_000 });
  if (blocked) return blocked;
  const token = readTravelVisitToken(request);
  if (!token) return json({ error: { code: "VISIT_REQUIRED", message: "请刷新页面后重试。" } }, 400);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 150_000) return json({ error: { code: "REQUEST_TOO_LARGE", message: "行程数据过大。" } }, 413);
  const parsed = Request.safeParse((() => { try { return JSON.parse(raw); } catch { return null; } })());
  if (!parsed.success || !isTrip(parsed.data.trip)) return json({ error: { code: "INVALID_QUESTION", message: "请提一个与当前旅行相关的问题。" } }, 400);
  const { question, dayId, trip } = parsed.data;
  const day = trip.days.find((item) => item.id === dayId);
  const prices = trip.days.flatMap((item) => item.stops.flatMap((stop) => stop.commerce?.status === "available" && stop.commerce.price
    ? [{ name: stop.name, price: stop.commerce.price.display, unit: stop.commerce.price.unit ?? "", updatedAt: stop.commerce.updatedAt ?? "" }] : [])).slice(0, 15);
  const facts = {
    destination: trip.destination, dates: trip.dateRange, travelers: trip.people, pace: trip.pace,
    accommodation: trip.accommodationSegments?.map((item) => ({ from: item.startDayId, name: item.anchor.name })) || trip.hotel,
    currentDay: day ? { label: day.label, stops: day.stops.map((stop) => ({ name: stop.name, kind: stop.kind, time: stop.time, verified: stop.verified })) } : null,
    visibleCommerceReferences: prices,
  };
  try {
    const reply = await askBailianAgent([
      "本轮仅回答旅客疑问，不调用地图编辑、不修改行程、不搜索或编造实时商品价格。请输出 JSON：{\"answer\":\"简洁中文回答\"}。",
      "酒店入住资料应提示以所订酒店政策与订单为准。预算仅可汇总已提供的明确报价；缺少价格时说明无法准确估算，并指出还需哪些费用。",
      `已确认行程摘要：${JSON.stringify(facts)}`,
      `用户问题：${JSON.stringify(question)}`,
    ].join("\n"), "planning", token);
    if (!reply?.text) return json({ error: { code: "QA_UNAVAILABLE", message: "答疑暂时不可用，请稍后重试。" } }, 502);
    let answer = reply.text.trim();
    try {
      const match = answer.match(/\{[\s\S]*\}/);
      const parsedAnswer = JSON.parse(match?.[0] || answer) as { answer?: unknown };
      if (typeof parsedAnswer.answer === "string") answer = parsedAnswer.answer.trim();
    } catch { /* Plain text remains a useful answer. */ }
    return json({ answer: answer.slice(0, 1200) });
  } catch {
    return json({ error: { code: "QA_UNAVAILABLE", message: "答疑暂时不可用，请稍后重试。" } }, 502);
  }
}
