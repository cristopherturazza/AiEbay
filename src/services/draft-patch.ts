import { loadRuntimeConfig, type RuntimeConfig } from "../config.js";
import { SellbotError } from "../errors.js";
import { getToSellRoot, readDraft, resolveListing, writeDraft } from "../fs/listings.js";
import { buildPriceTriple } from "../enrichment/shared.js";
import type { Draft } from "../types.js";

export interface DraftPatchInput {
  title?: string;
  description?: string;
  condition?: string;
  shippingProfile?: string;
  clearShippingProfile?: boolean;
  categoryHint?: string;
  categoryId?: string;
  clearCategoryId?: boolean;
  price?: Partial<Draft["price"]>;
  recalculatePriceLadder?: boolean;
  shipping?: Partial<NonNullable<Draft["shipping"]>>;
  clearShipping?: boolean;
  itemSpecificsSet?: Record<string, string>;
  itemSpecificsRemove?: string[];
}

const normalizeStringRecord = (value: Record<string, string> | undefined): Record<string, string> | undefined => {
  if (!value) {
    return undefined;
  }

  const normalized = Object.entries(value).reduce<Record<string, string>>((acc, [rawKey, rawValue]) => {
    const key = rawKey.trim();
    const nextValue = rawValue.trim();

    if (!key || !nextValue) {
      return acc;
    }

    acc[key] = nextValue;
    return acc;
  }, {});

  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

const normalizeRemovalKeys = (values: string[] | undefined): string[] => {
  if (!values) {
    return [];
  }

  const unique = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized) {
      unique.add(normalized);
    }
  }

  return [...unique];
};

const mergePrice = (existing: Draft["price"], patch: DraftPatchInput): Draft["price"] => {
  const next = {
    ...existing,
    ...(patch.price ?? {})
  };

  const shouldRecalculate =
    patch.recalculatePriceLadder === true ||
    (patch.price?.target !== undefined && patch.price?.quick_sale === undefined && patch.price?.floor === undefined);

  if (!shouldRecalculate) {
    return next;
  }

  const rebuilt = buildPriceTriple(next.target);
  return {
    ...rebuilt,
    currency: next.currency ?? rebuilt.currency
  };
};

const mergeShipping = (
  existing: Draft["shipping"],
  patch: DraftPatchInput
): Draft["shipping"] | undefined => {
  if (patch.clearShipping) {
    return undefined;
  }

  const merged = {
    ...(existing ?? {}),
    ...(patch.shipping ?? {})
  };

  return Object.values(merged).some((value) => value !== undefined) ? merged : undefined;
};

const mergeItemSpecifics = (existing: Draft["item_specifics"], patch: DraftPatchInput): Draft["item_specifics"] => {
  const next = { ...existing };

  for (const key of normalizeRemovalKeys(patch.itemSpecificsRemove)) {
    delete next[key];
  }

  const additions = normalizeStringRecord(patch.itemSpecificsSet);
  if (additions) {
    Object.assign(next, additions);
  }

  return next;
};

export const patchDraft = (draft: Draft, patch: DraftPatchInput): Draft => {
  const next: Draft = {
    ...draft,
    price: mergePrice(draft.price, patch),
    shipping: mergeShipping(draft.shipping, patch),
    item_specifics: mergeItemSpecifics(draft.item_specifics, patch)
  };

  if (patch.title !== undefined) {
    next.title = patch.title.trim();
  }

  if (patch.description !== undefined) {
    next.description = patch.description.trim();
  }

  if (patch.condition !== undefined) {
    next.condition = patch.condition.trim();
  }

  if (patch.categoryHint !== undefined) {
    next.category_hint = patch.categoryHint.trim();
  }

  if (patch.clearShippingProfile) {
    delete next.shipping_profile;
  } else if (patch.shippingProfile !== undefined) {
    next.shipping_profile = patch.shippingProfile.trim();
  }

  if (patch.clearCategoryId) {
    delete next.category_id;
  } else if (patch.categoryId !== undefined) {
    next.category_id = patch.categoryId.trim();
  }

  return next;
};

export const patchListingDraft = async (
  folder: string,
  patch: DraftPatchInput,
  config?: RuntimeConfig
): Promise<{ listingDir: string; draft: Draft }> => {
  const runtimeConfig = config ?? (await loadRuntimeConfig());
  const listing = await resolveListing(getToSellRoot(runtimeConfig.cwd), folder);
  const currentDraft = await readDraft(listing.draftPath);

  if (!currentDraft) {
    throw new SellbotError("DRAFT_MISSING", `draft.json mancante in ${listing.dir}`);
  }

  const nextDraft = patchDraft(currentDraft, patch);
  await writeDraft(listing.draftPath, nextDraft);

  return {
    listingDir: listing.dir,
    draft: nextDraft
  };
};
