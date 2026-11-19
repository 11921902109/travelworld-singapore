import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import { askPlanningHelpAgent, PLANNING_HELP_SYSTEM, PlanningHelpIsolationError } from "@/lib/travel/bailian";
import { planningHelpStages } from "@/lib/travel/planning-help-questions";
import { directPlanningHelp, planningHelpFacts } from "@/lib/travel/planning-help";
import { acquireHelpSession, readPlanningHelpSnapshot } from "@/lib/travel/planning-help-store";
import { planningDraftWithReadiness } from "@/lib/travel/planning-readiness";
import { requestQwenJson } from "@/lib/travel/qwen";
import { readTravelVisitToken } from "@/lib/travel/visit-session";

export const dynamic = "force-dynamic";
const BODY_LIMIT = 13_000;
const TEXT_FALLBACK = "text";
const Input = z.object({
  handoffId: z.string().uuid(),
  stage: z.enum(planningHelpStages),
  day: z.number().int().min(1).max(7).optional(),
  question: z.string().trim().min(2).max(500),
  history: z.array(z.object({ question: z.string().max(500), answer: z.string().max(650) })).max(4).default([]),
});
const AssistantAnswer = z.object({ answer: z.string().trim().min(1).max(650) }).strict();

function json(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
}

function error(code: string, message: string, status: number) {
  return json({ error: { code, message } }, status);
}

export async function POST(request: NextRequest) {
  const blocked = guardSingaporeApi(request, { bucket: "planning-help", limit: 24, windowMs: 300_000, maxBodyBytes: BODY_LIMIT });
  if (blocked) return blocked;
  const token = readTravelVisitToken(request);
  if (!token) return error("VISIT_REQUIRED", "请重新打开当前旅行后提问。", 400);
  const raw = await request.text().catch(() => "");
  if (new TextEncoder().encode(raw).length > BODY_LIMIT) return error("REQUEST_TOO_LARGE", "问题或随附的对话过长。", 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { body = null; }
  const parsed = Input.safeParse(body);
  if (!parsed.success) return error("INVALID_HELP_QUESTION", "请从当前规划步骤选择或填写一个 2–500 字的问题。", 422);
  const input = parsed.data;
  try {
    const snapshot = await readPlanningHelpSnapshot(token, input.handoffId);
    if (!snapshot) return error("HELP_TRIP_UNAVAILABLE", "当前旅行无法读取，请回到当前规划步骤后再提问。", 404);
    if (input.stage !== snapshot.draft.stage) return error("HELP_STAGE_CHANGED", "规划步骤已变化，请按当前步骤重新提问。", 409);
    if (input.day !== undefined && (input.stage !== "route" || input.day > snapshot.handoff.dates.days))
      return error("HELP_DAY_INVALID", "请选择当前旅行中的有效日期。", 422);
    const draft = input.stage === "route" ? await planningDraftWithReadiness(snapshot.handoff, snapshot.draft) : snapshot.draft;
    const facts = planningHelpFacts(snapshot.handoff, draft, input.day);
    const direct = directPlanningHelp(input.question, facts);
    if (direct) return json({ answer: direct.slice(0, 650), mode: "direct" });

    const lease = await acquireHelpSession(snapshot);
    if (!lease) return error("HELP_BUSY", "上一条帮助问题还在处理，请稍后再试。右侧规划不受影响。", 409);
    try {
      const message = JSON.stringify({ facts, question: input.question,
        recentHelpForReferenceOnly: input.history.map((turn) => ({ question: turn.question.slice(0, 260), answer: turn.answer.slice(0, 340) })),
      });
      let result: string | null = null;
      let fallback = lease.sessionId === TEXT_FALLBACK;
      if (!fallback) {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(37_000)]);
        try { result = await askPlanningHelpAgent(message, lease, signal); }
        catch (cause) {
          if (!(cause instanceof PlanningHelpIsolationError)) throw cause;
          fallback = true;
          await lease.bind(TEXT_FALLBACK);
        }
      }
      if (fallback && !request.signal.aborted) {
        result = await requestQwenJson({
          messages: [{ role: "system", content: PLANNING_HELP_SYSTEM }, { role: "user", content: message }],
          maxTokens: 420, timeoutMs: 18_000,
        });
      }
      const current = await readPlanningHelpSnapshot(token, input.handoffId);
      if (!current || current.visitCreatedAt !== snapshot.visitCreatedAt || current.draft.version !== snapshot.draft.version ||
          current.draft.stage !== snapshot.draft.stage)
        return error("HELP_CONTEXT_CHANGED", "规划内容已更新，请按最新安排重新提问。", 409);
      let output: unknown = null;
      if (result) {
        try { output = JSON.parse(result.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi, "")); } catch { /* Fail with the same bounded public message. */ }
      }
      const decoded = AssistantAnswer.safeParse(output);
      if (decoded.success && !/(?:https?:\/\/|\bwww\.)/i.test(decoded.data.answer)) return json({ answer: decoded.data.answer, mode: "bailian" });
      return error("HELP_UNAVAILABLE", "这次未能生成可靠回答，可以重试。右侧规划不受影响。", 502);
    } finally {
      await lease.release().catch(() => undefined);
    }
  } catch {
    return error("HELP_UNAVAILABLE", "答疑暂时不可用，可以重试。右侧规划不受影响。", 502);
  }
}
