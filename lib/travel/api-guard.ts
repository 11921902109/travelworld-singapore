import { NextRequest, NextResponse } from "next/server";

type RateEntry = { count: number; resetAt: number };
type GuardOptions = {
  bucket: string;
  limit: number;
  windowMs: number;
  maxBodyBytes?: number;
};

const rateEntries = new Map<string, RateEntry>();

function noStoreError(message: string, status: number, code: string) {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

function clientAddress(request: NextRequest) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export function guardSingaporeApi(request: NextRequest, options: GuardOptions) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    return noStoreError("不允许跨站调用旅行接口。", 403, "CROSS_SITE_REQUEST");
  }

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== request.nextUrl.origin) {
        return noStoreError("请求来源无效。", 403, "INVALID_ORIGIN");
      }
    } catch {
      return noStoreError("请求来源无效。", 403, "INVALID_ORIGIN");
    }
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > (options.maxBodyBytes ?? 32_000)) {
    return noStoreError("请求内容过长。", 413, "REQUEST_TOO_LARGE");
  }

  const now = Date.now();
  const key = `${options.bucket}:${clientAddress(request)}`;
  const current = rateEntries.get(key);
  const entry = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + options.windowMs }
    : current;
  entry.count += 1;
  rateEntries.set(key, entry);

  if (rateEntries.size > 1_000) {
    for (const [candidateKey, candidate] of rateEntries) {
      if (candidate.resetAt <= now) rateEntries.delete(candidateKey);
    }
  }

  if (entry.count > options.limit) {
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1_000));
    const response = noStoreError("请求过于频繁，请稍后再试。", 429, "RATE_LIMITED");
    response.headers.set("Retry-After", String(retryAfter));
    return response;
  }

  return null;
}
