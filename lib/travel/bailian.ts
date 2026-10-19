import { env } from "cloudflare:workers";

const MAX_RESPONSE_BYTES = 512_000;
// A FlyAI CLI lookup runs inside the Managed Agent sandbox and may include
// first-use configuration, so it needs longer than a plain model exchange.
// A batch may query up to five hotels sequentially in one sandbox. Keep the
// request bounded, while giving the read-only CLI enough time to finish.
const REQUEST_TIMEOUT_MS = 75_000;
const POLL_INTERVAL_MS = 850;

type RuntimeEnvironment = {
  BAILIAN_API_BASE_URL?: string;
  BAILIAN_AGENT_ID?: string;
  BAILIAN_ENVIRONMENT_ID?: string;
  DASHSCOPE_API_KEY?: string;
  FLYAI_API_KEY?: string;
  QWEN_API_KEY?: string;
};

type ManagedAgentConfig = {
  apiKey: string;
  baseUrl: string;
  agentId: string;
  environmentId: string;
  flyAiApiKey?: string;
};

type ManagedAgentReply = {
  sessionId: string;
  text: string;
};

type ManagedAgentFeature = "intent" | "hotel_commerce" | "poi_commerce";

type ManagedAgentStage = "create_session" | "send_event" | "list_events";

class ManagedAgentRequestError extends Error {
  readonly stage: ManagedAgentStage;
  readonly status: number;
  readonly code: string;
  readonly requestId: string;

  constructor(stage: ManagedAgentStage, response: Response, payload: unknown) {
    const details = asRecord(payload);
    const apiError = asRecord(details.error);
    const code = asString(apiError.code, 80) || asString(details.code, 80) || "unknown";
    super(`${stage} failed with ${response.status} (${code})`);
    this.name = "ManagedAgentRequestError";
    this.stage = stage;
    this.status = response.status;
    this.code = code;
    this.requestId = asString(response.headers.get("x-request-id"), 160);
  }
}

function runtimeValue(name: keyof RuntimeEnvironment): string {
  const runtime = env as unknown as RuntimeEnvironment;
  const value = runtime[name] ?? (typeof process !== "undefined" ? process.env[name] : undefined);
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function agentApiBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !/\.maas\.aliyuncs\.com$/i.test(url.hostname) ||
      !path.endsWith("/api/v1/agentstudio")
    ) {
      return null;
    }
    url.pathname = path;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function managedAgentConfig(): ManagedAgentConfig | null {
  const apiKey = runtimeValue("DASHSCOPE_API_KEY") || runtimeValue("QWEN_API_KEY");
  const baseUrl = agentApiBaseUrl(runtimeValue("BAILIAN_API_BASE_URL"));
  const agentId = runtimeValue("BAILIAN_AGENT_ID");
  const environmentId = runtimeValue("BAILIAN_ENVIRONMENT_ID");
  if (!apiKey || !baseUrl || !agentId || !environmentId) return null;
  const flyAiApiKey = runtimeValue("FLYAI_API_KEY");
  return {
    apiKey,
    baseUrl,
    agentId,
    environmentId,
    ...(flyAiApiKey ? { flyAiApiKey } : {}),
  };
}

async function readJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("Managed Agent response exceeded the configured size limit.");
  }
  const raw = await response.text();
  if (raw.length > MAX_RESPONSE_BYTES) {
    throw new Error("Managed Agent response exceeded the configured size limit.");
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Managed Agent returned invalid JSON.");
  }
}

function requestHeaders(apiKey: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function throwOnAgentResponseError(
  response: Response,
  payload: unknown,
  stage: ManagedAgentStage,
): void {
  if (!response.ok) throw new ManagedAgentRequestError(stage, response, payload);
}

async function createSession(
  config: ManagedAgentConfig,
  signal: AbortSignal,
  feature: ManagedAgentFeature,
): Promise<string> {
  const response = await fetch(`${config.baseUrl}/sessions`, {
    method: "POST",
    signal,
    headers: requestHeaders(config.apiKey),
    body: JSON.stringify({
      // Managed Agents requires an explicit Agent reference object. A plain
      // string worked in an earlier console flow but is rejected by the
      // current REST Session API, which meant Travelworld never reached the
      // FlyAI Skill even though it could run inside the console session.
      agent: { type: "agent", id: config.agentId },
      environment_id: config.environmentId,
      title: feature === "intent"
        ? "Travelworld Singapore intent"
        : feature === "hotel_commerce"
          ? "Travelworld FlyAI hotel commerce lookup"
          : "Travelworld FlyAI place commerce lookup",
      metadata: { source: "travelworld", feature },
      // FlyAI's CLI performs its own client-side configuration and request
      // signing.  A per-session runtime variable keeps each itinerary's Agent
      // sandbox independent while allowing the CLI to configure itself there.
      // This secret is never returned to the browser, logged, or put in Agent
      // prompts.
      ...(config.flyAiApiKey
        ? { environment_variables: { FLYAI_API_KEY: config.flyAiApiKey } }
        : {}),
    }),
  });
  const payload = await readJson(response);
  throwOnAgentResponseError(response, payload, "create_session");
  const sessionId = asString(asRecord(payload).id);
  if (!/^sesn_[A-Za-z0-9_-]{8,}$/.test(sessionId)) {
    throw new Error("Managed Agent session ID was missing or invalid.");
  }
  return sessionId;
}

async function sendMessage(
  config: ManagedAgentConfig,
  sessionId: string,
  message: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`${config.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events`, {
    method: "POST",
    signal,
    headers: requestHeaders(config.apiKey),
    body: JSON.stringify({
      input: [
        {
          role: "user",
          type: "message",
          content: [{ type: "text", text: message }],
        },
      ],
    }),
  });
  const payload = await readJson(response);
  throwOnAgentResponseError(response, payload, "send_event");
}

function eventData(event: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(event.data);
  return Object.keys(nested).length ? nested : event;
}

function assistantText(event: Record<string, unknown>): string {
  const value = eventData(event);
  if (asString(value.type) !== "message" || asString(value.role) !== "assistant") return "";
  const content = Array.isArray(value.content) ? value.content : [];
  return content
    .map((part) => {
      const item = asRecord(part);
      return asString(item.type) === "text" ? asString(item.text) : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim()
    .slice(0, 24_000);
}

function sessionEnded(event: Record<string, unknown>): boolean {
  const value = eventData(event);
  if (asString(value.type) !== "session_status") return false;
  const content = Array.isArray(value.content) ? value.content : [];
  const first = asRecord(content[0]);
  const data = asRecord(first.data);
  const reason = asString(asRecord(data.stop_reason).type);
  return reason === "end_turn" || reason === "retries_exhausted" || reason === "session_terminated";
}

function requiresApproval(event: Record<string, unknown>): boolean {
  const value = eventData(event);
  return asString(value.type) === "tool_approval_request";
}

async function listEvents(
  config: ManagedAgentConfig,
  sessionId: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(
    `${config.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events?order=asc&limit=100`,
    { signal, headers: requestHeaders(config.apiKey) },
  );
  const payload = await readJson(response);
  throwOnAgentResponseError(response, payload, "list_events");
  const data = asRecord(payload).data;
  return Array.isArray(data)
    ? data.map(asRecord).filter((event) => Object.keys(event).length > 0)
    : [];
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Runs one bounded, server-only exchange with the deployed Bailian Managed Agent.
 * It is used for intent orchestration and (when explicitly requested) its
 * installed FlyAI Skill. The Worker only reads the final answer and never
 * receives the FlyAI platform key.
 */
export async function askBailianAgent(
  message: string,
  feature: ManagedAgentFeature = "hotel_commerce",
): Promise<ManagedAgentReply | null> {
  const config = managedAgentConfig();
  if (!config || !message.trim()) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const sessionId = await createSession(config, controller.signal, feature);
    await sendMessage(config, sessionId, message.trim().slice(0, 6_000), controller.signal);

    let latestAssistantText = "";
    while (!controller.signal.aborted) {
      const events = await listEvents(config, sessionId, controller.signal);
      for (const event of events) {
        if (requiresApproval(event)) {
          // Travelworld never auto-approves a tool invocation. The current Agent
          // environment should mark its read-only FlyAI Skill as always allowed.
          return null;
        }
        const text = assistantText(event);
        if (text) latestAssistantText = text;
        if (latestAssistantText && sessionEnded(event)) {
          return { sessionId, text: latestAssistantText };
        }
      }
      await wait(POLL_INTERVAL_MS);
    }
    return null;
  } catch (error) {
    // Do not log prompts, agent output, session IDs, or credentials. The small
    // structured diagnostic lets production distinguish configuration errors
    // from a genuinely unavailable optional commerce lookup.
    if (error instanceof ManagedAgentRequestError) {
      console.warn("Managed Agent request unavailable", {
        stage: error.stage,
        status: error.status,
        code: error.code,
        ...(error.requestId ? { requestId: error.requestId } : {}),
      });
    } else {
      console.warn("Managed Agent request unavailable", {
        reason: error instanceof Error ? error.name : "unknown",
      });
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
