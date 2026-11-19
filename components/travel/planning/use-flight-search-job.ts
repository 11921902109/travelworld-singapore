"use client";

import { useCallback, useEffect, useRef } from "react";
import { getTravelVisitToken } from "@/lib/travel/visit-client";
import type { PlanningDraft } from "./planning-journey";

export function useFlightSearchJob(
  draft: PlanningDraft | null,
  onDraft: (draft: PlanningDraft) => void,
  onError: (message: string) => void,
): { resume: () => void; polling: boolean } {
  const inFlight = useRef(false);
  const jobId = typeof draft?.flightSearchJob?.id === "string" ? draft.flightSearchJob.id : "";
  const status = draft?.flightSearchJob?.status;
  const polling = draft?.stage === "flights" && (status === "queued" || status === "running");

  const fetchResult = useCallback(async (resume: boolean, isActive: () => boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await fetch(`/api/travel/singapore/planning/flights?poll=1${resume ? "&resume=1" : ""}`, {
        headers: { "x-travel-visit": await getTravelVisitToken() }, cache: "no-store",
      });
      const payload = await response.json().catch(() => null) as { draft?: PlanningDraft; error?: string | { message?: string } } | null;
      if (!isActive()) return;
      if (payload?.draft) onDraft(payload.draft);
      if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : payload?.error?.message || "暂时无法读取航班查询，正在保留同次查询。" );
    } catch (error) {
      if (isActive()) onError(error instanceof Error ? error.message : "暂时无法读取航班结果，任务仍可恢复。" );
    } finally { inFlight.current = false; }
  }, [onDraft, onError]);

  useEffect(() => {
    if (!polling || !jobId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await fetchResult(false, () => active);
      if (active) timer = setTimeout(() => void tick(), 3_000);
    };
    void tick();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [jobId, polling, fetchResult]);

  const resume = useCallback(() => { void fetchResult(true, () => true); }, [fetchResult]);
  return { resume, polling: Boolean(polling) };
}
