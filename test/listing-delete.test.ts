import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../src/config.js";
import { getToSellRoot } from "../src/fs/listings.js";
import { deleteListing, deleteListingsBulk } from "../src/services/listing-delete.js";

const tempRoots: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true })));
  tempRoots.length = 0;
});

const setupRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-delete-"));
  tempRoots.push(root);
  process.chdir(root);
  return root;
};

const writeStatus = async (slugDir: string, state: string): Promise<void> => {
  await writeFile(
    path.join(slugDir, "status.json"),
    JSON.stringify(
      {
        state,
        published_at: state === "published" ? new Date().toISOString() : null,
        ebay: { sku: "SKU-1", offer_id: "OFFER-1", listing_id: "LIST-1", url: "https://ebay.it/x" },
        last_error: null
      },
      null,
      2
    ) + "\n"
  );
};

const seedListing = async (root: string, slug: string, status: string | null): Promise<string> => {
  const slugDir = path.join(getToSellRoot(root), slug);
  await mkdir(path.join(slugDir, "photos"), { recursive: true });
  await writeFile(path.join(slugDir, "photos", "a.jpg"), "x");
  if (status) {
    await writeStatus(slugDir, status);
  }
  return slugDir;
};

describe.sequential("deleteListing", () => {
  it("rimuove la cartella della listing in stato draft", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);
    const slugDir = await seedListing(root, "test-1", "draft");

    const result = await deleteListing(config, "test-1");
    expect(result.slug).toBe("test-1");
    expect(result.was_published).toBe(false);
    await expect(stat(slugDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rifiuta listing 'published' senza force", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);
    await seedListing(root, "live-1", "published");

    await expect(deleteListing(config, "live-1")).rejects.toMatchObject({
      code: "LISTING_PUBLISHED"
    });
  });

  it("cancella listing 'published' con force=true", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);
    const slugDir = await seedListing(root, "live-2", "published");

    const result = await deleteListing(config, "live-2", { force: true });
    expect(result.was_published).toBe(true);
    expect(result.ebay_listing_id).toBe("LIST-1");
    await expect(stat(slugDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fallisce con LISTING_NOT_FOUND su slug inesistente", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);
    await expect(deleteListing(config, "ghost")).rejects.toMatchObject({
      code: "LISTING_NOT_FOUND"
    });
  });

  it("rifiuta '_inbox' come slug (LISTING_RESERVED)", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);
    await mkdir(path.join(getToSellRoot(root), "_inbox", "tg-1", "photos"), { recursive: true });

    await expect(deleteListing(config, "_inbox")).rejects.toMatchObject({
      code: "LISTING_RESERVED"
    });
    await expect(stat(path.join(getToSellRoot(root), "_inbox"))).resolves.toBeTruthy();
  });
});

describe.sequential("deleteListingsBulk", () => {
  it("cancella le bozze in stato draft/ready/error e salta published", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);
    await seedListing(root, "draft-1", "draft");
    await seedListing(root, "ready-1", "ready");
    await seedListing(root, "error-1", "error");
    await seedListing(root, "live-1", "published");
    await mkdir(path.join(getToSellRoot(root), "_inbox", "tg-1", "photos"), { recursive: true });

    const result = await deleteListingsBulk(config);
    expect(result.deleted.map((entry) => entry.slug).sort()).toEqual([
      "draft-1",
      "error-1",
      "ready-1"
    ]);
    expect(result.skipped).toEqual([
      { slug: "live-1", state: "published", reason: "published_protected" }
    ]);
    expect(result.total_scanned).toBe(4);

    await expect(stat(path.join(getToSellRoot(root), "draft-1"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(getToSellRoot(root), "live-1"))).resolves.toBeTruthy();
    await expect(stat(path.join(getToSellRoot(root), "_inbox"))).resolves.toBeTruthy();
  });

  it("include published se include_published=true", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);
    await seedListing(root, "draft-1", "draft");
    await seedListing(root, "live-1", "published");

    const result = await deleteListingsBulk(config, { includePublished: true });
    expect(result.deleted.map((entry) => entry.slug).sort()).toEqual(["draft-1", "live-1"]);
    expect(result.skipped).toEqual([]);
  });

  it("rispetta states custom", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);
    await seedListing(root, "draft-1", "draft");
    await seedListing(root, "ready-1", "ready");

    const result = await deleteListingsBulk(config, { states: new Set(["draft"]) });
    expect(result.deleted.map((entry) => entry.slug)).toEqual(["draft-1"]);
    expect(result.skipped).toEqual([
      { slug: "ready-1", state: "ready", reason: "state_excluded" }
    ]);
  });

  it("ritorna deleted vuoto se non ci sono bozze idonee", async () => {
    const root = await setupRoot();
    const config = await loadRuntimeConfig(root);
    await seedListing(root, "live-1", "published");

    const result = await deleteListingsBulk(config);
    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual([
      { slug: "live-1", state: "published", reason: "published_protected" }
    ]);
  });
});
