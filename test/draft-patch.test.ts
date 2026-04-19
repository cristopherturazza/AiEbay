import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../src/config.js";
import { defaultEbayBaseUrls } from "../src/ebay/urls.js";
import { patchDraft, patchListingDraft } from "../src/services/draft-patch.js";
import type { Draft } from "../src/types.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.map((dir) => rm(dir, { recursive: true, force: true })));
  temporaryRoots.length = 0;
});

const makeConfig = (cwd: string): RuntimeConfig => {
  const defaults = defaultEbayBaseUrls("sandbox");

  return {
    cwd,
    ebayEnv: "sandbox",
    ebayClientId: undefined,
    ebayClientSecret: undefined,
    ebayRuname: undefined,
    ebayCallbackUrl: undefined,
    ebayScopes: [],
    ebayMarketplaceId: "EBAY_IT",
    sellbotPort: 3000,
    ebayAuthBaseUrl: defaults.authBaseUrl,
    ebayApiBaseUrl: defaults.apiBaseUrl,
    ebayMediaBaseUrl: defaults.mediaBaseUrl,
    locale: "it-IT",
    notificationEndpointUrl: undefined,
    notificationVerificationToken: undefined,
    merchantLocationKey: undefined,
    shippingProfiles: undefined,
    policies: {},
    ollama: {
      baseUrl: "http://127.0.0.1:11434",
      visionModel: "gemma4:e4b",
      visionKeepAlive: "60s",
      visionTimeoutMs: 120_000
    }
  };
};

const baseDraft = (): Draft => ({
  title: "Libro test",
  description: "Descrizione iniziale",
  shipping_profile: "book_heavy",
  shipping: {
    weight_g: 500,
    thickness_cm: 3,
    pages: 280,
    binding: "paperback"
  },
  condition: "Like New",
  price: {
    target: 10,
    quick_sale: 9,
    floor: 8,
    currency: "EUR"
  },
  category_hint: "libri business",
  category_id: "12345",
  item_specifics: {
    Author: "Anthony Robbins",
    ISBN: "9788845297540",
    Topic: "finanza personale"
  }
});

describe("draft patch", () => {
  it("ricalcola la price ladder e aggiorna item specifics in modo strutturato", () => {
    const next = patchDraft(baseDraft(), {
      price: { target: 9.9 },
      title: "Soldi. Domina il gioco",
      recalculatePriceLadder: true,
      itemSpecificsSet: {
        Publisher: "Bompiani"
      },
      itemSpecificsRemove: ["Topic"]
    });

    expect(next.title).toBe("Soldi. Domina il gioco");
    expect(next.price).toEqual({
      target: 9.9,
      quick_sale: 8.91,
      floor: 7.92,
      currency: "EUR"
    });
    expect(next.item_specifics).toEqual({
      Author: "Anthony Robbins",
      ISBN: "9788845297540",
      Publisher: "Bompiani"
    });
  });

  it("persiste la patch su draft.json e consente clear di campi opzionali", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-draft-patch-"));
    temporaryRoots.push(root);

    const listingDir = path.join(root, "ToSell", "book-item");
    await mkdir(path.join(listingDir, "photos"), { recursive: true });
    await writeFile(path.join(listingDir, "draft.json"), JSON.stringify(baseDraft(), null, 2));

    const result = await patchListingDraft(
      "book-item",
      {
        shippingProfile: "book",
        clearCategoryId: true,
        clearShipping: true,
        description: "Descrizione aggiornata",
        shipping: {
          thickness_cm: 2.4
        }
      },
      makeConfig(root)
    );

    expect(result.draft.shipping_profile).toBe("book");
    expect(result.draft.category_id).toBeUndefined();
    expect(result.draft.shipping).toBeUndefined();

    const persisted = JSON.parse(await readFile(path.join(listingDir, "draft.json"), "utf8"));
    expect(persisted.description).toBe("Descrizione aggiornata");
    expect(persisted.shipping_profile).toBe("book");
    expect(persisted.category_id).toBeUndefined();
    expect(persisted.shipping).toBeUndefined();
  });
});
