import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RECENT_PROMOTION_TTL_MS,
  clearRecentPromotion,
  getRecentPromotion,
  recordRecentPromotion,
  removeStalePromotions
} from "../src/fs/inbox-state.js";
import { getToSellRoot } from "../src/fs/listings.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true })));
  tempRoots.length = 0;
});

const setupRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-inbox-state-"));
  tempRoots.push(root);
  return getToSellRoot(root);
};

describe("inbox state recent promotions", () => {
  it("memorizza e recupera una promozione per session_id", async () => {
    const toSell = await setupRoot();
    await recordRecentPromotion(toSell, "tg-1", {
      slug: "il-libro",
      title: "Il Libro",
      promoted_at: new Date().toISOString()
    });
    const lookup = await getRecentPromotion(toSell, "tg-1");
    expect(lookup).not.toBeNull();
    expect(lookup?.promotion.slug).toBe("il-libro");
    expect(lookup?.age_ms).toBeGreaterThanOrEqual(0);
  });

  it("ritorna null oltre il TTL", async () => {
    const toSell = await setupRoot();
    const promotedAt = new Date(Date.now() - RECENT_PROMOTION_TTL_MS - 60_000).toISOString();
    await recordRecentPromotion(toSell, "tg-old", {
      slug: "scaduta",
      title: "Scaduta",
      promoted_at: promotedAt
    });
    const lookup = await getRecentPromotion(toSell, "tg-old");
    expect(lookup).toBeNull();
  });

  it("ritorna null per session_id senza promozioni", async () => {
    const toSell = await setupRoot();
    expect(await getRecentPromotion(toSell, "missing")).toBeNull();
  });

  it("clearRecentPromotion rimuove l'entry indicata", async () => {
    const toSell = await setupRoot();
    await recordRecentPromotion(toSell, "tg-2", {
      slug: "x",
      title: "X",
      promoted_at: new Date().toISOString()
    });
    expect(await clearRecentPromotion(toSell, "tg-2")).toBe(true);
    expect(await getRecentPromotion(toSell, "tg-2")).toBeNull();
    expect(await clearRecentPromotion(toSell, "tg-2")).toBe(false);
  });

  it("removeStalePromotions pota tutte le entry scadute", async () => {
    const toSell = await setupRoot();
    const stale = new Date(Date.now() - RECENT_PROMOTION_TTL_MS - 1).toISOString();
    const fresh = new Date().toISOString();
    await recordRecentPromotion(toSell, "old", { slug: "a", title: "A", promoted_at: stale });
    await recordRecentPromotion(toSell, "new", { slug: "b", title: "B", promoted_at: fresh });
    const removed = await removeStalePromotions(toSell);
    expect(removed.sort()).toEqual(["old"]);
    expect(await getRecentPromotion(toSell, "new")).not.toBeNull();
  });
});
