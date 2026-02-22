export class SellbotError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "SellbotError";
    this.code = code;
    this.details = details;
  }
}

export const isSellbotError = (value: unknown): value is SellbotError => {
  return value instanceof SellbotError;
};
