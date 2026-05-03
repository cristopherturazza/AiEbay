export interface OpenRouterVisionRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  imageBase64: string;
  imageMime: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  httpReferer?: string;
  xTitle?: string;
}

export interface OpenRouterVisionResult {
  content: string;
  model: string;
}

const DEFAULT_FETCH: typeof fetch = (input, init) => fetch(input, init);

export const callOpenRouterVision = async (
  request: OpenRouterVisionRequest
): Promise<OpenRouterVisionResult> => {
  const endpoint = new URL("/api/v1/chat/completions", request.baseUrl).toString();
  const controller = new AbortController();
  const timer = request.timeoutMs
    ? setTimeout(() => controller.abort(), request.timeoutMs)
    : undefined;
  const fetchImpl = request.fetchImpl ?? DEFAULT_FETCH;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${request.apiKey}`
  };
  if (request.httpReferer) {
    headers["HTTP-Referer"] = request.httpReferer;
  }
  if (request.xTitle) {
    headers["X-Title"] = request.xTitle;
  }

  const body = {
    model: request.model,
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: request.prompt },
          {
            type: "image_url" as const,
            image_url: { url: `data:${request.imageMime};base64,${request.imageBase64}` }
          }
        ]
      }
    ],
    response_format: { type: "json_object" as const }
  };

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenRouter ${response.status}: ${text.slice(0, 300)}`);
    }

    const payload = (await response.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = payload.choices?.[0]?.message?.content ?? "";
    return {
      content,
      model: payload.model ?? request.model
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};
