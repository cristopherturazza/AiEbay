import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../src/config.js";
import { getToSellRoot } from "../src/fs/listings.js";
import { deleteListing } from "../src/services/listing-delete.js";

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
});
