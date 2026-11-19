"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getTravelVisitToken } from "@/lib/travel/visit-client";
import type { SceneDiscoveryJob } from "@/lib/travel/planning-scene-jobs";
import type { PlanningDraft } from "./planning-journey";

type SceneDraft = PlanningDraft & { sceneDiscoveryJob?: SceneDiscoveryJob | Record<string, unknown> };

/** Continue one saved operation; network retries never start a new recommendation batch. */
export function useSceneDiscoveryJob(
  draft: SceneDraft | null,
  onDraft: (draft: PlanningDraft) => void,
  onError: (message: string) => void,
): { resume: () => void; polling: boolean; paused: boolean } {
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const latest = useRef(draft);
  const callbacks = useRef({ onDraft, onError });
  callbacks.current = { onDraft, onError };
  const controllerRef = useRef<AbortController | null>(null);
  const [paused, setPaused] = useState(false);
  latest.current = draft;
  const jobId = typeof draft?.sceneDiscoveryJob?.id === "string" ? draft.sceneDiscoveryJob.id : "";
  const status = draft?.sceneDiscoveryJob?.status;
  const polling = !paused && draft?.stage === "places" && (status === "queued" || status === "running");

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controllerRef.current?.abort(); }; }, []);
  useEffect(() => { setPaused(false); }, [jobId]);
  const fetchResult = useCallback(async (resume: boolean, expectedId: string, isActive: () => boolean) => {
    if (inFlight.current || !expectedId) return;
    inFlight.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch(`/api/travel/singapore/planning/scenes?poll=1${resume ? "&resume=1" : ""}`, {
        headers: { "x-travel-visit": await getTravelVisitToken() }, cache: "no-store", signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as { draft?: SceneDraft; error?: string | { message?: string } } | null;
      if (!mounted.current || !isActive() || latest.current?.sceneDiscoveryJob?.id !== expectedId || latest.current?.stage !== "places") return;
      if (payload?.draft && payload.draft.sceneDiscoveryJob?.id === expectedId && payload.draft.version >= (latest.current?.version || 0)) callbacks.current.onDraft(payload.draft);
      if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : payload?.error?.message || "暂时无法读取本次地点整理，任务和已选地点仍已保留。" );
    } catch (error) {
      if (mounted.current && isActive() && latest.current?.sceneDiscoveryJob?.id === expectedId) {
        setPaused(true);
        callbacks.current.onError(controller.signal.aborted ? "本次读取超时，任务仍保留；请继续读取原任务，无需重新提交。" : error instanceof Error ? error.message : "暂时无法读取本次地点整理，可继续读取。" );
      }
    } finally { clearTimeout(timeout); inFlight.current = false; if (controllerRef.current === controller) controllerRef.current = null; }
  }, []);

  useEffect(() => {
    if (!polling || !jobId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await fetchResult(false, jobId, () => active);
      if (active) timer = setTimeout(() => void tick(), 3_000);
    };
    void tick();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [jobId, polling, fetchResult]);

  const resume = useCallback(() => { if (inFlight.current) return; setPaused(false); void fetchResult(true, jobId, () => mounted.current); }, [fetchResult, jobId]);
  return { resume, polling: Boolean(polling), paused };
}
