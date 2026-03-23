import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveListing } from "../src/fs/listings.js";
import { generateListingEnrichment } from "../src/enrichment/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.map((dir) => rm(dir, { recursive: true, force: true })));
  temporaryRoots.length = 0;
});

describe("listing enrichment", () => {
  it("routes book-like listings to the book module in auto mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-enrich-test-"));
    temporaryRoots.push(root);

    const listingDir = path.join(root, "ToSell", "proust-swann");
    const photosDir = path.join(listingDir, "photos");
    await mkdir(photosDir, { recursive: true });

    await writeFile(path.join(photosDir, "front.heic"), "x");
    await writeFile(path.join(photosDir, "isbn.jpg"), "x");
    await writeFile(
      path.join(listingDir, "notes.txt"),
      [
        "Titolo: Dalla parte di Swann",
        "Autore: Marcel Proust",
        "Editore: Mondadori",
        "Anno: 1998",
        "Lingua: Italiano",
        "Formato: Brossura",
        "ISBN: 9788804470001",
        "Argomento: narrativa"
      ].join("\n")
    );

    const listing = await resolveListing(path.join(root, "ToSell"), "proust-swann");
    const result = await generateListingEnrichment(listing, { moduleId: "auto" });

    expect(result.moduleId).toBe("book");
    expect(result.report.module).toBe("book");
    expect(result.report.extracted.isbn).toBe("9788804470001");
    expect(result.draft.title).toBe("Dalla parte di Swann");
    expect(result.draft.shipping_profile).toBe("book");
    expect(result.draft.category_hint).toBe("libri narrativa");
    expect(result.draft.item_specifics.Author).toBe("Marcel Proust");
    expect(result.draft.item_specifics.ISBN).toBe("9788804470001");
    expect(result.draft.item_specifics.Subtitle).toBeUndefined();
    expect(result.draft.item_specifics.Language).toBe("Italiano");
    expect(result.draft.price.currency).toBe("EUR");
    expect(result.draft.price.target).toBe(14);
  });

  it("falls back to generic for non-book listings in auto mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-enrich-test-"));
    temporaryRoots.push(root);

    const listingDir = path.join(root, "ToSell", "nike-shoes");
    const photosDir = path.join(listingDir, "photos");
    await mkdir(photosDir, { recursive: true });

    await writeFile(path.join(photosDir, "front.jpg"), "x");
    await writeFile(path.join(listingDir, "notes.txt"), "Scarpe running Nike nere numero 42\nPrezzo 45");

    const listing = await resolveListing(path.join(root, "ToSell"), "nike-shoes");
    const result = await generateListingEnrichment(listing, { moduleId: "auto" });

    expect(result.moduleId).toBe("generic");
    expect(result.report.module).toBe("generic");
  });

  it("does not mark books as new just because the author surname contains 'New'", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-enrich-test-"));
    temporaryRoots.push(root);

    const listingDir = path.join(root, "ToSell", "cal-newport");
    const photosDir = path.join(listingDir, "photos");
    await mkdir(photosDir, { recursive: true });

    await writeFile(path.join(photosDir, "front.heic"), "x");
    await writeFile(
      path.join(listingDir, "notes.txt"),
      [
        "Titolo: Così bravo che non potranno ignorarti",
        "Autore: Cal Newport",
        "Editore: ROI Edizioni",
        "Lingua: Italiano",
        "Argomento: carriera"
      ].join("\n")
    );

    const listing = await resolveListing(path.join(root, "ToSell"), "cal-newport");
    const result = await generateListingEnrichment(listing, { moduleId: "book" });

    expect(result.draft.condition).toBe("Used");
  });

  it("extracts subtitle when present in notes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-enrich-test-"));
    temporaryRoots.push(root);

    const listingDir = path.join(root, "ToSell", "anthony-robbins");
    const photosDir = path.join(listingDir, "photos");
    await mkdir(photosDir, { recursive: true });

    await writeFile(path.join(photosDir, "front.heic"), "x");
    await writeFile(
      path.join(listingDir, "notes.txt"),
      [
        "Titolo: Come ottenere il meglio da sé e dagli altri",
        "Sottotitolo: Il manuale del successo nella vita e nel lavoro",
        "Autore: Anthony Robbins",
        "Editore: Bompiani",
        "Lingua: Italiano",
        "Argomento: crescita personale"
      ].join("\n")
    );

    const listing = await resolveListing(path.join(root, "ToSell"), "anthony-robbins");
    const result = await generateListingEnrichment(listing, { moduleId: "book" });

    expect(result.draft.item_specifics.Subtitle).toBeUndefined();
    expect(result.draft.description).toContain("Sottotitolo: Il manuale del successo nella vita e nel lavoro");
    expect(result.report.extracted.subtitle).toBe("Il manuale del successo nella vita e nel lavoro");
  });

  it("maps 'come nuovo' book notes to Like New", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-enrich-test-"));
    temporaryRoots.push(root);

    const listingDir = path.join(root, "ToSell", "like-new-book");
    const photosDir = path.join(listingDir, "photos");
    await mkdir(photosDir, { recursive: true });

    await writeFile(path.join(photosDir, "front.heic"), "x");
    await writeFile(
      path.join(listingDir, "notes.txt"),
      [
        "Titolo: Test",
        "Autore: Mario Rossi",
        "Condizione: Come nuovo"
      ].join("\n")
    );

    const listing = await resolveListing(path.join(root, "ToSell"), "like-new-book");
    const result = await generateListingEnrichment(listing, { moduleId: "book" });

    expect(result.draft.condition).toBe("Like New");
  });

  it("omits internal note echoes and photo file names from book descriptions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-enrich-test-"));
    temporaryRoots.push(root);

    const listingDir = path.join(root, "ToSell", "clean-description");
    const photosDir = path.join(listingDir, "photos");
    await mkdir(photosDir, { recursive: true });

    await writeFile(path.join(photosDir, "IMG_0001.HEIC"), "x");
    await writeFile(
      path.join(listingDir, "notes.txt"),
      [
        "Titolo: Libro test",
        "Autore: Mario Rossi",
        "Note: copia in condizioni perfette"
      ].join("\n")
    );

    const listing = await resolveListing(path.join(root, "ToSell"), "clean-description");
    const result = await generateListingEnrichment(listing, { moduleId: "book" });

    expect(result.draft.description).not.toContain("Foto disponibili");
    expect(result.draft.description).not.toContain("IMG_0001.HEIC");
    expect(result.draft.description).not.toContain("Note:");
  });
});
