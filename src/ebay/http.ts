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
}

export class HttpClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async requestJson<T>(options: HttpRequestOptions): Promise<T> {
    const response = await this.request(options);

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }

    return JSON.parse(text) as T;
  }

  async requestVoid(options: HttpRequestOptions): Promise<void> {
    const response = await this.request(options);

    if (response.status >= 200 && response.status < 300) {
      return;
    }

    const text = await response.text();
    throw new EbayApiError(response.status, `Errore HTTP ${response.status}`, text.slice(0, 500));
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

    const response = await this.fetchImpl(options.url, {
      method: options.method,
      headers,
      body
    });

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
