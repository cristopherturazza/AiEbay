import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getToSellRoot,
  listListingFolders,
  listPhotoFiles,
  readDraft,
  resolveListing
} from "../src/fs/listings.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryRoots.map((dir) => rm(dir, { recursive: true, force: true })));
  temporaryRoots.length = 0;
});

describe("listings filesystem", () => {
  it("elenca cartelle listing dentro ToSell", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-test-"));
    temporaryRoots.push(root);

    const toSellPath = getToSellRoot(root);
    await mkdir(path.join(toSellPath, "item-a", "photos"), { recursive: true });
    await mkdir(path.join(toSellPath, "item-b", "photos"), { recursive: true });

    const listings = await listListingFolders(toSellPath);

    expect(listings.map((entry) => entry.slug)).toEqual(["item-a", "item-b"]);
  });

  it("esclude la cartella riservata _inbox dalle listing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-test-"));
    temporaryRoots.push(root);

    const toSellPath = getToSellRoot(root);
    await mkdir(path.join(toSellPath, "item-a", "photos"), { recursive: true });
    await mkdir(path.join(toSellPath, "_inbox", "tg-1", "photos"), { recursive: true });

    const listings = await listListingFolders(toSellPath);
    expect(listings.map((entry) => entry.slug)).toEqual(["item-a"]);
  });

  it("resolveListing trova la listing tramite slug normalizzato", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-test-"));
    temporaryRoots.push(root);

    const toSellPath = getToSellRoot(root);
    await mkdir(path.join(toSellPath, "elois-darcy-non-specificato"), { recursive: true });

    const fromUnicodeHyphens = await resolveListing(
      toSellPath,
      "Elois‑Darcy‑Non‑Specificato"
    );
    expect(fromUnicodeHyphens.slug).toBe("elois-darcy-non-specificato");

    const fromMixedCase = await resolveListing(toSellPath, "Elois Darcy Non Specificato");
    expect(fromMixedCase.slug).toBe("elois-darcy-non-specificato");
  });

  it("resolveListing rifiuta la cartella riservata _inbox", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-test-"));
    temporaryRoots.push(root);

    const toSellPath = getToSellRoot(root);
    await mkdir(path.join(toSellPath, "_inbox"), { recursive: true });

    await expect(resolveListing(toSellPath, "_inbox")).rejects.toMatchObject({
      code: "LISTING_RESERVED"
    });
  });

  it("considera solo immagini jpg/jpeg/png/heic", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-test-"));
    temporaryRoots.push(root);

    const photosDir = path.join(root, "photos");
    await mkdir(photosDir, { recursive: true });
    await writeFile(path.join(photosDir, "a.jpg"), "x");
    await writeFile(path.join(photosDir, "b.jpeg"), "x");
    await writeFile(path.join(photosDir, "c.png"), "x");
    await writeFile(path.join(photosDir, "d.heic"), "x");
    await writeFile(path.join(photosDir, "d.webp"), "x");

    const photos = await listPhotoFiles(photosDir);

    expect(photos).toEqual(["a.jpg", "b.jpeg", "c.png", "d.heic"]);
  });

  it("normalizza gli errori di draft non valido", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-test-"));
    temporaryRoots.push(root);

    const draftPath = path.join(root, "draft.json");
    await writeFile(
      draftPath,
      JSON.stringify(
        {
          title: "Titolo test"
        },
        null,
        2
      )
    );

    await expect(readDraft(draftPath)).rejects.toMatchObject({
      code: "DRAFT_INVALID"
    });
  });
});
