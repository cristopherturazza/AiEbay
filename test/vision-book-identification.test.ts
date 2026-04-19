import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { identifyBookFromPhoto } from "../src/vision/book-identification.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.map((dir) => rm(dir, { recursive: true, force: true })));
  temporaryRoots.length = 0;
});

const createFakePhoto = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastrota-vision-"));
  temporaryRoots.push(root);
  const photoPath = path.join(root, "cover.jpg");
  await writeFile(photoPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]));
  return photoPath;
};

const okResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });

describe("book vision identification", () => {
  it("normalizza la risposta Ollama e filtra gli ISBN non validi", async () => {
    const photoPath = await createFakePhoto();
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const rawBody = typeof init?.body === "string" ? init.body : "";
      fetchCalls.push({ url, body: JSON.parse(rawBody) });

      return okResponse({
        model: "gemma4:e4b",
        message: {
          role: "assistant",
          content: JSON.stringify({
            match: "high",
            candidates: [
              {
                title: "Se questo è un uomo",
                author: "Primo Levi",
                isbn: "9788806219356",
                confidence: "high",
                note: "Collana Einaudi Tascabili"
              },
              {
                title: "Edizione anonima",
                author: "",
                isbn: "123",
                confidence: "medium"
              }
            ]
          })
        },
        done: true,
        total_duration: 12_345_000_000
      });
    }) as typeof fetch;

    const result = await identifyBookFromPhoto({
      photoPath,
      baseUrl: "http://127.0.0.1:11434",
      model: "gemma4:e4b",
      keepAlive: "60s",
      timeoutMs: 5_000,
      fetchImpl: fakeFetch
    });

    expect(result.match).toBe("high");
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      title: "Se questo è un uomo",
      author: "Primo Levi",
      isbn: "9788806219356",
      confidence: "high"
    });
    expect(result.candidates[1].isbn).toBeUndefined();
    expect(result.reason).toBeUndefined();
    expect(result.model).toBe("gemma4:e4b");
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);

    expect(fetchCalls).toHaveLength(1);
    const sent = fetchCalls[0];
    expect(sent.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(sent.body).toMatchObject({
      model: "gemma4:e4b",
      keep_alive: "60s",
      format: "json",
      stream: false
    });
    expect(Array.isArray(sent.body.messages)).toBe(true);
  });

  it("ritorna match=none se il modello dichiara match none", async () => {
    const photoPath = await createFakePhoto();

    const fakeFetch = (async () =>
      okResponse({
        model: "gemma4:e4b",
        message: {
          role: "assistant",
          content: JSON.stringify({ match: "none", candidates: [] })
        },
        done: true
      })) as typeof fetch;

    const result = await identifyBookFromPhoto({
      photoPath,
      baseUrl: "http://127.0.0.1:11434",
      model: "gemma4:e4b",
      keepAlive: "60s",
      fetchImpl: fakeFetch
    });

    expect(result.match).toBe("none");
    expect(result.candidates).toEqual([]);
    expect(result.reason).toBeUndefined();
  });

  it("fallback a match=none quando Ollama è irraggiungibile", async () => {
    const photoPath = await createFakePhoto();

    const fakeFetch = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;

    const result = await identifyBookFromPhoto({
      photoPath,
      baseUrl: "http://127.0.0.1:11434",
      model: "gemma4:e4b",
      keepAlive: "60s",
      fetchImpl: fakeFetch
    });

    expect(result.match).toBe("none");
    expect(result.candidates).toEqual([]);
    expect(result.reason).toContain("vision_error");
  });

  it("fallback a match=none quando il modello restituisce JSON malformato", async () => {
    const photoPath = await createFakePhoto();

    const fakeFetch = (async () =>
      okResponse({
        model: "gemma4:e4b",
        message: {
          role: "assistant",
          content: "non sono riuscito a identificare il libro"
        },
        done: true
      })) as typeof fetch;

    const result = await identifyBookFromPhoto({
      photoPath,
      baseUrl: "http://127.0.0.1:11434",
      model: "gemma4:e4b",
      keepAlive: "60s",
      fetchImpl: fakeFetch
    });

    expect(result.match).toBe("none");
    expect(result.candidates).toEqual([]);
    expect(result.reason).toBe("invalid_json_from_model");
  });

  it("segnala errore se il path immagine non esiste", async () => {
    const result = await identifyBookFromPhoto({
      photoPath: path.join(os.tmpdir(), "nonexistent-book-cover-xyz.jpg"),
      baseUrl: "http://127.0.0.1:11434",
      model: "gemma4:e4b",
      keepAlive: "60s",
      fetchImpl: (async () => {
        throw new Error("fetch should not be called");
      }) as typeof fetch
    });

    expect(result.match).toBe("none");
    expect(result.candidates).toEqual([]);
    expect(result.reason).toContain("photo_read_error");
  });
});
