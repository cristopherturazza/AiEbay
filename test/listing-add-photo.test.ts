import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../src/config.js";
import { getInboxSession, saveInboxPhoto } from "../src/fs/inbox.js";
import { getToSellRoot } from "../src/fs/listings.js";
import { addPhotoToListing, adoptInboxPhotosToListing } from "../src/services/listing-add-photo.js";

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
  const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-add-photo-"));
  tempRoots.push(root);
  process.chdir(root);
  return root;
};

const seedListing = async (root: string, slug: string): Promise<string> => {
  const slugDir = path.join(getToSellRoot(root), slug);
  await mkdir(path.join(slugDir, "photos"), { recursive: true });
  return slugDir;
};

describe.sequential("addPhotoToListing", () => {
  it("aggiunge una foto alla cartella photos/ della listing", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);
    const slugDir = await seedListing(root, "il-libro");
    await writeFile(path.join(slugDir, "photos", "fronte.jpg"), "x");

    const result = await addPhotoToListing(config, "il-libro", {
      bytesBase64: oneByonePixelJpegBase64,
      mime: "image/jpeg",
      filename: "retro.jpg"
    });

    expect(result.slug).toBe("il-libro");
    expect(result.filename).toBe("retro.jpg");
    expect(result.totalPhotos).toBe(2);
    const files = await readdir(path.join(slugDir, "photos"));
    expect(files.sort()).toEqual(["fronte.jpg", "retro.jpg"]);
  });

  it("fallisce su slug inesistente", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);
    await expect(
      addPhotoToListing(config, "ghost", { bytesBase64: oneByonePixelJpegBase64, mime: "image/jpeg" })
    ).rejects.toMatchObject({ code: "LISTING_NOT_FOUND" });
  });
});

describe.sequential("adoptInboxPhotosToListing", () => {
  it("sposta tutte le foto dell'inbox nella listing e ripulisce la sessione", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);
    const slugDir = await seedListing(root, "il-libro");
    await writeFile(path.join(slugDir, "photos", "copertina.jpg"), "x");

    const session = getInboxSession(getToSellRoot(root), "tg-1");
    await saveInboxPhoto(session, {
      bytesBase64: oneByonePixelJpegBase64,
      mime: "image/jpeg",
      filename: "back.jpg"
    });
    await saveInboxPhoto(session, {
      bytesBase64: oneByonePixelJpegBase64,
      mime: "image/jpeg",
      filename: "spine.jpg"
    });

    const result = await adoptInboxPhotosToListing(config, "il-libro", "tg-1");
    expect(result.moved_filenames.sort()).toEqual(["back.jpg", "spine.jpg"]);
    expect(result.total_photos_after).toBe(3);

    const listingFiles = await readdir(path.join(slugDir, "photos"));
    expect(listingFiles.sort()).toEqual(["back.jpg", "copertina.jpg", "spine.jpg"]);

    await expect(readdir(session.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rinomina con suffisso in caso di collisione", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);
    const slugDir = await seedListing(root, "il-libro");
    await writeFile(path.join(slugDir, "photos", "back.jpg"), "x");

    const session = getInboxSession(getToSellRoot(root), "tg-2");
    await saveInboxPhoto(session, {
      bytesBase64: oneByonePixelJpegBase64,
      mime: "image/jpeg",
      filename: "back.jpg"
    });

    const result = await adoptInboxPhotosToListing(config, "il-libro", "tg-2");
    expect(result.moved_filenames).toEqual(["back-1.jpg"]);
    const listingFiles = await readdir(path.join(slugDir, "photos"));
    expect(listingFiles.sort()).toEqual(["back-1.jpg", "back.jpg"]);
  });

  it("fallisce con INBOX_EMPTY se la sessione non esiste", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);
    await seedListing(root, "il-libro");
    await expect(
      adoptInboxPhotosToListing(config, "il-libro", "missing")
    ).rejects.toMatchObject({ code: "INBOX_EMPTY" });
  });

  it("fallisce con INBOX_EMPTY se la sessione esiste ma e' vuota", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);
    await seedListing(root, "il-libro");
    const session = getInboxSession(getToSellRoot(root), "empty");
    await mkdir(session.photosDir, { recursive: true });
    await expect(
      adoptInboxPhotosToListing(config, "il-libro", "empty")
    ).rejects.toMatchObject({ code: "INBOX_EMPTY" });
  });

  it("fallisce con LISTING_NOT_FOUND su slug inesistente", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);
    const session = getInboxSession(getToSellRoot(root), "tg-3");
    await saveInboxPhoto(session, { bytesBase64: oneByonePixelJpegBase64, mime: "image/jpeg" });
    await expect(
      adoptInboxPhotosToListing(config, "ghost", "tg-3")
    ).rejects.toMatchObject({ code: "LISTING_NOT_FOUND" });
  });
});
