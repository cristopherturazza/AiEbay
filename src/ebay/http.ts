import { SellbotError } from "../errors.js";

export class EbayApiError extends SellbotError {
  readonly status: number;
  readonly responseSnippet: string;

  constructor(status: number, message: string, responseSnippet: string) {
    super("EBAY_HTTP_ERROR", message, { status, responseSnippet });
    this.status = status;
    this.responseSnippet = responseSnippet;
  }
}

export interface HttpRequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  json?: unknown;
  body?: BodyInit;
  timeoutMs?: number;
}

export class HttpClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly defaultTimeoutMs = 30_000
  ) {}

  async requestJson<T>(options: HttpRequestOptions): Promise<T> {
    const response = await this.request(options);

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new SellbotError(
        "EBAY_RESPONSE_PARSE_ERROR",
        `Risposta eBay non valida (JSON atteso) su ${options.method} ${options.url}: ${(error as Error).message}`,
        { responseSnippet: text.slice(0, 500) }
      );
    }
  }

  async requestVoid(options: HttpRequestOptions): Promise<void> {
    await this.request(options);
  }

  private async request(options: HttpRequestOptions): Promise<Response> {
    const headers = { ...(options.headers ?? {}) };
    let body = options.body;

    if (options.json !== undefined) {
      if (!headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
      body = JSON.stringify(options.json);
    }

    if (!headers.Accept) {
      headers.Accept = "application/json";
    }

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    let response: Response;

    try {
      response = await this.fetchImpl(options.url, {
        method: options.method,
        headers,
        body,
        signal: controller.signal
      });
    } catch (error) {
      const err = error as Error;
      if (err.name === "AbortError") {
        throw new SellbotError(
          "EBAY_HTTP_TIMEOUT",
          `Timeout richiesta eBay dopo ${timeoutMs}ms su ${options.method} ${options.url}`
        );
      }

      throw new SellbotError(
        "EBAY_HTTP_NETWORK",
        `Errore di rete durante richiesta eBay ${options.method} ${options.url}: ${err.message}`
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new EbayApiError(
        response.status,
        `Richiesta eBay fallita (${response.status}) su ${options.method} ${options.url}`,
        text.slice(0, 500)
      );
    }

    return response;
  }
}
