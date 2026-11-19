"use client";

import { useEffect, useState } from "react";
import { boardSignature, boardPlacePreferences, moveBoardPlace, type BoardAssignment, type BoardPlacePreference } from "@/lib/travel/planning-day-board";

type Draft = { version: number; assignments: BoardAssignment[]; placeTimePreferences?: Record<string, BoardPlacePreference> };
type State = { key: string; assignments: BoardAssignment[] | null; baseVersion: number | null; preferences?: Record<string, BoardPlacePreference> };
function restore(key: string): State {
  try {
    if (typeof window !== "undefined") {
      const value = JSON.parse(sessionStorage.getItem(key) || "null");
      if (value && Number.isInteger(value.baseVersion) && Array.isArray(value.assignments) && value.assignments.length <= 7 &&
        value.assignments.every((day: BoardAssignment) => Number.isInteger(day.day) && day.day >= 1 && day.day <= 7 && Array.isArray(day.orderedCandidateIds) && day.orderedCandidateIds.length <= 40 && day.orderedCandidateIds.every((id) => typeof id === "string" && id.length >= 8 && id.length <= 255))) {
        return { key, assignments: value.assignments, baseVersion: value.baseVersion, preferences: value.preferences && typeof value.preferences === "object" ? value.preferences : undefined };
      }
    }
  } catch { /* Visit-local persistence is optional. */ }
  return { key, assignments: null, baseVersion: null };
}

export function useWorkingDayBoard(handoffId: string, draft: Draft | null, days: number) {
  const key = `travelworld:day-board:${handoffId}`;
  const [state, setState] = useState(() => restore(key));
  if (state.key !== key) setState(restore(key));
  const assignments = state.key === key && state.assignments ? state.assignments : draft?.assignments || [];
  const preferences = boardPlacePreferences(assignments, state.key === key && state.assignments ? state.preferences ?? draft?.placeTimePreferences : draft?.placeTimePreferences);
  const dirty = Boolean(draft && (boardSignature(assignments) !== boardSignature(draft.assignments) || JSON.stringify(preferences) !== JSON.stringify(boardPlacePreferences(draft.assignments, draft.placeTimePreferences))));
  const conflict = dirty && state.baseVersion !== null && draft?.version !== state.baseVersion;
  useEffect(() => {
    if (state.key !== key) return;
    try {
      if (state.assignments) sessionStorage.setItem(key, JSON.stringify(state));
      else sessionStorage.removeItem(key);
    } catch { /* Privacy/quota settings do not block editing. */ }
  }, [state, key]);
  const edit = (update: (value: BoardAssignment[], preferences: Record<string, BoardPlacePreference>) => { assignments: BoardAssignment[]; preferences: Record<string, BoardPlacePreference> }) => {
    if (!draft) return;
    setState((current) => {
      const values = current.key === key && current.assignments ? current.assignments : draft.assignments;
      const preferences = boardPlacePreferences(values, current.key === key && current.assignments ? current.preferences ?? draft.placeTimePreferences : draft.placeTimePreferences);
      return { key, baseVersion: current.key === key && current.assignments ? current.baseVersion : draft.version, ...update(values, preferences) };
    });
  };
  return {
    assignments, preferences, dirty, conflict,
    move: (id: string, day: number | null, index?: number, period?: "morning" | "afternoon") => edit((current, preferences) => {
      const assignments = moveBoardPlace(current, days, id, day, index, preferences, period);
      return { assignments, preferences: boardPlacePreferences(assignments, preferences) };
    }),
    setPeriod: (id: string, day: number, period: "morning" | "afternoon" | "flexible", strength: "soft" | "hard") => edit((current, preferences) => {
      const nextPreferences = { ...preferences };
      if (period === "flexible") delete nextPreferences[id];
      else nextPreferences[id] = { period, constraint: { strength, source: "user", evidence: `${strength === "hard" ? "只能" : "偏好"}${period === "morning" ? "上午" : "下午／晚间"}到访` } };
      return { preferences: nextPreferences, assignments: current.map((item) => {
      if (item.day !== day || !item.orderedCandidateIds.includes(id)) return item;
      const periods = { ...item.periodByCandidateId }; const constraints = { ...item.periodConstraintByCandidateId };
      if (period === "flexible") { delete periods[id]; delete constraints[id]; }
      else { periods[id] = period; constraints[id] = { strength, source: "user", evidence: `${strength === "hard" ? "只能" : "偏好"}${period === "morning" ? "上午" : "下午／晚间"}到访` }; }
      return { ...item, periodByCandidateId: periods, periodConstraintByCandidateId: constraints };
      }) };
    }),
    clear: () => { setState({ key, assignments: null, baseVersion: null }); try { sessionStorage.removeItem(key); } catch { /* Optional storage. */ } },
    acceptLatestVersion: () => setState((current) => ({ ...current, baseVersion: draft?.version ?? null })),
  };
}
