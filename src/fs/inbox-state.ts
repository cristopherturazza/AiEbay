import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getInboxRoot } from "./inbox.js";

export const INBOX_STATE_FILE = ".session-state.json";
export const RECENT_PROMOTION_TTL_MS = 60 * 60 * 1000;

const recentPromotionSchema = z.object({
  slug: z.string().min(1),
  title: z.string(),
  promoted_at: z.string()
});

const inboxStateSchema = z.object({
  promotions: z.record(z.string(), recentPromotionSchema).default({})
});

export type RecentPromotion = z.infer<typeof recentPromotionSchema>;
export type InboxState = z.infer<typeof inboxStateSchema>;

const getStatePath = (toSellRoot: string): string =>
  path.join(getInboxRoot(toSellRoot), INBOX_STATE_FILE);

const readState = async (toSellRoot: string): Promise<InboxState> => {
  const file = getStatePath(toSellRoot);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { promotions: {} };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { promotions: {} };
  }
  const result = inboxStateSchema.safeParse(parsed);
  if (!result.success) {
    return { promotions: {} };
  }
  return result.data;
};

const writeState = async (toSellRoot: string, state: InboxState): Promise<void> => {
  const file = getStatePath(toSellRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
};

export const recordRecentPromotion = async (
  toSellRoot: string,
  sessionId: string,
  promotion: RecentPromotion
): Promise<void> => {
  const state = await readState(toSellRoot);
  state.promotions[sessionId] = promotion;
  await writeState(toSellRoot, state);
};

export interface RecentPromotionLookup {
  promotion: RecentPromotion;
  age_ms: number;
}

export const getRecentPromotion = async (
  toSellRoot: string,
  sessionId: string,
  ttlMs: number = RECENT_PROMOTION_TTL_MS,
  now: number = Date.now()
): Promise<RecentPromotionLookup | null> => {
  const state = await readState(toSellRoot);
  const entry = state.promotions[sessionId];
  if (!entry) {
    return null;
  }
  const promotedAt = Date.parse(entry.promoted_at);
  if (Number.isNaN(promotedAt)) {
    return null;
  }
  const age = now - promotedAt;
  if (age > ttlMs) {
    return null;
  }
  return { promotion: entry, age_ms: age };
};

export const clearRecentPromotion = async (
  toSellRoot: string,
  sessionId: string
): Promise<boolean> => {
  const state = await readState(toSellRoot);
  if (!(sessionId in state.promotions)) {
    return false;
  }
  delete state.promotions[sessionId];
  await writeState(toSellRoot, state);
  return true;
};

export const removeStalePromotions = async (
  toSellRoot: string,
  ttlMs: number = RECENT_PROMOTION_TTL_MS,
  now: number = Date.now()
): Promise<string[]> => {
  const state = await readState(toSellRoot);
  const removed: string[] = [];
  for (const [sessionId, entry] of Object.entries(state.promotions)) {
    const promotedAt = Date.parse(entry.promoted_at);
    if (Number.isNaN(promotedAt) || now - promotedAt > ttlMs) {
      removed.push(sessionId);
      delete state.promotions[sessionId];
    }
  }
  if (removed.length > 0) {
    await writeState(toSellRoot, state);
  }
  return removed;
};
