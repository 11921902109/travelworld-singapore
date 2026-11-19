import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import {
  buildBailianIntentPrompt,
  EMPTY_SINGAPORE_TRAVEL_INTENT,
  extractJsonObject,
  parseSingaporeIntentResult,
  SingaporeIntentRequestSchema,
  SingaporeIntentResultSchema,
  type SingaporeIntentRequest,
  type SingaporeIntentResult,
} from "@/lib/travel/singapore-intent";
import { preparseIntentInput, tryResolveDeterministicIntentTurn } from "@/lib/travel/intent-fast-path";
import { updateIntentSlotMeta, type IntentSlotMeta } from "@/lib/travel/intent-slot-meta";
import { evaluatePlaceDiscoveryReadiness } from "@/lib/travel/planning-state";
import { presentPlanningIntentResult } from "@/lib/travel/planning-intent-reply";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import { askBailianAgent, ManagedAgentInputTooLongError, ManagedAgentTurnUncertainError } from "@/lib/travel/bailian";
import {
  acquireTravelVisit, readTravelVisitToken,
  type TravelIntentState, type TravelVisitLease,
} from "@/lib/travel/visit-session";

export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 32_000;
const RENEW_INTERVAL_MS = 25_000;
const NEW_PLANNING_FLOW = process.env.NEXT_PUBLIC_TRAVEL_PLANNING_V2 !== "0";

function noStoreJson(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function jsonError(message: string, status: number, code: string) {
  return noStoreJson({ error: message, code }, status);
}

function singaporeDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function storedSlotMeta(json: string): IntentSlotMeta {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stored slot metadata.");
  return value as IntentSlotMeta;
}

function storedResult(json: string | null): SingaporeIntentResult | null {
  return json ? SingaporeIntentResultSchema.parse(JSON.parse(json)) : null;
}

function statePayload(state: TravelIntentState) {
  const stored = storedResult(state.resultJson);
  const result = stored && NEW_PLANNING_FLOW ? presentPlanningIntentResult(stored) : stored;
  const placeReadiness = evaluatePlaceDiscoveryReadiness(result);
  return {
    stateVersion: state.stateVersion,
    state: result,
    slotMeta: storedSlotMeta(state.slotMetaJson),
    placeDiscoveryReady: placeReadiness.ready,
    placeDiscoveryIssues: placeReadiness.issues,
  };
}

function stateConflict(state: TravelIntentState) {
  return noStoreJson({
    code: "STATE_VERSION_CONFLICT",
    error: "另一条消息已更新旅行条件，请根据最新状态重试。",
    ...statePayload(state),
  }, 409);
}

async function requestHash(input: { message: string; replyToIssueId: string | null; expectedStateVersion: number }) {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parsePatchOutput(text: string, input: SingaporeIntentRequest, currentDate: string) {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { patches?: unknown }).patches)) {
    throw new Error("Managed Agent did not return a field patch array.");
  }
  return parseSingaporeIntentResult(text, input, currentDate);
}

async function releaseQuietly(lease: TravelVisitLease | null) {
  try {
    await lease?.release();
  } catch {
    console.warn("Travel intent visit lease release unavailable");
  }
}

export async function GET(request: NextRequest) {
  const blocked = guardSingaporeApi(request, {
    bucket: "singapore-intent-read", limit: 30, windowMs: 60_000,
  });
  if (blocked) return blocked;
  const visitToken = readTravelVisitToken(request);
  if (!visitToken) return jsonError("本次访问未初始化，请刷新页面后重试。", 400, "VISIT_REQUIRED");
  let lease: TravelVisitLease | null = null;
  try {
    lease = await acquireTravelVisit(visitToken, request.signal);
    return noStoreJson(statePayload(await lease.readIntentState()));
  } catch {
    return jsonError("暂时无法读取本次访问的旅行条件，请稍后重试。", 503, "INTENT_STATE_UNAVAILABLE");
  } finally {
    await releaseQuietly(lease);
  }
}

export async function POST(request: NextRequest) {
  const blocked = guardSingaporeApi(request, {
    bucket: "singapore-intent",
    limit: 12,
    windowMs: 60_000,
    maxBodyBytes: MAX_REQUEST_BYTES,
  });
  if (blocked) return blocked;
  const visitToken = readTravelVisitToken(request);
  if (!visitToken) {
    return jsonError("本次访问未初始化，请刷新页面后重试。", 400, "VISIT_REQUIRED");
  }

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
    return jsonError("旅行描述格式不正确。", 400, "INVALID_INPUT");
  }
  const requestBody = parsedRequest.data;
  if (!requestBody.turnId) return jsonError("本轮请求缺少唯一标识，请刷新后重试。", 400, "TURN_ID_REQUIRED");
  if (requestBody.expectedStateVersion === undefined) {
    return jsonError("本轮请求缺少状态版本，请刷新后重试。", 400, "STATE_VERSION_REQUIRED");
  }

  const serverDate = singaporeDate();
  const referenceDate = requestBody.referenceDate;
  if (referenceDate && Math.abs(Date.parse(`${referenceDate}T00:00:00Z`) - Date.parse(`${serverDate}T00:00:00Z`)) > 86_400_000) {
    return jsonError("会话日期已过期，请刷新页面后重试。", 400, "REFERENCE_DATE_EXPIRED");
  }
  const currentDate = referenceDate || serverDate;
  const turnId = requestBody.turnId;
  const expectedStateVersion = requestBody.expectedStateVersion;
  const inputHash = await requestHash({
    message: requestBody.message,
    replyToIssueId: requestBody.replyToIssueId ?? null,
    expectedStateVersion,
  });

  let lease: TravelVisitLease | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let leaseRenewalFailed = false;
  try {
    // The lease covers version check, Agent exchange, parsing and D1 commit.
    // Other tabs cannot send a stale turn into this Agent Session meanwhile.
    lease = await acquireTravelVisit(visitToken, request.signal);
    const heldLease = lease;
    heartbeat = setInterval(() => {
      void heldLease.renew().catch(() => { leaseRenewalFailed = true; });
    }, RENEW_INTERVAL_MS);

    const existing = await lease.findIntentTurn(turnId);
    if (existing) {
      if (existing.input_hash !== inputHash) {
        return jsonError("这一轮的标识已用于另一条消息，请重新发送。", 409, "TURN_ID_REUSED");
      }
      return noStoreJson(JSON.parse(existing.response_json));
    }

    const state = await lease.readIntentState();
    if (state.stateVersion !== expectedStateVersion) return stateConflict(state);
    const previous = storedResult(state.resultJson);
    const previousSlotMeta = storedSlotMeta(state.slotMetaJson);
    // Browser-sent currentIntent/currentOutline are compatibility fields only.
    // Its purported assistant messages are not trusted conversation history.
    const recentUserTurns = requestBody.conversationHistory
      .filter((entry) => entry.role === "user").slice(-15);
    const authoritativeInput: SingaporeIntentRequest = {
      ...requestBody,
      currentIntent: previous?.intent ?? EMPTY_SINGAPORE_TRAVEL_INTENT,
      currentOutline: previous?.outline ?? [],
      previousPendingCandidates: previous?.pendingCandidates ?? [],
      conversationHistory: previous
        ? [...recentUserTurns, { role: "assistant", content: previous.reply }]
        : recentUserTurns,
      replyToIssueId: requestBody.replyToIssueId && requestBody.replyToIssueId === previous?.primaryIssueId
        ? requestBody.replyToIssueId : null,
    };
    // Draft-only edits predate V2 and still use the legacy outline contract.
    // Keep that branch until it is moved to its own endpoint.
    const outlineEdit = authoritativeInput.currentOutline.length > 0 &&
      /(?:Day\s*[1-7]|第[一二三四五六七1-7]天|草案|主题|每日方向)/i.test(requestBody.message);
    const parseAgentOutput = (text: string) => outlineEdit
      ? parseSingaporeIntentResult(text, authoritativeInput, currentDate)
      : parsePatchOutput(text, authoritativeInput, currentDate);

    let result = tryResolveDeterministicIntentTurn(authoritativeInput, currentDate);
    const processingSource: "code" | "bailian" = result ? "code" : "bailian";
    if (!result) {
      const preparse = preparseIntentInput(authoritativeInput.message);
      const preparseHints = JSON.stringify({ candidates: preparse.candidates, risks: preparse.risks });
      const agentReply = await askBailianAgent(
        `${buildBailianIntentPrompt(authoritativeInput, currentDate)}\n字面预解析线索（只供核对原话，不能直接确认为字段）：${preparseHints}`,
        "intent", visitToken, turnId, lease,
      );
      if (!agentReply?.text) {
        return jsonError("旅行智能服务暂时不可用，本轮条件未保存，请稍后重试。", 503, "AGENT_UNAVAILABLE");
      }
      try {
        result = parseAgentOutput(agentReply.text);
      } catch (error) {
        console.warn("Managed Agent intent output needs one format repair", {
          reason: error instanceof ZodError ? "schema" : "parse",
          issues: error instanceof ZodError
            ? error.issues.slice(0, 8).map((issue) => ({ path: issue.path.join("."), code: issue.code }))
            : undefined,
        });
        if (leaseRenewalFailed) throw new Error("Travel visit lease renewal failed.");
        const repaired = await askBailianAgent(
          outlineEdit
            ? "上一轮每日草案编辑结果未通过 JSON 校验。请针对上一轮同一用户要求重新输出完整的 intent 与 outline JSON，outline 必须逐日完整，不要调用工具。"
            : "上一轮意图解析结果未通过 JSON 字段和原文证据校验。请针对上一轮同一用户原话重新输出一个符合约定的字段变更 JSON；每项 evidenceText 必须逐字来自用户原话，不要猜测或调用工具。",
          "intent", visitToken, `${turnId}:repair`, lease,
        );
        if (!repaired?.text) throw error;
        result = parseAgentOutput(repaired.text);
      }
    }

    if (NEW_PLANNING_FLOW) result = presentPlanningIntentResult(result);
    if (leaseRenewalFailed) throw new Error("Travel visit lease renewal failed.");
    await lease.renew();
    const slotMeta = updateIntentSlotMeta({
      previous: previousSlotMeta,
      before: previous?.intent ?? EMPTY_SINGAPORE_TRAVEL_INTENT,
      result, turnId, source: processingSource,
      message: requestBody.message,
    });
    const response = {
      ...result, turnId, stateVersion: expectedStateVersion + 1,
      slotMeta, processingSource,
      placeDiscoveryReady: evaluatePlaceDiscoveryReadiness(result).ready,
      placeDiscoveryIssues: evaluatePlaceDiscoveryReadiness(result).issues,
    };
    const committed = await lease.commitIntentTurn({
      turnId, inputHash, expectedStateVersion,
      resultJson: JSON.stringify(response),
      slotMetaJson: JSON.stringify(slotMeta),
    });
    if (!committed.committed) return stateConflict(committed.state);
    return noStoreJson(response);
  } catch (error) {
    if (error instanceof ManagedAgentTurnUncertainError) {
      return jsonError("本轮消息是否已被百炼接收尚未确定。请勿立即重复发送；刷新页面后可用同一条消息重试。", 503, "TURN_OUTCOME_UNKNOWN");
    }
    if (error instanceof ManagedAgentInputTooLongError) {
      return jsonError("旅行描述或上下文过长，请缩短后再试。", 413, "INTENT_INPUT_TOO_LONG");
    }
    if (error instanceof ZodError) {
      console.error("Travel intent response validation failed", {
        issues: error.issues.slice(0, 8).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
      });
      return jsonError("旅行智能服务暂时未能完整解析这段描述。请重试，或把不明确的地点和时间换一种说法。", 502, "INTENT_OUTPUT_INVALID");
    }
    if (error instanceof Error && /valid JSON|empty response|field patch array/i.test(error.message)) {
      return jsonError("旅行智能服务暂时未返回符合字段约定的结果。请重试，或将日期、住宿和活动分开描述。", 502, "INTENT_OUTPUT_UNREADABLE");
    }
    console.error("Travel intent request failed", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    return jsonError("旅行智能服务暂时无法处理这句话，本轮条件未保存。请稍后重试。", 503, "INTENT_UNAVAILABLE");
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await releaseQuietly(lease);
  }
}
