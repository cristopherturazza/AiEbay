import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../src/config.js";
import { getInboxSession, saveInboxPhoto } from "../src/fs/inbox.js";
import { getRecentPromotion } from "../src/fs/inbox-state.js";
import { getToSellRoot } from "../src/fs/listings.js";
import { createListingFromInbox } from "../src/services/listing-create-from-inbox.js";

const oneByonePixelJpegBase64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwA/wD/Z";

const tempRoots: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true })));
  tempRoots.length = 0;
});

const setupRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-create-inbox-"));
  tempRoots.push(root);
  process.chdir(root);
  return root;
};

describe.sequential("createListingFromInbox", () => {
  it("promuove l'inbox a listing usando title_override e genera lo slug", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);
    const session = getInboxSession(getToSellRoot(root), "tg-42");
    await saveInboxPhoto(session, { bytesBase64: oneByonePixelJpegBase64, mime: "image/jpeg" });

    const result = await createListingFromInbox(config, {
      sessionId: "tg-42",
      module: "book",
      titleOverride: "Il Nome della Rosa"
    });

    expect(result.slug).toBe("il-nome-della-rosa");
    expect(result.title_used).toBe("Il Nome della Rosa");
    expect(result.title_source).toBe("override");
    expect(result.snapshot.summary.slug).toBe("il-nome-della-rosa");
    expect(result.snapshot.photos.length).toBe(1);
    expect(result.snapshot.draft?.title).toBeTruthy();

    const targetDir = path.join(getToSellRoot(root), "il-nome-della-rosa");
    await expect(stat(targetDir)).resolves.toBeTruthy();
  });

  it("rispetta slug_override e salta vision", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);
    const session = getInboxSession(getToSellRoot(root), "tg-99");
    await saveInboxPhoto(session, { bytesBase64: oneByonePixelJpegBase64, mime: "image/jpeg" });

    const result = await createListingFromInbox(config, {
      sessionId: "tg-99",
      module: "generic",
      slugOverride: "custom-slug-2024"
    });

    expect(result.slug).toBe("custom-slug-2024");
    expect(result.title_source).toBe("slug_override");
    expect(result.vision).toBeNull();
  });

  it("fallisce con INBOX_EMPTY se non ci sono foto", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);

    await expect(
      createListingFromInbox(config, {
        sessionId: "tg-empty",
        titleOverride: "qualcosa"
      })
    ).rejects.toMatchObject({ code: "INBOX_EMPTY" });
  });

  it("rifiuta slug_override non valido", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);
    const session = getInboxSession(getToSellRoot(root), "tg-bad");
    await saveInboxPhoto(session, { bytesBase64: oneByonePixelJpegBase64, mime: "image/jpeg" });

    await expect(
      createListingFromInbox(config, {
        sessionId: "tg-bad",
        slugOverride: "Bad Slug!"
      })
    ).rejects.toMatchObject({ code: "SLUG_INVALID" });
  });

  it("registra una recent_promotion per la sessione promossa", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);
    const session = getInboxSession(getToSellRoot(root), "tg-promo");
    await saveInboxPhoto(session, { bytesBase64: oneByonePixelJpegBase64, mime: "image/jpeg" });

    await createListingFromInbox(config, {
      sessionId: "tg-promo",
      module: "generic",
      titleOverride: "Da Promuovere"
    });

    const lookup = await getRecentPromotion(getToSellRoot(root), "tg-promo");
    expect(lookup).not.toBeNull();
    expect(lookup?.promotion.slug).toBe("da-promuovere");
    expect(lookup?.promotion.title).toBe("Da Promuovere");
  });

  it("risolve collisioni di slug con suffisso numerico", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);

    const sessionA = getInboxSession(getToSellRoot(root), "tg-1");
    await saveInboxPhoto(sessionA, { bytesBase64: oneByonePixelJpegBase64, mime: "image/jpeg" });
    const first = await createListingFromInbox(config, {
      sessionId: "tg-1",
      titleOverride: "Stesso Titolo"
    });
    expect(first.slug).toBe("stesso-titolo");

    const sessionB = getInboxSession(getToSellRoot(root), "tg-2");
    await saveInboxPhoto(sessionB, { bytesBase64: oneByonePixelJpegBase64, mime: "image/jpeg" });
    const second = await createListingFromInbox(config, {
      sessionId: "tg-2",
      titleOverride: "Stesso Titolo"
    });
    expect(second.slug).toBe("stesso-titolo-2");
  });
});
