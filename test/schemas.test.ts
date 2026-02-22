import { describe, expect, it } from "vitest";
import { draftSchema, statusSchema } from "../src/schemas/index.js";

describe("draftSchema", () => {
  it("accetta un draft valido", () => {
    const parsed = draftSchema.parse({
      title: "Nike Air Max 42",
      description: "Scarpe usate in buone condizioni",
      condition: "Used",
      price: {
        target: 45,
        quick_sale: 39,
        floor: 35,
        currency: "EUR"
      },
      category_hint: "scarpe uomo",
      item_specifics: {
        Brand: "Nike",
        "EU Shoe Size": "42"
      }
    });

    expect(parsed.title).toBe("Nike Air Max 42");
  });

  it("rifiuta un draft con currency non valida", () => {
    expect(() =>
      draftSchema.parse({
        title: "Titolo",
        description: "Descrizione",
        condition: "Used",
        price: {
          target: 10,
          currency: "EURO"
        },
        category_hint: "test",
        item_specifics: {}
      })
    ).toThrow();
  });
});

describe("statusSchema", () => {
  it("accetta lo status minimo valido", () => {
    const parsed = statusSchema.parse({
      state: "draft",
      published_at: null,
      ebay: {
        sku: null,
        offer_id: null,
        listing_id: null,
        url: null
      },
      last_error: null
    });

    expect(parsed.state).toBe("draft");
  });

  it("rifiuta uno state sconosciuto", () => {
    expect(() =>
      statusSchema.parse({
        state: "queued",
        published_at: null,
        ebay: {
          sku: null,
          offer_id: null,
          listing_id: null,
          url: null
        },
        last_error: null
      })
    ).toThrow();
  });
});
