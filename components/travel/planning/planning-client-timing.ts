const allowed = new Set(["board:edit", "board:save", "flights:search", "flights:select", "flights:manual", "flights:skip", "stays:advise", "stays:segments", "stays:searchHotels", "stays:quoteHotels", "stays:selectHotel", "stays:confirm", "schedule:calculate", "schedule:updateDay", "schedule:confirm", "schedule:decideFreeTime"]);

/** Local browser performance entries only; no conversation or traveller values. */
export function beginPlanningInteraction(input: string) {
  const action = allowed.has(input) ? input : "unknown";
  const start = performance.now(); let traceId: string | undefined; let finished = false;
  const measure = (phase: string) => {
    requestAnimationFrame(() => {
      const name = `travelworld:${phase}`;
      if (performance.getEntriesByName(name).length >= 50) performance.clearMeasures(name);
      performance.measure(name, { start, end: performance.now(), detail: { action, ...(traceId ? { traceId } : {}) } });
    });
  };
  measure("interaction_feedback");
  return {
    response(value: Response) { const id = value.headers.get("X-Travel-Trace-Id"); if (id && /^[0-9a-f-]{36}$/i.test(id)) traceId = id; },
    finish() { if (!finished) { finished = true; measure("result_presented"); } },
  };
}
