import { EbayApiError } from "../ebay/http.js";

export const toStatusError = (error: unknown): {
  message: string;
  http_status: number | null;
  response_snippet: string | null;
  at: string;
} => {
  if (error instanceof EbayApiError) {
    return {
      message: error.message,
      http_status: error.status,
      response_snippet: error.responseSnippet,
      at: new Date().toISOString()
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      http_status: null,
      response_snippet: null,
      at: new Date().toISOString()
    };
  }

  return {
    message: "Errore sconosciuto",
    http_status: null,
    response_snippet: String(error),
    at: new Date().toISOString()
  };
};
