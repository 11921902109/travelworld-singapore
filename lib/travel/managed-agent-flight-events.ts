type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function data(event: RecordValue) { const nested = record(event.data); return Object.keys(nested).length ? nested : event; }
function text(value: unknown) { return typeof value === "string" ? value : ""; }

export type FlightTurnStep =
  | { status: "running" }
  | { status: "completed"; text: string }
  | { status: "failed"; reason: "requires_action" | "agent_error" | "invalid_reply" };

/** Read only the response after this exact input event, never a previous turn. */
export function flightTurnFromEvents(events: RecordValue[], inputEventId: string): FlightTurnStep {
  const position = events.findIndex((event) => text(data(event).id) === inputEventId);
  if (position < 0) return { status: "running" };
  let latest = "";
  for (const event of events.slice(position + 1)) {
    const item = data(event);
    if (item.type === "tool_approval_request") return { status: "failed", reason: "requires_action" };
    if (item.type === "error") return { status: "failed", reason: "agent_error" };
    const content = Array.isArray(item.content) ? item.content.map(record) : [];
    if (item.type === "message" && item.role === "assistant") {
      const value = content.filter((part) => part.type === "text").map((part) => text(part.text)).join("\n").trim();
      if (value) latest = value.slice(0, 24_000);
    }
    if (item.type === "session_status") {
      const reason = text(record(record(content[0]?.data).stop_reason).type);
      if (reason) return reason === "end_turn" && latest
        ? { status: "completed", text: latest }
        : { status: "failed", reason: reason === "requires_action" ? "requires_action" : "invalid_reply" };
    }
    if (item.type === "message" && item.role === "user") return { status: "failed", reason: "invalid_reply" };
  }
  return { status: "running" };
}
