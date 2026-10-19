import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import {
  buildBailianIntentPrompt,
  buildSingaporeIntentMessages,
  parseSingaporeIntentResult,
  SingaporeIntentRequestSchema,
} from "@/lib/travel/singapore-intent";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import { askBailianAgent } from "@/lib/travel/bailian";
import { QwenServiceError, requestQwenJson } from "@/lib/travel/qwen";

export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 32_000;

function jsonError(message: string, status: number, code: string) {
  return NextResponse.json(
    { error: message, code },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

function singaporeDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function POST(request: NextRequest) {
  const blocked = guardSingaporeApi(request, {
    bucket: "singapore-intent",
    limit: 12,
    windowMs: 60_000,
    maxBodyBytes: MAX_REQUEST_BYTES,
  });
  if (blocked) return blocked;

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    return jsonError("请求内容过长。", 413, "REQUEST_TOO_LARGE");
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError("请求必须是有效的 JSON。", 400, "INVALID_JSON");
  }

  const parsedRequest = SingaporeIntentRequestSchema.safeParse(rawBody);
  if (!parsedRequest.success) {
    return jsonError("旅行描述或当前意图格式不正确。", 400, "INVALID_INPUT");
  }

  const currentDate = singaporeDate();

  try {
    // The deployed Bailian Agent is the preferred intent orchestrator. If it
    // is unavailable or returns non-structured output, retain the direct Qwen
    // path as a bounded fallback so a commerce/tool issue cannot block planning.
    const agentReply = await askBailianAgent(
      buildBailianIntentPrompt(parsedRequest.data, currentDate),
      "intent",
    );
    if (agentReply?.text) {
      try {
        const result = parseSingaporeIntentResult(agentReply.text, parsedRequest.data, currentDate);
        return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        console.warn("Managed Agent intent output was not usable; using direct fallback", {
          reason: error instanceof ZodError ? "schema" : "parse",
        });
      }
    }

    const content = await requestQwenJson({
      messages: buildSingaporeIntentMessages(parsedRequest.data, currentDate),
      temperature: 0.1,
      maxTokens: 3_000,
      timeoutMs: 25_000,
    });
    const result = parseSingaporeIntentResult(content, parsedRequest.data, currentDate);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof QwenServiceError) {
      return jsonError(error.message, error.status, error.code);
    }
    if (error instanceof ZodError) {
      console.error("Travel intent response validation failed", { reason: "schema" });
      return jsonError("旅行智能服务返回的数据格式不完整，请重试。", 502, "QWEN_INVALID_OUTPUT");
    }
    console.error("Qwen intent request failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return jsonError("暂时无法连接旅行智能服务。", 502, "QWEN_NETWORK_ERROR");
  }
}
