import { env } from "cloudflare:workers";

const DEFAULT_QWEN_API_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const DEFAULT_QWEN_MODEL = "qwen3.8-flash";

type RuntimeEnvironment = {
  DASHSCOPE_API_KEY?: string;
  QWEN_API_KEY?: string;
  QWEN_API_URL?: string;
  QWEN_MODEL?: string;
};

export type QwenChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type QwenResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  error?: {
    message?: string;
  };
};

export class QwenServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "QwenServiceError";
  }
}

function assistantContent(response: QwenResponse): string | null {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const combined = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .join("")
    .trim();
  return combined || null;
}

export async function requestQwenJson(options: {
  messages: QwenChatMessage[];
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<string> {
  const runtime = env as unknown as RuntimeEnvironment;
  // The original DashScope key is shared by the direct Qwen intent parser and
  // the Bailian Managed Agent. Keep the older QWEN_API_KEY name as a fallback
  // so existing production configuration stays compatible.
  const apiKey = runtime.DASHSCOPE_API_KEY?.trim() || runtime.QWEN_API_KEY?.trim();
  if (!apiKey) {
    throw new QwenServiceError(
      "QWEN_NOT_CONFIGURED",
      "旅行智能服务暂未配置。",
      503,
    );
  }

  let endpoint: URL;
  try {
    endpoint = new URL(runtime.QWEN_API_URL?.trim() || DEFAULT_QWEN_API_URL);
    if (endpoint.protocol !== "https:") throw new Error("HTTPS is required.");
  } catch {
    throw new QwenServiceError(
      "QWEN_INVALID_CONFIG",
      "旅行智能服务配置无效。",
      503,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 25_000);
  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: runtime.QWEN_MODEL?.trim() || DEFAULT_QWEN_MODEL,
        messages: options.messages,
        temperature: options.temperature ?? 0.1,
        stream: false,
        max_tokens: options.maxTokens,
        enable_thinking: false,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    const responseText = await upstream.text();
    let payload: QwenResponse;
    try {
      payload = JSON.parse(responseText) as QwenResponse;
    } catch {
      throw new QwenServiceError(
        "QWEN_BAD_RESPONSE",
        "旅行智能服务返回了无法识别的内容。",
        502,
      );
    }

    if (!upstream.ok) {
      console.error("Qwen request failed", {
        status: upstream.status,
        message: payload.error?.message?.slice(0, 240),
      });
      if (upstream.status === 429) {
        throw new QwenServiceError(
          "QWEN_RATE_LIMITED",
          "旅行智能服务当前请求较多，请稍后重试。",
          429,
        );
      }
      throw new QwenServiceError(
        "QWEN_UPSTREAM_ERROR",
        "旅行智能服务暂时不可用。",
        502,
      );
    }

    const content = assistantContent(payload);
    if (!content) {
      throw new QwenServiceError(
        "QWEN_EMPTY_RESPONSE",
        "旅行智能服务没有返回有效结果。",
        502,
      );
    }
    return content;
  } catch (error) {
    if (error instanceof QwenServiceError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new QwenServiceError(
        "QWEN_TIMEOUT",
        "旅行智能分析超时，请重试。",
        504,
      );
    }
    console.error("Qwen request failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
    throw new QwenServiceError(
      "QWEN_NETWORK_ERROR",
      "暂时无法连接旅行智能服务。",
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}
