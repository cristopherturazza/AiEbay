export interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
}

export interface OllamaChatOptions {
  baseUrl: string;
  model: string;
  messages: OllamaChatMessage[];
  keepAlive?: string;
  format?: "json" | Record<string, unknown>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface OllamaChatResult {
  content: string;
  model: string;
  totalDurationMs?: number;
  done: boolean;
}

const DEFAULT_FETCH: typeof fetch = (input, init) => fetch(input, init);

export const callOllamaChat = async (options: OllamaChatOptions): Promise<OllamaChatResult> => {
  const endpoint = new URL("/api/chat", options.baseUrl).toString();
  const controller = new AbortController();
  const timer = options.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : undefined;
  const fetchImpl = options.fetchImpl ?? DEFAULT_FETCH;

  const payload: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    stream: false
  };
  if (options.keepAlive !== undefined) {
    payload.keep_alive = options.keepAlive;
  }
  if (options.format !== undefined) {
    payload.format = options.format;
  }

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Ollama ${response.status}: ${text.slice(0, 200)}`);
    }

    const body = (await response.json()) as {
      model?: string;
      message?: { content?: string };
      total_duration?: number;
      done?: boolean;
    };

    const totalDurationNs = typeof body.total_duration === "number" ? body.total_duration : undefined;

    return {
      content: body.message?.content ?? "",
      model: body.model ?? options.model,
      totalDurationMs: totalDurationNs !== undefined ? totalDurationNs / 1_000_000 : undefined,
      done: body.done ?? true
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};
