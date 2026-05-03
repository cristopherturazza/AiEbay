import { mkdtemp, mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_ID,
  getInboxRoot,
  getInboxSession,
  promoteInboxToListing,
  purgeStaleInboxSessions,
  saveInboxPhoto,
  sanitizeSessionId
} from "../src/fs/inbox.js";
import { getToSellRoot } from "../src/fs/listings.js";

const tempRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true })));
  tempRoots.length = 0;
});

const oneByonePixelJpegBase64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwA/wD/Z";

const setupRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-inbox-test-"));
  tempRoots.push(root);
  await mkdir(getToSellRoot(root), { recursive: true });
  return root;
};

describe("sanitizeSessionId", () => {
  it("usa default quando undefined", () => {
    expect(sanitizeSessionId(undefined)).toBe(DEFAULT_SESSION_ID);
  });

  it("accetta id alfanumerici, _ e -", () => {
    expect(sanitizeSessionId("abc-123_def")).toBe("abc-123_def");
  });

  it("rifiuta id con caratteri non sicuri", () => {
    const matcher = expect.objectContaining({ code: "INBOX_SESSION_INVALID" });
    expect(() => sanitizeSessionId("../escape")).toThrow(matcher);
    expect(() => sanitizeSessionId("with space")).toThrow(matcher);
    expect(() => sanitizeSessionId("a/b")).toThrow(matcher);
    expect(() => sanitizeSessionId("")).toThrow(matcher);
  });
});

describe("saveInboxPhoto", () => {
  it("salva una foto e auto-genera filename con estensione corretta", async () => {
    const root = await setupRoot();
    const session = getInboxSession(getToSellRoot(root), "test-session");
    const result = await saveInboxPhoto(session, {
      bytesBase64: oneByonePixelJpegBase64,
      mime: "image/jpeg"
    });

    expect(result.filename).toMatch(/^photo-\d+\.jpg$/);
    expect(result.totalPhotos).toBe(1);
    expect(result.bytes).toBeGreaterThan(0);

    const stored = await readFile(result.photoPath);
    expect(stored.length).toBe(result.bytes);
  });

  it("rifiuta MIME non supportato", async () => {
    const root = await setupRoot();
    const session = getInboxSession(getToSellRoot(root), "test-session");
    await expect(
      saveInboxPhoto(session, { bytesBase64: oneByonePixelJpegBase64, mime: "image/webp" })
    ).rejects.toMatchObject({ code: "INBOX_PHOTO_MIME_UNSUPPORTED" });
  });

  it("rifiuta filename con caratteri non sicuri", async () => {
    const root = await setupRoot();
    const session = getInboxSession(getToSellRoot(root), "test-session");
    await expect(
      saveInboxPhoto(session, {
        bytesBase64: oneByonePixelJpegBase64,
        mime: "image/jpeg",
        filename: "file with space.jpg"
      })
    ).rejects.toMatchObject({ code: "INBOX_PHOTO_FILENAME_INVALID" });
  });

  it("neutralizza tentativi di path traversal nel filename", async () => {
    const root = await setupRoot();
    const session = getInboxSession(getToSellRoot(root), "test-session");
    const result = await saveInboxPhoto(session, {
      bytesBase64: oneByonePixelJpegBase64,
      mime: "image/jpeg",
      filename: "../escape.jpg"
    });
    expect(result.filename).toBe("escape.jpg");
    expect(result.photoPath).toBe(path.join(session.photosDir, "escape.jpg"));
  });

  it("aggiunge estensione mancante al filename custom", async () => {
    const root = await setupRoot();
    const session = getInboxSession(getToSellRoot(root), "test-session");
    const result = await saveInboxPhoto(session, {
      bytesBase64: oneByonePixelJpegBase64,
      mime: "image/jpeg",
      filename: "copertina"
    });
    expect(result.filename).toBe("copertina.jpg");
  });

  it("rifiuta base64 vuoto", async () => {
    const root = await setupRoot();
    const session = getInboxSession(getToSellRoot(root), "test-session");
    await expect(
      saveInboxPhoto(session, { bytesBase64: "", mime: "image/jpeg" })
    ).rejects.toMatchObject({ code: "INBOX_PHOTO_EMPTY" });
  });
});

describe("purgeStaleInboxSessions", () => {
  it("rimuove session_id piu' vecchi del TTL e lascia gli altri", async () => {
    const root = await setupRoot();
    const inboxRoot = getInboxRoot(getToSellRoot(root));
    await mkdir(path.join(inboxRoot, "old"), { recursive: true });
    await mkdir(path.join(inboxRoot, "fresh"), { recursive: true });

    const now = Date.now();
    const oldDate = new Date(now - 48 * 60 * 60 * 1000);
    const freshDate = new Date(now - 60 * 1000);
    await utimes(path.join(inboxRoot, "old"), oldDate, oldDate);
    await utimes(path.join(inboxRoot, "fresh"), freshDate, freshDate);

    const result = await purgeStaleInboxSessions(getToSellRoot(root), 24 * 60 * 60 * 1000, now);
    expect(result.purged).toEqual(["old"]);

    const remaining = await readdir(inboxRoot);
    expect(remaining.sort()).toEqual(["fresh"]);
  });

  it("non fallisce se l'inbox root non esiste", async () => {
    const root = await setupRoot();
    const result = await purgeStaleInboxSessions(getToSellRoot(root));
    expect(result.purged).toEqual([]);
  });
});

describe("promoteInboxToListing", () => {
  it("rinomina la cartella inbox sotto lo slug richiesto", async () => {
    const root = await setupRoot();
    const toSell = getToSellRoot(root);
    const session = getInboxSession(toSell, "tg-1234");
    await mkdir(session.photosDir, { recursive: true });
    await writeFile(path.join(session.photosDir, "p.jpg"), "x");

    const promoted = await promoteInboxToListing(toSell, "tg-1234", "il-mio-libro");
    expect(promoted.slug).toBe("il-mio-libro");
    expect(await stat(promoted.dir)).toBeTruthy();
  });

  it("risolve collisioni di slug con suffisso numerico", async () => {
    const root = await setupRoot();
    const toSell = getToSellRoot(root);
    await mkdir(path.join(toSell, "collide"), { recursive: true });

    const session = getInboxSession(toSell, "tg-1");
    await mkdir(session.photosDir, { recursive: true });
    await writeFile(path.join(session.photosDir, "p.jpg"), "x");

    const promoted = await promoteInboxToListing(toSell, "tg-1", "collide");
    expect(promoted.slug).toBe("collide-2");
  });

  it("fallisce se la session non esiste", async () => {
    const root = await setupRoot();
    await expect(promoteInboxToListing(getToSellRoot(root), "missing", "x")).rejects.toMatchObject({
      code: "INBOX_SESSION_NOT_FOUND"
    });
  });
});
