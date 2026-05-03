import { readFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "../logger.js";
import { callOllamaChat } from "./ollama-client.js";
import { callOpenRouterVision } from "./openrouter-client.js";

export type BookMatchLevel = "none" | "low" | "medium" | "high";

export interface BookCandidate {
  title?: string;
  author?: string;
  isbn?: string;
  confidence: "low" | "medium" | "high";
  note?: string;
}

export interface BookIdentificationResult {
  match: BookMatchLevel;
  candidates: BookCandidate[];
  elapsed_ms: number;
  model: string;
  reason?: string;
}

export type VisionBackend =
  | {
      kind: "ollama";
      baseUrl: string;
      model: string;
      keepAlive: string;
      timeoutMs?: number;
    }
  | {
      kind: "openrouter";
      baseUrl: string;
      apiKey: string;
      model: string;
      timeoutMs?: number;
      httpReferer?: string;
      xTitle?: string;
    };

export interface IdentifyBookFromPhotoOptions {
  photoPath: string;
  backend: VisionBackend;
  hint?: string;
  fetchImpl?: typeof fetch;
}

const PROMPT = `Sei un assistente esperto di identificazione libri dalla foto di copertina.
Osserva attentamente la copertina e restituisci SOLO un JSON valido conforme a questo schema:
{
  "match": "none" | "low" | "medium" | "high",
  "candidates": [
    {
      "title": "string",
      "author": "string",
      "isbn": "string (solo se effettivamente leggibile)",
      "confidence": "low" | "medium" | "high",
      "note": "string breve opzionale"
    }
  ]
}

Regole obbligatorie:
- Non inventare l'ISBN: ometti il campo se non e' chiaramente leggibile nella copertina o nel retro.
- Se non riesci a identificare il libro con ragionevole confidenza, rispondi con match="none" e candidates=[].
- Restituisci al massimo 3 candidates, ordinati per confidenza decrescente.
- Non aggiungere testo fuori dal JSON.`;

const VALID_MATCH = new Set<BookMatchLevel>(["none", "low", "medium", "high"]);
const VALID_CONFIDENCE = new Set<BookCandidate["confidence"]>(["low", "medium", "high"]);

const cleanString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeIsbn = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const compact = value.replace(/[^0-9X]/gi, "").toUpperCase();
  return compact.length === 10 || compact.length === 13 ? compact : undefined;
};

const normalizeCandidate = (raw: unknown): BookCandidate | undefined => {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const entry = raw as Record<string, unknown>;
  const title = cleanString(entry.title);
  const author = cleanString(entry.author);
  const isbn = normalizeIsbn(entry.isbn);
  const note = cleanString(entry.note);

  if (!title && !author && !isbn) {
    return undefined;
  }

  const confidence =
    typeof entry.confidence === "string" && VALID_CONFIDENCE.has(entry.confidence as BookCandidate["confidence"])
      ? (entry.confidence as BookCandidate["confidence"])
      : "low";

  return {
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(isbn ? { isbn } : {}),
    confidence,
    ...(note ? { note } : {})
  };
};

const extractJsonPayload = (raw: string): unknown | undefined => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Some models prefix output; try to find the outermost object.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }

    return undefined;
  }
};

const normalizeResponse = (
  payload: unknown,
  elapsedMs: number,
  model: string
): BookIdentificationResult => {
  const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

  const rawCandidates = Array.isArray(obj.candidates) ? obj.candidates : [];
  const candidates: BookCandidate[] = [];
  for (const entry of rawCandidates) {
    if (candidates.length >= 3) {
      break;
    }

    const normalized = normalizeCandidate(entry);
    if (normalized) {
      candidates.push(normalized);
    }
  }

  const declaredMatch =
    typeof obj.match === "string" && VALID_MATCH.has(obj.match as BookMatchLevel)
      ? (obj.match as BookMatchLevel)
      : "none";

  return {
    match: candidates.length === 0 ? "none" : declaredMatch,
    candidates,
    elapsed_ms: elapsedMs,
    model
  };
};

const emptyResult = (
  elapsedMs: number,
  model: string,
  reason: string
): BookIdentificationResult => ({
  match: "none",
  candidates: [],
  elapsed_ms: elapsedMs,
  model,
  reason
});

const guessMimeFromPath = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".heic":
    case ".heif":
      return "image/heic";
    case ".gif":
      return "image/gif";
    default:
      return "image/jpeg";
  }
};

interface ModelCallResult {
  content: string;
  modelLabel: string;
}

const runOllama = async (
  backend: Extract<VisionBackend, { kind: "ollama" }>,
  prompt: string,
  imageBase64: string,
  fetchImpl: typeof fetch | undefined
): Promise<ModelCallResult> => {
  const result = await callOllamaChat({
    baseUrl: backend.baseUrl,
    model: backend.model,
    keepAlive: backend.keepAlive,
    format: "json",
    timeoutMs: backend.timeoutMs,
    fetchImpl,
    messages: [
      {
        role: "user",
        content: prompt,
        images: [imageBase64]
      }
    ]
  });

  return { content: result.content, modelLabel: result.model };
};

const runOpenRouter = async (
  backend: Extract<VisionBackend, { kind: "openrouter" }>,
  prompt: string,
  imageBase64: string,
  imageMime: string,
  fetchImpl: typeof fetch | undefined
): Promise<ModelCallResult> => {
  const result = await callOpenRouterVision({
    baseUrl: backend.baseUrl,
    apiKey: backend.apiKey,
    model: backend.model,
    prompt,
    imageBase64,
    imageMime,
    timeoutMs: backend.timeoutMs,
    fetchImpl,
    httpReferer: backend.httpReferer,
    xTitle: backend.xTitle
  });

  return { content: result.content, modelLabel: result.model };
};

export const identifyBookFromPhoto = async (
  options: IdentifyBookFromPhotoOptions
): Promise<BookIdentificationResult> => {
  const absolute = path.isAbsolute(options.photoPath)
    ? options.photoPath
    : path.resolve(process.cwd(), options.photoPath);

  const started = Date.now();
  const backend = options.backend;
  const declaredModel = backend.model;

  let base64: string;
  try {
    const buffer = await readFile(absolute);
    base64 = buffer.toString("base64");
  } catch (error) {
    const elapsed = Date.now() - started;
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`[vision] book.identify lettura foto fallita path=${absolute}: ${reason}`);
    return emptyResult(elapsed, declaredModel, `photo_read_error: ${reason}`);
  }

  const prompt = options.hint ? `${PROMPT}\n\nSuggerimento dell'utente: ${options.hint}` : PROMPT;

  try {
    const { content, modelLabel } =
      backend.kind === "ollama"
        ? await runOllama(backend, prompt, base64, options.fetchImpl)
        : await runOpenRouter(backend, prompt, base64, guessMimeFromPath(absolute), options.fetchImpl);

    const elapsed = Date.now() - started;
    logger.info(
      `[vision] book.identify ok provider=${backend.kind} model=${modelLabel} elapsed_ms=${elapsed}`
    );

    const parsed = extractJsonPayload(content);
    if (parsed === undefined) {
      return emptyResult(elapsed, modelLabel, "invalid_json_from_model");
    }

    return normalizeResponse(parsed, elapsed, modelLabel);
  } catch (error) {
    const elapsed = Date.now() - started;
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[vision] book.identify errore provider=${backend.kind} elapsed_ms=${elapsed} model=${declaredModel}: ${reason}`
    );
    return emptyResult(elapsed, declaredModel, `vision_error: ${reason}`);
  }
};
