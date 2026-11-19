"use client";

import { useEffect, useState } from "react";
import { samePlanningPlaceSelection, toggleLocalPlanningPlace, workingPlanningPlaceIds, type LocalPlaceSelection } from "@/lib/travel/planning-place-selection";

type Draft = { version: number; stage: string; candidates: Array<{ placeId: string }>; selectedPlaceIds?: string[]; assignments: Array<{ orderedCandidateIds: string[] }> };
const empty = (): LocalPlaceSelection => ({ added: [], removed: [] });
function restore(key: string): { key: string; edits: LocalPlaceSelection; version: number | null } {
  try {
    if (typeof window !== "undefined") {
      const value = JSON.parse(sessionStorage.getItem(key) || "null");
      const valid = (items: unknown): items is string[] => Array.isArray(items) && items.length <= 40 && items.every((id) => typeof id === "string" && id.length >= 8 && id.length <= 255);
      if (value && valid(value.added) && valid(value.removed)) return { key, edits: { added: value.added, removed: value.removed }, version: Number.isInteger(value.version) ? value.version : null };
    }
  } catch { /* Storage is optional. */ }
  return { key, edits: empty(), version: null };
}

export function useWorkingPlaceSelection(handoffId: string, draft: Draft | null) {
  const key = `travelworld:place-selection:${handoffId}`;
  const [state, setState] = useState(() => restore(key));
  if (state.key !== key) setState(restore(key));
  const edits = state.key === key ? state.edits : empty();
  const saved = draft?.selectedPlaceIds ?? [...new Set(draft?.assignments.flatMap((item) => item.orderedCandidateIds) || [])];
  const available = draft?.candidates.map((item) => item.placeId) || [];
  const selectedIds = workingPlanningPlaceIds(saved, edits, available);
  const unavailableIds = [...new Set([...saved, ...edits.added])].filter((id) => !available.includes(id) && !edits.removed.includes(id));
  const dirty = unavailableIds.length > 0 || !samePlanningPlaceSelection(selectedIds, saved);

  useEffect(() => {
    if (state.key !== key || !draft) return;
    try {
      // A conflict can return another stage; only an acknowledged confirm clears edits.
      sessionStorage.setItem(key, JSON.stringify({ ...state.edits, version: draft.version }));
    } catch { /* Quota/privacy settings must not block planning. */ }
  }, [draft, key, state]);

  const setEdits = (update: (current: LocalPlaceSelection) => LocalPlaceSelection) => setState((current) => ({ ...current, edits: update(current.edits) }));

  return {
    selectedIds,
    dirty,
    unavailableIds,
    notice: unavailableIds.length ? `${unavailableIds.length} 个先前选择已不在当前候选中。请移除失效选择，或重新搜索后确认。` : dirty && state.version !== null && draft && state.version !== draft.version ? "规划已有更新，已保留本地选择，请核对后确认。" : "",
    clear: () => { setState({ key, edits: empty(), version: null }); try { sessionStorage.removeItem(key); } catch { /* Optional storage. */ } },
    discardUnavailable: () => setEdits((current) => ({ added: current.added.filter((id) => available.includes(id)), removed: [...new Set([...current.removed, ...unavailableIds])] })),
    toggle: (id: string) => setEdits((current) => toggleLocalPlanningPlace(saved, current, id)),
    select: (id: string) => setEdits((current) => {
      const values = workingPlanningPlaceIds(saved, current, [...available, id]);
      return values.includes(id) ? current : toggleLocalPlanningPlace(saved, current, id);
    }),
  };
}
