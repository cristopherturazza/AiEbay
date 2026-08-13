import { describe, expect, it } from "vitest";
import { deriveDraftShippingProfile, looksLikeBookDraft } from "../src/shipping/book-logistics.js";
import type { Draft } from "../src/types.js";

const makeDraft = (overrides: Partial<Draft> = {}): Draft =>
  ({
    title: "Titolo",
    description: "Descrizione",
    condition: "USED_GOOD",
    price: { target: 10, currency: "EUR" },
    category_hint: "Titolo",
    item_specifics: {},
    ...overrides
  }) as Draft;

describe("looksLikeBookDraft", () => {
  it("recognises a draft whose specifics use the Italian aspect names", () => {
    const draft = makeDraft({
      title: "Matteo Strukul - 2 Romanzi storici: Paolo & Francesca + Marianna Monaca di Monza",
      category_hint: "Matteo Strukul - 2 Romanzi storici",
      item_specifics: {
        Autore: "Matteo Strukul",
        Editore: "Nord Sud Edizioni",
        Formato: "Rilegatura flessibile"
      }
    });

    expect(looksLikeBookDraft(draft)).toBe(true);
  });

  it("still recognises the legacy English aspect names", () => {
    const draft = makeDraft({
      item_specifics: { Author: "Winston Graham", Publisher: "Marsilio" }
    });

    expect(looksLikeBookDraft(draft)).toBe(true);
  });

  it("does not classify an unrelated item as a book", () => {
    const draft = makeDraft({
      title: "Lampada da tavolo vintage",
      category_hint: "lampada da tavolo",
      item_specifics: { Colore: "Ottone", Materiale: "Metallo" }
    });

    expect(looksLikeBookDraft(draft)).toBe(false);
  });
});

describe("deriveDraftShippingProfile", () => {
  it("resolves book_heavy for a multi-book bundle with Italian specifics", () => {
    const draft = makeDraft({
      title: "Matteo Strukul - 2 Romanzi storici: Paolo & Francesca + Marianna Monaca di Monza",
      category_hint: "Matteo Strukul - 2 Romanzi storici",
      item_specifics: { Autore: "Matteo Strukul", Editore: "Nord Sud Edizioni" },
      shipping: { thickness_cm: 4.5, weight_g: 650, binding: "paperback" }
    });

    expect(deriveDraftShippingProfile(draft)).toBe("book_heavy");
  });

  it("keeps an explicit shipping_profile untouched", () => {
    const draft = makeDraft({
      shipping_profile: "book",
      item_specifics: { Autore: "Tizio" },
      shipping: { thickness_cm: 9, weight_g: 2000 }
    });

    expect(deriveDraftShippingProfile(draft)).toBe("book");
  });
});
