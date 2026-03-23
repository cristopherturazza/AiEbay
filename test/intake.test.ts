import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveListing } from "../src/fs/listings.js";
import { buildListingIntakeReport } from "../src/intake/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.map((dir) => rm(dir, { recursive: true, force: true })));
  temporaryRoots.length = 0;
});

describe("listing intake", () => {
  it("uses the search-first pricing strategy for books when the new price is known", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-intake-test-"));
    temporaryRoots.push(root);

    const listingDir = path.join(root, "ToSell", "book-pricing");
    const photosDir = path.join(listingDir, "photos");
    await mkdir(photosDir, { recursive: true });

    await writeFile(path.join(photosDir, "front.heic"), "x");
    await writeFile(
      path.join(listingDir, "draft.json"),
      JSON.stringify(
        {
          title: "Libro test",
          description: "Libro test.",
          condition: "Like New",
          price: {
            target: 12,
            quick_sale: 10.8,
            floor: 9.6,
            currency: "EUR"
          },
          category_hint: "libri saggistica",
          item_specifics: {
            Author: "Mario Rossi",
            ISBN: "9788800000001"
          }
        },
        null,
        2
      )
    );
    await writeFile(
      path.join(listingDir, "notes.txt"),
      ["Titolo: Libro test", "Autore: Mario Rossi", "Prezzo del nuovo: 20", "Condizione: Come nuovo"].join("\n")
    );

    const listing = await resolveListing(path.join(root, "ToSell"), "book-pricing");
    const result = await buildListingIntakeReport(listing, { moduleId: "book" });

    expect(result.report.profile).toBe("book");
    expect(result.report.pricing.reference_new_price).toBe(20);
    expect(result.report.pricing.discount_percent).toBe(20);
    expect(result.report.pricing.suggested_target).toBe(16);
    expect(result.report.pricing.suggested_quick_sale).toBe(14.4);
    expect(result.report.pricing.suggested_floor).toBe(12.8);
  });

  it("asks for web search first and user fallback when the new price is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-intake-test-"));
    temporaryRoots.push(root);

    const listingDir = path.join(root, "ToSell", "book-missing-price");
    const photosDir = path.join(listingDir, "photos");
    await mkdir(photosDir, { recursive: true });

    await writeFile(path.join(photosDir, "front.heic"), "x");
    await writeFile(
      path.join(listingDir, "draft.json"),
      JSON.stringify(
        {
          title: "Il potere di adesso",
          description: "Libro test.",
          condition: "Like New",
          price: {
            target: 14,
            quick_sale: 12.6,
            floor: 11.2,
            currency: "EUR"
          },
          category_hint: "libri spiritualita",
          item_specifics: {
            Author: "Eckhart Tolle"
          }
        },
        null,
        2
      )
    );
    await writeFile(
      path.join(listingDir, "notes.txt"),
      ["Titolo: Il potere di adesso", "Autore: Eckhart Tolle", "Condizione: Come nuovo"].join("\n")
    );

    const listing = await resolveListing(path.join(root, "ToSell"), "book-missing-price");
    const result = await buildListingIntakeReport(listing, { moduleId: "book" });

    expect(result.report.pricing.ready).toBe(false);
    expect(result.report.pricing.missing_inputs).toContain("reference_new_price");
    expect(result.report.summary.search_first).toContain("reference_new_price");
    expect(result.report.summary.ask_user).toContain("reference_new_price");
  });

  it("asks the user for shipping measurements when the book profile is not inferable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-intake-test-"));
    temporaryRoots.push(root);

    const listingDir = path.join(root, "ToSell", "book-shipping-missing");
    const photosDir = path.join(listingDir, "photos");
    await mkdir(photosDir, { recursive: true });

    await writeFile(path.join(photosDir, "front.heic"), "x");
    await writeFile(
      path.join(listingDir, "draft.json"),
      JSON.stringify(
        {
          title: "Libro senza misure",
          description: "Libro test.",
          condition: "Like New",
          price: {
            target: 11,
            quick_sale: 9.9,
            floor: 8.8,
            currency: "EUR"
          },
          category_hint: "libri saggistica",
          item_specifics: {
            Author: "Mario Rossi"
          }
        },
        null,
        2
      )
    );
    await writeFile(
      path.join(listingDir, "notes.txt"),
      ["Titolo: Libro senza misure", "Autore: Mario Rossi", "Condizione: Come nuovo"].join("\n")
    );

    const listing = await resolveListing(path.join(root, "ToSell"), "book-shipping-missing");
    const result = await buildListingIntakeReport(listing, { moduleId: "book" });

    expect(result.report.summary.ask_user).toContain("weight_g");
    expect(result.report.summary.ask_user).toContain("thickness_cm");
    expect(result.report.summary.publish_blockers).toContain("shipping_profile");
  });

  it("infers book_heavy when thickness exceeds the standard shipping profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-intake-test-"));
    temporaryRoots.push(root);

    const listingDir = path.join(root, "ToSell", "book-heavy");
    const photosDir = path.join(listingDir, "photos");
    await mkdir(photosDir, { recursive: true });

    await writeFile(path.join(photosDir, "front.heic"), "x");
    await writeFile(
      path.join(listingDir, "draft.json"),
      JSON.stringify(
        {
          title: "Enciclopedia",
          description: "Volume importante.",
          condition: "Used",
          shipping: {
            thickness_cm: 3.4,
            pages: 640,
            binding: "paperback"
          },
          price: {
            target: 16,
            quick_sale: 14.4,
            floor: 12.8,
            currency: "EUR"
          },
          category_hint: "libri reference",
          item_specifics: {
            Author: "Mario Rossi",
            Pages: "640"
          }
        },
        null,
        2
      )
    );
    await writeFile(
      path.join(listingDir, "notes.txt"),
      ["Titolo: Enciclopedia", "Autore: Mario Rossi", "Spessore: 3.4 cm", "Pagine: 640"].join("\n")
    );

    const listing = await resolveListing(path.join(root, "ToSell"), "book-heavy");
    const result = await buildListingIntakeReport(listing, { moduleId: "book" });
    const shippingField = result.report.fields.find((field) => field.field === "shipping_profile");

    expect(shippingField?.value).toBe("book_heavy");
    expect(result.report.summary.ask_user).not.toContain("weight_g");
    expect(result.report.summary.publish_blockers).not.toContain("shipping_profile");
  });
});
