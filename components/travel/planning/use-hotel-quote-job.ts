"use client";

import { useCallback, useEffect, useRef } from "react";
import { getTravelVisitToken } from "@/lib/travel/visit-client";
import type { PlanningDraft } from "./planning-journey";
import type { HotelQuoteJob } from "@/lib/travel/planning-hotel-jobs";

export function useHotelQuoteJob(draft: PlanningDraft | null, onDraft: (draft: PlanningDraft) => void, onError: (message: string) => void) {
  const inFlight = useRef(false);
  const latestId = useRef("");
  const snapshot = draft?.hotelQuoteJob as HotelQuoteJob | undefined;
  const job = snapshot?.kind === "discovery" ? undefined : snapshot;
  useEffect(() => { latestId.current = job?.id || ""; return () => { latestId.current = ""; }; }, [job?.id]);
  const polling = Boolean(job && (job.status === "queued" || job.status === "running"));
  const fetchResult = useCallback(async (resume: boolean, id: string, isActive: () => boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await fetch(`/api/travel/singapore/planning/stays?pollQuotes=1${resume ? "&resume=1" : ""}`, {
        headers: { "x-travel-visit": await getTravelVisitToken() }, cache: "no-store",
      });
      const payload = await response.json().catch(() => null) as { draft?: PlanningDraft; error?: { message?: string } } | null;
      if (!isActive() || latestId.current !== id) return;
      if (payload?.draft) onDraft(payload.draft);
      if (!response.ok) throw new Error(payload?.error?.message || "暂时无法读取酒店报价，任务仍可恢复。" );
    } catch (cause) { if (isActive() && latestId.current === id) onError(cause instanceof Error ? cause.message : "酒店报价暂时无法读取。" ); }
    finally { inFlight.current = false; }
  }, [onDraft, onError]);
  useEffect(() => {
    if (!polling || !job?.id) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => { await fetchResult(false, job.id, () => active); if (active) timer = setTimeout(() => void tick(), 3_000); };
    void tick();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [polling, job?.id, fetchResult]);
  const resume = useCallback(() => { const id = latestId.current; if (id) void fetchResult(true, id, () => true); }, [fetchResult]);
  return { job, polling, resume };
}
